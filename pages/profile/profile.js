const app = getApp();

function formatNet(value) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount).toFixed(2);
  return `${amount > 0 ? '+' : amount < 0 ? '-' : ''}${absolute}`;
}

function decorateNet(item, key = 'netProfit') {
  const value = Number(item[key] || 0);
  return {
    ...item,
    netDisplay: formatNet(item[key]),
    netClass: value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral',
  };
}

function displayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
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
    opponents: [],
    opponentDetail: null,
    opponentLoading: false,
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
    try {
      const login = await app.login();
      const dashboard = await app.getPersonalDashboard();
      const user = dashboard.summary.user || login.user;
      this.setData({
        loading: false,
        loadError: '',
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
        opponents: dashboard.opponents.map((opponent) => ({
          ...decorateNet(opponent),
          lastPlayedDisplay: displayDate(opponent.lastPlayedAt),
        })),
      });
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '个人数据加载失败' });
    }
  },

  decorateSummary(summary) {
    return {
      ...summary,
      totalNetDisplay: formatNet(summary.totalNetProfit),
      pokerNetDisplay: formatNet(summary.poker.netProfit),
      mahjongNetDisplay: formatNet(summary.mahjong.netProfit),
      totalNetClass: Number(summary.totalNetProfit) > 0 ? 'positive' : Number(summary.totalNetProfit) < 0 ? 'negative' : 'neutral',
      pokerNetClass: Number(summary.poker.netProfit) > 0 ? 'positive' : Number(summary.poker.netProfit) < 0 ? 'negative' : 'neutral',
      mahjongNetClass: Number(summary.mahjong.netProfit) > 0 ? 'positive' : Number(summary.mahjong.netProfit) < 0 ? 'negative' : 'neutral',
      teaFeeDisplay: Number(summary.mahjong.teaFeeTotal || 0).toFixed(2),
    };
  },

  decoratePokerLedger(ledger) {
    return {
      ...ledger,
      id: ledger.room.id,
      ...decorateNet(ledger, 'myNetProfit'),
      updatedDisplay: displayDate(ledger.room.updatedAt),
    };
  },

  decorateMahjongRoom(room) {
    return {
      ...room,
      ...decorateNet(room),
      lastActivityDisplay: displayDate(room.lastActivityAt),
      roomState: room.dissolvedAt ? '已归档' : '进行中',
      roomStateClass: room.dissolvedAt ? 'archived' : 'active',
    };
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value });
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
    const type = event.currentTarget.dataset.type || 'all';
    wx.navigateTo({ url: `/pages/history/history?type=${type}` });
  },

  async openOpponent(event) {
    const opponentId = event.currentTarget.dataset.id;
    if (!opponentId) return;
    this.setData({ opponentLoading: true, opponentDetail: { opponentName: '', records: [] } });
    try {
      const detail = await app.request({ path: `/api/mini/me/mahjong-opponents/${opponentId}` });
      this.setData({
        opponentDetail: {
          ...detail,
          records: detail.records.map((record) => ({
            ...decorateNet(record),
            amountDisplay: Number(record.amount || 0).toFixed(2),
            resultLabel: Number(record.netProfit || 0) > 0 ? '赢得' : '输给',
            createdDisplay: displayDate(record.createdAt),
          })),
        },
      });
    } catch (error) {
      this.setData({ opponentDetail: null });
      wx.showToast({ title: error.message || '对战记录加载失败', icon: 'none' });
    } finally {
      this.setData({ opponentLoading: false });
    }
  },

  closeOpponent() {
    this.setData({ opponentDetail: null, opponentLoading: false });
  },

  preventClose() {},
});
