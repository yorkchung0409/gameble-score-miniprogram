const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../bookkeeping-module/utils/bookkeeping-model');
const root = path.resolve(__dirname, '..');
const records = count => Array.from({ length: count }, (_, index) => ({ id: 'r' + index, date: '2026-10-08', minutes: 60, profit: index, note: '' }));
const book = count => JSON.stringify(model.backupObject({ records: records(count), blinds: ['1/2'], tags: ['线上'] }));

function cloudHarness(rows = new Map()) {
  const queries = [];
  class CoreError extends Error { constructor(message, code) { super(message); this.code = code; } }
  const connection = {
    async execute(sql, params) {
      queries.push({ sql, params });
      const conditional = sql.includes('IF(version = ?');
      const row = rows.get(params[conditional ? 1 : 0]);
      return [row ? [{ version: row.version, recordsJson: conditional && row.version === params[0] ? null : row.text }] : []];
    },
  };
  const module = { exports: {} };
  const filename = path.join(root, 'cloudfunctions/gameble-bootstrap-probe/bookkeeping-core.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer,
    require: name => name.includes('mahjong-core') ? { CoreError, requireUser: async (_, openId) => ({ id: openId }) } : model,
  }, { filename });
  return { core: module.exports, connection, queries, rows };
}

function adapterHarness(cloud) {
  const requests = [];
  const app = {
    globalData: { user: { id: 'owner' } },
    async login() { return { user: this.globalData.user }; },
    async request(options) {
      requests.push(options);
      const query = Object.fromEntries(new URL(options.path, 'https://local.invalid').searchParams);
      return cloud.core.dispatchBookkeepingAction(cloud.connection, this.globalData.user.id, { action: 'getBookkeeping', ...query });
    },
  };
  const module = { exports: {} };
  const filename = path.join(root, 'bookkeeping-module/utils/bookkeeping-adapter.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, require: () => model, getApp: () => app }, { filename });
  return { adapter: module.exports, app, requests };
}

test('unchanged cloud reads return only the authenticated user version and omit the book', async () => {
  const cloud = cloudHarness(new Map([['owner', { version: 4, text: 'unused invalid JSON' }]]));
  const result = await cloud.core.dispatchBookkeepingAction(cloud.connection, 'owner', { action: 'getBookkeeping', transport: '3', offset: '0', ifVersion: '4', userId: 'someone-else' });
  assert.equal(result.notModified, true);
  assert.equal(result.version, 4);
  assert.equal(result.chunk, undefined);
  assert.equal(cloud.queries.length, 1);
  assert.deepEqual(Array.from(cloud.queries[0].params), [4, 'owner']);
  const empty = await cloud.core.dispatchBookkeepingAction(cloud.connection, 'new-user', { action: 'getBookkeeping', transport: '3', ifVersion: '0' });
  assert.equal(empty.notModified, true);
  assert.equal(empty.version, 0);
  for (const ifVersion of ['-1', '', 'bad', '9007199254740992']) {
    await assert.rejects(cloud.core.dispatchBookkeepingAction(cloud.connection, 'owner', { action: 'getBookkeeping', transport: '3', ifVersion }), /参数/);
  }
});

test('large books reuse confirmed session data with one check, refresh when changed and force full reads', async () => {
  const cloud = cloudHarness(new Map([['owner', { version: 1, text: book(200) }]]));
  const { adapter, requests } = adapterHarness(cloud);
  const initial = await adapter.load();
  assert.equal(initial.records.length, 200);
  assert.ok(requests.length > 1);
  requests.length = 0;
  initial.records[0].profit = 999; // Page mutations must not mutate the cached book.
  const unchanged = await adapter.load();
  assert.equal(unchanged.notModified, true);
  assert.equal(unchanged.records[0].profit, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /ifVersion=1/);
  cloud.rows.set('owner', { version: 2, text: book(201) });
  requests.length = 0;
  const updated = await adapter.load();
  assert.equal(updated.version, 2);
  assert.equal(updated.records.length, 201);
  assert.ok(requests.length > 1);
  assert.match(requests[0].path, /ifVersion=1/);
  assert.ok(requests.slice(1).every(request => /version=2/.test(request.path) && !/ifVersion=/.test(request.path)));
  requests.length = 0;
  await adapter.load({ force: true });
  assert.ok(requests.length > 1);
  assert.ok(requests.every(request => !/ifVersion=/.test(request.path)));
});

test('session caches stay isolated by user and old cloud code falls back to full reads', async () => {
  const cloud = cloudHarness(new Map([['owner', { version: 1, text: book(3) }], ['other', { version: 1, text: book(1) }]]));
  const { adapter, app, requests } = adapterHarness(cloud);
  await adapter.load();
  app.globalData.user = { id: 'other' };
  requests.length = 0;
  const other = await adapter.load();
  assert.equal(other.records.length, 1);
  assert.ok(requests.every(request => !/ifVersion=/.test(request.path)));
  const currentRequest = app.request.bind(app);
  app.request = options => currentRequest({ ...options, path: options.path.replace(/&ifVersion=\d+/, '') });
  const fallback = await adapter.load();
  assert.equal(fallback.records.length, 1);
  assert.equal(fallback.notModified, undefined);
});

test('another-device edits during a changed book read restart from one consistent revision', async () => {
  const cloud = cloudHarness(new Map([['owner', { version: 1, text: book(200) }]]));
  const { adapter, app } = adapterHarness(cloud);
  await adapter.load();
  cloud.rows.set('owner', { version: 2, text: book(201) });
  const request = app.request.bind(app);
  let interrupted = false;
  app.request = options => {
    if (!interrupted && /&version=2/.test(options.path)) {
      interrupted = true;
      cloud.rows.set('owner', { version: 3, text: book(202) });
    }
    return request(options);
  };
  const latest = await adapter.load();
  assert.equal(interrupted, true);
  assert.equal(latest.version, 3);
  assert.equal(latest.records.length, 202);
  const reused = await adapter.load();
  assert.equal(reused.notModified, true);
  assert.equal(reused.version, 3);
});

test('only confirmed saves update the cache and late version checks cannot undo a save', async () => {
  const cloud = cloudHarness(new Map([['owner', { version: 1, text: book(1) }]]));
  const { adapter, app } = adapterHarness(cloud);
  await adapter.load();
  let finishCheck;
  app.request = options => options.method === 'PUT'
    ? Promise.resolve({ formatVersion: 3, version: 2 })
    : new Promise(resolve => { finishCheck = resolve; });
  const pending = adapter.load();
  await Promise.resolve();
  await adapter.mutate(records(2), 1, { blinds: [], tags: [] }, { operation: 'upsert', id: 'r1' });
  finishCheck({ formatVersion: 3, version: 1, notModified: true });
  const latest = await pending;
  assert.equal(latest.version, 2);
  assert.equal(latest.records.length, 2);
  app.request = async () => { throw Object.assign(new Error('版本冲突'), { code: 'VERSION_CONFLICT', coreBusiness: true }); };
  await assert.rejects(adapter.mutate(records(3), 2, {}, { operation: 'upsert', id: 'r2' }), /版本冲突/);
  app.request = async () => ({ formatVersion: 3, version: 2, notModified: true });
  const retained = await adapter.load();
  assert.equal(retained.records.length, 2);
  assert.equal(retained.version, 2);
});

test('bulk saves and empty books become reusable and inconsistent unchanged responses are rejected', async () => {
  const cloud = cloudHarness(new Map());
  const { adapter, app } = adapterHarness(cloud);
  await adapter.load();
  assert.equal((await adapter.load()).notModified, true);
  app.request = async options => ({ formatVersion: 3, version: options.data?.mode === 'commit' ? 1 : 0 });
  await adapter.save(records(2), 0, { blinds: ['2/4'], tags: [] });
  app.request = async () => ({ formatVersion: 3, version: 1, notModified: true });
  const saved = await adapter.load();
  assert.equal(saved.records.length, 2);
  assert.deepEqual(Array.from(saved.blinds), ['2/4']);
  app.request = async () => ({ formatVersion: 3, version: 99, notModified: true });
  await assert.rejects(adapter.load(), /版本检查异常/);
});
