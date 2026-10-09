const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');

test('opponent refresh discards stale pagination and out-of-order refreshes', async () => {
  const requests = [];
  const app = { login: async () => {}, request: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
  const { definition } = loadPage('pages/opponents/opponents.js', app);
  const page = createPage(definition, { hasMore: true });
  page.allOpponents = [{ userId: 'old' }];
  page.serverPagedOpponents = true; page.nextOpponentOffset = 30;
  const oldPage = page.loadMore();
  const refresh = page.loadOpponents();
  await Promise.resolve();
  await page.loadMore();
  assert.equal(requests.length, 2);
  requests[1].resolve({ opponents: [{ userId: 'fresh' }], total: 1, nextOffset: 1, hasMore: false });
  await refresh;
  requests[0].resolve({ opponents: [{ userId: 'stale' }], total: 60, nextOffset: 60, hasMore: true });
  await oldPage;
  assert.equal(page.data.opponents.map(r => r.userId).join(','), 'fresh');
  assert.equal(page.data.total, 1);
  assert.equal(page.nextOpponentOffset, 1);
  assert.equal(page.data.loadingMore, false);
  const first = page.loadOpponents(); await new Promise(resolve => setImmediate(resolve));
  const second = page.loadOpponents(); await new Promise(resolve => setImmediate(resolve));
  requests[3].resolve({ opponents: [{ userId: 'newest' }], total: 1, nextOffset: 1, hasMore: false });
  await second;
  requests[2].reject(new Error('stale error'));
  await first;
  assert.equal(page.data.opponents[0].userId, 'newest');
  assert.equal(page.data.syncWarning, '');
});

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
    mahjongCore: async () => ({ room: { roomCode: 'NEW123' } }),
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
    mahjongCore: () => new Promise((resolve) => { releaseDetail = resolve; }),
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
    mahjongCore(action, data) {
      requestCount += 1;
      sentData = data;
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
    mahjongCore: async () => { requests += 1; return detail; },
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

test('saving a nickname does not fall back to a second request path', async () => {
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

  assert.equal(fallbackCalls, 0);
  assert.equal(page.data.user.name, '微信用户');
});


test('history loads Mahjong even when opened with a retired poker filter', async () => {
  let calls = 0;
  const { definition } = loadPage('pages/history/history.js', {
    login: async () => ({ user: { id: 'u1' } }),
    getPersonalMahjongRooms: async () => {
      calls += 1;
      return { rooms: [{ roomCode: 'M1', myNetProfit: '12', lastActivityAt: '2026-09-28' }], total: 1 };
    },
  });
  const page = createPage(definition);
  page.onLoad({ type: 'poker' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(page.data.mahjongRooms[0].roomCode, 'M1');
  assert.equal(page.data.mahjongTotal, 1);
});

test('stale history responses cannot overwrite the latest request', async () => {
  const pending = [];
  const { definition } = loadPage('pages/history/history.js', {
    login: async () => ({}),
    getPersonalMahjongRooms: () => new Promise((resolve) => pending.push(resolve)),
  });
  const page = createPage(definition);
  const first = page.loadHistory();
  const second = page.loadHistory();
  await new Promise((resolve) => setImmediate(resolve));
  pending[1]({ rooms: [{ roomCode: 'LATEST' }], total: 1 });
  await second;
  pending[0]({ rooms: [{ roomCode: 'STALE' }], total: 1 });
  await first;
  assert.equal(page.data.mahjongRooms[0].roomCode, 'LATEST');
});

test('Mahjong history pagination deduplicates rooms and ignores a page superseded by refresh', async () => {
  const pending = [];
  const { definition } = loadPage('pages/history/history.js', {
    login: async () => ({}),
    getPersonalMahjongRooms: () => new Promise((resolve) => pending.push(resolve)),
  });
  const page = createPage(definition, {
    mahjongRooms: [{ roomCode: 'M1' }], mahjongHasMore: true, mahjongOffset: 1,
  });
  page.historyRequestSeq = 1;
  const more = page.loadMore();
  pending[0]({ rooms: [{ roomCode: 'M1' }, { roomCode: 'M2' }], total: 3, hasMore: true, nextOffset: 2 });
  await more;
  assert.equal(page.data.mahjongRooms.map((room) => room.roomCode).join(','), 'M1,M2');
  const staleMore = page.loadMore();
  const refresh = page.loadHistory();
  await new Promise((resolve) => setImmediate(resolve));
  pending[2]({ rooms: [{ roomCode: 'NEW' }], total: 1, hasMore: false, nextOffset: 1 });
  await refresh;
  pending[1]({ rooms: [{ roomCode: 'OLD' }], total: 3, hasMore: true, nextOffset: 3 });
  await staleMore;
  assert.equal(page.data.mahjongRooms.map((room) => room.roomCode).join(','), 'NEW');
  assert.equal(page.data.mahjongHasMore, false);
});

test('profile uses Mahjong totals even with an old server returning poker profits', () => {
  const { definition } = loadPage('pages/profile/profile.js', {});
  const page = createPage(definition);
  const summary = page.decorateSummary({
    totalNetProfit: '999', poker: { netProfit: '989' },
    mahjong: { netProfit: '10', teaFeeTotal: '2' },
  });
  assert.equal(summary.mahjongNetDisplay, '+10.00');
  assert.equal(summary.totalNetDisplay, '—');
  const ready = page.decorateSummary({
    totalNetProfit: '999', poker: { netProfit: '989' },
    bookkeeping: { netProfit: '-3.20', gameCount: 1 },
    mahjong: { netProfit: '10', teaFeeTotal: '2' },
  });
  assert.equal(ready.totalNetDisplay, '+6.80');
  assert.equal(ready.bookkeepingNetDisplay, '-3.20');
  const wxml = fs.readFileSync(path.join(root, 'pages/profile/profile.wxml'), 'utf8');
  assert.match(wxml, /summary.mahjongNetDisplay/);
  assert.doesNotMatch(wxml, /summary.poker|扑克账本/);
});
