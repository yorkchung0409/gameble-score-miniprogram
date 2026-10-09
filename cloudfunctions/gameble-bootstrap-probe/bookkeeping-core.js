'use strict';

const { CoreError, requireUser } = require('./mahjong-core');
const { parseBook, backupObject, summarize } = require('./bookkeeping-model');
const CHUNK_SIZE = 12000;

async function transferBookkeeping(connection, userId, event) {
  if (!Number.isSafeInteger(event.version) || event.version < 0) throw new CoreError('记录版本无效');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(event.uploadId || '')) throw new CoreError('上传编号无效');
  await connection.beginTransaction();
  try {
    await connection.execute("INSERT INTO personal_bookkeeping (user_id, version, records_json) VALUES (?, 0, '[]') ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)", [userId]);
    const [[row]] = await connection.execute('SELECT version, records_json AS recordsJson FROM personal_bookkeeping WHERE user_id = ? FOR UPDATE', [userId]);
    let raw;
    try { raw = JSON.parse(row.recordsJson); } catch { throw new CoreError('云端记账数据格式异常', 'DATA_ERROR'); }
    const currentVersion = Number(row.version);
    const mutationSignature = event.mode === 'mutate' ? JSON.stringify([event.operation, event.record, event.recordId, event.catalogDelta]) : '';
    if (event.mode === 'mutate' && currentVersion === event.version + 1 && raw._lastMutation?.id === event.uploadId && raw._lastMutation.signature === mutationSignature) {
      await connection.commit(); return { formatVersion: 3, version: currentVersion };
    }
    if (event.mode === 'commit' && currentVersion === event.version + 1 && raw._lastUpload === event.uploadId) {
      await connection.commit(); return { formatVersion: 3, version: currentVersion };
    }
    if (currentVersion !== event.version) throw new CoreError('另一台设备已更新记录，请刷新后重试', 'VERSION_CONFLICT');
    const current = backupObject(raw);
    let nextVersion = currentVersion;
    if (event.mode === 'mutate') {
      if (event.operation === 'upsert') {
        let record;
        try { record = backupObject({ records: [event.record] }).records[0]; } catch (error) { throw new CoreError(error.message); }
        const index = current.records.findIndex(r => r.id === record.id);
        if (index < 0) current.records.unshift(record); else current.records[index] = record;
      } else if (event.operation === 'delete') {
        if (typeof event.recordId !== 'string' || !current.records.some(r => r.id === event.recordId)) throw new CoreError('记录不存在，请刷新后重试');
        current.records = current.records.filter(r => r.id !== event.recordId);
      } else throw new CoreError('不支持的单笔操作');
      try {
        for (const key of ['blinds', 'tags']) {
          const delta = event.catalogDelta?.[key] || { add: [], remove: [] };
          if (!Array.isArray(delta.add) || !Array.isArray(delta.remove)) throw new Error('选项变更格式无效');
          current[key] = [...new Set([...current[key].filter(value => !delta.remove.includes(value)), ...delta.add])];
        }
        Object.assign(current, backupObject(current));
      } catch (error) { throw new CoreError(error.message); }
      if (Buffer.byteLength(JSON.stringify(current), 'utf8') > 800000) throw new CoreError('记录内容超过 800KB');
      current._lastMutation = { id: event.uploadId, signature: mutationSignature };
      nextVersion++;
    } else if (event.mode === 'begin') {
      if (!Number.isInteger(event.parts) || event.parts < 1 || event.parts > 100) throw new CoreError('文件分段数量无效');
      const pending = raw._pending;
      current._pending = pending?.id === event.uploadId && pending.parts === event.parts && pending.expires > Date.now()
        ? pending : { id: event.uploadId, parts: event.parts, chunks: [], expires: Date.now() + 3600000 };
    } else {
      const pending = raw._pending;
      if (!pending || pending.id !== event.uploadId || pending.expires < Date.now()) throw new CoreError('上传已过期或被另一次上传替换，请重新确认导入', 'UPLOAD_EXPIRED');
      if (event.mode === 'chunk') {
        if (!Number.isInteger(event.index) || event.index < 0 || event.index >= pending.parts || typeof event.chunk !== 'string' || event.chunk.length > CHUNK_SIZE) throw new CoreError('上传分段无效');
        pending.chunks[event.index] = event.chunk;
        if (Buffer.byteLength(pending.chunks.join(''), 'utf8') > 800000) throw new CoreError('记录内容超过 800KB，请整理后重试');
        current._pending = pending;
      } else if (event.mode === 'commit') {
        if (pending.chunks.length !== pending.parts || Array.from({ length: pending.parts }, (_, i) => pending.chunks[i]).some(chunk => typeof chunk !== 'string')) throw new CoreError('文件尚未传完，请重新确认导入');
        let incoming;
        try { incoming = backupObject(JSON.parse(pending.chunks.join(''))); } catch (error) { throw new CoreError(error.message); }
        if (Buffer.byteLength(JSON.stringify(incoming), 'utf8') > 800000) throw new CoreError('记录内容超过 800KB');
        Object.assign(current, incoming, { _lastUpload: event.uploadId });
        nextVersion++;
      } else throw new CoreError('不支持的上传步骤');
    }
    await connection.execute('UPDATE personal_bookkeeping SET records_json = ?, version = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE user_id = ?', [JSON.stringify(current), nextVersion, userId]);
    await connection.commit();
    return { formatVersion: 3, version: nextVersion };
  } catch (error) { await connection.rollback(); throw error; }
}

async function readBookkeeping(connection, userId, knownVersion) {
  const conditional = Number.isSafeInteger(knownVersion) && knownVersion >= 0;
  const [rows] = await connection.execute(
    conditional
      ? 'SELECT version, IF(version = ?, NULL, records_json) AS recordsJson FROM personal_bookkeeping WHERE user_id = ?'
      : 'SELECT version, records_json AS recordsJson FROM personal_bookkeeping WHERE user_id = ?',
    conditional ? [knownVersion, userId] : [userId],
  );
  const version = rows.length ? Number(rows[0].version) : 0;
  if (conditional && knownVersion === version) return { version, notModified: true };
  if (!rows.length) return { version: 0, formatVersion: 2, records: [], blinds: [], tags: [] };
  try { return { version: Number(rows[0].version), formatVersion: 2, ...parseBook(JSON.parse(rows[0].recordsJson)) }; }
  catch { throw new CoreError('云端记账数据格式异常，请联系管理员', 'DATA_ERROR'); }
}

async function getBookkeepingSummary(connection, userId) {
  const { records } = await readBookkeeping(connection, userId);
  const stats = summarize(records);
  return { netProfit: (stats.profitCents / 100).toFixed(2), gameCount: stats.games, hours: stats.hours };
}

async function dispatchBookkeepingAction(connection, openId, event) {
  if (!['getBookkeeping', 'saveBookkeeping'].includes(event.action)) throw new CoreError('不支持的记账操作', 'UNSUPPORTED_ACTION');
  // Only the platform-provided OpenID decides whose records are accessed.
  const user = await requireUser(connection, openId);
  if (event.action === 'getBookkeeping') {
    let knownVersion;
    if (event.ifVersion !== undefined) {
      knownVersion = Number(event.ifVersion);
      if (String(event.transport) !== '3' || !/^\d+$/.test(String(event.ifVersion)) || !Number.isSafeInteger(knownVersion) || Number(event.offset || 0) !== 0 || event.version !== undefined) throw new CoreError('版本检查参数无效');
    }
    const result = await readBookkeeping(connection, user.id, knownVersion);
    if (result.notModified) return { formatVersion: 3, version: result.version, notModified: true };
    if (String(event.transport) !== '3') return result;
    if (event.version !== undefined && Number(event.version) !== result.version) throw new CoreError('记录在读取期间已更新，请重试', 'VERSION_CONFLICT');
    const json = JSON.stringify(backupObject({ records: result.records, blinds: result.blinds, tags: result.tags }));
    const offset = Number(event.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > json.length) throw new CoreError('读取位置无效');
    return { formatVersion: 3, version: result.version, total: json.length, chunk: json.slice(offset, offset + CHUNK_SIZE) };
  }
  if (event.formatVersion === 3) return transferBookkeeping(connection, user.id, event);
  if (event.formatVersion !== 2) throw new CoreError('请更新小程序后再保存个人记账', 'UPGRADE_REQUIRED');
  let book;
  try { book = parseBook({ records: event.records, blinds: event.blinds, tags: event.tags }); } catch (error) { throw new CoreError(error.message); }
  if (!Number.isSafeInteger(event.version) || event.version < 0) throw new CoreError('记录版本无效');
  const json = JSON.stringify(backupObject(book));
  if (Buffer.byteLength(json, 'utf8') > 800000) throw new CoreError('记录内容过多，请先导出备份并整理历史记录');
  await connection.beginTransaction();
  try {
    await connection.execute("INSERT INTO personal_bookkeeping (user_id, version, records_json) VALUES (?, 0, '[]') ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)", [user.id]);
    const [[current]] = await connection.execute('SELECT version, records_json AS recordsJson FROM personal_bookkeeping WHERE user_id = ? FOR UPDATE', [user.id]);
    // A retry after a lost response must not duplicate or overwrite a later edit.
    if (Number(current.version) !== event.version) {
      if (Number(current.version) === event.version + 1 && current.recordsJson === json) {
        await connection.commit();
        return { version: Number(current.version), formatVersion: 2, ...book };
      }
      throw new CoreError('另一台设备已更新记录，请刷新后重试', 'VERSION_CONFLICT');
    }
    const version = event.version + 1;
    await connection.execute('UPDATE personal_bookkeeping SET records_json = ?, version = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE user_id = ?', [json, version, user.id]);
    await connection.commit();
    return { version, formatVersion: 2, ...book };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

module.exports = { readBookkeeping, getBookkeepingSummary, dispatchBookkeepingAction };
