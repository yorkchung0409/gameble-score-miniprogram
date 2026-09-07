const app = getApp();

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
    recentLoaded: false,
    recentMahjongRoom: null,
    recentPokerLedger: null,
  },

  async onLoad() {
    const user = await this.loadMahjongUser();
    if (user) await this.loadRecentActivity();
  },

  async onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 0 });
    this.setTabBarVisible(
      !this.data.showMahjongJoin && !this.data.showPokerCreate,
    );
    if (!app.globalData.user) {
      const user = await this.loadMahjongUser();
      if (user) await this.loadRecentActivity();
      return;
    }
    this.setData({ user: app.globalData.user });
    await this.loadRecentActivity();
  },

  async onPullDownRefresh() {
    await this.loadMahjongUser();
    await this.loadRecentActivity();
    wx.stopPullDownRefresh();
  },

  async loadMahjongUser() {
    try {
      const result = await app.login();
      this.setData({ user: result.user });
      return result.user;
    } catch {
      return null;
    }
  },

  async loadRecentActivity() {
    if (this.recentLoading || !app.globalData.user) return;
    this.recentLoading = true;
    try {
      const result = await app.getRecentActivity();
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

  async ensureMahjongUser() {
    if (app.globalData.user) return app.globalData.user;
    const user = await this.loadMahjongUser();
    if (!user) {
      wx.showToast({ title: '暂时无法登录，请检查云托管服务', icon: 'none' });
    }
    return user;
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
    try {
      const user = await this.ensureMahjongUser();
      if (!user) return;
      const result = await app.request({
        path: '/api/mahjong/rooms',
        method: 'POST',
        data: {
          name: '麻将牌局',
          creatorUserId: user.id,
        },
      });
      const roomCode = result.room.roomCode;
      app.globalData.pendingMahjongRooms = app.globalData.pendingMahjongRooms || {};
      app.globalData.pendingMahjongRooms[roomCode] = createMahjongPreviewDetail(result.room, user);
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
      });
    } catch (error) {
      wx.showToast({ title: error.message || '创建房间失败', icon: 'none' });
    } finally {
      this.setData({ creatingMahjong: false });
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
    try {
      await app.login();
      const result = await app.request({
        path: '/api/mini/poker/ledgers',
        method: 'POST',
        data: { roomName },
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
      });
    } catch (error) {
      wx.showToast({ title: error.message || '创建账本失败', icon: 'none' });
    } finally {
      this.setData({ creatingPoker: false });
    }
  },
});
