const app = getApp();
const { avatarColor, displayDateTime, formatNet } = require('../../utils/format');

const SEAT_LAYOUT = [
  { seatIndex: 3, seatName: '北', position: 'north' },
  { seatIndex: 0, seatName: '东', position: 'east' },
  { seatIndex: 1, seatName: '南', position: 'south' },
  { seatIndex: 2, seatName: '西', position: 'west' },
];
const TRANSACTION_BATCH_SIZE = 30;
const FUNCTION_SYNC_INTERVAL_MS = 15 * 1000;

function roomDetailPath(roomCode, suffix = '', offset = 0) {
  return `/api/mahjong/rooms/${encodeURIComponent(roomCode)}${suffix}?transactionLimit=${TRANSACTION_BATCH_SIZE}&transactionOffset=${offset}`;
}

async function requestMahjongCore(action, data) {
  if (typeof app.mahjongCore === 'function') return app.mahjongCore(action, data);
  // This branch only supports older embedded shells during development. The
  // production App adapter routes requests back to the same Cloud Function.
  return app.request({ action, data });
}

Page({
  data: {
    loading: true,
    roomCode: '',
    detail: null,
    loadError: '',
    syncWarning: '',
    isArchived: false,
    isFreeMode: true,
    modeLabel: '普通模式',
    isOwner: false,
    currentUserSeated: false,
    currentUserName: '',
    currentUserInitial: '?',
    currentUserColor: '#5C806D',
    seatCards: [],
    memberRows: [],
    payeeOptions: [],
    payeeIndex: 0,
    transferOpen: false,
    transferPayeeName: '',
    transferPayeeInitial: '茶',
    transferPayeeType: 'tea_fee',
    transferPayeeColor: '#5E6B73',
    amountInputFocus: false,
    amount: '',
    remark: '',
    submitting: false,
    sittingDown: false,
    leavingSeat: false,
    reversingTransactionId: '',
    exitingRoom: false,
    modeDialogOpen: false,
    switchingMode: false,
    teaFeeRule: {
      enabled: false,
      mode: 'percentage',
      thresholdAmount: '0.00',
      ratePercent: 10,
      feeAmount: '0.00',
      version: 0,
      updatedAt: null,
    },
    teaFeeRuleOpen: false,
    teaFeeRuleDraft: {
      enabled: false,
      mode: 'percentage',
      thresholdAmount: '0.00',
      ratePercent: 10,
      feeAmount: '0.00',
    },
    savingTeaFeeRule: false,
    transactionsHasMore: false,
    loadingMoreTransactions: false,
  },

  async onLoad(options) {
    this.hasJoinedRoom = false;
    this.functionSyncTimer = null;
    this.functionSyncPromise = null;
    this.roomRevision = undefined;
    this.roomLoadPromise = null;
    this.transferOperationId = '';
    this.visibleTransactionCount = TRANSACTION_BATCH_SIZE;
    this.roomTransactions = [];
    this.rawRoomTransactions = [];
    this.nextTransactionOffset = 0;
    const roomCode = (options.roomCode || '').trim().toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: '缺少房间码', icon: 'none' });
      wx.navigateBack();
      return;
    }
    const pendingRooms = app.globalData.pendingMahjongRooms || {};
    const pendingDetail = pendingRooms[roomCode];
    if (pendingDetail) delete pendingRooms[roomCode];
    this.setData({ roomCode });
    if (pendingDetail) {
      // 创建者已经由创建接口登记为成员，先展示本地预览，再后台拉取完整详情。
      this.hasJoinedRoom = true;
      this.applyRoomDetail(pendingDetail);
      this.setData({ loading: false });
    }
    try {
      await app.login();
    } catch (error) {
      if (this.data.detail) {
        this.setData({ loading: false, syncWarning: '同步暂时失败，当前显示创建后的房间预览' });
      } else {
        this.setData({
          loading: false,
          loadError: error.message || '登录失败，请重新加载',
        });
      }
      return;
    }
    await this.loadRoom();
    if (this.data.detail) {
      this.startFunctionSync();
    }
  },

  async onShow() {
    if (this.data.roomCode && !this.data.loading && !this.data.transferOpen && !this.data.modeDialogOpen) {
      await this.loadRoom(false);
    }
    if (this.data.roomCode && this.data.detail) {
      this.startFunctionSync();
    }
  },

  onHide() {
    this.stopFunctionSync();
  },

  onUnload() {
    this.stopFunctionSync();
    this.roomTransactions = [];
    this.rawRoomTransactions = [];
  },

  async onPullDownRefresh() {
    await this.loadRoom(false);
    wx.stopPullDownRefresh();
  },

  onShareAppMessage() {
    return {
      title: `邀请你加入麻将房 ${this.data.roomCode}`,
      path: `/pages/room/room?roomCode=${this.data.roomCode}`,
    };
  },

  onShareTimeline() {
    return {
      title: `邀请你加入麻将房 ${this.data.roomCode}`,
      query: `roomCode=${encodeURIComponent(this.data.roomCode)}`,
    };
  },

  async retryLoadRoom() {
    this.setData({ loading: true, loadError: '', syncWarning: '' });
    try {
      await app.login();
      await this.loadRoom();
      if (this.data.detail) this.startFunctionSync();
    } catch (error) {
      this.setData({
        loading: false,
        loadError: error.message || '登录失败，请重新加载',
      });
    }
  },

  loadRoom(showError = true) {
    if (this.roomLoadPromise) return this.roomLoadPromise;
    this.roomLoadPromise = this.performLoadRoom(showError).finally(() => {
      this.roomLoadPromise = null;
    });
    return this.roomLoadPromise;
  },

  async performLoadRoom(showError = true) {
    try {
      const user = app.globalData.user;
      if (!user) throw new Error('登录状态失效，请重新加载');
      let detail;
      if (!this.hasJoinedRoom) {
        try {
          detail = await requestMahjongCore(
            'joinMahjongRoom',
            { roomCode: this.data.roomCode },
            { path: roomDetailPath(this.data.roomCode, '/join'), method: 'POST', data: { userId: user.id } },
          );
          this.hasJoinedRoom = true;
        } catch (joinError) {
          detail = await requestMahjongCore(
            'getMahjongRoom',
            { roomCode: this.data.roomCode, limit: TRANSACTION_BATCH_SIZE, offset: 0 },
            { path: roomDetailPath(this.data.roomCode) },
          );
          const alreadyJoined = (detail.members || []).some((member) => member.userId === user.id);
          if (!detail.room.dissolvedAt && !alreadyJoined) throw joinError;
          if (alreadyJoined) this.hasJoinedRoom = true;
        }
      } else {
        detail = await requestMahjongCore(
          'getMahjongRoom',
          { roomCode: this.data.roomCode, limit: TRANSACTION_BATCH_SIZE, offset: 0 },
          { path: roomDetailPath(this.data.roomCode) },
        );
      }
      const wasArchived = this.data.isArchived;
      this.applyRoomDetail(detail);
      if (detail.room.dissolvedAt) {
        this.stopFunctionSync();
        if (!wasArchived) wx.showToast({ title: '房间已归档，仅可查看', icon: 'none' });
      }
    } catch (error) {
      const message = error.message || '加载房间失败';
      if (this.data.detail) {
        this.setData({ syncWarning: '同步暂时失败，当前显示上次成功加载的数据' });
      } else {
        this.setData({ loadError: message });
      }
      if (showError) wx.showToast({ title: message, icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // An active room has no permanent push connection. The lightweight revision
  // check reads one cached row; full room data is requested only after a change.
  startFunctionSync() {
    if (!this.data.roomCode || this.data.isArchived || this.functionSyncTimer) return;
    this.functionSyncFailureCount = 0;
    this.functionSyncNextAllowedAt = 0;
    this.functionSyncTimer = setInterval(() => {
      if (this.data.transferOpen || this.data.modeDialogOpen || this.data.teaFeeRuleOpen) return;
      if (Date.now() < (this.functionSyncNextAllowedAt || 0)) return;
      void this.syncRoomRevision();
    }, FUNCTION_SYNC_INTERVAL_MS);
    this.functionSyncTimer.unref?.();
  },

  stopFunctionSync() {
    if (!this.functionSyncTimer) return;
    clearInterval(this.functionSyncTimer);
    this.functionSyncTimer = null;
  },

  syncRoomRevision() {
    if (this.functionSyncPromise || !this.data.roomCode || this.data.isArchived) return this.functionSyncPromise;
    this.functionSyncPromise = requestMahjongCore('getMahjongRoomRevision', { roomCode: this.data.roomCode })
      .then(async (state) => {
        const revision = Number(state?.revision);
        if (!Number.isInteger(revision)) return;
        this.functionSyncFailureCount = 0;
        this.functionSyncNextAllowedAt = 0;
        if (this.roomRevision === undefined) {
          this.roomRevision = revision;
          return;
        }
        if (revision !== this.roomRevision) await this.loadRoom(false);
      })
      .catch(() => {
        this.functionSyncFailureCount = Math.min((this.functionSyncFailureCount || 0) + 1, 4);
        const backoffMs = Math.min(60 * 1000, FUNCTION_SYNC_INTERVAL_MS * (2 ** this.functionSyncFailureCount));
        this.functionSyncNextAllowedAt = Date.now() + backoffMs;
        // Preserve the last successful room view while the next retry backs off.
      })
      .finally(() => {
        this.functionSyncPromise = null;
      });
    return this.functionSyncPromise;
  },

  applyRoomDetail(detail) {
    if (Number.isInteger(Number(detail.roomRevision))) this.roomRevision = Number(detail.roomRevision);
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
        avatarColor: avatarColor(seat?.userId),
        balance,
        balanceDisplay: formatNet(balance),
      };
    });
    const memberRows = (detail.members || []).map((member) => {
      const balance = balances.find((item) => item.userId === member.userId);
      return Object.assign({}, member, {
        isMe: member.userId === userId,
        isOwner: member.userId === detail.room.creatorUserId,
        initial: (member.userName || '?').slice(0, 1),
        avatarColor: avatarColor(member.userId),
        balance: balance?.balance || '0',
        balanceDisplay: formatNet(balance?.balance || '0'),
      });
    });
    const userPayeeOptions = isFreeMode
        ? memberRows.filter((member) => !member.isMe).map((member) => ({ id: member.userId, name: member.userName, type: 'user', color: member.avatarColor }))
        : seatCards.filter((seat) => seat.occupied && !seat.isMe).map((seat) => ({ id: seat.userId, name: seat.userName, type: 'user', color: seat.avatarColor }));
    const teaFeeRule = detail.room.teaFeeRule || {
      enabled: false,
      mode: 'percentage',
      thresholdAmount: '0.00',
      ratePercent: 10,
      feeAmount: '0.00',
      version: 0,
      updatedAt: null,
    };
    const payeeOptions = userPayeeOptions.concat({ id: 'tea_fee', name: '茶水费', type: 'tea_fee' });
    const rawTransactions = detail.transactions || [];
    const reversedOriginIds = new Set(
      rawTransactions
        .map((transaction) => transaction.reversalOf)
        .filter(Boolean),
    );
    const transactions = rawTransactions.map((transaction) => Object.assign({}, transaction, {
      amountDisplay: Number(transaction.amount || 0).toFixed(2),
      timeDisplay: displayDateTime(transaction.createdAt),
      payeeDisplay: transaction.payeeType === 'tea_fee' ? '茶水费' : transaction.payeeName,
      teaFeeDisplay: Number(transaction.teaFeeAmount || 0) > 0
        ? Number(transaction.teaFeeAmount).toFixed(2)
        : '',
      isReversal: Boolean(transaction.reversalOf),
      canReverse:
        !detail.room.dissolvedAt &&
        transaction.payerId === userId &&
        !transaction.reversalOf &&
        !reversedOriginIds.has(transaction.id),
    }));
    const payeeIndex = Math.max(0, payeeOptions.findIndex((option) => option.type === 'user'));
    const serverPage = detail.transactionPage;
    const isServerPaged = Boolean(serverPage && Number.isFinite(Number(serverPage.nextOffset)));
    this.rawRoomTransactions = rawTransactions;
    this.roomTransactions = transactions;
    const visibleCount = isServerPaged
      ? transactions.length
      : Math.min(
        Math.max(this.visibleTransactionCount || TRANSACTION_BATCH_SIZE, TRANSACTION_BATCH_SIZE),
        transactions.length,
      );
    this.visibleTransactionCount = visibleCount || TRANSACTION_BATCH_SIZE;
    this.nextTransactionOffset = isServerPaged ? Number(serverPage.nextOffset) : visibleCount;
    this.setData({
      detail: Object.assign({}, detail, { transactions: transactions.slice(0, visibleCount) }),
      transactionsHasMore: isServerPaged ? Boolean(serverPage.hasMore) : visibleCount < transactions.length,
      loadError: '',
      syncWarning: '',
      isArchived: Boolean(detail.room.dissolvedAt),
      isFreeMode,
      modeLabel: isFreeMode ? '普通模式' : '坐下模式',
      isOwner,
      currentUserSeated: Boolean(currentSeat),
      currentUserName: user?.name || '',
      currentUserInitial: (user?.name || '?').slice(0, 1),
      currentUserColor: avatarColor(userId),
      seatCards,
      memberRows,
      payeeOptions,
      payeeIndex: payeeIndex < 0 ? 0 : payeeIndex,
      teaFeeRule,
    });
  },

  async loadMoreTransactions() {
    if (!this.data.transactionsHasMore || this.data.loadingMoreTransactions) return;
    if (this.data.detail?.transactionPage) {
      this.setData({ loadingMoreTransactions: true });
      try {
        const nextPage = await app.request({
          path: roomDetailPath(this.data.roomCode, '', this.nextTransactionOffset),
        });
        const knownIds = new Set(this.rawRoomTransactions.map((transaction) => transaction.id));
        const mergedTransactions = this.rawRoomTransactions.concat(
          (nextPage.transactions || []).filter((transaction) => !knownIds.has(transaction.id)),
        );
        this.applyRoomDetail(Object.assign({}, nextPage, { transactions: mergedTransactions }));
      } catch (error) {
        wx.showToast({ title: error.message || '流水加载失败', icon: 'none' });
      } finally {
        this.setData({ loadingMoreTransactions: false });
      }
      return;
    }
    this.visibleTransactionCount = Math.min(
      this.visibleTransactionCount + TRANSACTION_BATCH_SIZE,
      this.roomTransactions.length,
    );
    this.setData({
      detail: Object.assign({}, this.data.detail, {
        transactions: this.roomTransactions.slice(0, this.visibleTransactionCount),
      }),
      transactionsHasMore: this.visibleTransactionCount < this.roomTransactions.length,
    });
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

  openTeaFeeRule() {
    if (!this.data.isOwner || this.data.isArchived) return;
    const rule = this.data.teaFeeRule || {};
    const mode = rule.mode === 'threshold' || rule.mode === 'shared_total' ? 'threshold' : 'percentage';
    // Early threshold-mode drafts had a placeholder fee of 1.00 with a zero threshold.
    // That combination cannot produce a valid fee rule, so do not surface it as a default.
    const hasConfiguredThreshold = mode === 'threshold' && Number(rule.thresholdAmount) > 0;
    this.setData({
      teaFeeRuleOpen: true,
      teaFeeRuleDraft: {
        enabled: Boolean(rule.enabled),
        mode,
        thresholdAmount: mode === 'threshold' ? String(rule.thresholdAmount ?? '0.00') : '0.00',
        ratePercent: Number(rule.ratePercent ?? 10),
        feeAmount: hasConfiguredThreshold ? String(rule.feeAmount ?? '0.00') : '0.00',
      },
    });
  },

  closeTeaFeeRule() {
    if (this.data.savingTeaFeeRule) return;
    this.setData({ teaFeeRuleOpen: false });
  },

  onTeaFeeEnabledChange(event) {
    this.setData({ 'teaFeeRuleDraft.enabled': Boolean(event.detail.value) });
  },

  selectTeaFeeMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (mode !== 'percentage' && mode !== 'threshold') return;
    if (mode === 'threshold' && this.data.teaFeeRuleDraft.mode !== 'threshold') {
      this.setData({
        'teaFeeRuleDraft.mode': mode,
        'teaFeeRuleDraft.thresholdAmount': '0.00',
        'teaFeeRuleDraft.feeAmount': '0.00',
      });
      return;
    }
    this.setData({ 'teaFeeRuleDraft.mode': mode });
  },

  onTeaFeeThresholdInput(event) {
    this.setData({ 'teaFeeRuleDraft.thresholdAmount': event.detail.value });
  },

  onTeaFeeRateInput(event) {
    const raw = String(event.detail?.value ?? '').replace(/\D/g, '').slice(0, 3);
    const ratePercent = raw === '' ? '' : Math.min(Number(raw), 100);
    this.setData({ 'teaFeeRuleDraft.ratePercent': ratePercent });
  },

  onTeaFeeAmountInput(event) {
    this.setData({ 'teaFeeRuleDraft.feeAmount': event.detail.value });
  },

  setTeaFeeRate(event) {
    this.setData({ 'teaFeeRuleDraft.ratePercent': Number(event.currentTarget.dataset.rate) });
  },

  async saveTeaFeeRule() {
    if (this.data.savingTeaFeeRule) return;
    const user = app.globalData.user;
    const draft = this.data.teaFeeRuleDraft || {};
    const threshold = Number(draft.thresholdAmount);
    const ratePercent = Number(draft.ratePercent);
    const feeAmount = Number(draft.feeAmount);
    const mode = draft.mode === 'threshold' ? 'threshold' : 'percentage';
    if (!user || !this.data.isOwner) return;
    if (mode === 'percentage' && (!Number.isInteger(ratePercent) || ratePercent < 0 || ratePercent > 100)) {
      wx.showToast({ title: '抽成比例需为 0-100 的整数', icon: 'none' });
      return;
    }
    if (draft.enabled && mode === 'threshold' && (!Number.isFinite(threshold) || threshold <= 0 || Math.round(threshold * 100) !== threshold * 100)) {
      wx.showToast({ title: '请输入正确的满额金额', icon: 'none' });
      return;
    }
    if (draft.enabled && mode === 'threshold' && (!Number.isFinite(feeAmount) || feeAmount <= 0 || Math.round(feeAmount * 100) !== feeAmount * 100)) {
      wx.showToast({ title: '请输入正确的抽水金额', icon: 'none' });
      return;
    }
    this.setData({ savingTeaFeeRule: true });
    try {
      const detail = await requestMahjongCore(
        'updateTeaFeeRule',
        {
          roomCode: this.data.roomCode,
          enabled: Boolean(draft.enabled),
          mode,
          thresholdAmount: mode === 'threshold' ? threshold : 0,
          ratePercent: mode === 'percentage' ? ratePercent : 0,
          feeAmount: mode === 'threshold' ? feeAmount : 0,
        },
        {
          path: `/api/mahjong/rooms/${encodeURIComponent(this.data.roomCode)}/tea-fee-rule`,
          method: 'PATCH',
          data: {
            enabled: Boolean(draft.enabled), mode,
            thresholdAmount: mode === 'threshold' ? threshold : 0,
            ratePercent: mode === 'percentage' ? ratePercent : 0,
            feeAmount: mode === 'threshold' ? feeAmount : 0,
            operatorUserId: user.id,
          },
        },
      );
      this.applyRoomDetail(detail);
      this.setData({ teaFeeRuleOpen: false });
      wx.showToast({ title: '规则已保存', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '保存规则失败', icon: 'none' });
    } finally {
      this.setData({ savingTeaFeeRule: false });
    }
  },

  async switchMode(event) {
    const mode = event.currentTarget.dataset.mode;
    if (!app.globalData.user) {
      wx.showToast({ title: '登录状态失效，请重新加载', icon: 'none' });
      return;
    }
    if (!this.data.isOwner || this.data.switchingMode) return;
    if (mode === 'free' && this.data.detail.seats.length > 0) {
      wx.showToast({ title: '请先让所有玩家离座', icon: 'none' });
      return;
    }
    this.setData({ switchingMode: true });
    try {
      const detail = await requestMahjongCore(
        'updateMahjongMode',
        { roomCode: this.data.roomCode, mode },
        { path: roomDetailPath(this.data.roomCode, '/mode'), method: 'POST', data: { mode, operatorUserId: app.globalData.user.id } },
      );
      this.closeModeDialog();
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '切换模式失败', icon: 'none' });
    } finally {
      this.setData({ switchingMode: false });
    }
  },

  onSeatTap(event) {
    if (this.data.isFreeMode || this.data.isArchived || this.data.sittingDown) return;
    const seatIndex = Number(event.currentTarget.dataset.index);
    const seat = this.data.seatCards.find((item) => item.seatIndex === seatIndex);
    if (!seat || seat.occupied) return;
    this.sitDown({ currentTarget: { dataset: { index: seatIndex } } });
  },

  async sitDown(event) {
    const user = app.globalData.user;
    if (!user) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (this.data.sittingDown) return;
    const isChangingSeat = this.data.currentUserSeated;
    this.setData({ sittingDown: true });
    try {
      const seatIndex = Number(event.currentTarget.dataset.index);
      const detail = await requestMahjongCore(
        'sitDown',
        { roomCode: this.data.roomCode, seatIndex },
        { path: roomDetailPath(this.data.roomCode, '/seats/sit'), method: 'POST', data: { userId: user.id, seatIndex } },
      );
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || (isChangingSeat ? '换座失败' : '入座失败'), icon: 'none' });
    } finally {
      this.setData({ sittingDown: false });
    }
  },

  async leaveSeat() {
    const user = app.globalData.user;
    if (!user) {
      wx.showToast({ title: '登录状态失效，请重新加载', icon: 'none' });
      return;
    }
    if (this.data.leavingSeat) return;
    this.setData({ leavingSeat: true });
    try {
      const detail = await requestMahjongCore(
        'leaveSeat',
        { roomCode: this.data.roomCode },
        { path: roomDetailPath(this.data.roomCode, '/seats/leave'), method: 'POST', data: { userId: user.id } },
      );
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '离开座位失败', icon: 'none' });
    } finally {
      this.setData({ leavingSeat: false });
    }
  },

  openTransfer(event) {
    if (this.data.isArchived) return;
    if (!app.globalData.user) {
      wx.showToast({ title: '登录状态失效，请重新加载', icon: 'none' });
      return;
    }
    if (!this.data.isFreeMode && !this.data.currentUserSeated) {
      wx.showToast({ title: '坐下后才能转账，请先选择座位', icon: 'none' });
      return;
    }
    const payeeId = event.currentTarget.dataset.id || '';
    if (!payeeId || payeeId === app.globalData.user?.id) {
      if (payeeId) wx.showToast({ title: '不能给自己转账', icon: 'none' });
      return;
    }
    const index = this.data.payeeOptions.findIndex((option) => option.id === payeeId);
    if (index < 0) {
      wx.showToast({ title: '收款人已不在房间', icon: 'none' });
      return;
    }
    const payeeIndex = index;
    const payee = this.data.payeeOptions[payeeIndex];
    this.setData({
      transferOpen: true,
      payeeIndex,
      transferPayeeName: payee?.name || '茶水费',
      transferPayeeInitial: (payee?.name || '茶水费').slice(0, 1),
      transferPayeeType: payee?.type || 'tea_fee',
      transferPayeeColor: payee?.color || '#5E6B73',
      amountInputFocus: false,
      amount: '',
      remark: '',
    }, () => {
      this.transferOperationId = app.createOperationId('mahjong_transfer');
      wx.nextTick(() => {
        if (this.data.transferOpen) this.setData({ amountInputFocus: true });
      });
    });
  },

  openTeaFeeTransfer() {
    this.openTransfer({ currentTarget: { dataset: { id: 'tea_fee' } } });
  },

  closeTransfer() {
    if (this.data.submitting) return;
    this.transferOperationId = '';
    this.setData({ transferOpen: false, amountInputFocus: false });
  },

  onPayeeChange(event) {
    const payeeIndex = Number(event.detail.value);
    const payee = this.data.payeeOptions[payeeIndex];
    const name = payee?.name || '茶水费';
    this.setData({
      payeeIndex,
      transferPayeeName: name,
      transferPayeeInitial: name.slice(0, 1),
      transferPayeeType: payee?.type || 'tea_fee',
      transferPayeeColor: payee?.color || '#5E6B73',
    });
  },

  onAmountInput(event) {
    this.setData({ amount: event.detail.value });
  },

  onRemarkInput(event) {
    this.setData({ remark: event.detail.value });
  },

  async submitTransfer() {
    if (this.data.submitting) return;
    const user = app.globalData.user;
    const payee = this.data.payeeOptions[this.data.payeeIndex];
    const amount = Number(this.data.amount);
    if (!user) {
      wx.showToast({ title: '登录状态失效，请重新加载', icon: 'none' });
      return;
    }
    if (!payee) {
      wx.showToast({ title: '请选择收款人', icon: 'none' });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      wx.showToast({ title: '请输入正确金额', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      const operationId = this.transferOperationId || app.createOperationId('mahjong_transfer');
      const detail = await requestMahjongCore(
        'createMahjongTransaction',
        {
          roomCode: this.data.roomCode,
          payeeType: payee.type,
          payeeId: payee.type === 'user' ? payee.id : undefined,
          amount,
          remark: this.data.remark.trim() || undefined,
          operationId,
        },
        {
          path: roomDetailPath(this.data.roomCode, '/transactions'),
          method: 'POST',
          data: {
            payerId: user.id, payeeType: payee.type, payeeId: payee.type === 'user' ? payee.id : undefined,
            amount, remark: this.data.remark.trim() || undefined, operatorUserId: user.id, operationId,
          },
        },
      );
      this.transferOperationId = '';
      this.setData({ transferOpen: false, amountInputFocus: false, amount: '', remark: '' });
      this.applyRoomDetail(detail);
    } catch (error) {
      wx.showToast({ title: error.message || '记账失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  },

  reverseTransaction(event) {
    const transactionId = event.currentTarget.dataset.id;
    if (!app.globalData.user) {
      wx.showToast({ title: '登录状态失效，请重新加载', icon: 'none' });
      return;
    }
    if (!transactionId || this.data.reversingTransactionId) return;
    wx.showModal({
      title: '冲正转账',
      content: '原记录会保留，并新增一笔反向记录。确定继续吗？',
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ reversingTransactionId: transactionId });
        try {
          const detail = await requestMahjongCore(
            'reverseMahjongTransaction',
            { roomCode: this.data.roomCode, transactionId },
            {
              path: roomDetailPath(this.data.roomCode, `/transactions/${encodeURIComponent(transactionId)}/reverse`),
              method: 'POST', data: { operatorUserId: app.globalData.user.id },
            },
          );
          this.applyRoomDetail(detail);
        } catch (error) {
          wx.showToast({ title: error.message || '冲正失败', icon: 'none' });
        } finally {
          this.setData({ reversingTransactionId: '' });
        }
      },
    });
  },

  exitRoom() {
    const user = app.globalData.user;
    if (!user) {
      wx.showToast({ title: '登录状态失效，请重新加载', icon: 'none' });
      return;
    }
    if (this.data.exitingRoom) return;
    wx.showModal({
      title: '退出房间',
      content: '退出后仍可再次进入，历史余额会保留。确定退出吗？',
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ exitingRoom: true });
        try {
          await requestMahjongCore(
            'leaveMahjongRoom',
            { roomCode: this.data.roomCode },
            { path: roomDetailPath(this.data.roomCode, '/leave'), method: 'POST', data: { userId: user.id } },
          );
          wx.navigateBack();
        } catch (error) {
          wx.showToast({ title: error.message || '退出失败', icon: 'none' });
        } finally {
          this.setData({ exitingRoom: false });
        }
      },
    });
  },
});
