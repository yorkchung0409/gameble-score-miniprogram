/*
 * Pure insurance state and view model.
 *
 * This module intentionally has no wx/document/window dependency.  It is the
 * contract between the mini-program pages and the poker calculation core.
 */
const Core = require("../poker-core");
const { maximumBuy } = require("./buy-amount");
const HandAnalysis = require("../app-hand-analysis");
const { classifyOuts, selectedCards } = require("./outs-selection");
const { calculateSettlement } = require("./selective-settlement");

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

function asRakeRate(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : 0;
}

function rakedSidePots(inputs) {
  const side = Core.buildSidePots(inputs.contributions || {}, PLAYER_KEYS);
  const rate = asRakeRate(inputs.rakeRate);
  const pots = side.pots.map(pot => {
    // 扣水后的每个底池按十位四舍五入；差额归入该池的抽水金额。
    const amount = rate > 0 ? Math.round((pot.amount * (100 - rate) / 100) / 10) * 10 : pot.amount;
    return { ...pot, grossAmount: pot.amount, amount, rakeAmount: Number((pot.amount - amount).toFixed(2)) };
  });
  return { ...side, pots };
}

function rakeLocked(state) {
  return state.poolMode === "multi" && Object.values(state.insuranceByPool || {}).some(buyers =>
    Object.values(buyers || {}).some(record => STREET_NAMES.some(street => record[street] && record[street].status === "settled")));
}

function cappedStreetBuy(value, coverage, odds) {
  const multiplier = Number(odds);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return Math.min(Math.ceil(asAmount(value)), maximumBuy(coverage, multiplier));
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
    rankings: inputs.rankings || {},
    // Keep zero-rake branch keys compatible with existing local drafts.
    ...(stateLike.poolMode === "multi" && asRakeRate(inputs.rakeRate) > 0 ? { rakeRate: asRakeRate(inputs.rakeRate) } : {})
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
  const side = rakedSidePots(inputs);
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
  // Once the deciding card is known, only the pre-deal snapshot is valid.
  // Recalculate/auto must never price turn insurance using four board cards,
  // or river insurance using five, even for an existing notApplicable record.
  if (existing && existing.status === "settled") return existing;
  const decidingCardKnown = board.length >= (street === "turn" ? 4 : 5);
  if (decidingCardKnown) return emptyStreet(key, "notApplicable");
  const analysis = Array.isArray(participantKeys)
    ? HandAnalysis.calculateParticipantOuts(board, players, participantKeys, buyer)
    : HandAnalysis.calculateHandOuts(board, players);
  const stat = analysis.stats && analysis.stats[buyer];
  const allOutCards = Array.isArray(analysis.outCards)
    ? analysis.outCards.slice()
    : stat && Array.isArray(stat.lossCards) ? stat.lossCards.slice() : [];
  const keepSelection = !options.resetSelection && existing && existing.outsSource === "auto"
    && existing.selectionApplied && existing.boardKey === key;
  const outCards = keepSelection ? selectedCards(allOutCards, existing.outCards) : allOutCards.slice();
  const outs = Core.normalizedOuts(outCards.length, 0);
  const oddsOverride = forceAuto ? 0 : existing ? Core.validInsuranceOdds(existing.oddsOverride) : 0;
  const value = existing && existing.status === "settled" ? existing : {
    outs,
    outCards,
    allOutCards,
    outGroups: classifyOuts(board, players, participantKeys, buyer, allOutCards),
    selectionApplied: Boolean(keepSelection),
    odds: oddsOverride || Core.oddsForOuts(outs),
    oddsOverride,
    // A recalculation owns outs and odds. The premium is a separate player decision.
    buy: existing ? asAmount(existing.buy) : 0,
    status: street === "river" && board.length === 3 ? "estimated" : "current",
    boardKey: key,
    outsSource: "auto",
    sourceBoard: board.slice(),
    sourceHand: (players.find(player => player.key === buyer) || { cards: [] }).cards.slice(),
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
      const streetOptions = street => ({ ...options, resetSelection: Boolean(options.resetSelection
        && (!options.poolId || options.poolId === pool.id && options.buyer === buyer && options.street === street)) });
      const previous = next.insuranceByPool[pool.id] && next.insuranceByPool[pool.id][buyer];
      const oldTurn = previous && previous.turn;
      const oldRiver = previous && previous.river;
      const turn = board.length >= 4 && oldTurn && !options.forceAuto
        ? oldTurn
        : autoStreet(board, players, buyer, "turn", oldTurn, participantKeys, streetOptions("turn"));
      const turnHitTerminal = turn.status === "settled" && ["hit", "uncovered"].includes(turn.resolvedStatus);
      poolState[buyer] = {
        coverage: asAmount(pool.amount) / Math.max(leaders.length, 1),
        turn,
        river: turnHitTerminal && !(oldRiver && oldRiver.status === "settled")
          ? emptyStreet(boardKey(board), "notApplicable")
          : board.length >= 5 && oldRiver && oldRiver.status === "settled" && !options.forceAuto
            ? oldRiver
            : autoStreet(board, players, buyer, "river", oldRiver, participantKeys, streetOptions("river"))
      };
    });
    Object.values(poolState).forEach((record) => {
      STREET_NAMES.forEach((street) => {
        const value = record[street];
        if (value && value.status !== "settled") value.buy = cappedStreetBuy(value.buy, record.coverage, value.odds);
      });
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
    oddsConfig: Array.isArray(input.oddsConfig) && input.oddsConfig.length === Core.ODDS.length
      ? input.oddsConfig.map((value, index) => Number(value) > 0 ? Number(value) : Core.ODDS[index])
      : Core.ODDS.slice(),
    table,
    inputs: {
      coverage: asAmount(input.coverage),
      stake: asAmount(input.stake),
      rakeRate: asRakeRate(input.rakeRate),
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
      const resolvedStatus = ["hit", "safe", "uncovered"].includes(value.status)
        ? value.status
        : value.source === "manual" && !hasOutCards && !Array.isArray(value.allOutCards)
          ? "needsConfirm"
          : hasOutCards && value.outCards.includes(resolvedCard)
            ? "hit"
            : Array.isArray(value.allOutCards) && value.allOutCards.includes(resolvedCard) ? "uncovered" : "safe";
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
  if (type === "SET_PLAYER_CARDS" || type === "SET_BOARD_CARDS") {
    const isBoard = type === "SET_BOARD_CARDS";
    if (!Array.isArray(action.cards) || action.cards.length > (isBoard ? 5 : 2)) return { ...current, error: "invalid-card" };
    const parsed = action.cards.map((card) => Core.parseCard(card));
    if (parsed.some((card) => !card)) return { ...current, error: "invalid-card" };
    const cards = parsed.map((card) => card.value);
    const table = clone(current.table);
    if (isBoard) table.board = normalizeBoard(cards);
    else {
      const player = table.players.find((item) => item.key === String(action.player));
      if (!player) return { ...current, error: "unknown-player" };
      player.cards = [cards[0] || "", cards[1] || ""];
    }
    const allCards = table.board.filter(Boolean).concat(table.players.flatMap((player) => player.cards.filter(Boolean)));
    if (allCards.length !== new Set(allCards).size) return { ...current, error: "duplicate-card" };
    if (JSON.stringify(table) === JSON.stringify(current.table)) return { ...current, error: null };
    const previous = boardPrefix(current.table.board);
    // Preserve street snapshots when adding turn/river, after validating the complete selection.
    if (isBoard && cards.length > previous.length && previous.every((card, index) => cards[index] === card)) {
      let next = current;
      for (let index = previous.length; index < cards.length; index += 1) next = setBoardCard(next, index, cards[index]);
      return next;
    }
    return startNewBranch(current, table, null, null);
  }
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
  if (type === "SET_RAKE_RATE") {
    const value = Number(action.value);
    if (!Number.isFinite(value) || value < 0 || value > 100) return { ...current, error: "请输入 0–100 的抽水比例" };
    if (value === asRakeRate(current.inputs.rakeRate)) return { ...current, error: null };
    if (rakeLocked(current)) return { ...current, error: "发牌后抽水比例已锁定，请重置牌局后修改" };
    const next = clone(current);
    next.inputs.rakeRate = value;
    next.round.branchKey = handKey(next);
    // Reprice the pots without changing card selections or manual odds tiers.
    const players = completePlayers(next);
    const board = boardPrefix(next.table.board);
    (next.poolMode === "multi" ? getPools(next, players) : []).forEach(pool => {
      const records = Object.values(next.insuranceByPool[pool.id] || {});
      if (!records.length) return;
      const share = pool.amount / Math.max(currentLeaders(next, board, players, pool).length, 1);
      records.forEach(record => {
        record.coverage = share;
        STREET_NAMES.forEach(street => {
          if (record[street] && record[street].status !== "settled") record[street].buy = cappedStreetBuy(record[street].buy, share, record[street].odds);
        });
      });
    });
    next.error = null;
    return next;
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
  if (type === "SET_ODDS_CONFIG") {
    const values = Array.isArray(action.values) ? action.values.map(Number) : [];
    if (values.length !== Core.ODDS.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
      return { ...current, error: "invalid-odds-config" };
    }
    const next = clone(current);
    next.oddsConfig = values.slice();
    Object.values(next.insuranceByPool || {}).forEach((buyers) => Object.values(buyers || {}).forEach((record) => {
      ["turn", "river"].forEach((street) => {
        const target = record && record[street];
        const outs = Number(target && target.outs);
        if (!target || target.status === "settled" || !Number.isInteger(outs) || outs < 1 || outs > values.length) return;
        target.odds = values[outs - 1];
        if (target.oddsOverride) target.oddsOverride = values[outs - 1];
        target.buy = cappedStreetBuy(target.buy, record.coverage, target.odds);
      });
    }));
    next.error = null;
    return next;
  }
  if (type === "SELECT_OUTS") {
    const record = current.insuranceByPool[action.poolId] && current.insuranceByPool[action.poolId][action.buyer];
    const target = record && record[action.street];
    if (!target || !["current", "estimated"].includes(target.status) || target.outsSource !== "auto") return current;
    const next = clone(current);
    const value = next.insuranceByPool[action.poolId][action.buyer][action.street];
    value.allOutCards = (target.allOutCards || target.outCards || []).slice();
    value.outCards = selectedCards(value.allOutCards, action.cards);
    value.selectionApplied = true;
    value.outs = Core.normalizedOuts(value.outCards.length, 0);
    value.oddsOverride = 0;
    value.odds = Core.oddsForOuts(value.outs);
    value.buy = cappedStreetBuy(value.buy, record.coverage, value.odds);
    next.error = null;
    return next;
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
      delete target.allOutCards;
      delete target.outGroups;
      delete target.selectionApplied;
      target.outsSource = "manual";
      delete target.sourceBoard;
      delete target.sourceHand;
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
      if (selected) {
        delete target.allOutCards;
        delete target.outGroups;
        delete target.selectionApplied;
        target.outsSource = "manual";
        delete target.sourceBoard;
        delete target.sourceHand;
        // A manual slider position represents one consistent odds/outs pair.
        const requestedOuts = Number(action.outs);
        target.outs = Number.isInteger(requestedOuts) && requestedOuts >= 1 && requestedOuts <= 17
          && Core.ODDS[requestedOuts - 1] === selected ? requestedOuts : Core.ODDS.indexOf(selected) + 1;
        target.outCards = [];
        target.source = "manual";
        target.boardKey = boardKey(next.table.board);
        if (wasSettled) target.resolvedStatus = "needsConfirm";
      }
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
  if (type === "APPLY_AUTO_OUTS") return applyAutomaticOuts(current, { forceAuto: true, resetSelection: Boolean(action.resetSelection), poolId: action.poolId, buyer: action.buyer, street: action.street });
  return current;
}

function statusLabel(status) {
  return {
    unseen: "未执行",
    estimated: "当前估算",
    current: "当前估算",
    settled: "已结算",
    hit: "已爆",
    uncovered: "未投保牌命中",
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
  const settledBuy = turnSettled && ["hit", "uncovered"].includes(turn.resolvedStatus)
    ? settlement.turnBuy
    : (turnSettled ? settlement.turnBuy : 0) + (riverSettled ? settlement.riverBuy : 0);
  let settledReceipt = 0;
  let settledNet = 0;
  const turnResult = turn && turn.resolvedStatus;
  const riverResult = river && river.resolvedStatus;
  if (turnSettled && ["hit", "uncovered"].includes(turnResult)) {
    const row = settlement.rows.find((item) => item.key === (turnResult === "hit" ? "turnHit" : "turnUncovered"));
    settledReceipt = row ? row.receipt : settlement.turnPayout;
    settledNet = row ? row.net : settlement.turnPayout - settlement.stake;
  } else if (turnSettled && turnResult === "safe" && riverSettled && ["hit", "safe", "uncovered"].includes(riverResult)) {
    const row = settlement.rows.find((item) => item.key === (riverResult === "hit" ? "riverHit" : riverResult === "uncovered" ? "riverUncovered" : "bothSafe"));
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
    ? rakedSidePots(current.inputs)
    : { returned: 0, pots: [] };
  const rakeRate = current.poolMode === "multi" ? asRakeRate(current.inputs.rakeRate) : 0;
  const totalRake = Number(multiSide.pots.reduce((sum, pot) => sum + pot.rakeAmount, 0).toFixed(2));
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
    // Show settled purchasers in deal order before the new street's leader.
    const settledBuyers = (current.round.history || [])
      .filter((entry) => entry.poolId === pool.id).map((entry) => entry.buyer);
    const buyerKeys = [...new Set([...settledBuyers, ...leaders, ...Object.keys(records)])];
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
      const coverage = Number.isFinite(Number(record.coverage)) ? asAmount(record.coverage) : asAmount(pool.amount) / Math.max(leaders.length, 1);
      const turnForSettlement = turn.status === "notApplicable"
        ? { ...turn, outs: 0, buy: 0, status: "safe" }
        : turn.status === "settled" ? { ...turn, status: turn.resolvedStatus || "safe" } : turn;
      const riverForSettlement = river.status === "settled" ? { ...river, status: river.resolvedStatus || "safe" } : river;
      const riverForSettlementFinal = river.status === "notApplicable"
        ? { ...river, outs: 0, buy: 0, status: "safe" }
        : riverForSettlement;
      const settlement = calculateSettlement({
        coverage,
        stake,
        turn: turnForSettlement,
        river: riverForSettlementFinal,
        firstUnknownCards,
        secondUnknownCards
      });
      const strategySettlement = (turnBuy, riverBuy) => calculateSettlement({
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
        const terminalTurn = turn.status === "settled" && ["hit", "uncovered"].includes(turn.resolvedStatus);
        const completedRiver = turn.status === "settled" && turn.resolvedStatus === "safe"
          && river.status === "settled" && ["hit", "safe", "uncovered"].includes(river.resolvedStatus);
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
        turn: { ...turn, statusLabel: turn.resolvedStatus === "needsConfirm" ? "待确认" : statusLabel(turn.status), refreshLabel: "", payout: turn.resolvedStatus === "uncovered" ? 0 : settlement.turnPayout },
        river: {
          ...river,
          statusLabel: river.resolvedStatus === "needsConfirm" ? "待确认" : statusLabel(river.status),
          refreshLabel: river.status === "estimated" ? "转牌后刷新" : "",
          payout: river.resolvedStatus === "uncovered" ? 0 : settlement.riverPayout
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
      grossAmount: asAmount(pool.grossAmount === undefined ? pool.amount : pool.grossAmount),
      rakeAmount: Number(pool.rakeAmount) || 0,
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
    rakeRate,
    totalRake,
    rakeLocked: rakeLocked(current),
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
