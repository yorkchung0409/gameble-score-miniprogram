const app = getApp();
const { displayDateTime } = require('../../utils/format');

function formatCount(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

Page({
  data: {
    loading: true,
    loadError: '',
    syncWarning: '',
    overview: null,
  },

  onShareAppMessage() {
    return app.getDefaultShareMessage();
  },

  onShareTimeline() {
    return app.getDefaultTimelineShare();
  },

  onLoad() {
    this.loadOverview();
  },

  async onPullDownRefresh() {
    await this.loadOverview();
    wx.stopPullDownRefresh();
  },

  async loadOverview() {
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.performLoadOverview().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  },

  async performLoadOverview() {
    try {
      await app.login();
      const overview = await app.request({ path: '/api/mini/operations/overview', cacheTtl: 0 });
      this.setData({
        loading: false,
        loadError: '',
        syncWarning: '',
        overview: this.decorateOverview(overview),
      });
    } catch (error) {
      const message = error.message || '运营数据加载失败';
      if (this.data.overview) {
        this.setData({ loading: false, syncWarning: '刷新暂时失败，当前显示上次成功加载的数据' });
      } else {
        this.setData({ loading: false, loadError: message });
      }
    }
  },

  decorateOverview(overview) {
    return Object.assign({}, overview, {
      generatedDisplay: displayDateTime(overview.generatedAt),
      users: {
        total: formatCount(overview.users?.total),
        newIn24Hours: formatCount(overview.users?.newIn24Hours),
        activeIn5Minutes: formatCount(overview.users?.activeIn5Minutes),
      },
      rooms: {
        activeMahjongIn30Minutes: formatCount(overview.rooms?.activeMahjongIn30Minutes),
        activePokerIn30Minutes: formatCount(overview.rooms?.activePokerIn30Minutes),
      },
      transactions: {
        inLastHour: formatCount(overview.transactions?.inLastHour),
        inLast24Hours: formatCount(overview.transactions?.inLast24Hours),
        reversalsInLast24Hours: formatCount(overview.transactions?.reversalsInLast24Hours),
      },
      realtime: {
        mode: overview.realtime?.mode === 'cloud_database_watch' ? '云数据库监听' : '云函数刷新',
        refreshFallbackSeconds: formatCount(overview.realtime?.refreshFallbackSeconds || 15),
      },
    });
  },
});
