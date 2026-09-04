const app = getApp();

Page({
  data: {
    loading: true,
    roomCode: '',
    detail: null,
    payeeOptions: [],
    payeeIndex: 0,
    amount: '',
    submitting: false,
  },

  async onLoad(options) {
    const roomCode = (options.roomCode || '').toUpperCase();
    this.setData({ roomCode });
    await this.loadRoom();
  },

  async onShow() {
    if (this.data.roomCode) await this.loadRoom();
  },

  async loadRoom() {
    try {
      await app.request({
        path: `/api/mahjong/rooms/${this.data.roomCode}`,
      });
      const user = app.globalData.user;
      let detail;
      if (user) {
        detail = await app.request({
          path: `/api/mahjong/rooms/${this.data.roomCode}/join`,
          method: 'POST',
          data: { userId: user.id },
        });
      } else {
        detail = await app.request({
          path: `/api/mahjong/rooms/${this.data.roomCode}`,
        });
      }
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '加载房间失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applyRoomDetail(detail) {
    const userId = app.globalData.user?.id;
    const payeeOptions = [
      { id: '', name: '茶水费', payeeType: 'tea_fee' },
      ...detail.members
        .filter((member) => member.userId !== userId)
        .map((member) => ({
          id: member.userId,
          name: member.userName,
          payeeType: 'user',
        })),
    ];
    const transactions = detail.transactions.map((transaction) => ({
      ...transaction,
      canReverse: transaction.payerId === userId && !transaction.reversalOf,
    }));
    this.setData({
      detail: { ...detail, transactions },
      payeeOptions,
      payeeIndex: 0,
    });
  },

  onPayeeChange(event) {
    this.setData({ payeeIndex: Number(event.detail.value) });
  },

  onAmountInput(event) {
    this.setData({ amount: event.detail.value });
  },

  async submitTransfer() {
    const user = app.globalData.user;
    const amount = Number(this.data.amount);
    const payee = this.data.payeeOptions[this.data.payeeIndex];
    if (!user || !payee) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const detail = await app.request({
        path: `/api/mahjong/rooms/${this.data.roomCode}/transactions`,
        method: 'POST',
        data: {
          payerId: user.id,
          payeeType: payee.payeeType,
          payeeId: payee.id || undefined,
          amount,
          operatorUserId: user.id,
        },
      });
      this.setData({ amount: '' });
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '记账失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async reverseTransaction(event) {
    const user = app.globalData.user;
    const transactionId = event.currentTarget.dataset.id;
    if (!user || !transactionId) return;
    try {
      const detail = await app.request({
        path: `/api/mahjong/rooms/${this.data.roomCode}/transactions/${transactionId}/reverse`,
        method: 'POST',
        data: { operatorUserId: user.id },
      });
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '冲正失败', icon: 'none' });
    }
  },
});
