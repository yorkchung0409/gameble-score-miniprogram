const app = getApp();
const { displayDate, formatNet } = require('../../utils/format');
const OPPONENT_BATCH_SIZE = 30;

Page({
  data: {
    loading: true,
    loadError: '',
    opponents: [],
    total: 0,
    hasMore: false,
    loadingMore: false,
    syncWarning: '',
  },

  onLoad() {
    this.loadOpponents();
  },

  async onPullDownRefresh() {
    await this.loadOpponents();
    wx.stopPullDownRefresh();
  },

  async loadOpponents() {
    try {
      await app.login();
      const result = await app.request({ path: `/api/mini/me/mahjong-opponents?limit=${OPPONENT_BATCH_SIZE}&offset=0` });
      this.allOpponents = this.decorateOpponents(result.opponents || []);
      this.serverPagedOpponents = Number.isFinite(Number(result.nextOffset));
      this.nextOpponentOffset = this.serverPagedOpponents
        ? Number(result.nextOffset)
        : Math.min(OPPONENT_BATCH_SIZE, this.allOpponents.length);
      this.visibleOpponentCount = this.nextOpponentOffset;
      this.setData({
        loading: false,
        loadError: '',
        syncWarning: '',
        opponents: this.serverPagedOpponents
          ? this.allOpponents
          : this.allOpponents.slice(0, this.visibleOpponentCount),
        total: this.serverPagedOpponents ? Number(result.total || 0) : this.allOpponents.length,
        hasMore: this.serverPagedOpponents
          ? Boolean(result.hasMore)
          : this.visibleOpponentCount < this.allOpponents.length,
      });
    } catch (error) {
      const message = error.message || '对手战绩加载失败';
      if (this.data.opponents.length) {
        this.setData({ loading: false, syncWarning: '刷新暂时失败，当前显示上次成功加载的数据' });
      } else {
        this.setData({ loading: false, loadError: message });
      }
    }
  },

  decorateOpponents(opponents) {
    return opponents.map((opponent) => {
      const netProfit = Number(opponent.netProfit || 0);
      return Object.assign({}, opponent, {
        netDisplay: formatNet(netProfit),
        netClass: netProfit > 0 ? 'positive' : netProfit < 0 ? 'negative' : 'neutral',
        winDisplay: Number(opponent.winTotal || 0).toFixed(2),
        lossDisplay: Number(opponent.lossTotal || 0).toFixed(2),
        lastPlayedDisplay: displayDate(opponent.lastPlayedAt),
      });
    });
  },

  async loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    if (this.serverPagedOpponents) {
      this.setData({ loadingMore: true });
      try {
        const result = await app.request({
          path: `/api/mini/me/mahjong-opponents?limit=${OPPONENT_BATCH_SIZE}&offset=${this.nextOpponentOffset}`,
        });
        const knownIds = new Set(this.allOpponents.map((opponent) => opponent.userId));
        const nextOpponents = this.decorateOpponents(result.opponents || [])
          .filter((opponent) => !knownIds.has(opponent.userId));
        this.allOpponents = this.allOpponents.concat(nextOpponents);
        this.nextOpponentOffset = Number(result.nextOffset || this.allOpponents.length);
        this.setData({
          opponents: this.allOpponents,
          total: Number(result.total || this.data.total),
          hasMore: Boolean(result.hasMore),
        });
      } catch (error) {
        wx.showToast({ title: error.message || '对手加载失败', icon: 'none' });
      } finally {
        this.setData({ loadingMore: false });
      }
      return;
    }
    this.visibleOpponentCount = Math.min(
      this.visibleOpponentCount + OPPONENT_BATCH_SIZE,
      this.allOpponents.length,
    );
    this.setData({
      opponents: this.allOpponents.slice(0, this.visibleOpponentCount),
      hasMore: this.visibleOpponentCount < this.allOpponents.length,
    });
  },
});
