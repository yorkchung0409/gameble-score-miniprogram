'use strict';

const { CoreError, requireUser, amountToCents, centsToAmount, calculateTeaFeeCents, calculateThresholdTeaFeeCents, archiveIdleRoomsForUser } = require('./mahjong-core');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function asIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function page(input = {}) {
  const limitValue = Number(input.limit);
  const offsetValue = Number(input.offset);
  return {
    limit: Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0,
  };
}

function placeholders(ids) { return ids.map(() => '?').join(', '); }

function effectiveTransactions(rows) {
  const reversed = new Set(rows.map((row) => row.reversalOf).filter(Boolean));
  return rows.filter((row) => !row.reversalOf && !reversed.has(row.id));
}

function automaticFee(row) {
  if (row.transactionType !== 'manual' || row.autoFeeThresholdAmount == null) return 0;
  if ((row.autoFeeMode === 'percentage' || row.autoFeeMode === 'per_player') && row.autoFeeRatePercent != null) {
    return calculateTeaFeeCents(amountToCents(row.amount), amountToCents(row.autoFeeThresholdAmount), Number(row.autoFeeRatePercent));
  }
  if ((row.autoFeeMode === 'threshold' || row.autoFeeMode === 'shared_total') && row.autoFeeAmount != null) {
    return calculateThresholdTeaFeeCents(amountToCents(row.amount), amountToCents(row.autoFeeThresholdAmount), amountToCents(row.autoFeeAmount));
  }
  return 0;
}

async function getUser(connection, userId) {
  const [[user]] = await connection.execute('SELECT id, name, device_id AS deviceId, created_at AS createdAt FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!user) throw new CoreError('用户不存在', 'NOT_FOUND');
  return { id: user.id, name: user.name, createdAt: asIso(user.createdAt) };
}

async function getPokerLedgers(connection, userId, input = {}) {
  const { limit, offset } = page(input);
  const [[countRow], [owners]] = await Promise.all([
    connection.execute('SELECT COUNT(*) AS total FROM poker_ledger_owners WHERE user_id = ?', [userId]),
    connection.execute(
      `SELECT r.id, r.room_code AS roomCode, r.room_name AS roomName, r.game_type AS gameType,
              r.created_at AS createdAt, r.updated_at AS updatedAt, o.self_player_id AS selfPlayerId
         FROM poker_ledger_owners AS o INNER JOIN rooms AS r ON r.id = o.room_id
        WHERE o.user_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`, [userId, limit, offset],
    ),
  ]);
  if (!owners.length) return { ledgers: [], total: Number(countRow.total || 0), hasMore: false, nextOffset: offset };
  const roomIds = owners.map((row) => row.id);
  const selfPlayerIds = owners.map((row) => row.selfPlayerId).filter(Boolean);
  const snapshotByRoom = new Map();
  const totalsByPlayer = new Map();
  const [snapshots] = await connection.execute(
    `SELECT room_id AS roomId, net_profit AS netProfit, game_count AS gameCount FROM poker_ledger_snapshots WHERE room_id IN (${placeholders(roomIds)})`, roomIds,
  );
  for (const snapshot of snapshots) snapshotByRoom.set(snapshot.roomId, { netCents: amountToCents(snapshot.netProfit), gameCount: Number(snapshot.gameCount || 0) });
  if (selfPlayerIds.length) {
    const [rows] = await connection.execute(
      `SELECT player_id AS playerId, net_profit AS netProfit FROM game_players WHERE player_id IN (${placeholders(selfPlayerIds)})`, selfPlayerIds,
    );
    for (const row of rows) {
      const total = totalsByPlayer.get(row.playerId) || { netCents: 0, gameCount: 0 };
      total.netCents += amountToCents(row.netProfit);
      total.gameCount += 1;
      totalsByPlayer.set(row.playerId, total);
    }
  }
  const ledgers = owners.map((owner) => {
    const archived = snapshotByRoom.get(owner.id) || { netCents: 0, gameCount: 0 };
    const current = owner.selfPlayerId ? (totalsByPlayer.get(owner.selfPlayerId) || { netCents: 0, gameCount: 0 }) : { netCents: 0, gameCount: 0 };
    return {
      room: { id: owner.id, roomCode: owner.roomCode, roomName: owner.roomName, gameType: owner.gameType || 'texas', createdAt: asIso(owner.createdAt), updatedAt: asIso(owner.updatedAt) },
      selfPlayerId: owner.selfPlayerId || null,
      myNetProfit: centsToAmount(archived.netCents + current.netCents),
      myGameCount: archived.gameCount + current.gameCount,
    };
  });
  const total = Number(countRow.total || 0);
  return { ledgers, total, hasMore: offset + ledgers.length < total, nextOffset: offset + ledgers.length };
}

async function getPokerTotals(connection, userId) {
  const [owners] = await connection.execute(
    'SELECT room_id AS roomId, self_player_id AS selfPlayerId FROM poker_ledger_owners WHERE user_id = ?', [userId],
  );
  if (!owners.length) return { netCents: 0, gameCount: 0, ledgerCount: 0, trackedLedgerCount: 0 };
  const roomIds = owners.map((owner) => owner.roomId);
  const selfPlayerIds = owners.map((owner) => owner.selfPlayerId).filter(Boolean);
  const [snapshots] = await connection.execute(
    `SELECT room_id AS roomId, net_profit AS netProfit, game_count AS gameCount
       FROM poker_ledger_snapshots WHERE room_id IN (${placeholders(roomIds)})`, roomIds,
  );
  const snapshotByRoom = new Map(snapshots.map((row) => [row.roomId, row]));
  const [currentRows] = selfPlayerIds.length
    ? await connection.execute(
      `SELECT player_id AS playerId, net_profit AS netProfit FROM game_players WHERE player_id IN (${placeholders(selfPlayerIds)})`, selfPlayerIds,
    )
    : [[]];
  const currentByPlayer = new Map();
  for (const row of currentRows) {
    const total = currentByPlayer.get(row.playerId) || { netCents: 0, gameCount: 0 };
    total.netCents += amountToCents(row.netProfit);
    total.gameCount += 1;
    currentByPlayer.set(row.playerId, total);
  }
  return owners.reduce((total, owner) => {
    const snapshot = snapshotByRoom.get(owner.roomId);
    const current = owner.selfPlayerId
      ? currentByPlayer.get(owner.selfPlayerId) || { netCents: 0, gameCount: 0 }
      : { netCents: 0, gameCount: 0 };
    return {
      netCents: total.netCents + amountToCents(snapshot?.netProfit || 0) + current.netCents,
      gameCount: total.gameCount + Number(snapshot?.gameCount || 0) + current.gameCount,
      ledgerCount: total.ledgerCount + 1,
      trackedLedgerCount: total.trackedLedgerCount + (owner.selfPlayerId ? 1 : 0),
    };
  }, { netCents: 0, gameCount: 0, ledgerCount: 0, trackedLedgerCount: 0 });
}

async function getMahjongRooms(connection, userId, input = {}) {
  await archiveIdleRoomsForUser(connection, userId);
  const { limit, offset } = page(input);
  const activeOnly = Boolean(input.activeOnly);
  const condition = activeOnly
    ? 'm.user_id = ? AND m.left_at IS NULL AND r.dissolved_at IS NULL'
    : 'm.user_id = ?';
  const [[countRow], [memberships]] = await Promise.all([
    connection.execute(`SELECT COUNT(*) AS total FROM mahjong_room_members AS m INNER JOIN mahjong_rooms AS r ON r.id = m.room_id WHERE ${condition}`, [userId]),
    connection.execute(
      `SELECT r.id, r.room_code AS roomCode, r.name AS roomName, r.created_at AS createdAt, r.dissolved_at AS dissolvedAt
         FROM mahjong_room_members AS m INNER JOIN mahjong_rooms AS r ON r.id = m.room_id
        WHERE ${condition} ORDER BY m.joined_at DESC, r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`, [userId, limit, offset],
    ),
  ]);
  if (!memberships.length) return { rooms: [], total: Number(countRow.total || 0), hasMore: false, nextOffset: offset };
  const roomIds = memberships.map((row) => row.id);
  const [transactions] = await connection.execute(
    `SELECT id, room_id AS roomId, payer_id AS payerId, payee_type AS payeeType, payee_id AS payeeId, amount,
            reversal_of AS reversalOf, transaction_type AS transactionType, auto_fee_mode AS autoFeeMode,
            auto_fee_threshold_amount AS autoFeeThresholdAmount, auto_fee_rate_percent AS autoFeeRatePercent,
            auto_fee_amount AS autoFeeAmount,
            created_at AS createdAt FROM mahjong_transactions WHERE room_id IN (${placeholders(roomIds)})`, roomIds,
  );
  const totals = new Map();
  for (const row of effectiveTransactions(transactions)) {
    const total = totals.get(row.roomId) || { netCents: 0, lastActivityAt: null };
    const amount = amountToCents(row.amount);
    if (row.payeeType === 'tea_fee' && row.payerId === userId) total.netCents -= amount;
    if (row.payeeType === 'user') {
      if (row.payerId === userId) total.netCents -= amount;
      if (row.payeeId === userId) total.netCents += amount - automaticFee(row);
    }
    if (!total.lastActivityAt || new Date(row.createdAt) > new Date(total.lastActivityAt)) total.lastActivityAt = row.createdAt;
    totals.set(row.roomId, total);
  }
  const rooms = memberships.map((room) => {
    const total = totals.get(room.id) || { netCents: 0, lastActivityAt: null };
    return { roomCode: room.roomCode, roomName: room.roomName, createdAt: asIso(room.createdAt), dissolvedAt: asIso(room.dissolvedAt), lastActivityAt: asIso(total.lastActivityAt || room.createdAt), myNetProfit: centsToAmount(total.netCents) };
  });
  const total = Number(countRow.total || 0);
  return { rooms, total, hasMore: offset + rooms.length < total, nextOffset: offset + rooms.length };
}

async function getMyTransactions(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT id, room_id AS roomId, payer_id AS payerId, payee_type AS payeeType, payee_id AS payeeId, amount,
            reversal_of AS reversalOf, transaction_type AS transactionType, auto_fee_mode AS autoFeeMode,
            auto_fee_threshold_amount AS autoFeeThresholdAmount, auto_fee_rate_percent AS autoFeeRatePercent,
            auto_fee_amount AS autoFeeAmount,
            created_at AS createdAt FROM mahjong_transactions WHERE payer_id = ? OR payee_id = ?`, [userId, userId],
  );
  return effectiveTransactions(rows);
}

async function getSummary(connection, userId) {
  const [user, pokerTotals, transactions, snapshots, roomRows, opponentSnapshots] = await Promise.all([
    getUser(connection, userId),
    getPokerTotals(connection, userId),
    getMyTransactions(connection, userId),
    connection.execute('SELECT net_profit AS netProfit, win_total AS winTotal, loss_total AS lossTotal, tea_fee_total AS teaFeeTotal FROM mahjong_user_snapshots WHERE user_id = ? LIMIT 1', [userId]).then(([rows]) => rows[0]),
    connection.execute('SELECT room_id AS roomId FROM mahjong_room_members WHERE user_id = ?', [userId]).then(([rows]) => rows),
    connection.execute('SELECT opponent_user_id AS opponentId FROM mahjong_opponent_snapshots WHERE user_id = ?', [userId]).then(([rows]) => rows),
  ]);
  let netCents = amountToCents(snapshots?.netProfit || '0');
  let winCents = amountToCents(snapshots?.winTotal || '0');
  let lossCents = amountToCents(snapshots?.lossTotal || '0');
  let teaFeeCents = amountToCents(snapshots?.teaFeeTotal || '0');
  const opponentIds = new Set(opponentSnapshots.map((row) => row.opponentId));
  for (const row of transactions) {
    const amount = amountToCents(row.amount);
    if (row.payeeType === 'tea_fee' && row.payerId === userId) { netCents -= amount; teaFeeCents += amount; continue; }
    if (row.payeeType !== 'user') continue;
    const delta = row.payerId === userId ? -amount : amount;
    netCents += delta;
    if (delta > 0) winCents += delta;
    if (delta < 0) lossCents -= delta;
    if (row.payeeId === userId) { const fee = automaticFee(row); netCents -= fee; teaFeeCents += fee; }
    opponentIds.add(row.payerId === userId ? row.payeeId : row.payerId);
  }
  return {
    user,
    totalNetProfit: centsToAmount(pokerTotals.netCents + netCents),
    poker: { netProfit: centsToAmount(pokerTotals.netCents), gameCount: pokerTotals.gameCount, ledgerCount: pokerTotals.ledgerCount, trackedLedgerCount: pokerTotals.trackedLedgerCount },
    mahjong: { netProfit: centsToAmount(netCents), winTotal: centsToAmount(winCents), lossTotal: centsToAmount(lossCents), roomCount: roomRows.length, opponentCount: opponentIds.size, teaFeeTotal: centsToAmount(teaFeeCents) },
  };
}

async function getMahjongOpponents(connection, userId, input = {}) {
  const [transactions, snapshotRows] = await Promise.all([
    getMyTransactions(connection, userId),
    connection.execute(
      `SELECT opponent_user_id AS opponentId, net_profit AS netProfit, win_total AS winTotal,
              loss_total AS lossTotal, transaction_count AS transactionCount, room_count AS roomCount,
              archived_through AS archivedThrough
         FROM mahjong_opponent_snapshots WHERE user_id = ?`, [userId],
    ).then(([rows]) => rows),
  ]);
  const totals = new Map();
  for (const row of snapshotRows) {
    totals.set(row.opponentId, {
      netCents: amountToCents(row.netProfit),
      winCents: amountToCents(row.winTotal),
      lossCents: amountToCents(row.lossTotal),
      roomIds: new Set(),
      snapshotRoomCount: Number(row.roomCount || 0),
      transactionCount: Number(row.transactionCount || 0),
      lastPlayedAt: row.archivedThrough,
    });
  }
  for (const row of transactions) {
    if (row.payeeType !== 'user' || !row.payeeId) continue;
    const opponentId = row.payerId === userId ? row.payeeId : row.payerId;
    const total = totals.get(opponentId) || { netCents: 0, winCents: 0, lossCents: 0, roomIds: new Set(), snapshotRoomCount: 0, transactionCount: 0, lastPlayedAt: row.createdAt };
    const net = row.payerId === userId ? -amountToCents(row.amount) : amountToCents(row.amount);
    total.netCents += net;
    if (net > 0) total.winCents += net;
    if (net < 0) total.lossCents -= net;
    total.transactionCount += 1;
    total.roomIds.add(row.roomId);
    if (new Date(row.createdAt) > new Date(total.lastPlayedAt)) total.lastPlayedAt = row.createdAt;
    totals.set(opponentId, total);
  }
  const ids = [...totals.keys()];
  if (!ids.length) return { opponents: [], total: 0, hasMore: false, nextOffset: 0 };
  const [names] = await connection.execute(`SELECT id, name FROM users WHERE id IN (${placeholders(ids)})`, ids);
  const nameMap = new Map(names.map((row) => [row.id, row.name]));
  const all = ids.map((id) => {
    const total = totals.get(id);
    return { userId: id, userName: nameMap.get(id) || '未知玩家', netProfit: centsToAmount(total.netCents), winTotal: centsToAmount(total.winCents), lossTotal: centsToAmount(total.lossCents), roomCount: total.snapshotRoomCount + total.roomIds.size, transactionCount: total.transactionCount, lastPlayedAt: asIso(total.lastPlayedAt) };
  }).sort((left, right) => right.lastPlayedAt.localeCompare(left.lastPlayedAt));
  const { limit, offset } = page(input);
  const opponents = all.slice(offset, offset + limit);
  return { opponents, total: all.length, hasMore: offset + opponents.length < all.length, nextOffset: offset + opponents.length };
}

function isAdmin(openId) {
  return String(process.env.ADMIN_WECHAT_OPENIDS || '').split(',').map((value) => value.trim()).filter(Boolean).includes(openId);
}

async function getOperationsOverview(connection, openId) {
  if (!isAdmin(openId)) throw new CoreError('无权访问运营数据', 'FORBIDDEN');
  const [[users], [newUsers], [activeUsers], [activeMahjong], [activePoker], [hourly], [daily], [reversals]] = await Promise.all([
    connection.execute('SELECT COUNT(*) AS total FROM users'),
    connection.execute('SELECT COUNT(*) AS total FROM users WHERE created_at >= DATE_SUB(NOW(6), INTERVAL 1 DAY)'),
    connection.execute(`SELECT COUNT(DISTINCT actor_id) AS total FROM (
      SELECT payer_id AS actor_id FROM mahjong_transactions WHERE created_at >= DATE_SUB(NOW(6), INTERVAL 5 MINUTE)
      UNION
      SELECT payee_id AS actor_id FROM mahjong_transactions WHERE payee_type = 'user' AND created_at >= DATE_SUB(NOW(6), INTERVAL 5 MINUTE)
    ) AS active_users WHERE actor_id IS NOT NULL`),
    connection.execute(`SELECT COUNT(DISTINCT r.id) AS total FROM mahjong_rooms AS r LEFT JOIN mahjong_transactions AS t ON t.room_id = r.id WHERE r.dissolved_at IS NULL AND (r.created_at >= DATE_SUB(NOW(6), INTERVAL 30 MINUTE) OR t.created_at >= DATE_SUB(NOW(6), INTERVAL 30 MINUTE))`),
    connection.execute('SELECT COUNT(DISTINCT room_id) AS total FROM games WHERE created_at >= DATE_SUB(NOW(3), INTERVAL 30 MINUTE)'),
    connection.execute('SELECT COUNT(*) AS total FROM mahjong_transactions WHERE created_at >= DATE_SUB(NOW(6), INTERVAL 1 HOUR)'),
    connection.execute('SELECT COUNT(*) AS total FROM mahjong_transactions WHERE created_at >= DATE_SUB(NOW(6), INTERVAL 1 DAY)'),
    connection.execute('SELECT COUNT(*) AS total FROM mahjong_transactions WHERE reversal_of IS NOT NULL AND created_at >= DATE_SUB(NOW(6), INTERVAL 1 DAY)'),
  ]);
  return { generatedAt: new Date().toISOString(), users: { total: Number(users.total || 0), newIn24Hours: Number(newUsers.total || 0), activeIn5Minutes: Number(activeUsers.total || 0) }, rooms: { activeMahjongIn30Minutes: Number(activeMahjong.total || 0), activePokerIn30Minutes: Number(activePoker.total || 0) }, transactions: { inLastHour: Number(hourly.total || 0), inLast24Hours: Number(daily.total || 0), reversalsInLast24Hours: Number(reversals.total || 0) }, realtime: { mode: 'revision_polling', refreshFallbackSeconds: 15 } };
}

async function dispatchProfileAction(connection, openId, event) {
  const user = await requireUser(connection, openId);
  if (event.action === 'getPersonalDashboard') {
    const historyLimit = Math.min(Math.max(Number(event.historyLimit) || 1, 1), 20);
    const [summary, poker, mahjong] = await Promise.all([getSummary(connection, user.id), getPokerLedgers(connection, user.id, { limit: historyLimit }), getMahjongRooms(connection, user.id, { limit: historyLimit })]);
    return { summary, poker, mahjong, canAccessOperations: isAdmin(openId) };
  }
  if (event.action === 'getPersonalRecentActivity') {
    const [poker, mahjong] = await Promise.all([getPokerLedgers(connection, user.id, { limit: 1 }), getMahjongRooms(connection, user.id, { limit: 1 })]);
    return { poker, mahjong };
  }
  if (event.action === 'getPersonalPokerLedgers') return getPokerLedgers(connection, user.id, event);
  if (event.action === 'getPersonalMahjongRooms') return getMahjongRooms(connection, user.id, event);
  if (event.action === 'getMahjongOpponents') return getMahjongOpponents(connection, user.id, event);
  if (event.action === 'getOperationsOverview') return getOperationsOverview(connection, openId);
  throw new CoreError('不支持的个人数据操作', 'UNSUPPORTED_ACTION');
}

module.exports = { dispatchProfileAction, getPokerLedgers, getMahjongRooms, getSummary };
