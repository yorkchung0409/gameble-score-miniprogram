const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.resolve(__dirname, '..', 'app.js');

function loadApp() {
  let definition;
  const calls = [];
  const functionCalls = [];
  const wx = {
    getStorageSync: () => 'device-test',
    setStorageSync() {},
    cloud: {
      init() {},
      callContainer(options) { calls.push(options); },
      callFunction(options) {
        functionCalls.push(options);
        const action = options.data?.action;
        const payload = action === 'getPersonalDashboard'
          ? { summary: { user: { id: 'u1' } }, canAccessOperations: true, poker: { ledgers: [], total: 0, hasMore: false, nextOffset: 0 }, mahjong: { rooms: [], total: 0, hasMore: false, nextOffset: 0 } }
          : action === 'getPersonalRecentActivity'
            ? { poker: { ledgers: [{ room: { roomCode: 'P1' } }] }, mahjong: { rooms: [{ roomCode: 'M1' }] } }
            : { user: { id: 'u1', name: '玩家1' }, recent: { mahjongRooms: [], pokerLedgers: [] } };
        return Promise.resolve({
          result: {
            ok: true,
            coreVersion: 2,
            ...payload,
            metrics: { serverElapsedMs: 12 },
          },
        });
      },
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
  return { app: definition, calls, functionCalls };
}

test('bootstrap probe calls the separate CloudBase environment without replacing Cloud Hosting', async () => {
  const { app, functionCalls } = loadApp();
  const result = await app.probeBootstrap();
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].name, 'gameble-bootstrap-probe');
  assert.equal(functionCalls[0].config.env, 'cloudbase-d8guua73779173a0c');
  assert.equal(result.ok, true);
  assert.equal(result.serverElapsedMs, 12);
  assert.equal(app.globalData.startupMetrics.cloudFunction.ok, true);
});

test('bootstrap probe maps its lightweight result into the home recent-activity shape', async () => {
  const { app } = loadApp();
  const result = await app.getBootstrapRecentActivity();
  assert.equal(result.mahjongRooms.length, 0);
  assert.equal(result.pokerLedgers.length, 0);
});

test('function-first launch does not wake Cloud Hosting from the home page', async () => {
  const { app, calls } = loadApp();
  app.onLaunch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('Mahjong core actions record their own function timing', async () => {
  const { app } = loadApp();
  await app.mahjongCore('createMahjongRoom', { name: '麻将牌局' });
  const metric = app.globalData.startupMetrics.mahjongActions.createMahjongRoom;
  assert.equal(metric.ok, true);
  assert.equal(metric.serverElapsedMs, 12);
  assert.ok(Number.isFinite(metric.totalElapsedMs));
});

test('login reuses the Cloud Function bootstrap identity before Cloud Hosting is available', async () => {
  const { app, calls, functionCalls } = loadApp();
  app.onLaunch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(functionCalls.length, 1);
  assert.equal((await app.login()).user.id, 'u1');
  assert.equal(calls.length, 0);
  assert.equal(app.globalData.startupMetrics.login.ok, true);
  assert.equal(app.globalData.startupMetrics.login.source, 'cloud_function');
});

test('a successful bootstrap stores the trusted user so home does not make a second function login call', async () => {
  const { app, functionCalls } = loadApp();
  await app.probeBootstrap();
  assert.equal(app.globalData.user.id, 'u1');
  await app.login();
  assert.equal(functionCalls.length, 1);
});

test('login no longer has a Cloud Hosting fallback', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.doesNotMatch(source, /callContainer\(/);
  assert.match(source, /callCoreFunction\(functionActionForRequest/);
});

test('home makes scaled-to-zero startup visible and blocks premature room actions', () => {
  const homeWxml = fs.readFileSync(path.resolve(__dirname, '..', 'pages/home/home.wxml'), 'utf8');
  const homeJs = fs.readFileSync(path.resolve(__dirname, '..', 'pages/home/home.js'), 'utf8');
  assert.match(homeWxml, /wx:if="\{\{serviceStarting\}\}"/);
  assert.match(homeWxml, /disabled="\{\{creatingMahjong \|\| serviceStarting\}\}"/);
  assert.match(homeWxml, /bindtap="retryService"/);
  assert.match(homeJs, /retryService\(\)/);
});

test('concurrent login calls share one Cloud Function request', async () => {
  const { app, calls, functionCalls } = loadApp();
  const first = app.login();
  const second = app.login();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(functionCalls.length, 1);
  assert.equal(calls.length, 0);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.user.id, 'u1');
  assert.equal(secondResult.user.id, 'u1');
  assert.equal(app.globalData.user.id, 'u1');
});

test('concurrent identical reads share one Cloud Function request', async () => {
  const { app, functionCalls } = loadApp();
  const first = app.request({ path: '/api/mini/me/recent' });
  const second = app.request({ path: '/api/mini/me/recent' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(functionCalls.length, 1);
  assert.deepEqual(await first, await second);
});

test('profile dashboard uses one aggregated Cloud Function request', async () => {
  const { app, functionCalls } = loadApp();
  const pending = app.getPersonalDashboard({ historyLimit: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].data.action, 'getPersonalDashboard');
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
  assert.match(operationsWxml, /云托管不参与日常同步/);
});

test('home recent activity uses one aggregated Cloud Function request', async () => {
  const { app, functionCalls } = loadApp();
  const pending = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(functionCalls.length, 1);
  assert.equal(functionCalls[0].data.action, 'getPersonalRecentActivity');
  const result = await pending;
  assert.equal(result.pokerLedgers[0].room.roomCode, 'P1');
  assert.equal(result.mahjongRooms[0].roomCode, 'M1');
});

test('home uses CloudBase recent activity without waking Cloud Hosting after a successful bootstrap', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'pages/home/home.js'), 'utf8');
  assert.match(source, /this\.functionBootstrapLoaded = await this\.loadBootstrapActivity\(\);[\s\S]*?this\.loadMahjongUser\(\)/);
  assert.match(source, /if \(user && !this\.functionBootstrapLoaded\) await this\.loadRecentActivity\(\);/);
  assert.match(source, /if \(!this\.functionBootstrapLoaded && !this\.data\.recentLoaded\)/);
  assert.match(source, /app\.getBootstrapRecentActivity\(\)/);
});

test('shell reads use a brief cache and completed writes invalidate it', async () => {
  const { app, functionCalls } = loadApp();
  const first = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  await first;

  await app.getRecentActivity();
  assert.equal(functionCalls.length, 1);

  await app.request({ path: '/api/mahjong/rooms', method: 'POST', data: { name: '测试房间' } });

  await app.getRecentActivity();
  assert.equal(functionCalls.length, 3);
});

test('forced shell refresh bypasses and clears its brief cache', async () => {
  const { app, functionCalls } = loadApp();
  const initial = app.getRecentActivity();
  await new Promise((resolve) => setImmediate(resolve));
  await initial;

  const forced = app.getRecentActivity({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(functionCalls.length, 2);
  await forced;

  await app.getRecentActivity();
  assert.equal(functionCalls.length, 3);
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

test('all request routes are mapped to the Cloud Function', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /function functionActionForRequest/);
  assert.doesNotMatch(source, /callContainer\(/);
  assert.doesNotMatch(source, /connectContainer\(/);
});

test('an active Mahjong room uses lightweight revision checks without a permanent push connection', () => {
  const roomSource = fs.readFileSync(path.resolve(__dirname, '..', 'pages/room/room.js'), 'utf8');
  assert.match(roomSource, /const FUNCTION_SYNC_INTERVAL_MS = 15 \* 1000;/);
  assert.match(roomSource, /startFunctionSync\(\)/);
  assert.match(roomSource, /setInterval\([\s\S]*?this\.syncRoomRevision\(\)[\s\S]*?FUNCTION_SYNC_INTERVAL_MS/);
  assert.match(roomSource, /getMahjongRoomRevision/);
  assert.doesNotMatch(roomSource, /\.watch\(/);
  assert.doesNotMatch(roomSource, /wx\.cloud\.database/);
});

test('poker mutation routes resolve to Cloud Function actions', async () => {
  const { app, functionCalls } = loadApp();
  await app.request({ path: '/api/mini/poker/ledgers/ABC123/games', method: 'POST', data: { gameDate: '2026-09-08', players: [] } });
  assert.equal(functionCalls[0].data.action, 'createPokerGame');
});
