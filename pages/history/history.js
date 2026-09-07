const app = getApp();
const { displayDate, formatNet } = require('../../utils/format');

function decorateNet(item, key = 'myNetProfit') {
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
    activeType: 'mahjong',
    pokerLedgers: [],
    mahjongRooms: [],
    pokerHasMore: false,
    mahjongHasMore: false,
    pokerOffset: 0,
    mahjongOffset: 0,
    pokerTotal: 0,
    mahjongTotal: 0,
    pokerLoaded: false,
    mahjongLoaded: false,
    loadingMore: false,
  },

  onLoad(options) {
    this.historyRequestSeq = 0;
    const type = options.type === 'poker' || options.type === 'mahjong' ? options.type : 'mahjong';
    this.setData({ activeType: type });
    this.loadHistory();
  },

  async onPullDownRefresh() {
    await this.loadHistory({ refresh: true });
    wx.stopPullDownRefresh();
  },

  async loadHistory(options = {}) {
    const missingOnly = options.missingOnly === true;
    this.historyRequestSeq = (this.historyRequestSeq || 0) + 1;
    const requestSeq = this.historyRequestSeq;
    try {
      await app.login();
      const loadPoker =
        this.data.activeType !== 'mahjong' &&
        (!missingOnly || !this.data.pokerLoaded);
      const loadMahjong =
        this.data.activeType !== 'poker' &&
        (!missingOnly || !this.data.mahjongLoaded);
      const results = await Promise.all([
        loadPoker ? app.getPersonalPokerLedgers({ limit: 20 }) : Promise.resolve(null),
        loadMahjong ? app.getPersonalMahjongRooms({ limit: 20 }) : Promise.resolve(null),
      ]);
      const pokerResult = results[0];
      const mahjongResult = results[1];
      if (requestSeq !== this.historyRequestSeq) return;
      const patch = {
        loading: false,
        loadError: '',
      };
      if (pokerResult) {
        Object.assign(patch, {
          pokerLedgers: (pokerResult.ledgers || []).map((ledger) => Object.assign(
            {},
            ledger,
            decorateNet(ledger),
            { updatedDisplay: displayDate(ledger.room.updatedAt) },
          )),
          pokerHasMore: Boolean(pokerResult.hasMore),
          pokerOffset: pokerResult.nextOffset || 0,
          pokerTotal: Number(pokerResult.total || 0),
          pokerLoaded: true,
        });
      }
      if (mahjongResult) {
        Object.assign(patch, {
          mahjongRooms: (mahjongResult.rooms || []).map((room) => Object.assign(
            {},
            room,
            decorateNet(room),
            {
              lastActivityDisplay: displayDate(room.lastActivityAt),
              roomState: room.dissolvedAt ? '已归档' : '进行中',
              roomStateClass: room.dissolvedAt ? 'archived' : 'active',
            },
          )),
          mahjongHasMore: Boolean(mahjongResult.hasMore),
          mahjongOffset: mahjongResult.nextOffset || 0,
          mahjongTotal: Number(mahjongResult.total || 0),
          mahjongLoaded: true,
        });
      }
      this.setData(patch);
    } catch (error) {
      if (requestSeq !== this.historyRequestSeq) return;
      const message = error.message || '历史记录加载失败';
      if (this.data.pokerLoaded || this.data.mahjongLoaded) {
        this.setData({ loading: false });
        wx.showToast({ title: message, icon: 'none' });
      } else {
        this.setData({ loading: false, loadError: message });
      }
    }
  },

  async switchType(event) {
    const activeType = event.currentTarget.dataset.type === 'poker' ? 'poker' : 'mahjong';
    this.setData({ activeType, loadError: '' });
    await this.loadHistory({ missingOnly: true });
  },

  async loadMore(event) {
    if (this.data.loadingMore) return;
    const type = event.currentTarget.dataset.type;
    const isPoker = type === 'poker';
    const hasMore = isPoker ? this.data.pokerHasMore : this.data.mahjongHasMore;
    if (!hasMore) return;
    this.setData({ loadingMore: true });
    try {
      if (isPoker) {
        const result = await app.getPersonalPokerLedgers({ limit: 20, offset: this.data.pokerOffset });
        const items = (result.ledgers || []).map((ledger) => Object.assign(
          {},
          ledger,
          decorateNet(ledger),
          { updatedDisplay: displayDate(ledger.room.updatedAt) },
        ));
        this.setData({
          pokerLedgers: this.data.pokerLedgers.concat(items),
          pokerHasMore: Boolean(result.hasMore),
          pokerOffset: result.nextOffset || this.data.pokerOffset,
          pokerTotal: Number(result.total || this.data.pokerTotal),
        });
      } else {
        const result = await app.getPersonalMahjongRooms({ limit: 20, offset: this.data.mahjongOffset });
        const items = (result.rooms || []).map((room) => Object.assign(
          {},
          room,
          decorateNet(room),
          {
            lastActivityDisplay: displayDate(room.lastActivityAt),
            roomState: room.dissolvedAt ? '已归档' : '进行中',
            roomStateClass: room.dissolvedAt ? 'archived' : 'active',
          },
        ));
        this.setData({
          mahjongRooms: this.data.mahjongRooms.concat(items),
          mahjongHasMore: Boolean(result.hasMore),
          mahjongOffset: result.nextOffset || this.data.mahjongOffset,
          mahjongTotal: Number(result.total || this.data.mahjongTotal),
        });
      }
    } catch (error) {
      wx.showToast({ title: error.message || '加载更多失败', icon: 'none' });
    } finally {
      this.setData({ loadingMore: false });
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
});
