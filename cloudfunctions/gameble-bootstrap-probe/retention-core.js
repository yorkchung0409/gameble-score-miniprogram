'use strict';

const {
  amountToCents,
  centsToAmount,
  calculateTeaFeeCents,
  calculateThresholdTeaFeeCents,
} = require('./mahjong-core');

const RETENTION_MONTHS = 6;
const RETENTION_LOCK = 'gameble_score_retention_cleanup';
// The personal Cloud Function tier is limited to three seconds. Keep the
// daily work small and let subsequent runs drain a historical backlog.
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_MAX_BATCHES = 1;

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

async function withTransaction(connection, work) {
  await connection.beginTransaction();
  try {
    const result = await work();
    await connection.commit();
    return result;
  } catch (error) {
    try { await connection.rollback(); } catch {}
    throw error;
  }
}

function latestCreatedAt(rows) {
  return rows.reduce((latest, row) => {
    const value = new Date(row.createdAt);
    return Number.isNaN(value.getTime()) || value <= latest ? latest : value;
  }, new Date(0));
}

function addUserDelta(totals, userId, deltaCents) {
  const total = totals.get(userId) || { netCents: 0, winCents: 0, lossCents: 0, teaFeeCents: 0 };
  total.netCents += deltaCents;
  if (deltaCents > 0) total.winCents += deltaCents;
  if (deltaCents < 0) total.lossCents += Math.abs(deltaCents);
  totals.set(userId, total);
}

function addUserTeaFee(totals, userId, feeCents) {
  const total = totals.get(userId) || { netCents: 0, winCents: 0, lossCents: 0, teaFeeCents: 0 };
  total.netCents -= feeCents;
  total.teaFeeCents += feeCents;
  totals.set(userId, total);
}

function addOpponentDelta(totals, userId, opponentUserId, deltaCents, roomId) {
  const key = `${userId}:${opponentUserId}`;
  const total = totals.get(key) || {
    userId,
    opponentUserId,
    netCents: 0,
    winCents: 0,
    lossCents: 0,
    transactionCount: 0,
    roomIds: new Set(),
  };
  total.netCents += deltaCents;
  if (deltaCents > 0) total.winCents += deltaCents;
  if (deltaCents < 0) total.lossCents += Math.abs(deltaCents);
  total.transactionCount += 1;
  total.roomIds.add(roomId);
  totals.set(key, total);
}

function automaticFee(row) {
  if (row.transactionType !== 'manual' || row.autoFeeThresholdAmount == null) return 0;
  if ((row.autoFeeMode === 'percentage' || row.autoFeeMode === 'per_player') && row.autoFeeRatePercent != null) {
    return calculateTeaFeeCents(
      amountToCents(row.amount),
      amountToCents(row.autoFeeThresholdAmount),
      Number(row.autoFeeRatePercent),
    );
  }
  if ((row.autoFeeMode === 'threshold' || row.autoFeeMode === 'shared_total') && row.autoFeeAmount != null) {
    return calculateThresholdTeaFeeCents(
      amountToCents(row.amount),
      amountToCents(row.autoFeeThresholdAmount),
      amountToCents(row.autoFeeAmount),
    );
  }
  return 0;
}

async function upsertPokerSnapshots(connection, totals, archivedThrough) {
  for (const total of totals.values()) {
    await connection.execute(
      `INSERT INTO poker_ledger_snapshots
        (room_id, user_id, net_profit, game_count, archived_through)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         net_profit = net_profit + VALUES(net_profit),
         game_count = game_count + VALUES(game_count),
         archived_through = GREATEST(archived_through, VALUES(archived_through))`,
      [total.roomId, total.userId, centsToAmount(total.netCents), total.gameCount, archivedThrough],
    );
  }
}

async function cleanupPoker(connection, cutoff, batchSize) {
  const [games] = await connection.execute(
    `SELECT g.id, g.room_id AS roomId, o.user_id AS userId, o.self_player_id AS selfPlayerId
       FROM games AS g INNER JOIN poker_ledger_owners AS o ON o.room_id = g.room_id
      WHERE g.created_at < ? ORDER BY g.created_at ASC, g.id ASC LIMIT ? FOR UPDATE`,
    [cutoff, batchSize],
  );
  if (!games.length) return 0;

  const gameIds = games.map((game) => game.id);
  const [players] = await connection.execute(
    `SELECT game_id AS gameId, player_id AS playerId, net_profit AS netProfit
       FROM game_players WHERE game_id IN (${placeholders(gameIds)})`, gameIds,
  );
  const gameById = new Map(games.map((game) => [game.id, game]));
  const totals = new Map();
  for (const player of players) {
    const game = gameById.get(player.gameId);
    if (!game || !game.selfPlayerId || game.selfPlayerId !== player.playerId) continue;
    const total = totals.get(game.roomId) || { roomId: game.roomId, userId: game.userId, netCents: 0, gameCount: 0 };
    total.netCents += amountToCents(player.netProfit);
    total.gameCount += 1;
    totals.set(game.roomId, total);
  }
  await upsertPokerSnapshots(connection, totals, latestCreatedAt(games));
  await connection.execute(`DELETE FROM games WHERE id IN (${placeholders(gameIds)})`, gameIds);
  return games.length;
}

function transactionColumns() {
  return `id, room_id AS roomId, payer_id AS payerId, payee_type AS payeeType, payee_id AS payeeId,
          amount, reversal_of AS reversalOf, transaction_type AS transactionType,
          auto_fee_mode AS autoFeeMode, auto_fee_threshold_amount AS autoFeeThresholdAmount,
          auto_fee_rate_percent AS autoFeeRatePercent, auto_fee_amount AS autoFeeAmount,
          created_at AS createdAt`;
}

async function upsertMahjongSnapshots(connection, userTotals, opponentTotals, archivedThrough) {
  for (const [userId, total] of userTotals) {
    await connection.execute(
      `INSERT INTO mahjong_user_snapshots
        (user_id, net_profit, win_total, loss_total, tea_fee_total, archived_through)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         net_profit = net_profit + VALUES(net_profit),
         win_total = win_total + VALUES(win_total),
         loss_total = loss_total + VALUES(loss_total),
         tea_fee_total = tea_fee_total + VALUES(tea_fee_total),
         archived_through = GREATEST(archived_through, VALUES(archived_through))`,
      [userId, centsToAmount(total.netCents), centsToAmount(total.winCents), centsToAmount(total.lossCents), centsToAmount(total.teaFeeCents), archivedThrough],
    );
  }

  for (const total of opponentTotals.values()) {
    let newRoomCount = 0;
    for (const roomId of total.roomIds) {
      const [result] = await connection.execute(
        `INSERT IGNORE INTO mahjong_opponent_snapshot_rooms
          (id, user_id, opponent_user_id, room_id) VALUES (?, ?, ?, ?)`,
        [`${total.userId}:${total.opponentUserId}:${roomId}`, total.userId, total.opponentUserId, roomId],
      );
      newRoomCount += Number(result.affectedRows || 0);
    }
    const id = `${total.userId}:${total.opponentUserId}`;
    await connection.execute(
      `INSERT INTO mahjong_opponent_snapshots
        (id, user_id, opponent_user_id, net_profit, win_total, loss_total, transaction_count, room_count, archived_through)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         net_profit = net_profit + VALUES(net_profit),
         win_total = win_total + VALUES(win_total),
         loss_total = loss_total + VALUES(loss_total),
         transaction_count = transaction_count + VALUES(transaction_count),
         room_count = room_count + VALUES(room_count),
         archived_through = GREATEST(archived_through, VALUES(archived_through))`,
      [id, total.userId, total.opponentUserId, centsToAmount(total.netCents), centsToAmount(total.winCents), centsToAmount(total.lossCents), total.transactionCount, newRoomCount, archivedThrough],
    );
  }
}

async function cleanupMahjong(connection, cutoff, batchSize) {
  const [candidates] = await connection.execute(
    `SELECT ${transactionColumns()} FROM mahjong_transactions AS t
      WHERE t.created_at < ?
        AND t.reversal_of IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM mahjong_transactions AS reversal
           WHERE reversal.reversal_of = t.id AND reversal.created_at >= ?
        )
      ORDER BY t.created_at ASC, t.id ASC LIMIT ? FOR UPDATE`,
    [cutoff, cutoff, batchSize],
  );
  if (!candidates.length) return 0;

  const candidateIds = candidates.map((row) => row.id);
  const [reversals] = await connection.execute(
    `SELECT ${transactionColumns()} FROM mahjong_transactions
      WHERE reversal_of IN (${placeholders(candidateIds)})`, candidateIds,
  );
  // Candidates are original transfers only. Their rows are locked above, so
  // a concurrent reversal cannot be inserted between this read and deletion.
  const safeRows = [...candidates, ...reversals];
  const safeIds = new Set(safeRows.map((row) => row.id));
  const reversedOriginIds = new Set(safeRows.map((row) => row.reversalOf).filter(Boolean));
  const userTotals = new Map();
  const opponentTotals = new Map();
  for (const row of safeRows) {
    if (row.reversalOf || reversedOriginIds.has(row.id)) continue;
    const amountCents = amountToCents(row.amount);
    if (row.payeeType === 'tea_fee') {
      addUserDelta(userTotals, row.payerId, -amountCents);
      const total = userTotals.get(row.payerId);
      total.teaFeeCents += amountCents;
      continue;
    }
    if (row.payeeType !== 'user' || !row.payeeId) continue;
    addUserDelta(userTotals, row.payerId, -amountCents);
    addUserDelta(userTotals, row.payeeId, amountCents);
    const feeCents = automaticFee(row);
    if (feeCents > 0) addUserTeaFee(userTotals, row.payeeId, feeCents);
    addOpponentDelta(opponentTotals, row.payerId, row.payeeId, -amountCents, row.roomId);
    addOpponentDelta(opponentTotals, row.payeeId, row.payerId, amountCents, row.roomId);
  }
  await upsertMahjongSnapshots(connection, userTotals, opponentTotals, latestCreatedAt(safeRows));
  await connection.execute(`DELETE FROM mahjong_transactions WHERE id IN (${placeholders([...safeIds])})`, [...safeIds]);
  return safeIds.size;
}

async function runRetentionCleanup(connection, options = {}) {
  const batchSize = Math.min(Math.max(Number(options.batchSize) || DEFAULT_BATCH_SIZE, 1), 500);
  const maxBatches = Math.min(Math.max(Number(options.maxBatches) || DEFAULT_MAX_BATCHES, 1), 5);
  const [lockRows] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [RETENTION_LOCK]);
  if (Number(lockRows[0]?.acquired || 0) !== 1) return { skipped: true, poker: 0, mahjong: 0 };
  try {
    const [[cutoffRow]] = await connection.query(
      'SELECT DATE_SUB(CURRENT_TIMESTAMP(6), INTERVAL 6 MONTH) AS cutoff',
    );
    const cutoff = cutoffRow.cutoff;
    let poker = 0;
    let mahjong = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await withTransaction(connection, () => cleanupPoker(connection, cutoff, batchSize));
      poker += count;
      if (count < batchSize) break;
    }
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await withTransaction(connection, () => cleanupMahjong(connection, cutoff, batchSize));
      mahjong += count;
      if (count < batchSize) break;
    }
    return { skipped: false, poker, mahjong, cutoff: new Date(cutoff).toISOString() };
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [RETENTION_LOCK]).catch(() => null);
  }
}

module.exports = { runRetentionCleanup, cleanupMahjong };
