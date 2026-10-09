const app = getApp();
const { displayDate, formatNet, toCents } = require('../../utils/format');

function decorateNet(item, key = 'netProfit') {
  const value = Number(item[key] || 0);
  return Object.assign({}, item, {
    netDisplay: formatNet(item[key]),
    netClass: value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral',
  });
}

Page({
  data: {
    loading: true,
    loadError: '',
    user: null,
    nickname: '',
    needsNickname: false,
    savingProfile: false,
    summary: null,
    mahjongRooms: [],
    canAccessOperations: false,
    syncWarning: '',
  },

  onShareAppMessage() {
    return app.getDefaultShareMessage();
  },

  onShareTimeline() {
    return app.getDefaultTimelineShare();
  },

  async onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 1 });
    await this.loadProfile();
  },

  async onPullDownRefresh() {
    await this.loadProfile({ force: true });
    wx.stopPullDownRefresh();
  },

  async loadProfile(options = {}) {
    if (this.profileLoadPromise) return this.profileLoadPromise;
    this.profileLoadPromise = this.performLoadProfile(options).finally(() => {
      this.profileLoadPromise = null;
    });
    return this.profileLoadPromise;
  },

  async performLoadProfile(options = {}) {
    try {
      const login = await app.login();
      const dashboard = await app.getPersonalDashboard({ historyLimit: 1, force: options.force });
      const user = dashboard.summary.user || login.user;
      this.setData({
        loading: false,
        loadError: '',
        syncWarning: '',
        user,
        nickname: user.nicknameChangedAt ? user.name : '',
        needsNickname: !user.nicknameChangedAt,
        summary: this.decorateSummary(dashboard.summary),
        canAccessOperations: Boolean(dashboard.canAccessOperations),
        mahjongRooms: dashboard.mahjongRooms
          .map((room) => this.decorateMahjongRoom(room))
          .slice(0, 1),
      });
    } catch (error) {
      const message = error.message || '个人数据加载失败';
      if (this.data.summary) {
        this.setData({ loading: false, syncWarning: '刷新暂时失败，当前显示上次成功加载的数据' });
      } else {
        this.setData({ loading: false, loadError: message });
      }
    }
  },

  decorateSummary(summary) {
    const pokerNet = summary.bookkeeping ? summary.bookkeeping.netProfit : null;
    const total = toCents(summary.mahjong.netProfit) + toCents(pokerNet || 0);
    return Object.assign({}, summary, {
      totalNetDisplay: pokerNet === null ? '—' : formatNet(total / 100),
      totalNetClass: pokerNet === null ? 'neutral' : total > 0 ? 'positive' : total < 0 ? 'negative' : 'neutral',
      bookkeepingNetDisplay: pokerNet === null ? '待同步' : formatNet(pokerNet),
      bookkeepingNetClass: Number(pokerNet) > 0 ? 'positive' : Number(pokerNet) < 0 ? 'negative' : 'neutral',
      bookkeepingNote: pokerNet === null ? '请更新云函数' : `${summary.bookkeeping.gameCount} 场 · 查看记录`,
      mahjongNetDisplay: formatNet(summary.mahjong.netProfit),
      mahjongNetClass: Number(summary.mahjong.netProfit) > 0 ? 'positive' : Number(summary.mahjong.netProfit) < 0 ? 'negative' : 'neutral',
      teaFeeDisplay: Number(summary.mahjong.teaFeeTotal || 0).toFixed(2),
    });
  },

  decorateMahjongRoom(room) {
    return Object.assign({}, room, decorateNet(room), {
      lastActivityDisplay: displayDate(room.lastActivityAt),
      roomState: room.dissolvedAt ? '已归档' : '进行中',
      roomStateClass: room.dissolvedAt ? 'archived' : 'active',
    });
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  async saveProfile() {
    if (this.data.savingProfile) return;
    const name = this.data.nickname.trim();
    if (!name) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    this.setData({ savingProfile: true });
    try {
      const result = await app.mahjongCore('updateMahjongUserProfile', { name });
      app.globalData.user = result.user;
      this.setData({ user: result.user, nickname: result.user.name, needsNickname: false });
    } catch (error) {
      wx.showToast({ title: error.message || '昵称保存失败', icon: 'none' });
    } finally {
      this.setData({ savingProfile: false });
    }
  },

  openMahjongRoom(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
  },

  openHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },

  openBookkeeping() {
    wx.navigateTo({ url: '/bookkeeping-module/pages/bookkeeping/index' });
  },

  openOpponents() {
    wx.navigateTo({ url: '/pages/opponents/opponents' });
  },

  openOperations() {
    wx.navigateTo({ url: '/pages/operations/operations' });
  },
});
