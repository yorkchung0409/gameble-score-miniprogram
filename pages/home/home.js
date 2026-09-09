const app = getApp();

function createOperationId(prefix) {
  if (typeof app.createOperationId === 'function') return app.createOperationId(prefix);
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createMahjongPreviewDetail(room, user) {
  const userName = user.name || '微信用户';
  const roomDetail = Object.assign({}, room, {
    mode: room.mode || 'free',
    creatorUserId: room.creatorUserId || user.id,
    dissolvedAt: room.dissolvedAt || null,
  });
  return {
    room: roomDetail,
    seats: [],
    members: [{
      userId: user.id,
      userName,
      joinedAt: room.createdAt || new Date().toISOString(),
    }],
    transactions: [],
    stats: {
      balances: [{ userId: user.id, userName, balance: '0' }],
      teaFeeTotal: '0',
      totalTurnover: '0',
      balanceCheck: 'balanced',
    },
  };
}

Page({
  data: {
    guideOpen: false,
    user: null,
    showMahjongJoin: false,
    showPokerCreate: false,
    mahjongJoinCode: '',
    creatingMahjong: false,
    joiningMahjong: false,
    pokerLedgerName: '我的账本',
    creatingPoker: false,
    serviceStarting: true,
    serviceStartError: '',
    recentLoaded: false,
    recentMahjongRoom: null,
    recentPokerLedger: null,
  },

  onShareAppMessage() {
    return app.getDefaultShareMessage();
  },

  onShareTimeline() {
    return app.getDefaultTimelineShare();
  },

  async onLoad() {
    this.functionBootstrapLoaded = await this.loadBootstrapActivity();
    const user = await this.loadMahjongUser();
    // Do not immediately replace a successful function response with a Cloud
    // Hosting read. That request would wake a scaled-to-zero container again.
    if (user && !this.functionBootstrapLoaded) await this.loadRecentActivity();
  },

  async onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 0 });
    this.setTabBarVisible(
      !this.data.showMahjongJoin && !this.data.showPokerCreate,
    );
    if (!app.globalData.user) {
      this.functionBootstrapLoaded = await this.loadBootstrapActivity();
      const user = await this.loadMahjongUser();
      if (user && !this.functionBootstrapLoaded) await this.loadRecentActivity();
      return;
    }
    this.setData({ user: app.globalData.user });
    if (!this.functionBootstrapLoaded && !this.data.recentLoaded) {
      await this.loadRecentActivity();
    }
  },

  async onPullDownRefresh() {
    await this.loadMahjongUser();
    await this.loadRecentActivity({ force: true });
    wx.stopPullDownRefresh();
  },

  async loadMahjongUser() {
    if (!app.globalData.user) {
      this.setData({ serviceStarting: true, serviceStartError: '' });
    }
    try {
      const result = await app.login();
      this.setData({ user: result.user, serviceStarting: false, serviceStartError: '' });
      return result.user;
    } catch (error) {
      this.setData({
        serviceStarting: false,
        serviceStartError: error.message || '服务暂时无法连接',
      });
      return null;
    }
  },

  async loadRecentActivity(options = {}) {
    if (this.recentLoading || !app.globalData.user) return;
    this.recentLoading = true;
    try {
      const result = await app.getRecentActivity(options);
      this.setData({
        recentLoaded: true,
        recentPokerLedger: result.pokerLedgers?.[0] || null,
        recentMahjongRoom: result.mahjongRooms?.[0] || null,
      });
    } catch {
      this.setData({ recentLoaded: true });
    } finally {
      this.recentLoading = false;
    }
  },

  async loadBootstrapActivity() {
    try {
      const result = await app.getBootstrapRecentActivity();
      if (!result) return false;
      this.setData({
        recentLoaded: true,
        recentPokerLedger: result.pokerLedgers[0] || null,
        recentMahjongRoom: result.mahjongRooms[0] || null,
      });
      return true;
    } catch {
      // The Cloud Hosting refresh remains the authoritative fallback.
      return false;
    }
  },

  async ensureMahjongUser() {
    if (app.globalData.user) return app.globalData.user;
    const user = await this.loadMahjongUser();
    if (!user) {
      wx.showToast({ title: '暂时无法登录，请检查云函数服务或网络', icon: 'none' });
    }
    return user;
  },

  retryService() {
    this.loadMahjongUser().then(async (user) => {
      if (!user) return;
      this.functionBootstrapLoaded = await this.loadBootstrapActivity();
      if (!this.functionBootstrapLoaded) this.loadRecentActivity({ force: true });
    });
  },

  openGuide() {
    this.setData({ guideOpen: true });
    this.setTabBarVisible(false);
  },

  closeGuide() {
    this.setData({ guideOpen: false });
    this.setTabBarVisible(true);
  },

  preventGuideClose() {},

  setTabBarVisible(visible) {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ hidden: !visible });
  },

  async openMahjongCreate() {
    await this.createMahjongRoom();
  },

  openMahjongJoin() {
    this.setData({ showMahjongJoin: true });
    this.setTabBarVisible(false);
  },

  closeMahjongJoin() {
    this.setData({ showMahjongJoin: false });
    this.setTabBarVisible(true);
  },

  openPokerCreate() {
    this.setData({ showPokerCreate: true });
    this.setTabBarVisible(false);
  },

  closePokerCreate() {
    this.setData({ showPokerCreate: false });
    this.setTabBarVisible(true);
  },

  openRecentHistory(event) {
    const type = event.currentTarget.dataset.type;
    if (type === 'poker' || type === 'mahjong') {
      wx.navigateTo({ url: `/pages/history/history?type=${type}` });
    }
  },

  openRecentPoker(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/poker/poker?roomCode=${roomCode}` });
  },

  openRecentMahjong(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
  },

  preventSheetClose() {},

  onMahjongJoinCodeInput(event) {
    this.setData({ mahjongJoinCode: event.detail.value });
  },

  onPokerLedgerNameInput(event) {
    this.setData({ pokerLedgerName: event.detail.value });
  },

  async createMahjongRoom() {
    if (this.data.creatingMahjong) return;
    this.setData({ creatingMahjong: true });
    const operationId = this.mahjongCreateOperationId || (this.mahjongCreateOperationId = createOperationId('mahjong_room'));
    let navigationRequested = false;
    try {
      const user = await this.ensureMahjongUser();
      if (!user) return;
      let result;
      try {
        result = await app.mahjongCore('createMahjongRoom', { name: '麻将牌局', operationId });
      } catch (coreError) {
        if (coreError.coreBusiness) throw coreError;
        result = await app.request({
          path: '/api/mahjong/rooms',
          method: 'POST',
            data: { name: '麻将牌局', creatorUserId: user.id, operationId },
        });
      }
      const roomCode = result.room.roomCode;
      app.globalData.pendingMahjongRooms = app.globalData.pendingMahjongRooms || {};
      app.globalData.pendingMahjongRooms[roomCode] = createMahjongPreviewDetail(result.room, user);
      navigationRequested = true;
      wx.navigateTo({
        url: `/pages/room/room?roomCode=${roomCode}`,
        fail: () => {
          delete app.globalData.pendingMahjongRooms[roomCode];
          this.setData({
            recentLoaded: true,
            recentMahjongRoom: result.room,
          });
          wx.showToast({ title: '暂时无法打开房间', icon: 'none' });
        },
        success: () => { this.mahjongCreateOperationId = ''; },
        // Keep the button's loading state through the page transition. The
        // request is already done here, but the next page has not opened yet.
        complete: () => this.setData({ creatingMahjong: false }),
      });
    } catch (error) {
      navigationRequested = false;
      wx.showToast({ title: error.message || '创建房间失败', icon: 'none' });
    } finally {
      if (!navigationRequested) this.setData({ creatingMahjong: false });
    }
  },

  joinMahjongRoom() {
    if (this.data.joiningMahjong) return;
    const roomCode = this.data.mahjongJoinCode.trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: '请输入房间码', icon: 'none' });
      return;
    }
    this.setData({ joiningMahjong: true });
    this.closeMahjongJoin();
    wx.navigateTo({
      url: `/pages/room/room?roomCode=${roomCode}`,
      success: () => this.setData({ mahjongJoinCode: '' }),
      fail: () => wx.showToast({ title: '暂时无法打开房间', icon: 'none' }),
      complete: () => this.setData({ joiningMahjong: false }),
    });
  },

  async createPokerLedger() {
    if (this.data.creatingPoker) return;
    const roomName = this.data.pokerLedgerName.trim();
    if (!roomName) {
      wx.showToast({ title: '请填写账本名称', icon: 'none' });
      return;
    }

    this.setData({ creatingPoker: true });
    const operationId = this.pokerCreateOperationId || (this.pokerCreateOperationId = createOperationId('poker_ledger'));
    try {
      await app.login();
      const result = await app.request({
        path: '/api/mini/poker/ledgers',
        method: 'POST',
        data: { roomName, operationId },
      });
      this.closePokerCreate();
      wx.navigateTo({
        url: `/pages/poker/poker?roomCode=${result.room.roomCode}`,
        fail: () => {
          this.setData({
            recentLoaded: true,
            recentPokerLedger: { room: result.room },
          });
          wx.showToast({ title: '暂时无法打开账本', icon: 'none' });
        },
        success: () => { this.pokerCreateOperationId = ''; },
      });
    } catch (error) {
      wx.showToast({ title: error.message || '创建账本失败', icon: 'none' });
    } finally {
      this.setData({ creatingPoker: false });
    }
  },
});
