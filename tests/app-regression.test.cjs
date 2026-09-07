const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.resolve(__dirname, '..', 'app.js');

function loadApp() {
  let definition;
  const calls = [];
  const wx = {
    getStorageSync: () => 'device-test',
    setStorageSync() {},
    cloud: {
      init() {},
      callContainer(options) { calls.push(options); },
    },
  };
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
    App(value) { definition = value; },
    wx,
    console,
    Promise,
    Date,
    Math,
    Number,
    String,
    setTimeout,
    clearTimeout,
  }, { filename: appPath });
  return { app: definition, calls };
}

test('cold-start warmup waits for database readiness', async () => {
  const { app, calls } = loadApp();
  app.onLaunch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/health/ready');
  calls[0].success({ statusCode: 200, data: { status: 'ready' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.globalData.warmed, true);
});

test('concurrent login calls share one cloud request', async () => {
  const { app, calls } = loadApp();
  const first = app.login();
  const second = app.login();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  calls[0].success({
    statusCode: 200,
    data: { user: { id: 'u1', name: '玩家1' }, isNewUser: false },
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.user.id, 'u1');
  assert.equal(secondResult.user.id, 'u1');
  assert.equal(app.globalData.user.id, 'u1');
});

test('concurrent identical reads share one cloud request', async () => {
  const { app, calls } = loadApp();
  const first = app.request({ path: '/api/mini/me/recent' });
  const second = app.request({ path: '/api/mini/me/recent' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  calls[0].success({ statusCode: 200, data: { poker: { ledgers: [] }, mahjong: { rooms: [] } } });
  assert.deepEqual(await first, await second);
});

test('profile dashboard uses one aggregated cloud request', async () => {
  const { app, calls } = loadApp();
  const pending = app.getPersonalDashboard({ historyLimit: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/mini/me/dashboard?historyLimit=1');
  calls[0].success({
    statusCode: 200,
    data: {
      summary: { user: { id: 'u1' } },
      canAccessOperations: true,
      poker: { ledgers: [], total: 0, hasMore: false, nextOffset: 0 },
      mahjong: { rooms: [], total: 0, hasMore: false, nextOffset: 0 },
    },
  });
  const result = await pending;
  assert.equal(result.summary.user.id, 'u1');
  assert.equal(result.canAccessOperations, true);
  assert.equal(result.pokerLedgers.length, 0);
  assert.equal(result.mahjongRooms.length, 0);
});

test('operations entry is conditional on server-authorized dashboard access', () => {
  const profileWxml = fs.readFileSync(path.resolve(__dirname, '..', 'pages/profile/profile.wxml'), 'utf8');
  const profileJs = fs.readFileSync(path.resolve(__dirname, '..', 'pages/profile/profile.js'), 'utf8');
  const operationsWxml = fs.readFileSync(path.resolve(__dirname, '..', 'pages/operations/operations.wxml'), 'utf8');
  assert.match(profileWxml, /wx:if="\{\{canAccessOperations\}\}"[\s\S]*?bindtap="openOperations"/);
  assert.match(profileJs, /openOperations\(\)[\s\S]*?pages\/operations\/operations/);
  assert.match(operationsWxml, /5 分钟操作/);
  assert.match(operationsWxml, /本实例连接/);
});

test('home recent activity uses one aggregated cloud request', async () => {
  const { app, calls } = loadApp();
  const pending = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/mini/me/recent');
  calls[0].success({
    statusCode: 200,
    data: {
      poker: { ledgers: [{ room: { roomCode: 'P1' } }] },
      mahjong: { rooms: [{ roomCode: 'M1' }] },
    },
  });
  const result = await pending;
  assert.equal(result.pokerLedgers[0].room.roomCode, 'P1');
  assert.equal(result.mahjongRooms[0].roomCode, 'M1');
});

test('shell reads use a brief cache and completed writes invalidate it', async () => {
  const { app, calls } = loadApp();
  const first = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  calls[0].success({ statusCode: 200, data: { poker: { ledgers: [] }, mahjong: { rooms: [] } } });
  await first;

  await app.getRecentActivity();
  assert.equal(calls.length, 1);

  const write = app.request({ path: '/api/mahjong/rooms', method: 'POST', data: { name: '测试房间' } });
  await new Promise((resolve) => setImmediate(resolve));
  calls[1].success({ statusCode: 200, data: { room: { roomCode: 'NEW123' } } });
  await write;

  const afterWrite = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  calls[2].success({ statusCode: 200, data: { poker: { ledgers: [] }, mahjong: { rooms: [] } } });
  await afterWrite;
});

test('forced shell refresh bypasses and clears its brief cache', async () => {
  const { app, calls } = loadApp();
  const initial = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  calls[0].success({ statusCode: 200, data: { poker: { ledgers: [] }, mahjong: { rooms: [] } } });
  await initial;

  const forced = app.getRecentActivity({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  calls[1].success({ statusCode: 200, data: { poker: { ledgers: [] }, mahjong: { rooms: [] } } });
  await forced;

  const next = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3);
  calls[2].success({ statusCode: 200, data: { poker: { ledgers: [] }, mahjong: { rooms: [] } } });
  await next;
});

test('home recent poker ledger uses an explicit enter action instead of exposing the room code', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '..', 'pages/home/home.wxml'), 'utf8');
  const pokerRow = wxml.match(/<view wx:if="\{\{recentPokerLedger\}\}"[\s\S]*?<\/view>/)?.[0] || '';
  assert.match(pokerRow, /class="recent-enter">进入<\/text>/);
  assert.doesNotMatch(pokerRow, /class="recent-code">\{\{recentPokerLedger\.room\.roomCode\}\}/);
});

test('home recent Mahjong room uses the Mahjong action color', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '..', 'pages/home/home.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.resolve(__dirname, '..', 'pages/home/home.wxss'), 'utf8');
  const roomRow = wxml.match(/<view wx:if="\{\{recentMahjongRoom\}\}"[\s\S]*?<\/view>/)?.[0] || '';
  assert.match(roomRow, /class="recent-enter mahjong-enter">进入<\/text>/);
  assert.match(wxss, /\.mahjong-enter\s*\{[^}]*color:\s*#347258/);
});

test('bottom navigation is compact and clearly separated from page content', () => {
  const wxss = fs.readFileSync(path.resolve(__dirname, '..', 'custom-tab-bar/index.wxss'), 'utf8');
  assert.match(wxss, /\.tab-bar\s*\{[^}]*height:\s*96rpx/);
  assert.match(wxss, /border-top:\s*2rpx\s+solid\s+#D8E0DA/);
  assert.match(wxss, /box-shadow:/);
});

test('cloud container WebSocket uses the configured environment', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /connectContainer\(\{[\s\S]*config:\s*\{\s*env:\s*CLOUD_ENV\s*\}/);
  assert.match(source, /timeout:\s*CONTAINER_SOCKET_TIMEOUT_MS/);
  assert.match(source, /tcpNoDelay:\s*true/);
});

test('cloud requests forward an explicit timeout when a realtime fallback needs one', async () => {
  const { app, calls } = loadApp();
  const pending = app.request({ path: '/api/mahjong/rooms/ABC123/events?since=0', retry: 0, timeout: 53000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeout, 53000);
  calls[0].success({ statusCode: 200, data: { version: 0 } });
  await pending;
});
