const app = getApp();
const { displayDate, formatNet } = require('../../utils/format');

function decorateRoom(room) {
  const net = Number(room.myNetProfit || 0);
  return Object.assign({}, room, {
    netDisplay: formatNet(room.myNetProfit),
    netClass: net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral',
    lastActivityDisplay: displayDate(room.lastActivityAt),
    roomState: room.dissolvedAt ? '已归档' : '进行中',
    roomStateClass: room.dissolvedAt ? 'archived' : 'active',
  });
}

Page({
  data: {
    loading: true,
    loadError: '',
    mahjongRooms: [],
    mahjongHasMore: false,
    mahjongOffset: 0,
    mahjongTotal: 0,
    mahjongLoaded: false,
    loadingMore: false,
  },

  onShareAppMessage() { return app.getDefaultShareMessage(); },
  onShareTimeline() { return app.getDefaultTimelineShare(); },

  onLoad() {
    this.historyRequestSeq = 0;
    this.loadHistory();
  },

  async onPullDownRefresh() {
    await this.loadHistory();
    wx.stopPullDownRefresh();
  },

  async loadHistory() {
    const requestSeq = this.historyRequestSeq = (this.historyRequestSeq || 0) + 1;
    this.refreshing = true;
    try {
      await app.login();
      const result = await app.getPersonalMahjongRooms({ limit: 20 });
      if (requestSeq !== this.historyRequestSeq) return;
      this.setData({
        loading: false,
        loadError: '',
        mahjongRooms: (result.rooms || []).map(decorateRoom),
        mahjongHasMore: Boolean(result.hasMore),
        mahjongOffset: result.nextOffset || 0,
        mahjongTotal: Number(result.total || 0),
        mahjongLoaded: true,
      });
    } catch (error) {
      if (requestSeq !== this.historyRequestSeq) return;
      const message = error.message || '历史记录加载失败';
      if (this.data.mahjongLoaded) {
        this.setData({ loading: false });
        wx.showToast({ title: message, icon: 'none' });
      } else {
        this.setData({ loading: false, loadError: message });
      }
    } finally {
      if (requestSeq === this.historyRequestSeq) this.refreshing = false;
    }
  },

  async loadMore() {
    if (this.data.loadingMore || this.refreshing || !this.data.mahjongHasMore) return;
    const requestSeq = this.historyRequestSeq;
    this.setData({ loadingMore: true });
    try {
      const result = await app.getPersonalMahjongRooms({ limit: 20, offset: this.data.mahjongOffset });
      if (requestSeq !== this.historyRequestSeq) return;
      const rooms = new Map(this.data.mahjongRooms.map((room) => [room.roomCode, room]));
      for (const room of result.rooms || []) rooms.set(room.roomCode, decorateRoom(room));
      this.setData({
        mahjongRooms: Array.from(rooms.values()),
        mahjongHasMore: Boolean(result.hasMore),
        mahjongOffset: result.nextOffset ?? this.data.mahjongOffset,
        mahjongTotal: Number(result.total ?? this.data.mahjongTotal),
      });
    } catch (error) {
      if (requestSeq === this.historyRequestSeq) wx.showToast({ title: error.message || '加载更多失败', icon: 'none' });
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  openMahjongRoom(event) {
    const roomCode = event.currentTarget.dataset.code;
    if (roomCode) wx.navigateTo({ url: `/pages/room/room?roomCode=${roomCode}` });
  },
});
