const app = getApp();

const SEAT_LAYOUT = [
  { seatIndex: 3, seatName: '北', position: 'north' },
  { seatIndex: 0, seatName: '东', position: 'east' },
  { seatIndex: 1, seatName: '南', position: 'south' },
  { seatIndex: 2, seatName: '西', position: 'west' },
];

function formatBalance(value) {
  const amount = Number(value) || 0;
  return `${amount > 0 ? '+' : ''}${amount.toFixed(2)}`;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

Page({
  data: {
    loading: true,
    roomCode: '',
    detail: null,
    loadError: '',
    isArchived: false,
    isFreeMode: true,
    modeLabel: '普通模式',
    isOwner: false,
    currentUserSeated: false,
    currentUserName: '',
    currentUserInitial: '?',
    seatCards: [],
    memberRows: [],
    payeeOptions: [],
    payeeIndex: 0,
    transferOpen: false,
    transferPayeeName: '',
    transferPayeeInitial: '茶',
    amount: '',
    remark: '',
    submitting: false,
    modeDialogOpen: false,
    switchingMode: false,
    realtimeConnected: false,
  },

  async onLoad(options) {
    this.hasJoinedRoom = false;
    this.realtimeStarted = false;
    this.realtimeGeneration = 0;
    this.realtimeVersion = 0;
    this.roomSocketTask = null;
    this.realtimeReconnectTimer = null;
    this.realtimePollActive = false;
    this.realtimeRefreshPromise = null;
    const roomCode = (options.roomCode || '').trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: '缺少房间码', icon: 'none' });
      wx.navigateBack();
      return;
    }
    this.setData({ roomCode });
    try {
      await app.login();
    } catch {
      // A read-only room can still be displayed if login is temporarily unavailable.
    }
    await this.loadRoom();
    this.startRealtime();
  },

  async onShow() {
    if (this.data.roomCode && !this.data.transferOpen && !this.data.modeDialogOpen) {
      await this.loadRoom(false);
    }
    if (this.data.roomCode && !this.realtimeStarted) this.startRealtime();
  },

  onHide() {
    this.stopRealtime();
  },

  onUnload() {
    this.stopRealtime();
  },

  async onPullDownRefresh() {
    await this.loadRoom(false);
    wx.stopPullDownRefresh();
  },

  async loadRoom(showError = true) {
    try {
      const preview = await app.request({
        path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}`,
      });
      const user = app.globalData.user;
      let detail = preview;
      if (!preview.room.dissolvedAt && user && !this.hasJoinedRoom) {
        detail = await app.request({
          path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/join`,
          method: 'POST',
          data: { userId: user.id },
        });
        this.hasJoinedRoom = true;
      }
      this.applyRoomDetail(detail);
      if (detail.room.dissolvedAt && this.realtimeStarted) this.stopRealtime();
    } catch (error) {
      const message = error.message || '加载房间失败';
      this.setData({ loadError: message });
      if (showError) wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  startRealtime() {
    if (!this.data.roomCode || this.realtimeStarted) return;
    this.realtimeStarted = true;
    const generation = ++this.realtimeGeneration;
    this.connectRealtime(generation);
  },

  stopRealtime() {
    this.realtimeStarted = false;
    this.realtimeGeneration += 1;
    if (this.realtimeReconnectTimer) {
      clearTimeout(this.realtimeReconnectTimer);
      this.realtimeReconnectTimer = null;
    }
    this.stopLongPolling();
    const socketTask = this.roomSocketTask;
    this.roomSocketTask = null;
    if (socketTask && typeof socketTask.close === 'function') {
      try {
        socketTask.close({ code: 1000, reason: 'page hidden' });
      } catch {
        // The SDK may already have closed the task.
      }
    }
    if (this.data.realtimeConnected) this.setData({ realtimeConnected: false });
  },

  async connectRealtime(generation) {
    if (!this.realtimeStarted || generation !== this.realtimeGeneration) return;
    this.stopLongPolling();
    const roomCode = encodeURIComponent(this.data.roomCode);
    try {
      const result = await app.connectContainer(`/ws/mahjong?roomCode=${roomCode}`);
      const socketTask = result?.socketTask || result;
      if (!socketTask || generation !== this.realtimeGeneration || !this.realtimeStarted) {
        if (socketTask && typeof socketTask.close === 'function') socketTask.close();
        return;
      }

      this.roomSocketTask = socketTask;
      let lost = false;
      const handleLost = () => {
        if (lost || generation !== this.realtimeGeneration || !this.realtimeStarted) return;
        lost = true;
        if (this.roomSocketTask === socketTask) this.roomSocketTask = null;
        this.setData({ realtimeConnected: false });
        this.startLongPolling(generation);
        this.scheduleRealtimeReconnect(generation);
      };
      socketTask.onOpen(() => {
        if (generation !== this.realtimeGeneration || !this.realtimeStarted) return;
        this.setData({ realtimeConnected: true });
        this.stopLongPolling();
      });
      socketTask.onMessage((message) => this.handleRealtimeMessage(message));
      socketTask.onClose(handleLost);
      socketTask.onError(handleLost);
    } catch {
      if (generation !== this.realtimeGeneration || !this.realtimeStarted) return;
      this.startLongPolling(generation);
      this.scheduleRealtimeReconnect(generation);
    }
  },

  scheduleRealtimeReconnect(generation) {
    if (this.realtimeReconnectTimer || !this.realtimeStarted) return;
    this.realtimeReconnectTimer = setTimeout(() => {
      this.realtimeReconnectTimer = null;
      if (generation !== this.realtimeGeneration || !this.realtimeStarted || this.roomSocketTask) return;
      this.connectRealtime(generation);
    }, 5000);
  },

  handleRealtimeMessage(message) {
    let payload = message?.data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!payload || typeof payload !== 'object') return;
    if (Number.isSafeInteger(payload.version)) {
      this.realtimeVersion = Math.max(this.realtimeVersion, payload.version);
    }
    if (payload.type === 'room.updated') this.refreshRoomFromRealtime();
  },

  refreshRoomFromRealtime() {
    if (!this.realtimeStarted || this.realtimeRefreshPromise) return;
    this.realtimeRefreshPromise = this.loadRoom(false).finally(() => {
      this.realtimeRefreshPromise = null;
    });
  },

  startLongPolling(generation) {
    if (
      !this.realtimeStarted ||
      generation !== this.realtimeGeneration ||
      this.realtimePollActive ||
      this.roomSocketTask
    ) return;
    this.realtimePollActive = true;
    this.runLongPolling(generation);
  },

  stopLongPolling() {
    this.realtimePollActive = false;
  },

  async runLongPolling(generation) {
    while (
      this.realtimeStarted &&
      generation === this.realtimeGeneration &&
      this.realtimePollActive &&
      !this.roomSocketTask
    ) {
      try {
        const result = await app.request({
          path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/events?since=${this.realtimeVersion}`,
        });
        if (!this.realtimeStarted || generation !== this.realtimeGeneration) return;
        const version = Number(result?.version);
        if (Number.isSafeInteger(version) && version > this.realtimeVersion) {
          this.realtimeVersion = version;
          this.refreshRoomFromRealtime();
        }
      } catch {
        await this.waitForRealtime(3000);
      }
    }
  },

  waitForRealtime(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  },

  applyRoomDetail(detail) {
    const user = app.globalData.user;
    const userId = user?.id || '';
    const isFreeMode = detail.room.mode === 'free';
    const isOwner = Boolean(userId && detail.room.creatorUserId === userId);
    const currentSeat = detail.seats.find((seat) => seat.userId === userId);
    const seatMap = new Map(detail.seats.map((seat) => [seat.seatIndex, seat]));
    const balances = detail.stats.balances || [];
    const balanceMap = new Map(balances.map((balance) => [balance.userId, balance.balance]));
    const seatCards = SEAT_LAYOUT.map(({ seatIndex, seatName, position }) => {
      const seat = seatMap.get(seatIndex);
      const balance = Number(balanceMap.get(seat?.userId) || 0);
      return {
        seatIndex,
        seatName,
        position,
        occupied: Boolean(seat),
        userId: seat?.userId || '',
        userName: seat?.userName || '',
        isMe: Boolean(seat && seat.userId === userId),
        initial: (seat?.userName || '空').slice(0, 1),
        balance,
        balanceDisplay: formatBalance(balance),
      };
    });
    const memberRows = (detail.members || []).map((member) => {
      const balance = balances.find((item) => item.userId === member.userId);
      return {
        ...member,
        isMe: member.userId === userId,
        initial: (member.userName || '?').slice(0, 1),
        balance: balance?.balance || '0',
        balanceDisplay: formatBalance(balance?.balance || '0'),
      };
    });
    const payeeOptions = [
      ...(isFreeMode
        ? memberRows.filter((member) => !member.isMe).map((member) => ({ id: member.userId, name: member.userName, type: 'user' }))
        : seatCards.filter((seat) => seat.occupied && !seat.isMe).map((seat) => ({ id: seat.userId, name: seat.userName, type: 'user' }))),
      { id: 'tea_fee', name: '茶水费', type: 'tea_fee' },
    ];
    const transactions = (detail.transactions || []).map((transaction) => ({
      ...transaction,
      amountDisplay: Number(transaction.amount || 0).toFixed(2),
      timeDisplay: formatTime(transaction.createdAt),
      payeeDisplay: transaction.payeeType === 'tea_fee' ? '茶水费' : transaction.payeeName,
      isReversal: Boolean(transaction.reversalOf),
      canReverse: !detail.room.dissolvedAt && transaction.payerId === userId && !transaction.reversalOf,
    }));
    const payeeIndex = Math.max(0, payeeOptions.findIndex((option) => option.type === 'user'));
    this.setData({
      detail: { ...detail, transactions },
      loadError: '',
      isArchived: Boolean(detail.room.dissolvedAt),
      isFreeMode,
      modeLabel: isFreeMode ? '普通模式' : '坐下模式',
      isOwner,
      currentUserSeated: Boolean(currentSeat),
      currentUserName: user?.name || '',
      currentUserInitial: (user?.name || '?').slice(0, 1),
      seatCards,
      memberRows,
      payeeOptions,
      payeeIndex: payeeIndex < 0 ? 0 : payeeIndex,
    });
  },

  goBack() {
    wx.navigateBack();
  },

  copyRoomCode() {
    wx.setClipboardData({
      data: this.data.roomCode,
      success: () => wx.showToast({ title: '房间号已复制', icon: 'none' }),
    });
  },

  openModeDialog() {
    this.setData({ modeDialogOpen: true });
  },

  closeModeDialog() {
    this.setData({ modeDialogOpen: false });
  },

  preventModalClose() {},

  async switchMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!this.data.isOwner || !app.globalData.user || this.data.switchingMode) return;
    if (mode === 'free' && this.data.detail.seats.length > 0) {
      wx.showToast({ title: '请先让所有玩家离座', icon: 'none' });
      return;
    }
    this.setData({ switchingMode: true });
    try {
      await app.request({
        path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/mode`,
        method: 'POST',
        data: { mode, operatorUserId: app.globalData.user.id },
      });
      this.closeModeDialog();
      await this.loadRoom(false);
    } catch (error) {
      wx.showToast({ title: error.message || '切换模式失败', icon: 'none' });
    } finally {
      this.setData({ switchingMode: false });
    }
  },

  async sitDown(event) {
    const user = app.globalData.user;
    if (!user) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    try {
      await app.request({
        path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/seats/sit`,
        method: 'POST',
        data: { userId: user.id, seatIndex: Number(event.currentTarget.dataset.index) },
      });
      await this.loadRoom(false);
    } catch (error) {
      wx.showToast({ title: error.message || '入座失败', icon: 'none' });
    }
  },

  async leaveSeat() {
    const user = app.globalData.user;
    if (!user) return;
    try {
      await app.request({
        path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/seats/leave`,
        method: 'POST',
        data: { userId: user.id },
      });
      await this.loadRoom(false);
    } catch (error) {
      wx.showToast({ title: error.message || '离开座位失败', icon: 'none' });
    }
  },

  openTransfer(event) {
    if (this.data.isArchived) return;
    if (!this.data.isFreeMode && !this.data.currentUserSeated) {
      wx.showToast({ title: '坐下后才能转账，请先选择座位', icon: 'none' });
      return;
    }
    const payeeId = event.currentTarget.dataset.id || '';
    const index = this.data.payeeOptions.findIndex((option) => option.id === payeeId);
    const payeeIndex = index >= 0 ? index : 0;
    const payee = this.data.payeeOptions[payeeIndex];
    this.setData({
      transferOpen: true,
      payeeIndex,
      transferPayeeName: payee?.name || '茶水费',
      transferPayeeInitial: (payee?.name || '茶水费').slice(0, 1),
      amount: '',
      remark: '',
    });
  },

  openGeneralTransfer() {
    this.openTransfer({ currentTarget: { dataset: { id: '' } } });
  },

  closeTransfer() {
    this.setData({ transferOpen: false });
  },

  onPayeeChange(event) {
    const payeeIndex = Number(event.detail.value);
    const name = this.data.payeeOptions[payeeIndex]?.name || '茶水费';
    this.setData({ payeeIndex, transferPayeeName: name, transferPayeeInitial: name.slice(0, 1) });
  },

  onAmountInput(event) {
    this.setData({ amount: event.detail.value });
  },

  onRemarkInput(event) {
    this.setData({ remark: event.detail.value });
  },

  async submitTransfer() {
    const user = app.globalData.user;
    const payee = this.data.payeeOptions[this.data.payeeIndex];
    const amount = Number(this.data.amount);
    if (!user || !payee) return;
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const detail = await app.request({
        path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/transactions`,
        method: 'POST',
        data: {
          payerId: user.id,
          payeeType: payee.type,
          payeeId: payee.type === 'user' ? payee.id : undefined,
          amount,
          remark: this.data.remark.trim() || undefined,
          operatorUserId: user.id,
        },
      });
      this.setData({ transferOpen: false, amount: '', remark: '' });
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '记账失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  reverseTransaction(event) {
    const transactionId = event.currentTarget.dataset.id;
    if (!transactionId || !app.globalData.user) return;
    wx.showModal({
      title: '冲正转账',
      content: '原记录会保留，并新增一笔反向记录。确定继续吗？',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          const detail = await app.request({
            path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/transactions/${transactionId}/reverse`,
            method: 'POST',
            data: { operatorUserId: app.globalData.user.id },
          });
          this.applyRoomDetail(detail);
        } catch (error) {
          wx.showToast({ title: error.message || '冲正失败', icon: 'none' });
        }
      },
    });
  },

  exitRoom() {
    const user = app.globalData.user;
    if (!user) return;
    wx.showModal({
      title: '退出房间',
      content: '退出后仍可再次进入，历史余额会保留。确定退出吗？',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await app.request({
            path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/leave`,
            method: 'POST',
            data: { userId: user.id },
          });
          wx.navigateBack();
        } catch (error) {
          wx.showToast({ title: error.message || '退出失败', icon: 'none' });
        }
      },
    });
  },
});
