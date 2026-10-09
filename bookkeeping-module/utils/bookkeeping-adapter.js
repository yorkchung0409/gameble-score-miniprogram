const model = require('./bookkeeping-model');
const CHUNK_SIZE = 12000;
let cachedBook = null;

function cacheOwner(app, login) {
  const user = login?.user || app.globalData?.user;
  const id = user?.id;
  if (typeof id === 'string' && id.length > 0 || Number.isSafeInteger(id)) return String(id);
  return '';
}

function rememberBook(owner, book, version) {
  // Keep only confirmed data, scoped to this WeChat user and this app session.
  if (owner && (cachedBook?.owner !== owner || version >= cachedBook.version)) {
    cachedBook = { owner, version, text: JSON.stringify(model.backupObject(book)) };
  }
  return { ...model.parseBook(book), version };
}

function checkTransport(result) {
  if (result.formatVersion !== 3) throw new Error('请先上传新版云函数，再使用个人记账');
}
async function writeWithRetry(app, data) {
  const send = () => app.request({ path: '/api/mini/bookkeeping', method: 'PUT', data });
  try { return await send(); }
  catch (error) {
    if (error.code === 'UPGRADE_REQUIRED') throw new Error('请先上传新版云函数，再使用个人记账');
    const cloudCallFailed = typeof error.code === 'number' && error.code < 0 && /^cloud\.callFunction:fail/.test(error.errMsg || error.message || '');
    // These writes are idempotent. Reuse the operation ID even if the first
    // call committed but its response was lost. Never retry business conflicts.
    if (error.coreBusiness || (error.code && error.code !== 'INTERNAL' && !cloudCallFailed)) throw error;
    return send();
  }
}

module.exports = {
  async mutate(records, version, catalog, mutation, previousCatalog = {}) {
    const app = getApp(); const login = await app.login();
    const owner = cacheOwner(app, login);
    const book = model.backupObject({ records, blinds: catalog.blinds, tags: catalog.tags });
    const catalogDelta = {};
    for (const key of ['blinds', 'tags']) {
      const before = previousCatalog[key] || [], after = book[key];
      catalogDelta[key] = { add: after.filter(v => !before.includes(v)), remove: before.filter(v => !after.includes(v)) };
    }
    const data = { formatVersion: 3, mode: 'mutate', uploadId: model.newId(), version, operation: mutation.operation, catalogDelta };
    if (mutation.operation === 'upsert') {
      data.record = book.records.find(r => r.id === mutation.id);
      if (!data.record) throw new Error('待保存的记录不存在');
    } else data.recordId = mutation.id;
    // Unusually large dictionary edits still use the bounded bulk transfer.
    if (JSON.stringify(data).length > CHUNK_SIZE) return module.exports.save(records, version, catalog);
    const result = await writeWithRetry(app, data);
    checkTransport(result);
    if (result.version !== version + 1) throw new Error('保存版本异常，请重新加载确认结果');
    return rememberBook(owner, book, result.version);
  },
  async load(options = {}) {
    const app = getApp();
    const login = await app.login();
    const owner = cacheOwner(app, login);
    const cached = options.force !== true && owner && cachedBook?.owner === owner ? cachedBook : null;
    // Pin all parts to one revision; never combine data from two devices' edits.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let text = '', version, total;
        do {
          const condition = version === undefined && cached ? '&ifVersion=' + cached.version : '';
          const result = await app.request({ path: `/api/mini/bookkeeping?transport=3&offset=${text.length}${version === undefined ? '' : '&version=' + version}${condition}` });
          checkTransport(result);
          if (result.notModified === true) {
            if (!cached || version !== undefined || result.version !== cached.version) throw new Error('云端版本检查异常，请重试');
            // A save can finish while this check is in flight. Prefer its
            // confirmed cache so a late check cannot roll the local view back.
            const confirmed = cachedBook?.owner === owner && cachedBook.version > cached.version ? cachedBook : cached;
            return { ...model.parseBook(confirmed.text), version: confirmed.version, notModified: true };
          }
          if (!Number.isSafeInteger(result.version) || !Number.isInteger(result.total) || result.total < 1 || result.total > 800000 || typeof result.chunk !== 'string' || !result.chunk.length || result.chunk.length > CHUNK_SIZE) throw new Error('云端分段数据异常，请重试');
          if (version !== undefined && (version !== result.version || total !== result.total)) throw Object.assign(new Error('记录已更新'), { code: 'VERSION_CONFLICT' });
          version = result.version; total = result.total; text += result.chunk;
          if (text.length > total) throw new Error('云端分段长度异常');
        } while (text.length < total);
        return rememberBook(owner, model.parseBook(text), version);
      } catch (error) { if (error.code !== 'VERSION_CONFLICT' || attempt === 1) throw error; }
    }
  },
  async save(records, version, catalog = {}) {
    const app = getApp();
    const login = await app.login();
    const owner = cacheOwner(app, login);
    const book = model.backupObject({ records, blinds: catalog.blinds, tags: catalog.tags });
    const text = JSON.stringify(book), uploadId = model.newId();
    const send = async payload => {
      const data = { ...payload, uploadId, version, formatVersion: 3 };
      const result = await writeWithRetry(app, data);
      checkTransport(result); return result;
    };
    await send({ mode: 'begin', parts: Math.ceil(text.length / CHUNK_SIZE) });
    for (let offset = 0; offset < text.length; offset += CHUNK_SIZE) await send({ mode: 'chunk', index: offset / CHUNK_SIZE, chunk: text.slice(offset, offset + CHUNK_SIZE) });
    const result = await send({ mode: 'commit' });
    if (result.version !== version + 1) throw new Error('保存版本异常，请重新加载确认结果');
    return rememberBook(owner, book, result.version);
  },
  export(records, catalog = {}) { return JSON.stringify(model.backupObject({ records, blinds: catalog.blinds, tags: catalog.tags }), null, 2); },
};
