const app = getApp();
const { avatarColor, formatAmount, formatNet, toCents, today } = require('../../utils/format');
const GAME_BATCH_SIZE = 20;

function pokerDetailPath(roomCode, suffix = '', offset = 0) {
  return `/api/mini/poker/ledgers/${encodeURIComponent(roomCode)}${suffix}?gameLimit=${GAME_BATCH_SIZE}&gameOffset=${offset}`;
}

Page({
  data: {
    loading: true,
    loadError: '',
    syncWarning: '',
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
    playerPickerOpen: false,
    savingGame: false,
    deletingGameId: '',
    gamesHasMore: false,
    loadingMoreGames: false,
  },

  async onLoad(options) {
    this.roomLoadPromise = null;
    this.visibleGameCount = GAME_BATCH_SIZE;
    this.allGames = [];
    this.rawGames = [];
    this.nextGameOffset = 0;
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

  loadRoom(showFailure = true) {
    if (this.roomLoadPromise) return this.roomLoadPromise;
    this.roomLoadPromise = this.performLoadRoom(showFailure).finally(() => {
      this.roomLoadPromise = null;
    });
    return this.roomLoadPromise;
  },

  async performLoadRoom(showFailure = true) {
    try {
      await app.login();
      const detail = await app.request({
        path: pokerDetailPath(this.data.roomCode),
      });
      this.applyDetail(detail);
    } catch (error) {
      if (showFailure) {
        wx.showToast({ title: error.message || '加载账本失败', icon: 'none' });
      }
      if (this.data.detail) {
        this.setData({
          loading: false,
          syncWarning: '刷新暂时失败，当前显示上次成功加载的数据',
        });
      } else {
        this.setData({ loading: false, loadError: error.message || '账本加载失败' });
      }
    }
  },

  applyDetail(detail) {
    const decoratedDetail = this.decorateDetail(detail);
    const serverPage = detail.gamePage;
    const isServerPaged = Boolean(serverPage && Number.isFinite(Number(serverPage.nextOffset)));
    this.rawGames = detail.games || [];
    this.allGames = decoratedDetail.games;
    const visibleCount = isServerPaged
      ? this.allGames.length
      : Math.min(
        Math.max(this.visibleGameCount || GAME_BATCH_SIZE, GAME_BATCH_SIZE),
        this.allGames.length,
      );
    this.visibleGameCount = visibleCount || GAME_BATCH_SIZE;
    this.nextGameOffset = isServerPaged ? Number(serverPage.nextOffset) : visibleCount;
    this.setData({
      detail: Object.assign({}, decoratedDetail, { games: this.allGames.slice(0, visibleCount) }),
      gamesHasMore: isServerPaged ? Boolean(serverPage.hasMore) : visibleCount < this.allGames.length,
      playerManagerLabel: this.data.showPlayerManager
        ? '收起'
        : `管理人员（${detail.players.length}人）`,
      loading: false,
      loadError: '',
      syncWarning: '',
    });
  },

  decorateDetail(detail, expandedGameId = this.data.expandedGameId) {
    const players = detail.players.map((player) => Object.assign({}, player, {
      initial: (player.name || '?').slice(0, 1),
      avatarColor: avatarColor(player.id),
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
        return Object.assign({}, player, {
          buyInDisplay: formatAmount(player.buyIn),
          balanceDisplay: formatAmount(player.balance),
          netDisplay: formatNet(player.netProfit),
          netClass: netCents > 0 ? 'positive' : netCents < 0 ? 'negative' : 'neutral',
        });
      });
      return Object.assign({}, game, {
        players: gamePlayers,
        totalBuyInDisplay: formatAmount(game.totalBuyIn),
        turnoverDisplay: formatAmount(winTotal / 100),
        balanceDifferenceDisplay: formatAmount(Math.abs(netTotal) / 100),
        winDisplay: formatAmount(winTotal / 100),
        lossDisplay: formatAmount(lossTotal / 100),
        isBalanced: netTotal === 0,
        expanded: game.id === expandedGameId,
      });
    });

    return Object.assign({}, detail, {
      players,
      games,
      leaderboard: (detail.leaderboard || []).map((entry) => {
        const netCents = toCents(entry.netProfit);
        return Object.assign({}, entry, {
          netDisplay: formatNet(entry.netProfit),
          netClass: netCents > 0 ? 'positive' : netCents < 0 ? 'negative' : 'neutral',
          winDisplay: formatAmount(entry.winTotal),
          lossDisplay: formatAmount(entry.lossTotal),
          isSelf: entry.playerId === detail.selfPlayerId,
        });
      }),
      stats: Object.assign({}, detail.stats, {
        totalBuyInDisplay: formatAmount(detail.stats.totalBuyIn),
        latestGameBalanceDiffDisplay: formatAmount(detail.stats.latestGameBalanceDiff),
        latestGameTurnoverDisplay: formatAmount(detail.stats.latestGameTurnover),
      }),
    });
  },

  toggleGame(event) {
    const gameId = event.currentTarget.dataset.id;
    const expandedGameId = this.data.expandedGameId === gameId ? '' : gameId;
    this.allGames = this.allGames.map((game) => Object.assign({}, game, {
      expanded: game.id === expandedGameId,
    }));
    this.setData({
      expandedGameId,
      detail: Object.assign({}, this.data.detail, {
        games: this.allGames.slice(0, this.visibleGameCount),
      }),
    });
  },

  async loadMoreGames() {
    if (!this.data.gamesHasMore || this.data.loadingMoreGames) return;
    if (this.data.detail?.gamePage) {
      this.setData({ loadingMoreGames: true });
      try {
        const nextPage = await app.request({
          path: pokerDetailPath(this.data.roomCode, '', this.nextGameOffset),
        });
        const knownIds = new Set(this.rawGames.map((game) => game.id));
        const mergedGames = this.rawGames.concat(
          (nextPage.games || []).filter((game) => !knownIds.has(game.id)),
        );
        this.applyDetail(Object.assign({}, nextPage, { games: mergedGames }));
      } catch (error) {
        wx.showToast({ title: error.message || '牌局加载失败', icon: 'none' });
      } finally {
        this.setData({ loadingMoreGames: false });
      }
      return;
    }
    this.visibleGameCount = Math.min(
      this.visibleGameCount + GAME_BATCH_SIZE,
      this.allGames.length,
    );
    this.setData({
      detail: Object.assign({}, this.data.detail, {
        games: this.allGames.slice(0, this.visibleGameCount),
      }),
      gamesHasMore: this.visibleGameCount < this.allGames.length,
    });
  },

  openRoomSettings() {
    const selfPlayerOptions = [{ id: '', name: '暂不设置' }].concat(
      this.data.detail.players.map((player) => ({ id: player.id, name: player.name })),
    );
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
    if (this.data.savingRoom) return;
    const roomName = this.data.roomNameInput.trim();
    if (!roomName) {
      wx.showToast({ title: '请输入账本名称', icon: 'none' });
      return;
    }
    this.setData({ savingRoom: true });
    try {
      const selectedSelfPlayer = this.data.selfPlayerOptions[this.data.selfPlayerIndex];
      const detail = await app.request({
        path: pokerDetailPath(this.data.roomCode, '/settings'),
        method: 'PATCH',
        data: {
          roomName,
          selfPlayerId: selectedSelfPlayer ? selectedSelfPlayer.id || null : null,
        },
      });
      this.setData({ showRoomSettings: false });
      this.applyDetail(detail);
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
    if (this.data.addingPlayer) return;
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
    if (this.data.deletingPlayerId) return;
    wx.showModal({
      title: '删除人员',
      content: `确定删除「${name}」吗？有历史牌局记录的人员不能删除。`,
      confirmColor: '#B84E43',
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
        buyIn: previous && Number(previous.buyIn) !== 0 ? String(previous.buyIn) : '',
        balance: previous && Number(previous.balance) !== 0 ? String(previous.balance) : '',
      };
    });
    this.setData({
      showGameEditor: true,
      editingGameId: gameId,
      gameDate: (game && game.gameDate) || today(),
      gameRows,
      availableGamePlayers: this.data.detail.players.filter(
        (player) => !gameRows.some((row) => row.playerId === player.id),
      ).map((player) => ({
        id: player.id,
        name: player.name,
        initial: (player.name || '?').slice(0, 1),
        avatarColor: avatarColor(player.id),
      })),
      playerPickerOpen: false,
    });
    this.gameOperationId = gameId ? '' : app.createOperationId('poker_game');
  },

  closeGameEditor() {
    this.setData({
      showGameEditor: false,
      editingGameId: '',
      gameRows: [],
      availableGamePlayers: [],
      playerPickerOpen: false,
    });
  },

  togglePlayerPicker() {
    if (!this.data.availableGamePlayers.length) return;
    this.setData({ playerPickerOpen: !this.data.playerPickerOpen });
  },

  onGameDateChange(event) {
    this.setData({ gameDate: event.detail.value });
  },

  onAddGamePlayer(event) {
    const index = Number(event.currentTarget.dataset.index);
    const player = this.data.availableGamePlayers[index];
    if (!player) return;
    const gameRows = this.data.gameRows.concat({
      playerId: player.id,
      playerName: player.name,
      buyIn: '',
      balance: '',
    });
    const availableGamePlayers = this.data.availableGamePlayers.filter(
      (_, itemIndex) => itemIndex !== index,
    );
    this.setData({
      gameRows,
      availableGamePlayers,
      playerPickerOpen: availableGamePlayers.length > 0,
    });
  },

  removeGamePlayer(event) {
    const index = Number(event.currentTarget.dataset.index);
    const removed = this.data.gameRows[index];
    if (!removed) return;
    const gameRows = this.data.gameRows.filter((_, rowIndex) => rowIndex !== index);
    const availableGamePlayers = this.data.availableGamePlayers.concat({
      id: removed.playerId,
      name: removed.playerName,
      initial: (removed.playerName || '?').slice(0, 1),
      avatarColor: avatarColor(removed.playerId),
    });
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
    if (this.data.savingGame) return;
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
        data: {
          gameDate: this.data.gameDate,
          players,
          operationId: isEditing ? undefined : (this.gameOperationId || app.createOperationId('poker_game')),
        },
      });
      this.gameOperationId = '';
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
    if (!gameId || this.data.deletingGameId) return;
    wx.showModal({
      title: '删除牌局',
      content: '删除后无法恢复，确定继续吗？',
      confirmColor: '#B84E43',
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ deletingGameId: gameId });
        try {
          await app.request({
            path: `/api/mini/poker/ledgers/${encodeURIComponent(this.data.roomCode)}/games/${gameId}`,
            method: 'DELETE',
          });
          this.setData({ expandedGameId: '' });
          await this.loadRoom(false);
        } catch (error) {
          wx.showToast({ title: error.message || '删除牌局失败', icon: 'none' });
        } finally {
          this.setData({ deletingGameId: '' });
        }
      },
    });
  },

});
