const app = getApp();

function today() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function toCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function formatAmount(value) {
  const cents = toCents(value);
  return (cents / 100).toFixed(2);
}

function formatNet(value) {
  const cents = toCents(value);
  return `${cents >= 0 ? '+' : '-'}${formatAmount(Math.abs(cents) / 100)}`;
}

Page({
  data: {
    loading: true,
    loadError: '',
    roomCode: '',
    detail: null,
    expandedGameId: '',
    showRoomSettings: false,
    roomNameInput: '',
    selfPlayerOptions: [],
    selfPlayerIndex: 0,
    savingRoom: false,
    showPlayerManager: false,
    playerManagerLabel: '管理人员',
    playerName: '',
    addingPlayer: false,
    deletingPlayerId: '',
    showGameEditor: false,
    editingGameId: '',
    gameDate: today(),
    gameRows: [],
    availableGamePlayers: [],
    savingGame: false,
  },

  async onLoad(options) {
    const roomCode = (options.roomCode || '').toUpperCase();
    if (!roomCode) {
      wx.showToast({ title: '缺少账本码', icon: 'none' });
      wx.navigateBack();
      return;
    }
    this.setData({ roomCode });
    await this.loadRoom();
  },

  async onShow() {
    if (this.data.roomCode && !this.data.loading) await this.loadRoom(false);
  },

  async onPullDownRefresh() {
    await this.loadRoom(false);
    wx.stopPullDownRefresh();
  },

  async loadRoom(showFailure = true) {
    try {
      await app.login();
      const detail = await app.request({
        path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}`,
      });
    this.setData({
      detail: this.decorateDetail(detail),
      playerManagerLabel: `管理人员（${detail.players.length}人）`,
      loading: false,
      loadError: '',
    });
    } catch (error) {
      if (showFailure) {
        wx.showToast({ title: error.message || '加载账本失败', icon: 'none' });
      }
      this.setData({ loading: false, loadError: error.message || '账本加载失败' });
    }
  },

  decorateDetail(detail, expandedGameId = this.data.expandedGameId) {
    const players = detail.players.map((player) => ({
      ...player,
      initial: (player.name || '?').slice(0, 1),
    }));
    const games = detail.games.map((game) => {
      let netTotal = 0;
      let winTotal = 0;
      let lossTotal = 0;
      const gamePlayers = game.players.map((player) => {
        const netCents = toCents(player.netProfit);
        netTotal += netCents;
        if (netCents > 0) winTotal += netCents;
        if (netCents < 0) lossTotal += Math.abs(netCents);
        return {
          ...player,
          buyInDisplay: formatAmount(player.buyIn),
          balanceDisplay: formatAmount(player.balance),
          netDisplay: formatNet(player.netProfit),
          netClass: netCents > 0 ? 'positive' : netCents < 0 ? 'negative' : 'neutral',
        };
      });
      return {
        ...game,
        players: gamePlayers,
        totalBuyInDisplay: formatAmount(game.totalBuyIn),
        turnoverDisplay: formatAmount(winTotal / 100),
        balanceDifferenceDisplay: formatAmount(Math.abs(netTotal) / 100),
        winDisplay: formatAmount(winTotal / 100),
        lossDisplay: formatAmount(lossTotal / 100),
        isBalanced: netTotal === 0,
        expanded: game.id === expandedGameId,
      };
    });

    return {
      ...detail,
      players,
      games,
      leaderboard: (detail.leaderboard || []).map((entry) => {
        const netCents = toCents(entry.netProfit);
        return {
          ...entry,
          netDisplay: formatNet(entry.netProfit),
          netClass: netCents > 0 ? 'positive' : netCents < 0 ? 'negative' : 'neutral',
          winDisplay: formatAmount(entry.winTotal),
          lossDisplay: formatAmount(entry.lossTotal),
          isSelf: entry.playerId === detail.selfPlayerId,
        };
      }),
      stats: {
        ...detail.stats,
        totalBuyInDisplay: formatAmount(detail.stats.totalBuyIn),
        latestGameBalanceDiffDisplay: formatAmount(detail.stats.latestGameBalanceDiff),
        latestGameTurnoverDisplay: formatAmount(detail.stats.latestGameTurnover),
      },
    };
  },

  toggleGame(event) {
    const gameId = event.currentTarget.dataset.id;
    const expandedGameId = this.data.expandedGameId === gameId ? '' : gameId;
    this.setData({
      expandedGameId,
      detail: this.decorateDetail(this.data.detail, expandedGameId),
    });
  },

  openRoomSettings() {
    const selfPlayerOptions = [
      { id: '', name: '暂不设置' },
      ...this.data.detail.players.map((player) => ({ id: player.id, name: player.name })),
    ];
    const selfPlayerIndex = Math.max(
      0,
      selfPlayerOptions.findIndex((option) => option.id === this.data.detail.selfPlayerId),
    );
    this.setData({
      showRoomSettings: true,
      roomNameInput: this.data.detail.room.roomName,
      selfPlayerOptions,
      selfPlayerIndex,
    });
  },

  closeRoomSettings() {
    this.setData({ showRoomSettings: false });
  },

  onRoomNameInput(event) {
    this.setData({ roomNameInput: event.detail.value });
  },

  onSelfPlayerChange(event) {
    this.setData({ selfPlayerIndex: Number(event.detail.value) });
  },

  async saveRoomName() {
    const roomName = this.data.roomNameInput.trim();
    if (!roomName) {
      wx.showToast({ title: '请输入账本名称', icon: 'none' });
      return;
    }
    this.setData({ savingRoom: true });
    try {
      const selectedSelfPlayer = this.data.selfPlayerOptions[this.data.selfPlayerIndex];
      await app.request({
        path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}`,
        method: 'PATCH',
        data: { roomName },
      });
      await app.request({
        path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/self-player`,
        method: 'PATCH',
        data: { playerId: selectedSelfPlayer ? selectedSelfPlayer.id || null : null },
      });
      this.setData({ showRoomSettings: false });
      await this.loadRoom(false);
    } catch (error) {
      wx.showToast({ title: error.message || '账本名称保存失败', icon: 'none' });
    } finally {
      this.setData({ savingRoom: false });
    }
  },

  togglePlayerManager() {
    this.setData({
      showPlayerManager: !this.data.showPlayerManager,
      playerManagerLabel: this.data.showPlayerManager
        ? `管理人员（${this.data.detail.players.length}人）`
        : '收起',
    });
  },

  onPlayerNameInput(event) {
    this.setData({ playerName: event.detail.value });
  },

  async addPlayer() {
    const name = this.data.playerName.trim();
    if (!name) {
      wx.showToast({ title: '请输入人员姓名', icon: 'none' });
      return;
    }
    this.setData({ addingPlayer: true });
    try {
      await app.request({
        path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/players`,
        method: 'POST',
        data: { name },
      });
      this.setData({ playerName: '' });
      await this.loadRoom(false);
    } catch (error) {
      wx.showToast({ title: error.message || '添加人员失败', icon: 'none' });
    } finally {
      this.setData({ addingPlayer: false });
    }
  },

  deletePlayer(event) {
    const { id, name } = event.currentTarget.dataset;
    wx.showModal({
      title: '删除人员',
      content: `确定删除「${name}」吗？有历史牌局记录的人员不能删除。`,
      confirmColor: '#C43C35',
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ deletingPlayerId: id });
        try {
          await app.request({
            path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/players/${id}`,
            method: 'DELETE',
          });
          await this.loadRoom(false);
        } catch (error) {
          wx.showToast({ title: error.message || '删除人员失败', icon: 'none' });
        } finally {
          this.setData({ deletingPlayerId: '' });
        }
      },
    });
  },

  openNewGame() {
    this.openGameEditor();
  },

  openGameEditor(event) {
    const gameId = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.id || ''
      : '';
    const game = gameId
      ? this.data.detail.games.find((item) => item.id === gameId)
      : null;
    const gamePlayerMap = new Map(
      ((game && game.players) || []).map((player) => [player.playerId, player]),
    );
    const gameRows = this.data.detail.players.filter((player) => gamePlayerMap.has(player.id)).map((player) => {
      const previous = gamePlayerMap.get(player.id);
      return {
        playerId: player.id,
        playerName: player.name,
        buyIn: previous ? String(previous.buyIn) : '',
        balance: previous ? String(previous.balance) : '',
      };
    });
    this.setData({
      showGameEditor: true,
      editingGameId: gameId,
      gameDate: (game && game.gameDate) || today(),
      gameRows,
      availableGamePlayers: this.data.detail.players.filter(
        (player) => !gameRows.some((row) => row.playerId === player.id),
      ),
    });
  },

  closeGameEditor() {
    this.setData({ showGameEditor: false, editingGameId: '', gameRows: [], availableGamePlayers: [] });
  },

  onGameDateChange(event) {
    this.setData({ gameDate: event.detail.value });
  },

  onAddGamePlayer(event) {
    const index = Number(event.detail.value);
    const player = this.data.availableGamePlayers[index];
    if (!player) return;
    const gameRows = [
      ...this.data.gameRows,
      { playerId: player.id, playerName: player.name, buyIn: '', balance: '' },
    ];
    this.setData({
      gameRows,
      availableGamePlayers: this.data.availableGamePlayers.filter((_, itemIndex) => itemIndex !== index),
    });
  },

  removeGamePlayer(event) {
    const index = Number(event.currentTarget.dataset.index);
    const removed = this.data.gameRows[index];
    if (!removed) return;
    const gameRows = this.data.gameRows.filter((_, rowIndex) => rowIndex !== index);
    const availableGamePlayers = [...this.data.availableGamePlayers, {
      id: removed.playerId,
      name: removed.playerName,
    }];
    this.setData({ gameRows, availableGamePlayers });
  },

  onGameBuyInInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`gameRows[${index}].buyIn`]: event.detail.value });
  },

  onGameBalanceInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({ [`gameRows[${index}].balance`]: event.detail.value });
  },

  async saveGame() {
    const selectedRows = this.data.gameRows;
    if (selectedRows.length === 0) {
      wx.showToast({ title: '请至少选择一位人员', icon: 'none' });
      return;
    }

    const players = [];
    for (const row of selectedRows) {
      const buyIn = row.buyIn === '' ? 0 : Number(row.buyIn);
      const balance = row.balance === '' ? 0 : Number(row.balance);
      if (!Number.isFinite(buyIn) || buyIn < 0 || !Number.isFinite(balance) || balance < 0) {
        wx.showToast({ title: `${row.playerName} 的金额不正确`, icon: 'none' });
        return;
      }
      players.push({ playerId: row.playerId, buyIn, balance });
    }

    this.setData({ savingGame: true });
    try {
      const isEditing = Boolean(this.data.editingGameId);
      await app.request({
        path: isEditing
          ? `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/games/${this.data.editingGameId}`
          : `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/games`,
        method: isEditing ? 'PUT' : 'POST',
        data: { gameDate: this.data.gameDate, players },
      });
      this.closeGameEditor();
      await this.loadRoom(false);
    } catch (error) {
      wx.showToast({ title: error.message || '牌局保存失败', icon: 'none' });
    } finally {
      this.setData({ savingGame: false });
    }
  },

  deleteGame(event) {
    const gameId = event.currentTarget.dataset.id;
    wx.showModal({
      title: '删除牌局',
      content: '删除后无法恢复，确定继续吗？',
      confirmColor: '#C43C35',
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await app.request({
            path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/games/${gameId}`,
            method: 'DELETE',
          });
          this.setData({ expandedGameId: '' });
          await this.loadRoom(false);
        } catch (error) {
          wx.showToast({ title: error.message || '删除牌局失败', icon: 'none' });
        }
      },
    });
  },

});
