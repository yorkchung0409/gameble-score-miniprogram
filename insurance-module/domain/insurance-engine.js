/*
 * Pure insurance state and view model.
 *
 * This module intentionally has no wx/document/window dependency.  It is the
 * contract between the mini-program pages and the poker calculation core.
 */
const Core = require("../poker-core");
const HandAnalysis = require("../app-hand-analysis");

const SCHEMA_VERSION = 1;
const PLAYER_KEYS = ["A", "B", "C", "D"];
const STREET_NAMES = ["turn", "river"];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function cappedStreetBuy(value, coverage, odds) {
  const multiplier = Number(odds);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return Math.min(asAmount(value), asAmount(coverage) / multiplier);
}

function boardPrefix(board) {
  if (!Array.isArray(board)) return [];
  const result = [];
  for (const card of board) {
    if (!card) break;
    result.push(String(card));
  }
  return result;
}

function boardKey(board) {
  return boardPrefix(board).join("|");
}

function cardsForPlayer(player) {
  if (!player || !Array.isArray(player.cards)) return ["", ""];
  return [player.cards[0] || "", player.cards[1] || ""];
}

function normalizePlayers(players) {
  const source = Array.isArray(players) && players.length ? players : PLAYER_KEYS.slice(0, 2).map((key) => ({ key, cards: ["", ""] }));
  return source.slice(0, 4).map((player, index) => ({
    key: player && player.key ? String(player.key) : PLAYER_KEYS[index],
    cards: cardsForPlayer(player)
  }));
}

function playerCount(state) {
  const players = state && state.table && Array.isArray(state.table.players) ? state.table.players : [];
  return Math.min(4, Math.max(2, players.length || 2));
}

function normalizeBoard(board) {
  const source = Array.isArray(board) ? board : [];
  return Array.from({ length: 5 }, (_, index) => source[index] || "");
}

function handKey(stateLike) {
  const table = stateLike.table || {};
  const players = normalizePlayers(table.players).map((player) => ({ key: player.key, cards: player.cards }));
  const inputs = stateLike.inputs || {};
  return JSON.stringify({
    flop: boardPrefix(table.board).slice(0, 3),
    players,
    poolMode: stateLike.poolMode === "multi" ? "multi" : "single",
    coverage: asAmount(inputs.coverage),
    stake: asAmount(inputs.stake),
    contributions: inputs.contributions || {},
    rankings: inputs.rankings || {}
  });
}

function emptyStreet(key = "", status = "unseen") {
  return {
    outs: null,
    outCards: [],
    odds: 0,
    oddsOverride: 0,
    buy: 0,
    status,
    boardKey: key,
    source: "auto"
  };
}

function stablePoolId(pot) {
  if (!pot) return "single";
  const eligible = Array.isArray(pot.eligible) ? pot.eligible.map(String).sort().join(",") : "";
  return `${Number(pot.from) || 0}-${Number(pot.to) || 0}|${eligible}`;
}

function isStrictAppend(previous, next) {
  const before = boardPrefix(previous);
  const after = boardPrefix(next);
  return after.length === before.length + 1
    && before.every((card, index) => card === after[index])
    && after.length >= 4;
}

function completePlayers(state) {
  return normalizePlayers(state.table && state.table.players).filter((player) => player.cards.every(Boolean));
}

function getPools(state, players) {
  const inputs = state.inputs || {};
  if (!Array.isArray(players) || !players.length) return [];
  if (state.poolMode !== "multi") {
    return [{
      id: "single",
      label: "底池",
      amount: asAmount(inputs.coverage),
      from: 0,
      to: asAmount(inputs.coverage),
      eligible: players.map((player) => player.key),
      stakeByPlayer: Object.fromEntries(players.map((player) => [player.key, asAmount(inputs.stake)]))
    }];
  }
  const contributions = inputs.contributions || {};
  const side = Core.buildSidePots(contributions, PLAYER_KEYS);
  return side.pots.map((pot) => ({ ...pot, id: stablePoolId(pot) }));
}

function currentLeaders(state, board, players, pool) {
  if (!players.length) return [];
  if (state.poolMode === "multi") {
    const rankings = state.inputs && state.inputs.rankings ? state.inputs.rankings : {};
    const explicit = pool.eligible.some((key) => Number(rankings[key]) > 0);
    if (explicit) {
      const best = Math.min(...pool.eligible.map((key) => Number(rankings[key]) || 4));
      return pool.eligible.filter((key) => (Number(rankings[key]) || 4) === best && players.some((player) => player.key === key));
    }
    const hand = HandAnalysis.calculateHandOuts(board, players);
    const eligible = players.filter((player) => pool.eligible.includes(player.key));
    const best = eligible.reduce((top, player) => {
      const score = hand.stats[player.key] && hand.stats[player.key].currentRank || [0];
      return Core.compareScore(score, top) > 0 ? score : top;
    }, [0]);
    return eligible.filter((player) => Core.compareScore(hand.stats[player.key].currentRank, best) === 0).map((player) => player.key);
  }
  const hand = HandAnalysis.calculateHandOuts(board, players);
  return hand.currentLeaders.filter((key) => players.some((player) => player.key === key));
}

function autoStreet(board, players, buyer, street, existing, participantKeys, options = {}) {
  const forceAuto = Boolean(options.forceAuto);
  const key = boardKey(board);
  if (board.length >= 5) return existing && existing.status === "settled" ? existing : emptyStreet(key, "settled");
  if (board.length >= 4 && street === "turn" && !existing) return emptyStreet(key, "notApplicable");
  const analysis = Array.isArray(participantKeys)
    ? HandAnalysis.calculateParticipantOuts(board, players, participantKeys, buyer)
    : HandAnalysis.calculateHandOuts(board, players);
  const stat = analysis.stats && analysis.stats[buyer];
  const outCards = Array.isArray(analysis.outCards)
    ? analysis.outCards.slice()
    : stat && Array.isArray(stat.lossCards) ? stat.lossCards.slice() : [];
  const outs = Core.normalizedOuts(outCards.length, 0);
  const oddsOverride = forceAuto ? 0 : existing ? Core.validInsuranceOdds(existing.oddsOverride) : 0;
  const value = existing && existing.status === "settled" ? existing : {
    outs,
    outCards,
    odds: oddsOverride || Core.oddsForOuts(outs),
    oddsOverride,
    // A recalculation owns outs and odds. The premium is a separate player decision.
    buy: existing ? asAmount(existing.buy) : 0,
    status: street === "river" && board.length === 3 ? "estimated" : "current",
    boardKey: key,
    source: "auto"
  };
  return value;
}

function applyAutomaticOuts(state, options = {}) {
  const next = clone(state);
  const board = boardPrefix(next.table.board);
  const players = completePlayers(next);
  if (board.length < 3 || !players.length) return next;

  const insurance = {};
  getPools(next, players).forEach((pool) => {
    const leaders = currentLeaders(next, board, players, pool);
    const poolState = {};
    const participantKeys = pool.eligible.slice();
    leaders.forEach((buyer) => {
      const previous = next.insuranceByPool[pool.id] && next.insuranceByPool[pool.id][buyer];
      const oldTurn = previous && previous.turn;
      const oldRiver = previous && previous.river;
      const turn = board.length >= 4 && oldTurn
        ? oldTurn
        : autoStreet(board, players, buyer, "turn", oldTurn, participantKeys, options);
      const turnHitTerminal = turn.status === "settled" && turn.resolvedStatus === "hit";
      poolState[buyer] = {
        coverage: asAmount(pool.amount) / Math.max(leaders.length, 1),
        turn,
        river: turnHitTerminal && !(oldRiver && oldRiver.status === "settled")
          ? emptyStreet(boardKey(board), "notApplicable")
          : board.length >= 5 && oldRiver && oldRiver.status === "settled"
            ? oldRiver
            : autoStreet(board, players, buyer, "river", oldRiver, participantKeys, options)
      };
    });
    const previousPool = next.insuranceByPool[pool.id] || {};
    Object.keys(previousPool).forEach((buyer) => {
      if (!poolState[buyer]) poolState[buyer] = previousPool[buyer];
      if (!leaders.includes(buyer) && board.length >= 4 && poolState[buyer] && poolState[buyer].river && poolState[buyer].river.status !== "settled") {
        poolState[buyer] = {
          ...poolState[buyer],
          river: emptyStreet(boardKey(board), "notApplicable")
        };
      }
    });
    insurance[pool.id] = poolState;
  });
  next.insuranceByPool = insurance;
  next.round.board = next.table.board.slice();
  return next;
}

function startNewBranch(state, table, inputs, poolMode) {
  const next = {
    ...clone(state),
    table: table || clone(state.table),
    inputs: inputs || clone(state.inputs),
    poolMode: poolMode || state.poolMode,
    branchId: (Number(state.branchId) || 0) + 1,
    insuranceByPool: {},
    round: {
      schemaVersion: SCHEMA_VERSION,
      branchKey: "",
      board: table ? table.board.slice() : state.table.board.slice(),
      history: []
    },
    error: null
  };
  next.round.branchKey = handKey(next);
  return applyAutomaticOuts(next);
}

function createRound(input = {}) {
  const requestedCount = Math.min(4, Math.max(2, Number(input.playerCount) || (Array.isArray(input.players) && input.players.length) || 2));
  const supplied = normalizePlayers(input.players);
  const players = PLAYER_KEYS.slice(0, requestedCount).map((key, index) => supplied[index] && supplied[index].key === key
    ? supplied[index]
    : { key, cards: ["", ""] });
  const table = { board: normalizeBoard(input.board), players };
  const state = {
    schemaVersion: SCHEMA_VERSION,
    branchId: 1,
    poolMode: input.poolMode === "multi" ? "multi" : "single",
    table,
    inputs: {
      coverage: asAmount(input.coverage),
      stake: asAmount(input.stake),
      contributions: { ...(input.contributions || {}) },
      rankings: { ...(input.rankings || {}) }
    },
    insuranceByPool: {},
    round: {
      schemaVersion: SCHEMA_VERSION,
      branchKey: "",
      board: table.board.slice(),
      history: []
    },
    error: null
  };
  state.round.branchKey = handKey(state);
  return applyAutomaticOuts(state);
}

function snapshotHistory(state, street, resolvedCard, sourceBoardKey) {
  const next = clone(state);
  const key = sourceBoardKey || boardKey(next.table.board);
  Object.entries(next.insuranceByPool || {}).forEach(([poolId, buyers]) => {
    Object.entries(buyers || {}).forEach(([buyer, record]) => {
      const value = record && record[street];
      if (!value || value.status === "notApplicable") return;
      const hasOutCards = Array.isArray(value.outCards) && value.outCards.length > 0;
      const resolvedStatus = value.status === "hit" || value.status === "safe"
        ? value.status
        : value.source === "manual" && !hasOutCards
          ? "needsConfirm"
          : hasOutCards && value.outCards.includes(resolvedCard)
            ? "hit"
            : "safe";
      const snapshot = { ...clone(value), status: "settled", boardKey: key, resolvedStatus };
      next.round.history.push({ poolId, buyer, street, boardKey: key, snapshot: clone(snapshot) });
      record[street] = { ...snapshot, status: "settled" };
    });
  });
  return next;
}

function syncHistorySnapshot(state, poolId, buyer, street, snapshot) {
  if (!snapshot || snapshot.status !== "settled") return;
  const entries = Array.isArray(state.round && state.round.history) ? state.round.history : [];
  const index = entries.map((entry, cursor) => ({ entry, cursor })).reverse().find(({ entry }) => (
    entry && entry.poolId === poolId && entry.buyer === buyer && entry.street === street
  ));
  const value = { ...clone(snapshot) };
  if (index) {
    entries[index.cursor] = {
      ...entries[index.cursor],
      boardKey: value.boardKey || entries[index.cursor].boardKey,
      snapshot: value
    };
  } else {
    entries.push({
      poolId,
      buyer,
      street,
      boardKey: value.boardKey || boardKey(state.table.board),
      snapshot: value
    });
  }
  state.round.history = entries;
}

function setBoardCard(state, index, rawCard) {
  const card = rawCard ? Core.parseCard(rawCard) : null;
  if (rawCard && !card) return { ...state, error: "invalid-card" };
  const board = normalizeBoard(state.table.board);
  const nextBoard = board.slice();
  nextBoard[index] = card ? card.value : "";
  if (nextBoard[index] === board[index]) return { ...state, error: null };
  const used = nextBoard.filter(Boolean);
  const playerCards = normalizePlayers(state.table && state.table.players).flatMap((player) => player.cards.filter(Boolean));
  const allKnown = used.concat(playerCards);
  const duplicates = allKnown.length !== new Set(allKnown).size;
  if (duplicates) return { ...state, error: "duplicate-card" };
  const previous = boardPrefix(board);
  const nextPrefix = boardPrefix(nextBoard);
  if (card && index > previous.length) return { ...state, error: "board-order" };
  if (isStrictAppend(previous, nextPrefix)) {
    const next = clone(state);
    next.table.board = nextBoard;
    if (previous.length === 3) return applyAutomaticOuts(snapshotHistory(next, "turn", nextPrefix[nextPrefix.length - 1], boardKey(board)));
    if (previous.length === 4) return applyAutomaticOuts(snapshotHistory(next, "river", nextPrefix[nextPrefix.length - 1], boardKey(board)));
    return applyAutomaticOuts(next);
  }
  return startNewBranch(state, { ...state.table, board: nextBoard }, null, null);
}

function reduceRound(state, action = {}) {
  const current = state && typeof state === "object" ? state : createRound();
  const type = action.type;
  if (type === "RESET") return createRound();
  if (type === "SET_BOARD_CARD") {
    const index = Number(action.index);
    if (!Number.isInteger(index) || index < 0 || index > 4) return { ...current, error: "invalid-board-index" };
    return setBoardCard(current, index, action.card || "");
  }
  if (type === "SET_PLAYER_CARD") {
    const playerKey = String(action.player || "");
    const index = Number(action.index);
    if (!Number.isInteger(index) || index < 0 || index > 1) return { ...current, error: "invalid-player-card-index" };
    if (!normalizePlayers(current.table.players).some((player) => player.key === playerKey)) return { ...current, error: "unknown-player" };
    const parsedCard = action.card ? Core.parseCard(action.card) : null;
    if (action.card && !parsedCard) return { ...current, error: "invalid-card" };
    const players = normalizePlayers(current.table.players).map((player) => {
      if (player.key !== playerKey) return player;
      const cards = player.cards.slice();
      cards[index] = parsedCard ? parsedCard.value : "";
      return { ...player, cards };
    });
    const currentPlayer = normalizePlayers(current.table.players).find((player) => player.key === playerKey);
    if (currentPlayer && currentPlayer.cards[index] === players.find((player) => player.key === playerKey).cards[index]) {
      return { ...current, error: null };
    }
    const allCards = normalizeBoard(current.table.board).filter(Boolean).concat(players.flatMap((player) => player.cards.filter(Boolean)));
    if (allCards.length !== new Set(allCards).size) return { ...current, error: "duplicate-card" };
    return startNewBranch(current, { ...current.table, players }, null, null);
  }
  if (type === "SET_PLAYER_COUNT") {
    const count = Math.min(4, Math.max(2, Number(action.count) || 2));
    const existing = normalizePlayers(current.table.players);
    if (count === existing.length) return { ...current, error: null };
    const players = PLAYER_KEYS.slice(0, count).map((key, index) => existing[index] && existing[index].key === key
      ? existing[index]
      : { key, cards: ["", ""] });
    const inputs = clone(current.inputs);
    inputs.contributions = Object.fromEntries(PLAYER_KEYS.slice(0, count)
      .filter((key) => Object.prototype.hasOwnProperty.call(inputs.contributions || {}, key))
      .map((key) => [key, inputs.contributions[key]]));
    inputs.rankings = Object.fromEntries(PLAYER_KEYS.slice(0, count)
      .filter((key) => Object.prototype.hasOwnProperty.call(inputs.rankings || {}, key))
      .map((key) => [key, inputs.rankings[key]]));
    return startNewBranch(current, { ...current.table, players }, inputs, null);
  }
  if (type === "SET_POOL_MODE") {
    const mode = action.mode === "multi" ? "multi" : "single";
    if (mode === current.poolMode) return { ...current, error: null };
    return startNewBranch(current, null, null, mode);
  }
  if (type === "SET_AMOUNT") {
    const inputs = clone(current.inputs);
    if (action.field === "coverage" || action.field === "stake") {
      const value = asAmount(action.value);
      if (value === asAmount(inputs[action.field])) return { ...current, error: null };
      inputs[action.field] = value;
    }
    return startNewBranch(current, null, inputs, null);
  }
  if (type === "SET_CONTRIBUTION") {
    const inputs = clone(current.inputs);
    const player = String(action.player);
    const value = asAmount(action.value);
    if (value === asAmount(inputs.contributions[player])) return { ...current, error: null };
    inputs.contributions[player] = value;
    return startNewBranch(current, null, inputs, null);
  }
  if (type === "SET_RANK") {
    const inputs = clone(current.inputs);
    const player = String(action.player);
    const rank = Number(action.value);
    const nextRank = Number.isInteger(rank) && rank >= 1 && rank <= 4 ? rank : 0;
    const previousRank = Number(inputs.rankings[player]) || 0;
    if (nextRank === previousRank) return { ...current, error: null };
    if (nextRank) inputs.rankings[player] = nextRank;
    else delete inputs.rankings[player];
    return startNewBranch(current, null, inputs, null);
  }
  if (type === "EDIT_STREET") {
    const next = clone(current);
    const pool = next.insuranceByPool[action.poolId] || (next.insuranceByPool[action.poolId] = {});
    const record = pool[action.buyer] || (pool[action.buyer] = { turn: emptyStreet(boardKey(next.table.board)), river: emptyStreet(boardKey(next.table.board)) });
    const street = STREET_NAMES.includes(action.street) ? action.street : "turn";
    const target = record[street] || emptyStreet(boardKey(next.table.board));
    const wasSettled = target.status === "settled";
    const previousBoardKey = target.boardKey;
    if (action.field === "outs") {
      if (action.value === "" || action.value === null || action.value === undefined) {
        target.outs = null;
        target.outCards = [];
        target.odds = Core.validInsuranceOdds(target.oddsOverride);
        target.status = wasSettled ? "settled" : "unseen";
        if (wasSettled) target.resolvedStatus = "needsConfirm";
        else delete target.resolvedStatus;
        target.source = "manual";
        target.boardKey = boardKey(next.table.board);
      } else {
        const parsed = Core.parseOuts(action.value);
        if (!parsed.valid) return { ...current, error: parsed.message || "invalid-outs" };
        target.outs = parsed.value;
        target.outCards = [];
        target.odds = Core.validInsuranceOdds(target.oddsOverride) || Core.oddsForOuts(parsed.value);
        if (wasSettled) target.resolvedStatus = "needsConfirm";
      }
    } else if (action.field === "buy") {
      target.buy = target.status === "notApplicable"
        ? 0
        : cappedStreetBuy(action.value, record.coverage, target.odds);
    } else if (action.field === "odds") {
      const selected = Core.validInsuranceOdds(action.value);
      if (action.value !== "" && Number(action.value) !== 0 && !selected) return { ...current, error: "invalid-odds" };
      target.oddsOverride = selected;
      target.odds = selected || Core.oddsForOuts(target.outs || 0);
    } else if (action.field === "status") {
      target.status = ["hit", "safe", "unseen", "estimated", "current", "settled", "needsConfirm"].includes(action.value)
        ? action.value : target.status;
      if (wasSettled) {
        target.status = "settled";
        target.resolvedStatus = action.value === "hit" || action.value === "safe" ? action.value : "needsConfirm";
      } else if (action.value === "hit" || action.value === "safe") target.resolvedStatus = action.value;
    }
    if (target.status === "notApplicable") {
      target.oddsOverride = 0;
      target.odds = 0;
      target.buy = 0;
    } else {
      target.buy = cappedStreetBuy(target.buy, record.coverage, target.odds);
    }
    target.source = "manual";
    target.boardKey = wasSettled && previousBoardKey ? previousBoardKey : boardKey(next.table.board);
    record[street] = target;
    if (target.status === "settled") syncHistorySnapshot(next, action.poolId, String(action.buyer), street, target);
    next.error = null;
    return next;
  }
  if (type === "APPLY_AUTO_OUTS") return applyAutomaticOuts(current, { forceAuto: true });
  return current;
}

function statusLabel(status) {
  return {
    unseen: "未执行",
    estimated: "当前估算",
    current: "当前估算",
    settled: "已结算",
    hit: "已爆",
    safe: "安全",
    needsConfirm: "待确认",
    notApplicable: "未参与"
  }[status] || "未执行";
}

function settledRecordSummary(turn, river, settlement) {
  const turnSettled = turn && turn.status === "settled";
  const riverSettled = river && river.status === "settled";
  // A turn hit is terminal.  A stale or manually edited river record may
  // still be marked settled, but its premium was never paid and must not leak
  // into the realized totals.
  const settledBuy = turnSettled && turn.resolvedStatus === "hit"
    ? settlement.turnBuy
    : (turnSettled ? settlement.turnBuy : 0) + (riverSettled ? settlement.riverBuy : 0);
  let settledReceipt = 0;
  let settledNet = 0;
  const turnResult = turn && turn.resolvedStatus;
  const riverResult = river && river.resolvedStatus;
  if (turnSettled && turnResult === "hit") {
    const row = settlement.rows.find((item) => item.key === "turnHit");
    settledReceipt = row ? row.receipt : settlement.turnPayout;
    settledNet = row ? row.net : settlement.turnPayout - settlement.stake;
  } else if (turnSettled && turnResult === "safe" && riverSettled && (riverResult === "hit" || riverResult === "safe")) {
    const row = settlement.rows.find((item) => item.key === (riverResult === "hit" ? "riverHit" : "bothSafe"));
    if (row) {
      settledReceipt = row.receipt;
      settledNet = row.net;
    }
  }
  return { settledBuy, settledReceipt, settledNet };
}

function selectInsuranceView(state) {
  const current = state || createRound();
  const board = boardPrefix(current.table.board);
  const allPlayers = normalizePlayers(current.table && current.table.players);
  const players = allPlayers.filter((player) => player.cards.every(Boolean));
  const pools = getPools(current, players);
  const hand = board.length >= 3 && players.length ? HandAnalysis.calculateHandOuts(board, players) : null;
  const equityBreakdown = board.length >= 3 && players.length
    ? HandAnalysis.calculateEquityBreakdown(board, players)
    : { byPlayer: {} };
  const multiSide = current.poolMode === "multi"
    ? Core.buildSidePots(current.inputs.contributions || {}, PLAYER_KEYS)
    : { returned: 0 };
  const effective = current.poolMode === "multi"
    ? Core.sideEffectiveStakes(current.inputs.contributions || {}, multiSide.highest, multiSide.returned, PLAYER_KEYS)
    : {};
  const preparedCards = board.length >= 3 && players.length ? Core.prepareCardState(board, players) : null;
  const firstUnknownCards = Math.max(0, preparedCards ? preparedCards.remainingCount : 47);
  const secondUnknownCards = Math.max(0, firstUnknownCards - (board.length === 3 ? 1 : 0));
  const playerStats = allPlayers.map((player) => {
    const stat = hand && hand.stats[player.key];
    const equity = equityBreakdown.byPlayer[player.key] || { win: 0, tie: 0, lose: 0, share: 0 };
    const allIn = current.poolMode === "multi"
      ? asAmount(current.inputs.contributions && current.inputs.contributions[player.key])
      : player.key === "A" ? asAmount(current.inputs.stake) : 0;
    const actualInPot = current.poolMode === "multi" ? asAmount(effective[player.key]) : allIn;
    return {
      key: player.key,
      cards: player.cards.slice(),
      rank: Number(current.inputs.rankings && current.inputs.rankings[player.key]) || 0,
      currentStatus: stat ? stat.currentStatus : "待输入",
      winOuts: stat ? stat.winCards.length : 0,
      tieOuts: stat ? stat.tieCards.length : 0,
      lossOuts: stat ? stat.lossCards.length : 0,
      nextOuts: stat ? Core.normalizedOuts(stat.lossCards.length, 0) : 0,
      nextOutCards: stat ? stat.lossCards.slice() : [],
      equity: equity.share,
      equityBreakdown: equity,
      financial: {
        allIn,
        actualInPot,
        returned: Math.max(0, allIn - actualInPot),
        plannedBuy: 0,
        expectedNet: 0
      }
    };
  });
  let summary = {
    totalAllIn: allPlayers.reduce((sum, player) => sum + playerStats.find((item) => item.key === player.key).financial.allIn, 0),
    totalActualInPot: allPlayers.reduce((sum, player) => sum + playerStats.find((item) => item.key === player.key).financial.actualInPot, 0),
    returned: asAmount(multiSide.returned),
    plannedBuy: 0,
    settledBuy: 0,
    settledReceipt: 0,
    settledNet: 0,
    expectedNet: 0,
    expectedNoInsurance: 0,
    worstNet: 0,
    bestNet: 0,
    strategyEV: { noInsurance: 0, turnOnly: 0, bothStreets: 0 }
  };
  const poolViews = pools.map((pool) => {
    const leaders = currentLeaders(current, board, players, pool);
    const records = current.insuranceByPool[pool.id] || {};
    const buyerKeys = [...new Set([...leaders, ...Object.keys(current.insuranceByPool[pool.id] || {})])];
    const poolSummary = {
      plannedBuy: 0,
      settledBuy: 0,
      settledReceipt: 0,
      settledNet: 0,
      expectedReceipt: 0,
      expectedNoInsurance: 0,
      expectedNet: 0,
      worstNet: 0,
      bestNet: 0,
      strategyEV: { noInsurance: 0, turnOnly: 0, bothStreets: 0 }
    };
    const buyers = buyerKeys.map((buyer) => {
      const record = records[buyer] || { turn: emptyStreet(boardKey(current.table.board)), river: emptyStreet(boardKey(current.table.board)) };
      const turn = record.turn || emptyStreet(boardKey(current.table.board));
      const river = record.river || emptyStreet(boardKey(current.table.board));
      const stake = current.poolMode === "multi" ? asAmount(pool.stakeByPlayer && pool.stakeByPlayer[buyer]) : asAmount(current.inputs.stake);
      const coverage = asAmount(record.coverage) || asAmount(pool.amount) / Math.max(leaders.length, 1);
      const turnForSettlement = turn.status === "notApplicable"
        ? { ...turn, outs: 0, buy: 0, status: "safe" }
        : turn.status === "settled" ? { ...turn, status: turn.resolvedStatus || "safe" } : turn;
      const riverForSettlement = river.status === "settled" ? { ...river, status: river.resolvedStatus || "safe" } : river;
      const riverForSettlementFinal = river.status === "notApplicable"
        ? { ...river, outs: 0, buy: 0, status: "safe" }
        : riverForSettlement;
      const settlement = Core.calculateTwoStreetSettlement({
        coverage,
        stake,
        turn: turnForSettlement,
        river: riverForSettlementFinal,
        firstUnknownCards,
        secondUnknownCards
      });
      const strategySettlement = (turnBuy, riverBuy) => Core.calculateTwoStreetSettlement({
        coverage,
        stake,
        turn: { ...turnForSettlement, buy: turnBuy },
        river: { ...riverForSettlementFinal, buy: riverBuy },
        firstUnknownCards,
        secondUnknownCards
      });
      const strategyEV = {
        noInsurance: strategySettlement(0, 0).expectedNet,
        turnOnly: strategySettlement(turn.buy, 0).expectedNet,
        bothStreets: settlement.expectedNet
      };
      const settled = settledRecordSummary(turn, river, settlement);
      if (leaders.includes(buyer)) {
        summary.plannedBuy += settlement.plannedBuy;
        summary.expectedNet += settlement.expectedNet;
        summary.expectedNoInsurance += settlement.expectedNoInsurance;
        summary.worstNet += settlement.worstNet;
        summary.bestNet += settlement.bestNet;
        summary.strategyEV.noInsurance += strategyEV.noInsurance;
        summary.strategyEV.turnOnly += strategyEV.turnOnly;
        summary.strategyEV.bothStreets += strategyEV.bothStreets;
        summary.settledBuy += settled.settledBuy;
        summary.settledReceipt += settled.settledReceipt;
        summary.settledNet += settled.settledNet;
        poolSummary.plannedBuy += settlement.plannedBuy;
        poolSummary.expectedReceipt += settlement.expectedReceipt;
        poolSummary.expectedNoInsurance += settlement.expectedNoInsurance;
        poolSummary.expectedNet += settlement.expectedNet;
        poolSummary.worstNet += settlement.worstNet;
        poolSummary.bestNet += settlement.bestNet;
        poolSummary.strategyEV.noInsurance += strategyEV.noInsurance;
        poolSummary.strategyEV.turnOnly += strategyEV.turnOnly;
        poolSummary.strategyEV.bothStreets += strategyEV.bothStreets;
        poolSummary.settledBuy += settled.settledBuy;
        poolSummary.settledReceipt += settled.settledReceipt;
        poolSummary.settledNet += settled.settledNet;
        const player = playerStats.find((item) => item.key === buyer);
        if (player) {
          player.financial.plannedBuy += settlement.plannedBuy;
          player.financial.expectedNet += settlement.expectedNet;
        }
      } else {
        const terminalTurn = turn.status === "settled" && turn.resolvedStatus === "hit";
        const completedRiver = turn.status === "settled" && turn.resolvedStatus === "safe"
          && river.status === "settled" && (river.resolvedStatus === "hit" || river.resolvedStatus === "safe");
        if (terminalTurn || (completedRiver && turn.resolvedStatus !== "needsConfirm" && river.resolvedStatus !== "needsConfirm")) {
          const settledBuy = settlement.rows.reduce((sum, row) => sum + row.buy, 0);
          const settledReceipt = settlement.rows.reduce((sum, row) => sum + row.receipt, 0);
          const settledNet = settlement.rows.reduce((sum, row) => sum + row.net, 0);
          summary.plannedBuy += settledBuy;
          summary.settledBuy += settledBuy;
          summary.settledReceipt += settledReceipt;
          summary.settledNet += settledNet;
          summary.expectedNet += settledNet;
          summary.expectedNoInsurance += settlement.expectedNoInsurance;
          summary.worstNet += settledNet;
          summary.bestNet += settledNet;
          poolSummary.plannedBuy += settledBuy;
          poolSummary.settledBuy += settledBuy;
          poolSummary.settledReceipt += settledReceipt;
          poolSummary.settledNet += settledNet;
          poolSummary.expectedNoInsurance += settlement.expectedNoInsurance;
          poolSummary.expectedNet += settledNet;
          poolSummary.worstNet += settledNet;
          poolSummary.bestNet += settledNet;
          const player = playerStats.find((item) => item.key === buyer);
          if (player) {
            player.financial.plannedBuy += settledBuy;
            player.financial.expectedNet += settledNet;
          }
        }
      }
      return {
        buyer,
        recommended: leaders.length === 1 && leaders.includes(buyer),
        historicalOnly: !leaders.includes(buyer),
        turn: { ...turn, statusLabel: turn.resolvedStatus === "needsConfirm" ? "待确认" : statusLabel(turn.status), refreshLabel: "", payout: settlement.turnPayout },
        river: {
          ...river,
          statusLabel: river.resolvedStatus === "needsConfirm" ? "待确认" : statusLabel(river.status),
          refreshLabel: river.status === "estimated" ? "转牌后刷新" : "",
          payout: settlement.riverPayout
        },
        settlement: {
          probabilities: settlement.probabilities,
          rows: settlement.rows,
          plannedBuy: settlement.plannedBuy,
          expectedNet: settlement.expectedNet,
          expectedNoInsurance: settlement.expectedNoInsurance,
          worstNet: settlement.worstNet,
          bestNet: settlement.bestNet
        },
        strategyEV
      };
    });
    return {
      id: pool.id,
      label: pool.label,
      amount: asAmount(pool.amount),
      eligible: pool.eligible.slice(),
      leaders,
      buyers,
      summary: poolSummary
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    branchId: current.branchId,
    branchKey: current.round.branchKey,
    street: board.length <= 3 ? "flop" : board.length === 4 ? "turn" : "river",
    playerCount: allPlayers.length,
    board: current.table.board.slice(),
    players: playerStats,
    pools: poolViews,
    history: clone(current.round.history),
    summary,
    error: current.error || ""
  };
}

module.exports = {
  SCHEMA_VERSION,
  PLAYER_KEYS,
  createRound,
  reduceRound,
  selectInsuranceView,
  deriveInsuranceView: selectInsuranceView,
  stablePoolId,
  isStrictAppend,
  boardPrefix,
  boardKey
};
