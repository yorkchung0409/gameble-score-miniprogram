const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');

function loadPage(relativePath, app, wxOverrides = {}) {
  const filename = path.join(root, relativePath);
  let definition;
  const wx = {
    showToast() {},
    navigateBack() {},
    nextTick(callback) { callback(); },
    stopPullDownRefresh() {},
    setClipboardData() {},
    showModal() {},
    ...wxOverrides,
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value; },
    getApp() { return app; },
    require: createRequire(filename),
    wx,
    console,
    Promise,
    Map,
    Set,
    Date,
    Math,
    Number,
    String,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  }, { filename });
  return { definition, wx };
}

function createPage(definition, data = {}) {
  const page = {
    ...definition,
    data: { ...JSON.parse(JSON.stringify(definition.data)), ...data },
  };
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch);
    if (callback) callback();
  };
  return page;
}

function roomDetail(mode = 'free') {
  const members = ['u1', 'u2', 'u3', 'u4'].map((userId, index) => ({
    userId,
    userName: `玩家${index + 1}`,
    joinedAt: '2026-09-06T00:00:00.000Z',
  }));
  return {
    room: {
      id: 'room-1',
      roomCode: 'ABC123',
      name: '麻将牌局',
      mode,
      creatorUserId: 'u1',
      createdAt: '2026-09-06T00:00:00.000Z',
      dissolvedAt: null,
    },
    members,
    seats: mode === 'seated'
      ? members.map((member, seatIndex) => ({
        seatIndex,
        userId: member.userId,
        userName: member.userName,
        joinedAt: member.joinedAt,
      }))
      : [],
    transactions: [],
    stats: {
      balances: members.map((member) => ({
        userId: member.userId,
        userName: member.userName,
        balance: '0',
      })),
      teaFeeTotal: '0',
      totalTurnover: '0',
      balanceCheck: 'balanced',
    },
  };
}

test('four-player room never opens a transfer to self and resolves every other target', () => {
  const toasts = [];
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    createOperationId: () => 'op-1',
  };
  const { definition } = loadPage('pages/room/room.js', app, {
    showToast(options) { toasts.push(options.title); },
  });
  const page = createPage(definition);
  page.applyRoomDetail(roomDetail('free'));

  assert.equal(page.data.payeeOptions.map((item) => item.id).join(','), 'u2,u3,u4,tea_fee');
  page.openTransfer({ currentTarget: { dataset: { id: 'u1' } } });
  assert.equal(page.data.transferOpen, false);
  assert.equal(toasts.at(-1), '不能给自己转账');

  for (const userId of ['u2', 'u3', 'u4', 'tea_fee']) {
    page.openTransfer({ currentTarget: { dataset: { id: userId } } });
    assert.equal(page.data.transferOpen, true);
    assert.equal(page.data.payeeOptions[page.data.payeeIndex].id, userId);
    page.setData({ transferOpen: false });
  }
});

test('automatic tea-fee mode keeps manual tea-fee transfers available', () => {
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    createOperationId: () => 'op-tea-fee',
  };
  const { definition } = loadPage('pages/room/room.js', app, {
  });
  const page = createPage(definition);
  const detail = roomDetail('free');
  detail.room.teaFeeRule = {
    enabled: true,
    mode: 'per_player',
    thresholdAmount: '20.00',
    ratePercent: 5,
    version: 1,
    updatedAt: null,
  };
  page.applyRoomDetail(detail);

  assert.equal(page.data.payeeOptions.map((item) => item.id).join(','), 'u2,u3,u4,tea_fee');
  page.openTeaFeeTransfer();
  assert.equal(page.data.transferOpen, true);
  assert.equal(page.data.payeeOptions[page.data.payeeIndex].id, 'tea_fee');
});

test('automatic tea-fee rule summary sits above the transaction list', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/room/room.wxml'), 'utf8');
  const summaryIndex = wxml.indexOf('class="tea-fee-rule-summary"');
  const transactionListIndex = wxml.indexOf('wx:for="{{detail.transactions}}"');
  assert.notEqual(summaryIndex, -1);
  assert.match(
    wxml.slice(Math.max(0, summaryIndex - 80), summaryIndex),
    /wx:if="\{\{teaFeeRule\.enabled\}\}"/,
  );
  assert.ok(summaryIndex < transactionListIndex);
  assert.match(wxml.slice(summaryIndex, transactionListIndex), /满 ¥/);
  assert.match(wxml.slice(summaryIndex, transactionListIndex), /不向上取整/);
  assert.match(wxml.slice(summaryIndex, transactionListIndex), /抽水/);
  assert.match(wxml.slice(summaryIndex, transactionListIndex), /手动茶水费/);
});

test('tea-fee rule editor offers percentage and threshold modes', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/room/room.wxml'), 'utf8');
  assert.match(wxml, /百分比抽水<text>按百分比抽水，不取整<\/text>/);
  assert.match(wxml, /满额抽水<text>满X抽Y<\/text>/);
  assert.match(wxml, /class="threshold-fee-row"/);
  assert.match(wxml, /bindinput="onTeaFeeAmountInput"/);
});

test('a legacy zero-threshold rule does not show 1.00 as the default fee', () => {
  const app = { globalData: { user: { id: 'u1', name: '玩家1' } } };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition, {
    isOwner: true,
    isArchived: false,
    teaFeeRule: {
      enabled: true,
      mode: 'threshold',
      thresholdAmount: '0.00',
      ratePercent: 0,
      feeAmount: '1.00',
    },
  });

  page.openTeaFeeRule();

  assert.equal(page.data.teaFeeRuleDraft.thresholdAmount, '0.00');
  assert.equal(page.data.teaFeeRuleDraft.feeAmount, '0.00');
});

test('tea-fee rate input supports the full 0-100 percent range', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/room/room.wxml'), 'utf8');
  assert.match(wxml, /class="rate-input"[^>]*type="number"/);
  assert.match(wxml, /maxlength="3"[^>]*bindinput="onTeaFeeRateInput"/);
  assert.doesNotMatch(wxml, /<slider\b/);
});

test('automatic tea-fee amount is shown on each transaction row', () => {
  const app = { globalData: { user: { id: 'u1', name: '玩家1' } } };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition);
  const detail = roomDetail('free');
  detail.transactions = [{
    id: 'tx-1', payerId: 'u2', payerName: '玩家2', payeeType: 'user', payeeId: 'u1', payeeName: '玩家1',
    amount: '100.00', teaFeeAmount: '5.00', remark: null, reversalOf: null,
    createdAt: '2026-09-06T00:00:00.000Z', transactionType: 'manual', autoFeeRuleVersion: 1,
  }];
  page.applyRoomDetail(detail);
  assert.equal(page.data.detail.transactions[0].teaFeeDisplay, '5.00');
  const wxml = fs.readFileSync(path.join(root, 'pages/room/room.wxml'), 'utf8');
  assert.match(wxml, /茶水费 ¥\{\{item\.teaFeeDisplay\}\}/);
});

test('creating a Mahjong room keeps its loading state through navigation', async () => {
  let navigation;
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    request: async () => ({ room: { roomCode: 'NEW123' } }),
  };
  const { definition } = loadPage('pages/home/home.js', app, {
    navigateTo(options) { navigation = options; },
  });
  const page = createPage(definition);
  page.ensureMahjongUser = async () => app.globalData.user;

  await page.createMahjongRoom();

  assert.equal(navigation.url, '/pages/room/room?roomCode=NEW123');
  assert.equal(page.data.recentMahjongRoom, null);
  assert.equal(app.globalData.pendingMahjongRooms.NEW123.room.roomCode, 'NEW123');
  assert.equal(app.globalData.pendingMahjongRooms.NEW123.members[0].userId, 'u1');
  assert.equal(page.data.creatingMahjong, true);
  navigation.complete();
  assert.equal(page.data.creatingMahjong, false);
});

test('newly created Mahjong room renders its preview before detail refresh completes', async () => {
  let releaseDetail;
  const preview = roomDetail('free');
  preview.room.roomCode = 'NEW123';
  const app = {
    globalData: {
      user: { id: 'u1', name: '玩家1' },
      pendingMahjongRooms: { NEW123: preview },
    },
    login: async () => ({ user: app.globalData.user }),
    request: () => new Promise((resolve) => { releaseDetail = resolve; }),
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition);

  const loading = page.onLoad({ roomCode: 'NEW123' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(page.data.loading, false);
  assert.equal(page.data.detail.room.roomCode, 'NEW123');
  assert.equal(page.hasJoinedRoom, true);

  releaseDetail(roomDetail('free'));
  await loading;
});

test('room version polling loads full detail only after another player changes the room', async () => {
  const actions = [];
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    mahjongCore: async (action) => {
      actions.push(action);
      return { revision: 8 };
    },
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition, { roomCode: 'ABC123' });
  page.roomRevision = 7;
  let fullLoads = 0;
  page.loadRoom = async () => { fullLoads += 1; page.roomRevision = 8; };

  await page.syncRoomRevision();
  assert.deepEqual(actions, ['getMahjongRoomRevision']);
  assert.equal(fullLoads, 1);

  await page.syncRoomRevision();
  assert.equal(fullLoads, 1);
});

test('a transient background refresh keeps the last successful room visible', async () => {
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    request: async () => { throw new Error('temporary network error'); },
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const existingDetail = roomDetail('free');
  const page = createPage(definition, {
    roomCode: 'ABC123',
    detail: existingDetail,
    loadError: '',
  });
  page.hasJoinedRoom = true;

  await page.performLoadRoom(false);

  assert.equal(page.data.detail, existingDetail);
  assert.equal(page.data.loadError, '');
  assert.match(page.data.syncWarning, /上次成功加载/);
});

test('an initial login failure shows a retry state instead of a read-only room', async () => {
  let roomRequests = 0;
  const app = {
    globalData: { user: null },
    login: async () => { throw new Error('login unavailable'); },
    request: async () => { roomRequests += 1; },
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition);

  await page.onLoad({ roomCode: 'ABC123' });

  assert.equal(roomRequests, 0);
  assert.equal(page.data.detail, null);
  assert.equal(page.data.loadError, 'login unavailable');
});

test('an already reversed transaction no longer offers another reversal', () => {
  const app = { globalData: { user: { id: 'u1', name: '玩家1' } } };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition);
  const detail = roomDetail('free');
  detail.transactions = [
    {
      id: 'tx-original',
      payerId: 'u1',
      payerName: '玩家1',
      payeeType: 'user',
      payeeId: 'u2',
      payeeName: '玩家2',
      amount: '10.00',
      remark: null,
      reversalOf: null,
      createdAt: '2026-09-06T00:00:00.000Z',
    },
    {
      id: 'tx-reversal',
      payerId: 'u2',
      payerName: '玩家2',
      payeeType: 'user',
      payeeId: 'u1',
      payeeName: '玩家1',
      amount: '10.00',
      remark: '冲正',
      reversalOf: 'tx-original',
      createdAt: '2026-09-06T00:01:00.000Z',
    },
  ];

  page.applyRoomDetail(detail);

  assert.equal(page.data.detail.transactions[0].canReverse, false);
  assert.equal(page.data.detail.transactions[1].canReverse, false);
});

test('mahjong transaction pages are requested and merged without duplicates', async () => {
  let requestPath = '';
  const nextDetail = roomDetail('free');
  nextDetail.transactions = [{
    id: 'tx-2',
    payerId: 'u2',
    payerName: '玩家2',
    payeeType: 'user',
    payeeId: 'u1',
    payeeName: '玩家1',
    amount: '8.00',
    remark: null,
    reversalOf: null,
    createdAt: '2026-09-06T00:01:00.000Z',
  }];
  nextDetail.transactionPage = { total: 2, hasMore: false, nextOffset: 2 };
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    request: async (options) => {
      requestPath = options.path;
      return nextDetail;
    },
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition, { roomCode: 'ABC123' });
  const firstDetail = roomDetail('free');
  firstDetail.transactions = [{
    id: 'tx-1',
    payerId: 'u1',
    payerName: '玩家1',
    payeeType: 'user',
    payeeId: 'u2',
    payeeName: '玩家2',
    amount: '10.00',
    remark: null,
    reversalOf: null,
    createdAt: '2026-09-06T00:00:00.000Z',
  }];
  firstDetail.transactionPage = { total: 2, hasMore: true, nextOffset: 1 };
  page.applyRoomDetail(firstDetail);

  await page.loadMoreTransactions();

  assert.equal(requestPath, '/api/mahjong/rooms/ABC123?transactionLimit=30&transactionOffset=1');
  assert.equal(page.data.detail.transactions.map((item) => item.id).join(','), 'tx-1,tx-2');
  assert.equal(page.data.transactionsHasMore, false);
});

test('rapid transfer taps issue one write and include a stable operation id', async () => {
  let requestCount = 0;
  let sentData;
  let releaseRequest;
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    createOperationId: () => 'mahjong_transfer_test',
    request(options) {
      requestCount += 1;
      sentData = options.data;
      return new Promise((resolve) => { releaseRequest = resolve; });
    },
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition, {
    roomCode: 'ABC123',
    payeeOptions: [{ id: 'u2', name: '玩家2', type: 'user' }],
    payeeIndex: 0,
    amount: '12.50',
    remark: '',
  });
  page.transferOperationId = 'mahjong_transfer_test';
  page.applyRoomDetail = () => {};

  const first = page.submitTransfer();
  const second = page.submitTransfer();
  assert.equal(requestCount, 1);
  assert.equal(sentData.operationId, 'mahjong_transfer_test');
  releaseRequest(roomDetail('free'));
  await Promise.all([first, second]);
});

test('seat changes apply the mutation response without an extra room request', async () => {
  const detail = roomDetail('seated');
  let requests = 0;
  const app = {
    globalData: { user: { id: 'u1', name: '玩家1' } },
    request: async () => { requests += 1; return detail; },
  };
  const { definition } = loadPage('pages/room/room.js', app);
  const page = createPage(definition, { roomCode: 'ABC123' });
  let applied = 0;
  page.applyRoomDetail = (value) => {
    assert.equal(value, detail);
    applied += 1;
  };
  page.loadRoom = () => { throw new Error('unexpected extra load'); };

  await page.sitDown({ currentTarget: { dataset: { index: 2 } } });
  assert.equal(requests, 1);
  assert.equal(applied, 1);
});

test('four-player poker save is multi-select and ignores rapid duplicate taps', async () => {
  let requestCount = 0;
  let requestData;
  let releaseRequest;
  const app = {
    createOperationId: () => 'poker_game_test',
    request(options) {
      requestCount += 1;
      requestData = options.data;
      return new Promise((resolve) => { releaseRequest = resolve; });
    },
  };
  const { definition } = loadPage('pages/poker/poker.js', app);
  const page = createPage(definition, {
    roomCode: 'POKER1',
    gameDate: '2026-09-06',
    gameRows: ['p1', 'p2', 'p3', 'p4'].map((playerId, index) => ({
      playerId,
      playerName: `玩家${index + 1}`,
      buyIn: '100',
      balance: index < 2 ? '150' : '50',
    })),
  });
  page.gameOperationId = 'poker_game_test';
  page.closeGameEditor = () => {};
  page.loadRoom = async () => {};

  const first = page.saveGame();
  const second = page.saveGame();
  assert.equal(requestCount, 1);
  assert.equal(requestData.players.length, 4);
  assert.equal(requestData.operationId, 'poker_game_test');
  releaseRequest({});
  await Promise.all([first, second]);
});

test('filtered history loads only the requested game type', async () => {
  let pokerCalls = 0;
  let mahjongCalls = 0;
  const app = {
    login: async () => ({ user: { id: 'u1' } }),
    getPersonalPokerLedgers: async () => {
      pokerCalls += 1;
      return { ledgers: [], hasMore: false, nextOffset: 0 };
    },
    getPersonalMahjongRooms: async () => {
      mahjongCalls += 1;
      return { rooms: [], hasMore: false, nextOffset: 0 };
    },
  };
  const { definition } = loadPage('pages/history/history.js', app);
  const page = createPage(definition, { activeType: 'poker' });
  await page.loadHistory();
  assert.equal(pokerCalls, 1);
  assert.equal(mahjongCalls, 0);
});

test('switching a filtered history page loads the previously omitted type', async () => {
  let pokerCalls = 0;
  let mahjongCalls = 0;
  const app = {
    login: async () => ({ user: { id: 'u1' } }),
    getPersonalPokerLedgers: async () => {
      pokerCalls += 1;
      return { ledgers: [], total: 0, hasMore: false, nextOffset: 0 };
    },
    getPersonalMahjongRooms: async () => {
      mahjongCalls += 1;
      return { rooms: [], total: 0, hasMore: false, nextOffset: 0 };
    },
  };
  const { definition } = loadPage('pages/history/history.js', app);
  const page = createPage(definition, { activeType: 'poker' });
  await page.loadHistory();
  await page.switchType({ currentTarget: { dataset: { type: 'mahjong' } } });

  assert.equal(pokerCalls, 1);
  assert.equal(mahjongCalls, 1);
  assert.equal(page.data.mahjongLoaded, true);
});

test('stale history responses cannot overwrite the latest request', async () => {
  const pokerPending = [];
  const mahjongPending = [];
  const app = {
    login: async () => ({ user: { id: 'u1' } }),
    getPersonalPokerLedgers: () => new Promise((resolve) => pokerPending.push(resolve)),
    getPersonalMahjongRooms: () => new Promise((resolve) => mahjongPending.push(resolve)),
  };
  const { definition } = loadPage('pages/history/history.js', app);
  const page = createPage(definition, { activeType: 'all' });
  const first = page.loadHistory();
  const second = page.loadHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pokerPending.length, 2);
  assert.equal(mahjongPending.length, 2);
  pokerPending[1]({
    ledgers: [{ room: { roomCode: 'LATEST', roomName: '最新' }, myNetProfit: '2' }],
    total: 1,
    hasMore: false,
    nextOffset: 1,
  });
  mahjongPending[1]({ rooms: [], total: 0, hasMore: false, nextOffset: 0 });
  pokerPending[0]({
    ledgers: [{ room: { roomCode: 'STALE', roomName: '旧响应' }, myNetProfit: '1' }],
    total: 1,
    hasMore: false,
    nextOffset: 1,
  });
  mahjongPending[0]({ rooms: [], total: 0, hasMore: false, nextOffset: 0 });
  await Promise.all([first, second]);
  assert.equal(page.data.pokerLedgers[0].room.roomCode, 'LATEST');
});

test('history tabs contain only Mahjong on the left and poker on the right', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/history/history.wxml'), 'utf8');
  const segmentedStart = wxml.indexOf('<view class="segmented">');
  const segmentedEnd = wxml.indexOf('<block', segmentedStart);
  const segmented = wxml.slice(segmentedStart, segmentedEnd);
  assert.equal(segmented.indexOf('麻将房') < segmented.indexOf('扑克账本'), true);
  assert.doesNotMatch(segmented, />全部</);
  assert.doesNotMatch(wxml, /activeType == 'all'/);
});

test('a transient profile refresh keeps the last successful dashboard visible', async () => {
  const app = {
    login: async () => ({ user: { id: 'u1' } }),
    getPersonalDashboard: async () => { throw new Error('temporary network error'); },
  };
  const { definition } = loadPage('pages/profile/profile.js', app);
  const summary = { totalNetDisplay: '0.00' };
  const page = createPage(definition, { summary, loadError: '' });

  await page.loadProfile();

  assert.equal(page.data.summary, summary);
  assert.equal(page.data.loadError, '');
  assert.match(page.data.syncWarning, /上次成功加载/);
});

test('saving a nickname uses the Cloud Function before Cloud Hosting', async () => {
  const calls = [];
  const app = {
    globalData: { user: { id: 'u1', name: '微信用户' } },
    mahjongCore: async (action, data) => {
      calls.push({ action, data });
      return { user: { id: 'u1', name: data.name } };
    },
    request: async () => { throw new Error('Cloud Hosting fallback should not run'); },
  };
  const { definition } = loadPage('pages/profile/profile.js', app);
  const page = createPage(definition, {
    user: app.globalData.user,
    nickname: '新昵称',
    needsNickname: true,
  });

  await page.saveProfile();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'updateMahjongUserProfile');
  assert.equal(calls[0].data.name, '新昵称');
  assert.equal(page.data.user.name, '新昵称');
  assert.equal(page.data.needsNickname, false);
});

test('saving a nickname falls back when an older Cloud Function lacks the action', async () => {
  let fallbackCalls = 0;
  const app = {
    globalData: { user: { id: 'u1', name: '微信用户' } },
    mahjongCore: async () => {
      const error = new Error('不支持的云函数操作');
      error.coreBusiness = true;
      error.code = 'BAD_REQUEST';
      throw error;
    },
    request: async () => {
      fallbackCalls += 1;
      return { user: { id: 'u1', name: '新昵称' } };
    },
  };
  const { definition } = loadPage('pages/profile/profile.js', app);
  const page = createPage(definition, {
    user: app.globalData.user,
    nickname: '新昵称',
    needsNickname: true,
  });

  await page.saveProfile();

  assert.equal(fallbackCalls, 1);
  assert.equal(page.data.user.name, '新昵称');
});

test('poker settings are saved with one atomic request', async () => {
  let requestCount = 0;
  let requestOptions;
  const app = {
    request: async (options) => {
      requestCount += 1;
      requestOptions = options;
      return {};
    },
  };
  const { definition } = loadPage('pages/poker/poker.js', app);
  const page = createPage(definition, {
    roomCode: 'POKER1',
    roomNameInput: '周末账本',
    selfPlayerOptions: [{ id: 'p1', name: '玩家1' }],
    selfPlayerIndex: 0,
  });
  page.applyDetail = () => {};

  await page.saveRoomName();

  assert.equal(requestCount, 1);
  assert.equal(requestOptions.path, '/api/mini/poker/ledgers/POKER1/settings?gameLimit=20&gameOffset=0');
  assert.equal(requestOptions.data.roomName, '周末账本');
  assert.equal(requestOptions.data.selfPlayerId, 'p1');
});

test('poker game pages are requested and merged without duplicates', async () => {
  let requestPath = '';
  const app = {
    request: async (options) => {
      requestPath = options.path;
      return {
        games: [{ id: 'g2' }],
        gamePage: { total: 2, hasMore: false, nextOffset: 2 },
      };
    },
  };
  const { definition } = loadPage('pages/poker/poker.js', app);
  const page = createPage(definition, {
    roomCode: 'POKER1',
    detail: { gamePage: { total: 2, hasMore: true, nextOffset: 1 } },
    gamesHasMore: true,
  });
  page.rawGames = [{ id: 'g1' }];
  page.nextGameOffset = 1;
  let merged;
  page.applyDetail = (detail) => { merged = detail.games; };

  await page.loadMoreGames();

  assert.equal(requestPath, '/api/mini/poker/ledgers/POKER1?gameLimit=20&gameOffset=1');
  assert.equal(merged.map((game) => game.id).join(','), 'g1,g2');
});
