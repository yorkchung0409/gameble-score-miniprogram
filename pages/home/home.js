const app = getApp();

Page({
  data: {
    loading: true,
    user: null,
    userInitial: '',
    nickname: '',
    roomCode: '',
    joinCode: '',
    savingProfile: false,
    creating: false,
    joining: false,
  },

  async onLoad() {
    try {
      const result = await app.login();
      this.setData({
        user: result.user,
        userInitial: result.user.name.slice(0, 1),
        nickname: result.user.name === '微信用户' ? '' : result.user.name,
      });
    } catch (error) {
      wx.showModal({
        title: '登录失败',
        content: error.message || '请检查网络与服务端配置',
        showCancel: false,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  onRoomCodeInput(event) {
    this.setData({ roomCode: event.detail.value });
  },

  onJoinCodeInput(event) {
    this.setData({ joinCode: event.detail.value });
  },

  async saveProfile() {
    const name = this.data.nickname.trim();
    if (!name) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    this.setData({ savingProfile: true });
    try {
      const result = await app.request({
        path: `/api/mahjong/users/${this.data.user.id}/profile`,
        method: 'PATCH',
        data: { name },
      });
      app.globalData.user = result.user;
      this.setData({ user: result.user, userInitial: result.user.name.slice(0, 1) });
    } catch (error) {
      wx.showToast({ title: error.message || '昵称保存失败', icon: 'none' });
    } finally {
      this.setData({ savingProfile: false });
    }
  },

  async createRoom() {
    if (!this.data.user) return;
    this.setData({ creating: true });
    try {
      const result = await app.request({
        path: '/api/mahjong/rooms',
        method: 'POST',
        data: {
          name: '麻将牌局',
          roomCode: this.data.roomCode.trim() || undefined,
          creatorUserId: this.data.user.id,
        },
      });
      wx.navigateTo({ url: `/pages/room/room?roomCode=${result.room.roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '创建房间失败', icon: 'none' });
    } finally {
      this.setData({ creating: false });
    }
  },

  async joinRoom() {
    const roomCode = this.data.joinCode.trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: '请输入房间码', icon: 'none' });
      return;
    }
    this.setData({ joining: true });
    try {
      await app.request({ path: `/api/mahjong/rooms/${roomCode}` });
      wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '房间不存在', icon: 'none' });
    } finally {
      this.setData({ joining: false });
    }
  },
});
