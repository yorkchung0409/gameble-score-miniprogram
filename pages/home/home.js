const app = getApp();

Page({
  data: {
    guideOpen: false,
    user: null,
    nickname: '',
    needsNickname: false,
    savingProfile: false,
    mahjongRoomCode: '',
    mahjongJoinCode: '',
    creatingMahjong: false,
    joiningMahjong: false,
  },

  async onLoad() {
    await this.loadMahjongUser();
  },

  async onShow() {
    if (!app.globalData.user) {
      await this.loadMahjongUser();
      return;
    }
    const user = app.globalData.user;
    this.setData({
      user,
      nickname: user.name === '微信用户' ? '' : user.name,
      needsNickname: user.name === '微信用户',
    });
  },

  async onPullDownRefresh() {
    await this.loadMahjongUser();
    wx.stopPullDownRefresh();
  },

  async loadMahjongUser() {
    try {
      const result = await app.login();
      const user = result.user;
      this.setData({
        user,
        nickname: user.name === '微信用户' ? '' : user.name,
        needsNickname: user.name === '微信用户',
      });
      return user;
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
  },

  closeGuide() {
    this.setData({ guideOpen: false });
  },

  preventGuideClose() {},

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  onMahjongRoomCodeInput(event) {
    this.setData({ mahjongRoomCode: event.detail.value });
  },

  onMahjongJoinCodeInput(event) {
    this.setData({ mahjongJoinCode: event.detail.value });
  },

  async saveProfile() {
    const name = this.data.nickname.trim();
    if (!name) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    const user = await this.ensureMahjongUser();
    if (!user) return;

    this.setData({ savingProfile: true });
    try {
      const result = await app.request({
        path: `/api/mahjong/users/${user.id}/profile`,
        method: 'PATCH',
        data: { name },
      });
      app.globalData.user = result.user;
      this.setData({
        user: result.user,
        nickname: result.user.name,
        needsNickname: false,
      });
    } catch (error) {
      wx.showToast({ title: error.message || '昵称保存失败', icon: 'none' });
    } finally {
      this.setData({ savingProfile: false });
    }
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
      wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '房间不存在', icon: 'none' });
    } finally {
      this.setData({ joiningMahjong: false });
    }
  },
});
