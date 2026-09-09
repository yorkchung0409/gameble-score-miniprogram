'use strict';

const { randomUUID } = require('crypto');
const rules = require('./mahjong-rules');

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_TEA_FEE_RULE = Object.freeze({
  enabled: false,
  mode: 'percentage',
  thresholdAmount: '0.00',
  ratePercent: 10,
  feeAmount: '0.00',
  version: 0,
  updatedAt: null,
});
const TRANSACTION_LIMIT = 30;
const DISSOLVE_IDLE_MS = 30 * 60 * 1000;

class CoreError extends Error {
  constructor(message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

function asIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function generateRoomCode() {
  let value = '';
  for (let index = 0; index < 6; index += 1) {
    value += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return value;
}

function normalizeRoomCode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized || normalized.length > 50) throw new CoreError('房间码无效');
  return normalized;
}

function amountToCents(value, label = '金额') {
  return rules.amountToCents(value, label, (message) => new CoreError(message));
}

function centsToAmount(cents) {
  return rules.centsToAmount(cents);
}

function calculateTeaFeeCents(amountCents, thresholdCents, ratePercent) {
  return rules.calculateTeaFeeCents(amountCents, thresholdCents, ratePercent);
}

function calculateThresholdTeaFeeCents(amountCents, thresholdCents, feeCents) {
  return rules.calculateThresholdTeaFeeCents(amountCents, thresholdCents, feeCents);
}

function normalizeTeaFeeMode(value) {
  return value === 'threshold' || value === 'shared_total' ? 'threshold' : 'percentage';
}

function calculateAutomaticTeaFeeCents(row) {
  if (row.payeeType !== 'user' || row.transactionType !== 'manual' || !row.autoFeeMode || row.autoFeeThresholdAmount == null) return 0;
  if ((row.autoFeeMode === 'percentage' || row.autoFeeMode === 'per_player') && row.autoFeeRatePercent != null) {
    return calculateTeaFeeCents(amountToCents(row.amount), amountToCents(row.autoFeeThresholdAmount), Number(row.autoFeeRatePercent));
  }
  if ((row.autoFeeMode === 'threshold' || row.autoFeeMode === 'shared_total') && row.autoFeeAmount != null) {
    return calculateThresholdTeaFeeCents(amountToCents(row.amount), amountToCents(row.autoFeeThresholdAmount), amountToCents(row.autoFeeAmount));
  }
  return 0;
}

function calculateRoomStats(rows) {
  return rules.calculateRoomStats(rows, { amountToCents });
}

function parseCachedBalances(value) {
  try {
    const entries = JSON.parse(String(value || '[]'));
    if (!Array.isArray(entries)) return null;
    const balanceMap = new Map();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return null;
      const cents = Number(entry[1]);
      if (!Number.isSafeInteger(cents)) return null;
      balanceMap.set(entry[0], cents);
    }
    return balanceMap;
  } catch {
    return null;
  }
}

async function getRoomStats(connection, room) {
  const [revisionRows] = await connection.execute(
    `SELECT version, stats_version AS statsVersion, stats_total_turnover AS statsTotalTurnover,
            stats_tea_fee_total AS statsTeaFeeTotal, stats_balances_json AS statsBalancesJson
       FROM mahjong_room_revisions WHERE room_code = ? LIMIT 1`,
    [room.roomCode],
  );
  const revision = Number(revisionRows[0]?.version || 0);
  const cached = revisionRows[0];
  const cachedBalances = cached && Number(cached.statsVersion) === revision
    ? parseCachedBalances(cached.statsBalancesJson)
    : null;
  if (cachedBalances) {
    return {
      balanceMap: cachedBalances,
      teaFeeTotal: amountToCents(cached.statsTeaFeeTotal),
      totalTurnover: amountToCents(cached.statsTotalTurnover),
      revision,
    };
  }

  // A room is fully scanned only after its revision changes. Polling reads use
  // the cached aggregate above, while every existing writer already bumps the
  // same revision row.
  const [rows] = await connection.execute(
    `SELECT id, payer_id AS payerId, payee_type AS payeeType, payee_id AS payeeId, amount,
            reversal_of AS reversalOf, transaction_type AS transactionType, auto_fee_mode AS autoFeeMode,
            auto_fee_threshold_amount AS autoFeeThresholdAmount, auto_fee_rate_percent AS autoFeeRatePercent,
            auto_fee_amount AS autoFeeAmount
       FROM mahjong_transactions WHERE room_id = ?`,
    [room.id],
  );
  const stats = calculateRoomStats(rows);
  const balancesJson = JSON.stringify([...stats.balanceMap.entries()]);
  if (cached) {
    await connection.execute(
      `UPDATE mahjong_room_revisions
          SET stats_version = ?, stats_total_turnover = ?, stats_tea_fee_total = ?, stats_balances_json = ?
        WHERE room_code = ? AND version = ?`,
      [revision, centsToAmount(stats.totalTurnover), centsToAmount(stats.teaFeeTotal), balancesJson, room.roomCode, revision],
    );
  } else {
    await connection.execute(
      `INSERT IGNORE INTO mahjong_room_revisions
        (room_code, version, stats_version, stats_total_turnover, stats_tea_fee_total, stats_balances_json)
       VALUES (?, 0, 0, ?, ?, ?)`,
      [room.roomCode, centsToAmount(stats.totalTurnover), centsToAmount(stats.teaFeeTotal), balancesJson],
    );
  }
  return { ...stats, revision };
}

function normalizeName(value, label, maxLength) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new CoreError(`${label}不能为空`);
  if (normalized.length > maxLength) throw new CoreError(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function normalizeOperationId(value) {
  const operationId = value === undefined || value === null ? '' : String(value).trim();
  if (operationId.length > 80) throw new CoreError('操作号不能超过 80 个字符');
  return operationId || null;
}

async function generateDefaultUserName(connection) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const suffix = String(1000 + Math.floor(Math.random() * 9000));
    const name = `微信用户${suffix}`;
    const [rows] = await connection.execute('SELECT id FROM users WHERE name = ? LIMIT 1', [name]);
    if (!rows[0]) return name;
  }
  throw new CoreError('暂时无法生成可用的默认昵称，请重试', 'CONFLICT');
}

function isDuplicate(error) {
  return error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062);
}

async function inTransaction(connection, work) {
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

async function findUserByOpenId(connection, openId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT u.id, u.name, u.device_id AS deviceId, u.created_at AS createdAt
       FROM user_identities AS identity_row
       INNER JOIN users AS u ON u.id = identity_row.user_id
      WHERE identity_row.provider = 'wechat_mini'
        AND identity_row.provider_subject = ?
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [openId],
  );
  return rows[0] || null;
}

function toUser(row) {
  return { id: row.id, name: row.name, createdAt: asIso(row.createdAt) };
}

function toRoom(row, rule) {
  return {
    id: row.id,
    roomCode: row.roomCode,
    name: row.name,
    mode: row.mode === 'free' ? 'free' : 'seated',
    creatorUserId: row.creatorUserId || null,
    createdAt: asIso(row.createdAt),
    dissolvedAt: asIso(row.dissolvedAt),
    teaFeeRule: rule,
  };
}

async function authenticate(connection, openId) {
  const existing = await findUserByOpenId(connection, openId);
  if (existing) return { user: toUser(existing), isNewUser: false };

  try {
    return await inTransaction(connection, async () => {
      const concurrent = await findUserByOpenId(connection, openId, true);
      if (concurrent) return { user: toUser(concurrent), isNewUser: false };

      const deviceId = `wx:${openId}`;
      const [deviceRows] = await connection.execute(
        'SELECT id, name, device_id AS deviceId, created_at AS createdAt FROM users WHERE device_id = ? LIMIT 1 FOR UPDATE',
        [deviceId],
      );
      let user = deviceRows[0];
      const isNewUser = !user;
      if (!user) {
        const id = randomUUID();
        const defaultName = await generateDefaultUserName(connection);
        await connection.execute(
          'INSERT INTO users (id, name, device_id) VALUES (?, ?, ?)',
          [id, defaultName, deviceId],
        );
        const [createdRows] = await connection.execute(
          'SELECT id, name, device_id AS deviceId, created_at AS createdAt FROM users WHERE id = ? LIMIT 1',
          [id],
        );
        user = createdRows[0];
      }
      await connection.execute(
        'INSERT INTO user_identities (id, user_id, provider, provider_subject) VALUES (?, ?, ?, ?)',
        [randomUUID(), user.id, 'wechat_mini', openId],
      );
      return { user: toUser(user), isNewUser };
    });
  } catch (error) {
    if (isDuplicate(error)) {
      const concurrent = await findUserByOpenId(connection, openId);
      if (concurrent) return { user: toUser(concurrent), isNewUser: false };
    }
    throw error;
  }
}

async function requireUser(connection, openId) {
  const login = await authenticate(connection, openId);
  return login.user;
}

async function updateMahjongUserProfile(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const name = normalizeName(input.name, '昵称', 30);
  const [existing] = await connection.execute('SELECT id FROM users WHERE name = ? AND id <> ? LIMIT 1', [name, user.id]);
  if (existing[0]) throw new CoreError('昵称已被使用，请换一个', 'CONFLICT');
  try {
    await connection.execute('UPDATE users SET name = ? WHERE id = ?', [name, user.id]);
  } catch (error) {
    if (isDuplicate(error)) throw new CoreError('昵称已被使用，请换一个', 'CONFLICT');
    throw error;
  }
  return { user: { ...user, name } };
}

async function getRoomRow(connection, roomCode, lock = false) {
  const [rows] = await connection.execute(
    `SELECT id, room_code AS roomCode, name, mode, creator_user_id AS creatorUserId,
            created_at AS createdAt, dissolved_at AS dissolvedAt
       FROM mahjong_rooms WHERE room_code = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [roomCode],
  );
  if (!rows[0]) throw new CoreError('房间不存在', 'NOT_FOUND');
  return rows[0];
}

async function ensureActiveRoom(connection, roomCode, lock = false) {
  const room = await getRoomRow(connection, roomCode, lock);
  if (room.dissolvedAt) throw new CoreError('房间已解散');
  return room;
}

async function assertActiveMember(connection, roomId, userId, lock = false) {
  if (await hasActiveMember(connection, roomId, userId, lock)) return;
  throw new CoreError('请先加入房间', 'FORBIDDEN');
}

async function hasActiveMember(connection, roomId, userId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT id FROM mahjong_room_members
      WHERE room_id = ? AND user_id = ? AND left_at IS NULL
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [roomId, userId],
  );
  return Boolean(rows[0]);
}

async function assertRoomViewer(connection, room, userId) {
  if (!room.dissolvedAt) {
    const active = await hasActiveMember(connection, room.id, userId);
    if (!rules.canViewRoom({ isArchived: false, isActiveMember: active, wasMember: active })) {
      throw new CoreError('请先加入房间', 'FORBIDDEN');
    }
    return;
  }
  const [rows] = await connection.execute(
    'SELECT id FROM mahjong_room_members WHERE room_id = ? AND user_id = ? LIMIT 1',
    [room.id, userId],
  );
  if (!rules.canViewRoom({ isArchived: true, isActiveMember: false, wasMember: Boolean(rows[0]) })) {
    throw new CoreError('请先加入房间', 'FORBIDDEN');
  }
}

async function bumpRevision(connection, roomCode) {
  await connection.execute(
    `INSERT INTO mahjong_room_revisions (room_code, version)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE version = version + 1, updated_at = CURRENT_TIMESTAMP(6)`,
    [roomCode],
  );
}

async function maybeDissolveIdleRoom(connection, room) {
  if (room.dissolvedAt) return room;
  const [rows] = await connection.execute(
    'SELECT MAX(created_at) AS lastTransactionAt FROM mahjong_transactions WHERE room_id = ?',
    [room.id],
  );
  const lastActivity = rows[0]?.lastTransactionAt || room.createdAt;
  if (Date.now() - new Date(lastActivity).getTime() <= DISSOLVE_IDLE_MS) return room;
  await connection.execute(
    'UPDATE mahjong_rooms SET dissolved_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND dissolved_at IS NULL',
    [room.id],
  );
  await bumpRevision(connection, room.roomCode);
  return getRoomRow(connection, room.roomCode);
}

async function archiveIdleRoomsForUser(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT DISTINCT r.id, r.room_code AS roomCode, r.created_at AS createdAt, r.dissolved_at AS dissolvedAt
       FROM mahjong_room_members AS m INNER JOIN mahjong_rooms AS r ON r.id = m.room_id
      WHERE m.user_id = ? AND r.dissolved_at IS NULL`,
    [userId],
  );
  for (const room of rows) await maybeDissolveIdleRoom(connection, room);
}

async function assertRoomFreshForAction(connection, roomCode) {
  const room = await maybeDissolveIdleRoom(connection, await getRoomRow(connection, roomCode));
  if (room.dissolvedAt) throw new CoreError('房间已归档，不能继续操作');
  return room;
}

async function getTeaFeeRule(connection, roomId) {
  const [rows] = await connection.execute(
    `SELECT enabled, mode, threshold_amount AS thresholdAmount, rate_percent AS ratePercent, fee_amount AS feeAmount,
            version, updated_at AS updatedAt
       FROM mahjong_tea_fee_rules WHERE room_id = ? LIMIT 1`,
    [roomId],
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_TEA_FEE_RULE };
  return {
    enabled: Boolean(row.enabled),
    mode: normalizeTeaFeeMode(row.mode),
    thresholdAmount: String(row.thresholdAmount),
    ratePercent: Number(row.ratePercent),
    feeAmount: String(row.feeAmount),
    version: Number(row.version),
    updatedAt: asIso(row.updatedAt),
  };
}

async function getMahjongRoomDetail(connection, input) {
  const roomCode = normalizeRoomCode(input.roomCode);
  let room = await getRoomRow(connection, roomCode);
  room = await maybeDissolveIdleRoom(connection, room);
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 50) : TRANSACTION_LIMIT;
  const offset = Number.isInteger(input.offset) ? Math.max(input.offset, 0) : 0;
  const stats = await getRoomStats(connection, room);

  const [rule, seatResult, memberResult, transactionResult, countResult] = await Promise.all([
    getTeaFeeRule(connection, room.id),
    connection.execute(
      `SELECT s.seat_index AS seatIndex, s.user_id AS userId, u.name AS userName, s.joined_at AS joinedAt
         FROM mahjong_seats AS s INNER JOIN users AS u ON u.id = s.user_id
        WHERE s.room_id = ? ORDER BY s.seat_index`, [room.id],
    ),
     connection.execute(
       `SELECT m.user_id AS userId, u.name AS userName, m.joined_at AS joinedAt, m.left_at AS leftAt
          FROM mahjong_room_members AS m INNER JOIN users AS u ON u.id = m.user_id
         WHERE m.room_id = ?${room.dissolvedAt ? '' : ' AND m.left_at IS NULL'} ORDER BY m.joined_at`, [room.id],
     ),
    connection.execute(
      `SELECT t.id, t.payer_id AS payerId, payer.name AS payerName, t.payee_type AS payeeType,
              t.payee_id AS payeeId, payee.name AS payeeName, t.amount, t.remark,
              t.reversal_of AS reversalOf, t.created_at AS createdAt, t.transaction_type AS transactionType,
              t.auto_fee_rule_version AS autoFeeRuleVersion, t.auto_fee_mode AS autoFeeMode,
              t.auto_fee_threshold_amount AS autoFeeThresholdAmount, t.auto_fee_rate_percent AS autoFeeRatePercent,
              t.auto_fee_amount AS autoFeeAmount
         FROM mahjong_transactions AS t
         INNER JOIN users AS payer ON payer.id = t.payer_id
         LEFT JOIN users AS payee ON payee.id = t.payee_id
        WHERE t.room_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`, [room.id, limit, offset],
    ),
    connection.execute('SELECT COUNT(*) AS total FROM mahjong_transactions WHERE room_id = ?', [room.id]),
  ]);

  const seats = seatResult[0].map((row) => ({
    seatIndex: Number(row.seatIndex), userId: row.userId, userName: row.userName, joinedAt: asIso(row.joinedAt),
  }));
   const members = memberResult[0].map((row) => ({
     userId: row.userId, userName: row.userName, joinedAt: asIso(row.joinedAt), leftAt: asIso(row.leftAt),
  }));
  const transactions = transactionResult[0].map((row) => {
    const fee = calculateAutomaticTeaFeeCents(row);
    return {
      id: row.id, payerId: row.payerId, payerName: row.payerName, payeeType: row.payeeType,
      payeeId: row.payeeId || null, payeeName: row.payeeName || null, amount: String(row.amount),
      remark: row.remark || null, reversalOf: row.reversalOf || null, createdAt: asIso(row.createdAt),
      transactionType: row.transactionType === 'auto_tea_fee_adjustment' ? 'auto_tea_fee_adjustment' : 'manual',
      autoFeeRuleVersion: row.autoFeeRuleVersion === null ? null : Number(row.autoFeeRuleVersion),
      teaFeeAmount: fee > 0 ? centsToAmount(fee) : null,
    };
  });

  const balanceMap = stats.balanceMap;
  const names = new Map();
  for (const seat of seats) names.set(seat.userId, seat.userName);
  for (const member of members) names.set(member.userId, member.userName);
  for (const transaction of transactions) {
    names.set(transaction.payerId, transaction.payerName);
    if (transaction.payeeId && transaction.payeeName) names.set(transaction.payeeId, transaction.payeeName);
  }
  const unnamedIds = [...balanceMap.keys()].filter((userId) => !names.has(userId));
  if (unnamedIds.length) {
    const placeholders = unnamedIds.map(() => '?').join(', ');
    const [nameRows] = await connection.execute(`SELECT id, name FROM users WHERE id IN (${placeholders})`, unnamedIds);
    for (const row of nameRows) names.set(row.id, row.name);
  }
  const balances = [...balanceMap.entries()].map(([userId, cents]) => ({
    userId, userName: names.get(userId) || '', balance: centsToAmount(cents),
  })).sort((left, right) => Math.abs(Number(right.balance)) - Math.abs(Number(left.balance)));
  const total = Number(countResult[0][0]?.total || 0);
  const nextOffset = offset + transactions.length;
  return {
    room: toRoom(room, rule), roomRevision: stats.revision, seats, members, transactions,
    transactionPage: { total, hasMore: nextOffset < total, nextOffset },
    stats: {
      balances, teaFeeTotal: centsToAmount(stats.teaFeeTotal), totalTurnover: centsToAmount(stats.totalTurnover),
      balanceCheck: balances.reduce((totalBalance, row) => totalBalance + amountToCents(row.balance), 0) + stats.teaFeeTotal === 0 ? 'balanced' : 'unbalanced',
    },
  };
}

async function createMahjongRoom(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const name = normalizeName(input.name || '麻将牌局', '房间名称', 50);
  const operationId = normalizeOperationId(input.operationId);
  if (operationId) {
    const [existingRows] = await connection.execute(
      `SELECT id, room_code AS roomCode, name, mode, creator_user_id AS creatorUserId,
              created_at AS createdAt, dissolved_at AS dissolvedAt
         FROM mahjong_rooms WHERE create_operation_id = ? LIMIT 1`, [operationId],
    );
    if (existingRows[0]) {
      if (existingRows[0].creatorUserId !== user.id) throw new CoreError('操作号已被使用', 'CONFLICT');
      return { user, room: toRoom(existingRows[0], { ...DEFAULT_TEA_FEE_RULE }) };
    }
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const room = await inTransaction(connection, async () => {
        const id = randomUUID();
        const roomCode = generateRoomCode();
        await connection.execute(
          `INSERT INTO mahjong_rooms (id, room_code, name, mode, creator_user_id, create_operation_id)
           VALUES (?, ?, ?, 'free', ?, ?)`, [id, roomCode, name, user.id, operationId],
        );
        await connection.execute(
          'INSERT INTO mahjong_room_members (id, room_id, user_id) VALUES (?, ?, ?)',
          [randomUUID(), id, user.id],
        );
        await bumpRevision(connection, roomCode);
        return getRoomRow(connection, roomCode);
      });
      return { user, room: toRoom(room, { ...DEFAULT_TEA_FEE_RULE }) };
    } catch (error) {
      if (isDuplicate(error) && operationId) {
        const [existingRows] = await connection.execute(
          `SELECT id, room_code AS roomCode, name, mode, creator_user_id AS creatorUserId,
                  created_at AS createdAt, dissolved_at AS dissolvedAt
             FROM mahjong_rooms WHERE create_operation_id = ? LIMIT 1`, [operationId],
        );
        if (existingRows[0]) {
          if (existingRows[0].creatorUserId !== user.id) throw new CoreError('操作号已被使用', 'CONFLICT');
          return { user, room: toRoom(existingRows[0], { ...DEFAULT_TEA_FEE_RULE }) };
        }
      }
      if (isDuplicate(error)) continue;
      throw error;
    }
  }
  throw new CoreError('生成唯一房间码失败，请重试', 'CONFLICT');
}

async function joinMahjongRoom(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    const [members] = await connection.execute(
      'SELECT id, left_at AS leftAt FROM mahjong_room_members WHERE room_id = ? AND user_id = ? LIMIT 1 FOR UPDATE',
      [room.id, user.id],
    );
    if (!members[0]) {
      await connection.execute('INSERT INTO mahjong_room_members (id, room_id, user_id) VALUES (?, ?, ?)', [randomUUID(), room.id, user.id]);
      await bumpRevision(connection, roomCode);
    } else if (members[0].leftAt) {
      await connection.execute('UPDATE mahjong_room_members SET joined_at = CURRENT_TIMESTAMP(6), left_at = NULL WHERE id = ?', [members[0].id]);
      await bumpRevision(connection, roomCode);
    }
  });
  return getMahjongRoomDetail(connection, input);
}

async function sitDown(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  const seatIndex = Number(input.seatIndex);
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > 3) throw new CoreError('座位号必须在 0-3 之间');
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    await assertActiveMember(connection, room.id, user.id, true);
    const [taken] = await connection.execute('SELECT id FROM mahjong_seats WHERE room_id = ? AND seat_index = ? LIMIT 1 FOR UPDATE', [room.id, seatIndex]);
    const [mine] = await connection.execute('SELECT id, seat_index AS seatIndex FROM mahjong_seats WHERE room_id = ? AND user_id = ? LIMIT 1 FOR UPDATE', [room.id, user.id]);
    if (mine[0]?.seatIndex === seatIndex) return;
    if (taken[0]) throw new CoreError('该座位刚刚被其他玩家占用', 'CONFLICT');
    if (mine[0]) await connection.execute('UPDATE mahjong_seats SET seat_index = ? WHERE id = ?', [seatIndex, mine[0].id]);
    else await connection.execute('INSERT INTO mahjong_seats (id, room_id, seat_index, user_id) VALUES (?, ?, ?, ?)', [randomUUID(), room.id, seatIndex, user.id]);
    await bumpRevision(connection, roomCode);
  });
  return getMahjongRoomDetail(connection, input);
}

async function leaveSeat(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    await assertActiveMember(connection, room.id, user.id, true);
    await connection.execute('DELETE FROM mahjong_seats WHERE room_id = ? AND user_id = ?', [room.id, user.id]);
    await bumpRevision(connection, roomCode);
  });
  return getMahjongRoomDetail(connection, input);
}

async function leaveMahjongRoom(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    await connection.execute('DELETE FROM mahjong_seats WHERE room_id = ? AND user_id = ?', [room.id, user.id]);
    await connection.execute('UPDATE mahjong_room_members SET left_at = CURRENT_TIMESTAMP(6) WHERE room_id = ? AND user_id = ?', [room.id, user.id]);
    await bumpRevision(connection, roomCode);
  });
  return { left: true };
}

async function updateMode(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  const mode = input.mode;
  if (mode !== 'free' && mode !== 'seated') throw new CoreError('模式无效');
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    if (room.creatorUserId !== user.id) throw new CoreError('只有房主可以切换房间模式', 'FORBIDDEN');
    if (mode === 'free') {
      const [seats] = await connection.execute('SELECT id FROM mahjong_seats WHERE room_id = ? LIMIT 1 FOR UPDATE', [room.id]);
      if (seats[0]) throw new CoreError('有玩家正在座位上，需全部离座后才能切换为普通模式');
    }
    await connection.execute('UPDATE mahjong_rooms SET mode = ? WHERE id = ?', [mode, room.id]);
    await bumpRevision(connection, roomCode);
  });
  return getMahjongRoomDetail(connection, input);
}

async function updateTeaFeeRule(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  const enabled = Boolean(input.enabled);
  const inputMode = String(input.mode || '');
  if (!['percentage', 'threshold', 'per_player', 'shared_total'].includes(inputMode)) throw new CoreError('茶水费模式无效');
  const mode = normalizeTeaFeeMode(inputMode);
  const thresholdCents = amountToCents(input.thresholdAmount ?? 0, '满额金额');
  const ratePercent = Number(input.ratePercent);
  if (!Number.isInteger(ratePercent) || ratePercent < 0 || ratePercent > 100) throw new CoreError('抽成比例必须是 0 到 100 的整数');
  const feeCents = amountToCents(input.feeAmount ?? 0, '抽水金额');
  if (enabled && mode === 'threshold' && thresholdCents <= 0) throw new CoreError('满额金额必须大于 0');
  if (enabled && mode === 'threshold' && feeCents <= 0) throw new CoreError('抽水金额必须大于 0');
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    if (room.creatorUserId !== user.id) throw new CoreError('只有房主可以设置自动茶水费', 'FORBIDDEN');
    const [existing] = await connection.execute('SELECT version FROM mahjong_tea_fee_rules WHERE room_id = ? LIMIT 1 FOR UPDATE', [room.id]);
    const nextVersion = Number(existing[0]?.version || 0) + 1;
    await connection.execute(
      `INSERT INTO mahjong_tea_fee_rules (room_id, enabled, mode, threshold_amount, rate_percent, fee_amount, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), mode = VALUES(mode), threshold_amount = VALUES(threshold_amount),
         rate_percent = VALUES(rate_percent), fee_amount = VALUES(fee_amount), version = VALUES(version), updated_at = CURRENT_TIMESTAMP(6)`,
      [room.id, enabled ? 1 : 0, mode, mode === 'threshold' ? centsToAmount(thresholdCents) : '0.00', mode === 'percentage' ? ratePercent : 0, mode === 'threshold' ? centsToAmount(feeCents) : '0.00', nextVersion],
    );
    await bumpRevision(connection, roomCode);
  });
  return getMahjongRoomDetail(connection, input);
}

async function createTransaction(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  const amountCents = amountToCents(input.amount, '转账金额');
  if (amountCents <= 0) throw new CoreError('转账金额必须大于 0');
  const payeeType = input.payeeType;
  if (payeeType !== 'user' && payeeType !== 'tea_fee') throw new CoreError('收款方类型无效');
  const payeeId = payeeType === 'user' ? String(input.payeeId || '') : null;
  if (payeeType === 'user' && !payeeId) throw new CoreError('用户类型收款方必须指定 payeeId');
  if (payeeId === user.id) throw new CoreError('付款方和收款方不能是同一人');
  const remark = input.remark === undefined || input.remark === null ? null : String(input.remark).trim();
  if (remark && remark.length > 500) throw new CoreError('备注不能超过 500 个字符');
  const operationId = input.operationId === undefined || input.operationId === null ? null : String(input.operationId).trim();
  if (operationId && operationId.length > 80) throw new CoreError('操作号不能超过 80 个字符');

  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    if (operationId) {
      const [previous] = await connection.execute('SELECT room_id AS roomId, payer_id AS payerId FROM mahjong_transactions WHERE operation_id = ? LIMIT 1 FOR UPDATE', [operationId]);
      if (previous[0]) {
        if (previous[0].roomId === room.id && previous[0].payerId === user.id) return;
        throw new CoreError('操作号已被使用', 'CONFLICT');
      }
    }
    await assertActiveMember(connection, room.id, user.id, true);
    const [payerSeats] = await connection.execute('SELECT id FROM mahjong_seats WHERE room_id = ? AND user_id = ? LIMIT 1 FOR UPDATE', [room.id, user.id]);
    if (room.mode !== 'free' && !payerSeats[0]) throw new CoreError('付款方不在当前房间座位上');
    if (payeeType === 'user') {
      await assertActiveMember(connection, room.id, payeeId, true);
      if (room.mode !== 'free') {
        const [payeeSeats] = await connection.execute('SELECT id FROM mahjong_seats WHERE room_id = ? AND user_id = ? LIMIT 1 FOR UPDATE', [room.id, payeeId]);
        if (!payeeSeats[0]) throw new CoreError('收款方不在当前房间座位上');
      }
    }
    const rule = await getTeaFeeRule(connection, room.id);
    await connection.execute(
      `INSERT INTO mahjong_transactions (
        id, room_id, operation_id, transaction_type, auto_fee_rule_version, auto_fee_mode,
        auto_fee_threshold_amount, auto_fee_rate_percent, auto_fee_amount, payer_id, payee_type, payee_id, amount, remark
      ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), room.id, operationId,
        payeeType === 'user' && rule.enabled ? rule.version : null,
        payeeType === 'user' && rule.enabled ? rule.mode : null,
        payeeType === 'user' && rule.enabled ? rule.thresholdAmount : null,
        payeeType === 'user' && rule.enabled && rule.mode === 'percentage' ? rule.ratePercent : null,
        payeeType === 'user' && rule.enabled && rule.mode === 'threshold' ? rule.feeAmount : null,
        user.id, payeeType, payeeId, centsToAmount(amountCents), remark,
      ],
    );
    await bumpRevision(connection, roomCode);
  });
  return getMahjongRoomDetail(connection, input);
}

async function reverseTransaction(connection, openId, input) {
  const user = await requireUser(connection, openId);
  const roomCode = normalizeRoomCode(input.roomCode);
  const transactionId = String(input.transactionId || '').trim();
  if (!transactionId) throw new CoreError('转账记录无效');
  await inTransaction(connection, async () => {
    const room = await ensureActiveRoom(connection, roomCode, true);
    const [origins] = await connection.execute(
      `SELECT id, payer_id AS payerId, payee_type AS payeeType, payee_id AS payeeId,
              amount, remark, reversal_of AS reversalOf
         FROM mahjong_transactions WHERE id = ? AND room_id = ? LIMIT 1 FOR UPDATE`, [transactionId, room.id],
    );
    const origin = origins[0];
    if (!origin) throw new CoreError('转账记录不存在', 'NOT_FOUND');
    if (origin.payerId !== user.id) throw new CoreError('只能冲正自己付款的转账记录', 'FORBIDDEN');
    if (origin.reversalOf) throw new CoreError('不能冲正一笔冲正记录');
    const [reversed] = await connection.execute('SELECT id FROM mahjong_transactions WHERE reversal_of = ? LIMIT 1 FOR UPDATE', [origin.id]);
    if (reversed[0]) throw new CoreError('该记录已被冲正，不能重复冲正');
    const isTea = origin.payeeType === 'tea_fee';
    await connection.execute(
      `INSERT INTO mahjong_transactions (id, room_id, payer_id, payee_type, payee_id, amount, remark, reversal_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), room.id,
        isTea ? origin.payerId : (origin.payeeId || origin.payerId),
        isTea ? 'tea_fee' : 'user',
        isTea ? null : origin.payerId,
        isTea ? centsToAmount(-amountToCents(origin.amount)) : String(origin.amount),
        `【冲正】${origin.remark ? `（${origin.remark}）` : ''}`,
        origin.id,
      ],
    );
    await bumpRevision(connection, roomCode);
  });
  return getMahjongRoomDetail(connection, input);
}

async function dispatchMahjongAction(connection, openId, event) {
  const action = event?.action || 'bootstrap';
  if (action === 'bootstrap') return { ...await authenticate(connection, openId), recent: await loadRecentActivity(connection, openId) };
  if (action === 'login') return authenticate(connection, openId);
  if (action === 'updateMahjongUserProfile') return updateMahjongUserProfile(connection, openId, event);
  if (action === 'createMahjongRoom') return createMahjongRoom(connection, openId, event);
  if (action === 'getMahjongRoom') {
    const user = await requireUser(connection, openId);
    const room = await maybeDissolveIdleRoom(connection, await getRoomRow(connection, normalizeRoomCode(event.roomCode)));
    await assertRoomViewer(connection, room, user.id);
    return getMahjongRoomDetail(connection, event);
  }
  if (action === 'getMahjongRoomRevision') {
    const user = await requireUser(connection, openId);
    const room = await maybeDissolveIdleRoom(connection, await getRoomRow(connection, normalizeRoomCode(event.roomCode)));
    await assertRoomViewer(connection, room, user.id);
    const [rows] = await connection.execute(
      'SELECT version, updated_at AS updatedAt FROM mahjong_room_revisions WHERE room_code = ? LIMIT 1',
      [room.roomCode],
    );
    return {
      roomCode: room.roomCode,
      revision: Number(rows[0]?.version || 0),
      updatedAt: asIso(rows[0]?.updatedAt || room.createdAt),
      dissolvedAt: asIso(room.dissolvedAt),
    };
  }
  const roomGuardedActions = new Set([
    'joinMahjongRoom', 'sitDown', 'leaveSeat', 'leaveMahjongRoom',
    'updateMahjongMode', 'updateTeaFeeRule', 'createMahjongTransaction',
    'reverseMahjongTransaction',
  ]);
  if (roomGuardedActions.has(action)) await assertRoomFreshForAction(connection, normalizeRoomCode(event.roomCode));
  if (action === 'joinMahjongRoom') return joinMahjongRoom(connection, openId, event);
  if (action === 'sitDown') return sitDown(connection, openId, event);
  if (action === 'leaveSeat') return leaveSeat(connection, openId, event);
  if (action === 'leaveMahjongRoom') return leaveMahjongRoom(connection, openId, event);
  if (action === 'updateMahjongMode') return updateMode(connection, openId, event);
  if (action === 'updateTeaFeeRule') return updateTeaFeeRule(connection, openId, event);
  if (action === 'createMahjongTransaction') return createTransaction(connection, openId, event);
  if (action === 'reverseMahjongTransaction') return reverseTransaction(connection, openId, event);
  throw new CoreError('不支持的云函数操作', 'UNSUPPORTED_ACTION');
}

async function loadRecentActivity(connection, openId) {
  const user = await findUserByOpenId(connection, openId);
  if (!user) return { mahjongRooms: [], pokerLedgers: [] };
  await archiveIdleRoomsForUser(connection, user.id);
  const [[mahjongRows], [pokerRows]] = await Promise.all([
    connection.execute(
      `SELECT r.id, r.room_code AS roomCode, r.name, r.mode, r.creator_user_id AS creatorUserId,
              r.created_at AS createdAt, r.dissolved_at AS dissolvedAt
         FROM mahjong_room_members AS member_row INNER JOIN mahjong_rooms AS r ON r.id = member_row.room_id
        WHERE member_row.user_id = ? ORDER BY member_row.joined_at DESC, r.created_at DESC, r.id DESC LIMIT 1`, [user.id],
    ),
    connection.execute(
      `SELECT r.id, r.room_code AS roomCode, r.room_name AS roomName, r.game_type AS gameType,
              r.created_at AS createdAt, r.updated_at AS updatedAt
         FROM poker_ledger_owners AS owner_row INNER JOIN rooms AS r ON r.id = owner_row.room_id
        WHERE owner_row.user_id = ? ORDER BY r.updated_at DESC LIMIT 1`, [user.id],
    ),
  ]);
  return {
    mahjongRooms: mahjongRows.map((row) => ({ ...toRoom(row, undefined), teaFeeRule: undefined })),
    pokerLedgers: pokerRows.map((row) => ({ room: {
      id: row.id, roomCode: row.roomCode, roomName: row.roomName, gameType: row.gameType,
      createdAt: asIso(row.createdAt), updatedAt: asIso(row.updatedAt),
    } })),
  };
}

module.exports = {
  CoreError,
  DEFAULT_TEA_FEE_RULE,
  amountToCents,
  centsToAmount,
  calculateTeaFeeCents,
  calculateThresholdTeaFeeCents,
  calculateRoomStats,
  getRoomStats,
  parseCachedBalances,
  dispatchMahjongAction,
  assertRoomViewer,
  requireUser,
  updateMahjongUserProfile,
  getMahjongRoomDetail,
  archiveIdleRoomsForUser,
  loadRecentActivity,
};
