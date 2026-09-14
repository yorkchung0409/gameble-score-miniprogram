const STORAGE_KEY = "gameble-score:insurance-round:v1";
const LEGACY_STORAGE_KEY = "gameble-score:insurance-draft:v1";
const Insurance = require("../domain/insurance-engine");
const Core = require("../poker-core");

const PLAYER_KEYS = ["A", "B", "C", "D"];

function finiteAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function cappedStreetBuy(value, coverage, odds) {
  const multiplier = Number(odds);
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return Math.min(finiteAmount(value), finiteAmount(coverage) / multiplier);
}

function normalizePreviewStreet(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const maxIndex = Math.max(1, Core.ODDS.length);
  const oddsIndex = Math.max(1, Math.min(maxIndex, Math.trunc(Number(source.oddsIndex)) || 1));
  return { oddsIndex, buy: finiteAmount(source.buy) };
}

function normalizePresentation(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const buyer = String(source.previewBuyer || "A");
  return {
    isCalculated: Boolean(source.isCalculated),
    previewBuyer: PLAYER_KEYS.includes(buyer) ? buyer : "A",
    previewTurn: normalizePreviewStreet(source.previewTurn),
    previewRiver: normalizePreviewStreet(source.previewRiver)
  };
}

function firstDefined(values, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== "" && values[key] !== null && values[key] !== undefined) {
      return values[key];
    }
  }
  return "";
}

function normalizeLegacyCard(value) {
  if (!value) return "";
  const parsed = Core.parseCard(value);
  return parsed ? parsed.value : "";
}

function draftBoardKey(board) {
  if (!Array.isArray(board)) return "";
  const values = [];
  for (const raw of board) {
    if (!raw) break;
    const card = normalizeLegacyCard(raw);
    if (!card) return "!invalid";
    values.push(card);
  }
  return values.join("|");
}

const CURRENT_STREET_STATUSES = new Set(["unseen", "estimated", "current", "settled", "notApplicable", "needsConfirm", "hit", "safe"]);
const CURRENT_RESOLVED_STATUSES = new Set(["hit", "safe", "needsConfirm"]);

function currentStreetFallback(boardKey, status = "unseen") {
  return { outs: null, outCards: [], odds: 0, oddsOverride: 0, buy: 0, status, boardKey, source: "auto" };
}

function normalizeCurrentStreet(raw, fallback, boardKey) {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = fallback && typeof fallback === "object" ? fallback : currentStreetFallback(boardKey);
  const rawCards = Array.isArray(source.outCards) ? source.outCards : [];
  const outCards = [...new Set(rawCards.map(normalizeLegacyCard).filter(Boolean))];
  const hasOuts = Object.prototype.hasOwnProperty.call(source, "outs")
    && source.outs !== null && source.outs !== undefined && String(source.outs).trim() !== "";
  const parsedOuts = hasOuts ? Number(source.outs) : NaN;
  const fallbackOuts = Number(base.outs);
  const outs = Number.isFinite(parsedOuts)
    ? Core.normalizedOuts(parsedOuts, 0)
    : outCards.length || (Number.isFinite(fallbackOuts) ? Core.normalizedOuts(fallbackOuts, 0) : null);
  const status = CURRENT_STREET_STATUSES.has(source.status) ? source.status : (base.status || "unseen");
  const rawOddsOverride = Object.prototype.hasOwnProperty.call(source, "oddsOverride") ? source.oddsOverride : base.oddsOverride;
  const oddsOverride = Core.validInsuranceOdds(rawOddsOverride);
  const result = {
    ...base,
    outs,
    outCards,
    odds: oddsOverride || Core.oddsForOuts(outs || 0),
    oddsOverride,
    buy: finiteAmount(Object.prototype.hasOwnProperty.call(source, "buy") ? source.buy : base.buy),
    status,
    boardKey: typeof source.boardKey === "string" && source.boardKey ? source.boardKey : (base.boardKey || boardKey),
    source: source.source === "manual" ? "manual" : "auto"
  };
  const resolvedStatus = CURRENT_RESOLVED_STATUSES.has(source.resolvedStatus)
    ? source.resolvedStatus
    : CURRENT_RESOLVED_STATUSES.has(base.resolvedStatus) ? base.resolvedStatus : "";
  delete result.resolvedStatus;
  if (resolvedStatus) result.resolvedStatus = resolvedStatus;
  if (result.status === "notApplicable") {
    result.outs = null;
    result.outCards = [];
    result.odds = 0;
    result.oddsOverride = 0;
    result.buy = 0;
  }
  return result;
}

function normalizeCurrentInsurance(rawInsurance, seed) {
  const source = rawInsurance && typeof rawInsurance === "object" ? rawInsurance : {};
  const generated = seed.insuranceByPool && typeof seed.insuranceByPool === "object" ? seed.insuranceByPool : {};
  const boardKey = Array.isArray(seed.table && seed.table.board) ? seed.table.board.filter(Boolean).join("|") : "";
  const poolIds = [...new Set([...Object.keys(generated), ...Object.keys(source)])];
  return Object.fromEntries(poolIds.map((poolId) => {
    const rawPool = source[poolId] && typeof source[poolId] === "object" ? source[poolId] : {};
    const generatedPool = generated[poolId] && typeof generated[poolId] === "object" ? generated[poolId] : {};
    const buyers = [...new Set([...Object.keys(generatedPool), ...Object.keys(rawPool)])];
    return [poolId, Object.fromEntries(buyers.map((buyer) => {
      const rawRecord = rawPool[buyer] && typeof rawPool[buyer] === "object" ? rawPool[buyer] : {};
      const generatedRecord = generatedPool[buyer] && typeof generatedPool[buyer] === "object" ? generatedPool[buyer] : {};
      const fallbackTurn = generatedRecord.turn || currentStreetFallback(boardKey);
      const fallbackRiver = generatedRecord.river || currentStreetFallback(boardKey, "estimated");
      const coverage = finiteAmount(Object.prototype.hasOwnProperty.call(rawRecord, "coverage") ? rawRecord.coverage : generatedRecord.coverage);
      const turn = normalizeCurrentStreet(rawRecord.turn, fallbackTurn, boardKey);
      const river = normalizeCurrentStreet(rawRecord.river, fallbackRiver, boardKey);
      turn.buy = cappedStreetBuy(turn.buy, coverage, turn.odds);
      river.buy = cappedStreetBuy(river.buy, coverage, river.odds);
      return [buyer, {
        ...generatedRecord,
        ...rawRecord,
        coverage,
        turn,
        river
      }];
    }))];
  }));
}

function normalizeCurrentHistory(rawHistory, insuranceByPool, boardKey) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory.map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const street = entry.street === "river" ? "river" : entry.street === "turn" ? "turn" : "";
    if (!street || entry.poolId === null || entry.poolId === undefined || entry.buyer === null || entry.buyer === undefined
      || !entry.snapshot || typeof entry.snapshot !== "object" || Array.isArray(entry.snapshot)) return null;
    const pool = insuranceByPool[String(entry.poolId)] || {};
    const record = pool[String(entry.buyer)] || {};
    const fallback = record[street] || currentStreetFallback(boardKey, "settled");
    const snapshot = normalizeCurrentStreet(entry.snapshot, fallback, boardKey);
    snapshot.status = "settled";
    return {
      ...entry,
      poolId: String(entry.poolId),
      buyer: String(entry.buyer),
      street,
      boardKey: typeof entry.boardKey === "string" && entry.boardKey ? entry.boardKey : snapshot.boardKey,
      snapshot
    };
  }).filter(Boolean);
}

function normalizeLegacyCards(raw) {
  const cardValues = raw && raw.cardValues && typeof raw.cardValues === "object" ? raw.cardValues : {};
  const board = Array.from({ length: 5 }, (_, index) => normalizeLegacyCard(Array.isArray(cardValues.board) ? cardValues.board[index] : ""));
  const hands = cardValues.hands && typeof cardValues.hands === "object" ? cardValues.hands : {};
  return { board, hands };
}

function legacyPlayerCount(raw, hands) {
  const values = raw && raw.values && typeof raw.values === "object" ? raw.values : {};
  const requested = Number(firstDefined(values, ["handPlayerCount"]));
  const handKeys = PLAYER_KEYS.filter((key) => Array.isArray(hands[key]) && hands[key].some(Boolean)).length;
  return Math.min(4, Math.max(2, Number.isInteger(requested) && requested >= 2 ? requested : handKeys || 2));
}

function legacyPlayers(raw, cards) {
  const count = legacyPlayerCount(raw, cards.hands);
  return PLAYER_KEYS.slice(0, count).map((key) => ({
    key,
    cards: [
      normalizeLegacyCard(Array.isArray(cards.hands[key]) ? cards.hands[key][0] : ""),
      normalizeLegacyCard(Array.isArray(cards.hands[key]) ? cards.hands[key][1] : "")
    ]
  }));
}

function legacyStreetSnapshot(snapshot, street, board, fallback) {
  if (!snapshot || typeof snapshot !== "object") return fallback;
  const index = street === "turn" ? 3 : 4;
  const outCards = [...new Set((Array.isArray(snapshot.hitCards) ? snapshot.hitCards : snapshot.outCards || [])
    .map(normalizeLegacyCard).filter(Boolean))];
  const rawOuts = Number(snapshot.outs);
  const outs = Number.isFinite(rawOuts) ? Math.min(17, Math.max(0, Math.trunc(rawOuts))) : outCards.length;
  const sourceBoard = (Array.isArray(snapshot.sourceBoard) ? snapshot.sourceBoard : board)
    .map(normalizeLegacyCard).filter(Boolean).slice(0, street === "turn" ? 3 : 4);
  const dealt = board.length > index;
  let resolvedStatus = snapshot.resolvedStatus === "hit" || snapshot.resolvedStatus === "safe"
    ? snapshot.resolvedStatus
    : null;
  if (dealt) resolvedStatus = outCards.includes(board[index]) ? "hit" : "safe";
  const status = dealt ? "settled" : street === "river" && board.length === 3 ? "estimated" : "current";
  return {
    ...(fallback || {}),
    outs,
    outCards,
    odds: Core.oddsForOuts(outs),
    buy: finiteAmount(snapshot.buy),
    status,
    resolvedStatus: dealt ? resolvedStatus || "safe" : undefined,
    boardKey: sourceBoard.join("|"),
    source: "manual"
  };
}

function legacySideValue(sideState, player, pool, field) {
  if (!sideState || typeof sideState !== "object") return "";
  const eligible = Array.isArray(pool.eligible) ? pool.eligible.map(String).sort().join(",") : "";
  const candidates = [
    `${player}:${pool.from}-${pool.to}|${eligible}:${field}`,
    `${player}:${pool.from}-${pool.to}:${field}`,
    `${player}:${pool.index}:${field}`
  ];
  return firstDefined(sideState, candidates);
}

function legacySideHistory(raw, player, pool) {
  const side = raw && raw.insuranceHistory && raw.insuranceHistory.side;
  const playerHistory = side && typeof side === "object" ? side[player] : null;
  const pools = playerHistory && Array.isArray(playerHistory.pools) ? playerHistory.pools : [];
  return pools.find((item) => Number(item && item.potIndex) === Number(pool.index)) || null;
}

function migrateLegacySideRecords(state, raw, cards) {
  const sideInput = raw.sidePotInputState && typeof raw.sidePotInputState === "object" ? raw.sidePotInputState : {};
  const board = cards.board.filter(Boolean);
  const players = state.table.players;
  const pools = Insurance.selectInsuranceView(state).pools;
  const sourcePots = Core.buildSidePots(state.inputs.contributions || {}, PLAYER_KEYS).pots
    .map((pot) => ({ ...pot, id: Insurance.stablePoolId(pot) }));
  if (!pools.length) return state;
  pools.forEach((poolView) => {
    const pool = sourcePots.find((pot) => pot.id === poolView.id) || poolView;
    const generated = state.insuranceByPool[poolView.id] || {};
    const leaders = poolView.leaders || [];
    const candidates = [...new Set([...leaders, ...players.map((player) => player.key).filter((key) => legacySideHistory(raw, key, pool))])];
    candidates.forEach((buyer) => {
      const previous = generated[buyer] || {
        coverage: poolView.amount / Math.max(leaders.length, 1),
        turn: { outs: 0, outCards: [], odds: 0, buy: 0, status: board.length === 3 ? "current" : "settled", boardKey: board.slice(0, 3).join("|"), source: "auto" },
        river: { outs: 0, outCards: [], odds: 0, buy: 0, status: board.length === 3 ? "estimated" : board.length === 4 ? "current" : "settled", boardKey: board.slice(0, 4).join("|"), source: "auto" }
      };
      const history = legacySideHistory(raw, buyer, pool) || {};
      const turnOuts = legacySideValue(sideInput, buyer, pool, "turnOuts");
      const riverOuts = legacySideValue(sideInput, buyer, pool, "riverOuts");
      const turnBuy = legacySideValue(sideInput, buyer, pool, "turnBuy");
      const riverBuy = legacySideValue(sideInput, buyer, pool, "riverBuy");
      const turnCards = Array.isArray(history.turnLossCards) ? history.turnLossCards : previous.turn.outCards;
      const riverCards = Array.isArray(history.riverLossCards) ? history.riverLossCards : previous.river.outCards;
      const hasTurnData = turnOuts !== "" || turnBuy !== "" || Array.isArray(history.turnLossCards);
      const hasRiverData = riverOuts !== "" || riverBuy !== "" || Array.isArray(history.riverLossCards);
      const turnSnapshot = { ...history, outs: turnOuts === "" ? turnCards.length : turnOuts, buy: turnBuy === "" ? previous.turn.buy : turnBuy, hitCards: turnCards };
      const riverSnapshot = { ...history, outs: riverOuts === "" ? riverCards.length : riverOuts, buy: riverBuy === "" ? previous.river.buy : riverBuy, hitCards: riverCards };
      state.insuranceByPool[poolView.id] = state.insuranceByPool[poolView.id] || {};
      state.insuranceByPool[poolView.id][buyer] = {
        ...previous,
        coverage: previous.coverage || poolView.amount / Math.max(leaders.length, 1),
        turn: hasTurnData ? legacyStreetSnapshot(turnSnapshot, "turn", board, previous.turn) : previous.turn,
        river: hasRiverData ? legacyStreetSnapshot(riverSnapshot, "river", board, previous.river) : previous.river
      };
    });
  });
  return state;
}

function appendMigratedHistory(state) {
  const board = state.table.board.filter(Boolean);
  const history = [];
  Object.entries(state.insuranceByPool || {}).forEach(([poolId, buyers]) => {
    Object.entries(buyers || {}).forEach(([buyer, record]) => {
      ["turn", "river"].forEach((street) => {
        const value = record && record[street];
        const index = street === "turn" ? 3 : 4;
        if (!value || value.status !== "settled" || board.length <= index || (value.source !== "manual" && !value.resolvedStatus)) return;
        history.push({ poolId, buyer, street, boardKey: value.boardKey || board.slice(0, index).join("|"), snapshot: { ...value } });
      });
    });
  });
  state.round.history = history;
  return state;
}

function migrateLegacyDraft(raw) {
  const values = raw && raw.values && typeof raw.values === "object" ? raw.values : {};
  const cards = normalizeLegacyCards(raw);
  const players = legacyPlayers(raw, cards);
  const legacyMode = raw.poolMode || raw.mode;
  const legacyPoolMode = legacyMode === "side" || legacyMode === "multi" ? "multi" : "single";
  const contributions = PLAYER_KEYS.reduce((result, key) => {
    const value = firstDefined(values, [`sidePlayer${key}`]);
    if (value !== "") result[key] = finiteAmount(value);
    return result;
  }, {});
  const rankings = PLAYER_KEYS.reduce((result, key) => {
    const value = Number(firstDefined(values, [`sideRank${key}`]));
    if (Number.isInteger(value) && value >= 1 && value <= 4) result[key] = value;
    return result;
  }, {});
  const state = Insurance.createRound({
    poolMode: legacyPoolMode,
    board: cards.board,
    players,
    coverage: finiteAmount(firstDefined(values, ["doublePotInput", "potInput"])),
    stake: finiteAmount(firstDefined(values, ["doubleStakeInput", "stakeInput"])),
    contributions,
    rankings,
    playerCount: players.length
  });
  if (legacyPoolMode === "single") {
    const history = raw.insuranceHistory && typeof raw.insuranceHistory === "object" ? raw.insuranceHistory : {};
    state.insuranceByPool.single = state.insuranceByPool.single || {};
    const previous = state.insuranceByPool.single.A || {
      coverage: state.inputs.coverage,
      turn: { outs: 0, outCards: [], odds: 0, buy: 0, status: "current", boardKey: cards.board.slice(0, 3).join("|"), source: "auto" },
      river: { outs: 0, outCards: [], odds: 0, buy: 0, status: "estimated", boardKey: cards.board.slice(0, 3).join("|"), source: "auto" }
    };
    state.insuranceByPool.single.A = {
      ...previous,
      coverage: state.inputs.coverage,
      turn: legacyStreetSnapshot(history.turn, "turn", cards.board.filter(Boolean), previous.turn),
      river: legacyStreetSnapshot(history.river, "river", cards.board.filter(Boolean), previous.river)
    };
  } else {
    migrateLegacySideRecords(state, raw, cards);
  }
  return appendMigratedHistory(state);
}

function hydrateDraft(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.values && typeof raw.values === "object" || raw.cardValues && typeof raw.cardValues === "object") {
    try {
      return migrateLegacyDraft(raw);
    } catch (error) {
      return null;
    }
  }
  try {
    const table = raw.table && typeof raw.table === "object" ? raw.table : {};
    const inputs = raw.inputs && typeof raw.inputs === "object" ? raw.inputs : {};
    const currentMode = raw.poolMode || raw.mode;
    const seed = Insurance.createRound({
      poolMode: currentMode === "multi" || currentMode === "side" ? "multi" : "single",
      board: Array.isArray(table.board) ? table.board : [],
      players: Array.isArray(table.players) ? table.players : [],
      coverage: inputs.coverage,
      stake: inputs.stake,
      contributions: inputs.contributions,
      rankings: inputs.rankings
    });
    const rawBranchKey = raw.round && typeof raw.round.branchKey === "string" ? raw.round.branchKey : "";
    const rawRoundBoard = raw.round && Array.isArray(raw.round.board) ? raw.round.board : null;
    const boardMatches = !rawRoundBoard || draftBoardKey(rawRoundBoard) === draftBoardKey(seed.table.board);
    const branchMatches = (!rawBranchKey || rawBranchKey === seed.round.branchKey) && boardMatches;
    const insuranceByPool = branchMatches ? normalizeCurrentInsurance(raw.insuranceByPool, seed) : {};
    const history = branchMatches
      ? normalizeCurrentHistory(raw.round && raw.round.history, insuranceByPool, seed.table.board.filter(Boolean).join("|"))
      : [];
    return {
      ...seed,
      branchId: branchMatches && Number.isInteger(raw.branchId) && raw.branchId > 0 ? raw.branchId : seed.branchId,
      insuranceByPool,
      round: {
        ...seed.round,
        branchKey: branchMatches && rawBranchKey ? rawBranchKey : seed.round.branchKey,
        history
      },
      error: ""
    };
  } catch (error) {
    return null;
  }
}

function hydrateSavedDraft(raw) {
  const source = raw && typeof raw === "object" ? raw : null;
  const isEnvelope = Boolean(source && source.state && typeof source.state === "object");
  const state = hydrateDraft(isEnvelope ? source.state : raw);
  if (!state) return null;
  return {
    state,
    presentation: normalizePresentation(isEnvelope ? source.presentation : null)
  };
}

function loadDraft() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY);
    const current = hydrateSavedDraft(value);
    if (current) return current;
    const legacy = hydrateSavedDraft(wx.getStorageSync(LEGACY_STORAGE_KEY));
    if (legacy) {
      wx.setStorageSync(STORAGE_KEY, legacy);
      return legacy;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function saveDraft(state, presentation) {
  try {
    wx.setStorageSync(STORAGE_KEY, {
      state,
      presentation: normalizePresentation(presentation)
    });
  } catch (error) {
    // Storage failure must not block the calculator UI.
  }
}

function clearDraft() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
    wx.removeStorageSync(LEGACY_STORAGE_KEY);
  } catch (error) {
    // Storage failure must not block reset.
  }
}

module.exports = {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  loadDraft,
  saveDraft,
  clearDraft,
  hydrateDraft,
  hydrateSavedDraft,
  migrateLegacyDraft,
  normalizePresentation
};
