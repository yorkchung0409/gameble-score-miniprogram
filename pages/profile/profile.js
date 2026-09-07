const app = getApp();
const { displayDate, formatNet } = require('../../utils/format');

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
    pokerLedgers: [],
    mahjongRooms: [],
    syncWarning: '',
  },

  async onShow() {
    const tabBar = this.getTabBar?.();
    if (tabBar) tabBar.setData({ selected: 1 });
    await this.loadProfile();
  },

  async onPullDownRefresh() {
    await this.loadProfile();
    wx.stopPullDownRefresh();
  },

  async loadProfile() {
    if (this.profileLoadPromise) return this.profileLoadPromise;
    this.profileLoadPromise = this.performLoadProfile().finally(() => {
      this.profileLoadPromise = null;
    });
    return this.profileLoadPromise;
  },

  async performLoadProfile() {
    try {
      const login = await app.login();
      const dashboard = await app.getPersonalDashboard({ historyLimit: 1 });
      const user = dashboard.summary.user || login.user;
      this.setData({
        loading: false,
        loadError: '',
        syncWarning: '',
        user,
        nickname: user.name === '微信用户' ? '' : user.name,
        needsNickname: user.name === '微信用户',
        summary: this.decorateSummary(dashboard.summary),
        pokerLedgers: dashboard.pokerLedgers
          .map((ledger) => this.decoratePokerLedger(ledger))
          .slice(0, 1),
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
    return Object.assign({}, summary, {
      totalNetDisplay: formatNet(summary.totalNetProfit),
      pokerNetDisplay: formatNet(summary.poker.netProfit),
      mahjongNetDisplay: formatNet(summary.mahjong.netProfit),
      totalNetClass: Number(summary.totalNetProfit) > 0 ? 'positive' : Number(summary.totalNetProfit) < 0 ? 'negative' : 'neutral',
      pokerNetClass: Number(summary.poker.netProfit) > 0 ? 'positive' : Number(summary.poker.netProfit) < 0 ? 'negative' : 'neutral',
      mahjongNetClass: Number(summary.mahjong.netProfit) > 0 ? 'positive' : Number(summary.mahjong.netProfit) < 0 ? 'negative' : 'neutral',
      teaFeeDisplay: Number(summary.mahjong.teaFeeTotal || 0).toFixed(2),
    });
  },

  decoratePokerLedger(ledger) {
    return Object.assign(
      {},
      ledger,
      { id: ledger.room.id },
      decorateNet(ledger, 'myNetProfit'),
      { updatedDisplay: displayDate(ledger.room.updatedAt) },
    );
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
      const result = await app.request({
        path: `/api/mahjong/users/${this.data.user.id}/profile`,
        method: 'PATCH',
        data: { name },
      });
      app.globalData.user = result.user;
      this.setData({ user: result.user, nickname: result.user.name, needsNickname: false });
    } catch (error) {
      wx.showToast({ title: error.message || '昵称保存失败', icon: 'none' });
    } finally {
      this.setData({ savingProfile: false });
    }
  },

  openPokerLedger(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/poker/poker?roomCode=${roomCode}` });
  },

  openMahjongRoom(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
  },

  openHistory(event) {
    const type = event.currentTarget.dataset.type === 'poker' ? 'poker' : 'mahjong';
    wx.navigateTo({ url: `/pages/history/history?type=${type}` });
  },

  openOpponents() {
    wx.navigateTo({ url: '/pages/opponents/opponents' });
  },
});
