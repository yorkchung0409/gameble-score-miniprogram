'use strict';

const { randomUUID } = require('crypto');
const { CoreError, requireUser, centsToAmount, amountToCents } = require('./mahjong-core');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function asIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!code || code.length > 50) throw new CoreError('账本码无效');
  return code;
}

function normalizeText(value, label, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new CoreError(`${label}不能为空`);
  if (text.length > maxLength) throw new CoreError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeOperationId(value) {
  const operationId = value === undefined || value === null ? '' : String(value).trim();
  if (operationId.length > 80) throw new CoreError('操作号不能超过 80 个字符');
  return operationId || null;
}

function normalizePage(input = {}) {
  const limitValue = Number(input.limit ?? input.gameLimit);
  const offsetValue = Number(input.offset ?? input.gameOffset);
  return {
    limit: Number.isInteger(limitValue) ? Math.min(Math.max(limitValue, 1), MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0,
  };
}

function normalizeDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new CoreError('牌局日期格式无效');
  const [year, month, day] = date.split('-').map(Number);
  const actual = new Date(Date.UTC(year, month - 1, day));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() + 1 !== month || actual.getUTCDate() !== day) {
    throw new CoreError('牌局日期无效');
  }
  return date;
}

function normalizeAmount(value, label) {
  const cents = amountToCents(value, label);
  if (cents < 0) throw new CoreError(`${label}不能为负数`);
  return centsToAmount(cents);
}

function toRoom(row) {
  return {
    id: row.id,
    roomCode: row.roomCode,
    roomName: row.roomName,
    gameType: row.gameType || 'texas',
    createdAt: asIso(row.createdAt),
    updatedAt: asIso(row.updatedAt),
  };
}

async function getOwner(connection, userId, roomCode) {
  const [rows] = await connection.execute(
    `SELECT r.id, r.room_code AS roomCode, r.room_name AS roomName, r.game_type AS gameType,
            r.created_at AS createdAt, r.updated_at AS updatedAt, o.self_player_id AS selfPlayerId
       FROM poker_ledger_owners AS o INNER JOIN rooms AS r ON r.id = o.room_id
      WHERE o.user_id = ? AND r.room_code = ? LIMIT 1`,
    [userId, normalizeCode(roomCode)],
  );
  if (!rows[0]) throw new CoreError('账本不存在或无权访问', 'FORBIDDEN');
  return rows[0];
}

async function touchRoom(connection, roomId) {
  await connection.execute('UPDATE rooms SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [roomId]);
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

async function getPokerDetail(connection, userId, input) {
  const owner = await getOwner(connection, userId, input.roomCode);
  const page = normalizePage(input);
  const [playerRows] = await connection.execute(
    'SELECT id, room_id AS roomId, name FROM players WHERE room_id = ? ORDER BY name',
    [owner.id],
  );
  const [gameRows] = await connection.execute(
    `SELECT id, room_id AS roomId, game_date AS gameDate, created_at AS createdAt
       FROM games WHERE room_id = ? ORDER BY game_date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [owner.id, page.limit, page.offset],
  );
  const gameIds = gameRows.map((row) => row.id);
  let gamePlayerRows = [];
  if (gameIds.length) {
    [gamePlayerRows] = await connection.execute(
      `SELECT gp.id, gp.game_id AS gameId, gp.player_id AS playerId, p.name AS playerName,
              gp.buy_in AS buyIn, gp.balance, gp.net_profit AS netProfit
         FROM game_players AS gp INNER JOIN players AS p ON p.id = gp.player_id
        WHERE gp.game_id IN (${placeholders(gameIds)})`,
      gameIds,
    );
  }
  const playerByGame = new Map();
  for (const row of gamePlayerRows) {
    const list = playerByGame.get(row.gameId) || [];
    list.push({ ...row, buyIn: centsToAmount(amountToCents(row.buyIn)), balance: centsToAmount(amountToCents(row.balance)), netProfit: centsToAmount(amountToCents(row.netProfit)) });
    playerByGame.set(row.gameId, list);
  }
  const games = gameRows.map((row) => {
    const players = playerByGame.get(row.id) || [];
    const totalBuyIn = players.reduce((sum, player) => sum + amountToCents(player.buyIn), 0);
    return { id: row.id, roomId: row.roomId, gameDate: row.gameDate, players, totalBuyIn: centsToAmount(totalBuyIn), playerCount: players.length };
  });
  const [[countRow]] = await connection.execute('SELECT COUNT(*) AS total FROM games WHERE room_id = ?', [owner.id]);
  const [[buyInRow]] = await connection.execute(
    `SELECT COALESCE(SUM(gp.buy_in), 0) AS total FROM game_players AS gp
       INNER JOIN games AS g ON g.id = gp.game_id WHERE g.room_id = ?`, [owner.id],
  );
  const [[latestGame]] = await connection.execute(
    'SELECT id FROM games WHERE room_id = ? ORDER BY game_date DESC, created_at DESC, id DESC LIMIT 1', [owner.id],
  );
  let latestNetRows = [];
  if (latestGame) [latestNetRows] = await connection.execute('SELECT net_profit AS netProfit FROM game_players WHERE game_id = ?', [latestGame.id]);
  const latestNetCents = latestNetRows.map((row) => amountToCents(row.netProfit));
  const latestBalanceDifference = Math.abs(latestNetCents.reduce((sum, value) => sum + value, 0));
  const latestTurnover = latestNetCents.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const [leaderboardRows] = await connection.execute(
    `SELECT p.id AS playerId, p.name AS playerName, COALESCE(SUM(gp.net_profit), 0) AS netProfit,
            COALESCE(SUM(CASE WHEN gp.net_profit > 0 THEN gp.net_profit ELSE 0 END), 0) AS winTotal,
            COALESCE(SUM(CASE WHEN gp.net_profit < 0 THEN -gp.net_profit ELSE 0 END), 0) AS lossTotal
       FROM players AS p LEFT JOIN game_players AS gp ON gp.player_id = p.id
      WHERE p.room_id = ? GROUP BY p.id, p.name`, [owner.id],
  );
  const leaderboard = leaderboardRows.map((row) => ({
    ...row,
    netProfit: centsToAmount(amountToCents(row.netProfit)),
    winTotal: centsToAmount(amountToCents(row.winTotal)),
    lossTotal: centsToAmount(amountToCents(row.lossTotal)),
  })).sort((left, right) => amountToCents(right.netProfit) - amountToCents(left.netProfit) || left.playerName.localeCompare(right.playerName, 'zh-CN'));
  const total = Number(countRow.total || 0);
  return {
    room: toRoom(owner),
    players: playerRows.map((row) => ({ id: row.id, roomId: row.roomId, name: row.name })),
    games,
    leaderboard,
    selfPlayerId: owner.selfPlayerId || null,
    stats: {
      totalGames: total,
      totalBuyIn: centsToAmount(amountToCents(buyInRow.total)),
      latestGameBalanceDiff: centsToAmount(latestBalanceDifference),
      latestGameTurnover: centsToAmount(latestTurnover),
    },
    lastUpdated: asIso(owner.updatedAt),
    gamePage: { total, hasMore: page.offset + games.length < total, nextOffset: page.offset + games.length },
  };
}

async function createPokerLedger(connection, userId, input) {
  const name = normalizeText(input.roomName, '账本名称', 50);
  const operationId = normalizeOperationId(input.operationId);
  if (operationId) {
    const [existingRows] = await connection.execute(
      `SELECT r.id, r.room_code AS roomCode, r.room_name AS roomName, r.game_type AS gameType,
              r.created_at AS createdAt, r.updated_at AS updatedAt, o.self_player_id AS selfPlayerId
         FROM poker_ledger_owners AS o INNER JOIN rooms AS r ON r.id = o.room_id
        WHERE o.user_id = ? AND r.create_operation_id = ? LIMIT 1`, [userId, operationId],
    );
    if (existingRows[0]) return { room: toRoom(existingRows[0]) };
  }
  let roomCode = String(input.roomCode || '').trim().toUpperCase();
  if (roomCode && roomCode.length > 50) throw new CoreError('账本码无效');
  if (!roomCode) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    roomCode = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  }
  const id = randomUUID();
  try {
    await connection.beginTransaction();
    await connection.execute('INSERT INTO rooms (id, room_code, room_name, game_type, create_operation_id) VALUES (?, ?, ?, ?, ?)', [id, roomCode, name, 'texas', operationId]);
    await connection.execute('INSERT INTO poker_ledger_owners (room_id, user_id) VALUES (?, ?)', [id, userId]);
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch {}
    if (error?.code === 'ER_DUP_ENTRY' && operationId) {
      const [existingRows] = await connection.execute(
        `SELECT r.id, r.room_code AS roomCode, r.room_name AS roomName, r.game_type AS gameType,
                r.created_at AS createdAt, r.updated_at AS updatedAt, o.self_player_id AS selfPlayerId
           FROM poker_ledger_owners AS o INNER JOIN rooms AS r ON r.id = o.room_id
          WHERE o.user_id = ? AND r.create_operation_id = ? LIMIT 1`, [userId, operationId],
      );
      if (existingRows[0]) return { room: toRoom(existingRows[0]) };
    }
    if (error?.code === 'ER_DUP_ENTRY') throw new CoreError('账本码已存在');
    throw error;
  }
  const owner = await getOwner(connection, userId, roomCode);
  return { room: toRoom(owner) };
}

async function updatePokerSettings(connection, userId, input) {
  const owner = await getOwner(connection, userId, input.roomCode);
  const roomName = normalizeText(input.roomName, '账本名称', 50);
  const selfPlayerId = input.selfPlayerId || null;
  if (selfPlayerId) {
    const [rows] = await connection.execute('SELECT id FROM players WHERE id = ? AND room_id = ? LIMIT 1', [selfPlayerId, owner.id]);
    if (!rows[0]) throw new CoreError('本人玩家不属于该账本');
  }
  await connection.beginTransaction();
  try {
    await connection.execute('UPDATE rooms SET room_name = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [roomName, owner.id]);
    await connection.execute('UPDATE poker_ledger_owners SET self_player_id = ? WHERE room_id = ?', [selfPlayerId, owner.id]);
    await connection.commit();
  } catch (error) { try { await connection.rollback(); } catch {}; throw error; }
  return getPokerDetail(connection, userId, input);
}

async function addPokerPlayer(connection, userId, input) {
  const owner = await getOwner(connection, userId, input.roomCode);
  const name = normalizeText(input.name, '人员名称', 100);
  const id = randomUUID();
  await connection.execute('INSERT INTO players (id, room_id, name) VALUES (?, ?, ?)', [id, owner.id, name]);
  await touchRoom(connection, owner.id);
  return { id, roomId: owner.id, name };
}

async function deletePokerPlayer(connection, userId, input) {
  const owner = await getOwner(connection, userId, input.roomCode);
  const [players] = await connection.execute('SELECT id FROM players WHERE id = ? AND room_id = ? LIMIT 1', [input.playerId, owner.id]);
  if (!players[0]) throw new CoreError('人员不存在', 'NOT_FOUND');
  const [history] = await connection.execute('SELECT id FROM game_players WHERE player_id = ? LIMIT 1', [input.playerId]);
  if (history[0]) throw new CoreError('该人员已有历史牌局记录，无法删除');
  await connection.execute('DELETE FROM players WHERE id = ? AND room_id = ?', [input.playerId, owner.id]);
  await touchRoom(connection, owner.id);
  return {};
}

async function savePokerGame(connection, userId, input, editing) {
  const owner = await getOwner(connection, userId, input.roomCode);
  const rawPlayers = Array.isArray(input.players) ? input.players : [];
  if (!rawPlayers.length) throw new CoreError('牌局至少需要一名玩家');
  const gameDate = normalizeDate(input.gameDate);
  const unique = [...new Map(rawPlayers.map((player) => [player.playerId, player])).values()];
  if (unique.length > 100) throw new CoreError('单局玩家数量不能超过 100');
  const playerIds = unique.map((player) => String(player.playerId || '')).filter(Boolean);
  if (playerIds.length !== unique.length) throw new CoreError('玩家信息无效');
  const [validRows] = await connection.execute(`SELECT id, name FROM players WHERE room_id = ? AND id IN (${placeholders(playerIds)})`, [owner.id, ...playerIds]);
  if (validRows.length !== playerIds.length) throw new CoreError('存在不属于该账本的玩家');
  const values = unique.map((player) => ({ playerId: player.playerId, buyIn: normalizeAmount(player.buyIn, '买入'), balance: normalizeAmount(player.balance, '结余') }));
  const nameMap = new Map(validRows.map((row) => [row.id, row.name]));
  let gameId = editing ? String(input.gameId || '') : randomUUID();
  const operationId = editing ? null : String(input.operationId || '').trim() || null;
  if (operationId && operationId.length > 80) throw new CoreError('操作号不能超过 80 个字符');
  try {
    await connection.beginTransaction();
    if (editing) {
      const [games] = await connection.execute('SELECT id FROM games WHERE id = ? AND room_id = ? LIMIT 1 FOR UPDATE', [gameId, owner.id]);
      if (!games[0]) throw new CoreError('牌局不存在', 'NOT_FOUND');
      await connection.execute('UPDATE games SET game_date = ? WHERE id = ?', [gameDate, gameId]);
      await connection.execute('DELETE FROM game_players WHERE game_id = ?', [gameId]);
    } else if (operationId) {
      const [existing] = await connection.execute('SELECT id, room_id AS roomId FROM games WHERE operation_id = ? LIMIT 1 FOR UPDATE', [operationId]);
      if (existing[0]) {
        if (existing[0].roomId !== owner.id) throw new CoreError('操作号已被使用');
        gameId = existing[0].id;
        await connection.commit();
        return getPokerGame(connection, owner, gameId, nameMap);
      }
      await connection.execute('INSERT INTO games (id, room_id, operation_id, game_date) VALUES (?, ?, ?, ?)', [gameId, owner.id, operationId, gameDate]);
    } else {
      await connection.execute('INSERT INTO games (id, room_id, game_date) VALUES (?, ?, ?)', [gameId, owner.id, gameDate]);
    }
    for (const player of values) {
      const netProfit = centsToAmount(amountToCents(player.balance) - amountToCents(player.buyIn));
      await connection.execute(
        'INSERT INTO game_players (id, game_id, player_id, buy_in, balance, net_profit) VALUES (?, ?, ?, ?, ?, ?)',
        [randomUUID(), gameId, player.playerId, player.buyIn, player.balance, netProfit],
      );
    }
    await connection.execute('UPDATE rooms SET updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [owner.id]);
    await connection.commit();
  } catch (error) { try { await connection.rollback(); } catch {}; if (error?.code === 'ER_DUP_ENTRY' && operationId) return savePokerGame(connection, userId, input, false); throw error; }
  return getPokerGame(connection, owner, gameId, nameMap);
}

async function getPokerGame(connection, owner, gameId, nameMap = new Map()) {
  const [[game]] = await connection.execute('SELECT id, room_id AS roomId, game_date AS gameDate FROM games WHERE id = ? AND room_id = ? LIMIT 1', [gameId, owner.id]);
  if (!game) throw new CoreError('牌局不存在', 'NOT_FOUND');
  const [rows] = await connection.execute(
    `SELECT gp.id, gp.player_id AS playerId, p.name AS playerName, gp.buy_in AS buyIn, gp.balance, gp.net_profit AS netProfit
       FROM game_players AS gp INNER JOIN players AS p ON p.id = gp.player_id WHERE gp.game_id = ?`, [gameId],
  );
  const players = rows.map((row) => ({ ...row, playerName: row.playerName || nameMap.get(row.playerId) || '', buyIn: centsToAmount(amountToCents(row.buyIn)), balance: centsToAmount(amountToCents(row.balance)), netProfit: centsToAmount(amountToCents(row.netProfit)), gameId }));
  return { game: { id: game.id, roomId: game.roomId, gameDate: game.gameDate, players, totalBuyIn: centsToAmount(players.reduce((sum, player) => sum + amountToCents(player.buyIn), 0)), playerCount: players.length } };
}

async function deletePokerGame(connection, userId, input) {
  const owner = await getOwner(connection, userId, input.roomCode);
  const [rows] = await connection.execute('SELECT id FROM games WHERE id = ? AND room_id = ? LIMIT 1', [input.gameId, owner.id]);
  if (!rows[0]) throw new CoreError('牌局不存在', 'NOT_FOUND');
  await connection.execute('DELETE FROM games WHERE id = ? AND room_id = ?', [input.gameId, owner.id]);
  await touchRoom(connection, owner.id);
  return {};
}

async function dispatchPokerAction(connection, openId, event) {
  const user = await requireUser(connection, openId);
  switch (event.action) {
    case 'createPokerLedger': return createPokerLedger(connection, user.id, event);
    case 'getPokerLedger': return getPokerDetail(connection, user.id, event);
    case 'updatePokerSettings': return updatePokerSettings(connection, user.id, event);
    case 'addPokerPlayer': return addPokerPlayer(connection, user.id, event);
    case 'deletePokerPlayer': return deletePokerPlayer(connection, user.id, event);
    case 'createPokerGame': return savePokerGame(connection, user.id, event, false);
    case 'updatePokerGame': return savePokerGame(connection, user.id, event, true);
    case 'deletePokerGame': return deletePokerGame(connection, user.id, event);
    default: throw new CoreError('不支持的扑克操作', 'UNSUPPORTED_ACTION');
  }
}

module.exports = { dispatchPokerAction, getPokerDetail, getOwner, normalizePage };
