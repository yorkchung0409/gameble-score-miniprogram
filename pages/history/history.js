const app = getApp();

function formatNet(value) {
  const amount = Number(value || 0);
  return `${amount > 0 ? '+' : amount < 0 ? '-' : ''}${Math.abs(amount).toFixed(2)}`;
}

function displayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function decorateNet(item, key = 'myNetProfit') {
  const value = Number(item[key] || 0);
  return {
    ...item,
    netDisplay: formatNet(item[key]),
    netClass: value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral',
  };
}

Page({
  data: {
    loading: true,
    loadError: '',
    activeType: 'all',
    pokerLedgers: [],
    mahjongRooms: [],
  },

  onLoad(options) {
    const type = options.type === 'poker' || options.type === 'mahjong' ? options.type : 'all';
    this.setData({ activeType: type });
    this.loadHistory();
  },

  async onPullDownRefresh() {
    await this.loadHistory();
    wx.stopPullDownRefresh();
  },

  async loadHistory() {
    try {
      await app.login();
      const dashboard = await app.getPersonalDashboard();
      this.setData({
        loading: false,
        loadError: '',
        pokerLedgers: dashboard.pokerLedgers.map((ledger) => ({
          ...ledger,
          ...decorateNet(ledger),
          updatedDisplay: displayDate(ledger.room.updatedAt),
        })),
        mahjongRooms: dashboard.mahjongRooms.map((room) => ({
          ...room,
          ...decorateNet(room),
          lastActivityDisplay: displayDate(room.lastActivityAt),
          roomState: room.dissolvedAt ? '已归档' : '进行中',
          roomStateClass: room.dissolvedAt ? 'archived' : 'active',
        })),
      });
    } catch (error) {
      this.setData({ loading: false, loadError: error.message || '历史记录加载失败' });
    }
  },

  switchType(event) {
    this.setData({ activeType: event.currentTarget.dataset.type || 'all' });
  },

  openPokerLedger(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/poker/poker?roomCode=${roomCode}` });
  },

  openMahjongRoom(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
  },
});
