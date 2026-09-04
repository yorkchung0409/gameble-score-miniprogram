const app = getApp();

Page({
  data: {
    guideOpen: false,
    user: null,
    showMahjongCreate: false,
    showMahjongJoin: false,
    showPokerCreate: false,
    mahjongRoomCode: '',
    mahjongJoinCode: '',
    creatingMahjong: false,
    joiningMahjong: false,
    pokerLedgerName: '我的账本',
    creatingPoker: false,
  },

  async onLoad() {
    await this.loadMahjongUser();
  },

  async onShow() {
    this.setTabBarVisible(
      !this.data.showMahjongCreate && !this.data.showMahjongJoin && !this.data.showPokerCreate,
    );
    if (!app.globalData.user) {
      await this.loadMahjongUser();
      return;
    }
    this.setData({ user: app.globalData.user });
  },

  async onPullDownRefresh() {
    await this.loadMahjongUser();
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

  openMahjongCreate() {
    this.setData({ showMahjongCreate: true });
    this.setTabBarVisible(false);
  },

  closeMahjongCreate() {
    this.setData({ showMahjongCreate: false });
    this.setTabBarVisible(true);
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

  preventSheetClose() {},

  onMahjongRoomCodeInput(event) {
    this.setData({ mahjongRoomCode: event.detail.value });
  },

  onMahjongJoinCodeInput(event) {
    this.setData({ mahjongJoinCode: event.detail.value });
  },

  onPokerLedgerNameInput(event) {
    this.setData({ pokerLedgerName: event.detail.value });
  },

  async createMahjongRoom() {
    const user = await this.ensureMahjongUser();
    if (!user) return;
    this.setData({ creatingMahjong: true });
    try {
      const result = await app.request({
        path: '/api/mahjong/rooms',
        method: 'POST',
        data: {
          name: '麻将牌局',
          roomCode: this.data.mahjongRoomCode.trim() || undefined,
          creatorUserId: user.id,
        },
      });
      this.closeMahjongCreate();
      wx.navigateTo({ url: `/pages/room/room?roomCode=${result.room.roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '创建房间失败', icon: 'none' });
    } finally {
      this.setData({ creatingMahjong: false });
    }
  },

  async joinMahjongRoom() {
    const roomCode = this.data.mahjongJoinCode.trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: '请输入房间码', icon: 'none' });
      return;
    }
    this.setData({ joiningMahjong: true });
    try {
      await app.request({ path: `/api/mahjong/rooms/${encodeURIComponent(roomCode)}` });
      this.closeMahjongJoin();
      wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '房间不存在', icon: 'none' });
    } finally {
      this.setData({ joiningMahjong: false });
    }
  },

  async createPokerLedger() {
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
      wx.navigateTo({ url: `/pages/poker/poker?roomCode=${result.room.roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '创建账本失败', icon: 'none' });
    } finally {
      this.setData({ creatingPoker: false });
    }
  },
});
