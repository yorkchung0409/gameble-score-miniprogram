const app = getApp();

function formatNet(value) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount).toFixed(2);
  return `${amount > 0 ? '+' : amount < 0 ? '-' : ''}${absolute}`;
}

Page({
  data: {
    loading: true,
    ledgerName: '我的账本',
    creating: false,
    recentLedger: null,
  },

  async onShow() {
    await this.loadLedgers();
  },

  async onPullDownRefresh() {
    await this.loadLedgers();
    wx.stopPullDownRefresh();
  },

  onLedgerNameInput(event) {
    this.setData({ ledgerName: event.detail.value });
  },

  async loadLedgers() {
    try {
      await app.login();
      const ledgers = await app.getPersonalPokerLedgers();
      const recentLedger = ledgers.length ? this.decorateLedger(ledgers[0]) : null;
      this.setData({ recentLedger, loading: false });
    } catch (error) {
      this.setData({ recentLedger: null, loading: false });
      wx.showToast({ title: error.message || '账本加载失败', icon: 'none' });
    }
  },

  decorateLedger(ledger) {
    const value = Number(ledger.myNetProfit || 0);
    return {
      ...ledger,
      myNetDisplay: formatNet(ledger.myNetProfit),
      myNetClass: value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral',
    };
  },

  async createLedger() {
    const roomName = this.data.ledgerName.trim();
    if (!roomName) {
      wx.showToast({ title: '请输入账本名称', icon: 'none' });
      return;
    }
    this.setData({ creating: true });
    try {
      await app.login();
      const result = await app.request({
        path: '/api/mini/poker/ledgers',
        method: 'POST',
        data: { roomName },
      });
      wx.navigateTo({ url: `/pages/poker/poker?roomCode=${result.room.roomCode}` });
    } catch (error) {
      wx.showToast({ title: error.message || '创建账本失败', icon: 'none' });
    } finally {
      this.setData({ creating: false });
    }
  },

  openRecentLedger() {
    const roomCode = this.data.recentLedger && this.data.recentLedger.room.roomCode;
    if (roomCode) wx.navigateTo({ url: `/pages/poker/poker?roomCode=${roomCode}` });
  },
});
