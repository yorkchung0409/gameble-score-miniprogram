(function initHandAnalysisModule(global) {
  const Core = typeof module === "object" && module.exports
    ? require("./poker-core")
    : global.PokerCore;
  const prepareCardState = Core.prepareCardState;
  const evaluateBest = Core.evaluateBest;
  const compareScore = Core.compareScore;

  function fallbackPlayers(players) {
    if (!Array.isArray(players)) return [];
    return players.filter((player) => player && typeof player === "object" && player.key !== null && player.key !== undefined)
      .map((player) => ({ key: String(player.key) }));
  }

  function emptyHandResult(players) {
    const stats = Object.fromEntries(fallbackPlayers(players).map((player) => [player.key, {
      key: player.key,
      currentRank: [0],
      currentStatus: "不可用",
      winCards: [],
      tieCards: [],
      lossCards: []
    }]));
    return {
      stats,
      remainingCount: 0,
      knownCount: 0,
      currentLeaders: [],
      valid: false
    };
  }

  function scoreLeaders(board, runout, players) {
    const scores = players.map((player) => evaluateBest([...board, ...runout, ...player.cards]));
    const best = scores.reduce((top, score) => (compareScore(score, top) > 0 ? score : top), scores[0] || [0]);
    const leaders = scores.map((score, index) => compareScore(score, best) === 0 ? index : -1).filter((index) => index >= 0);
    return { scores, leaders };
  }

  function calculateHandOuts(boardValues, players) {
    const state = prepareCardState(boardValues, players);
    if (!state || state.board.length < 3 || state.board.length > 5 || !state.players.length) return emptyHandResult(players);
    const { board, players: completePlayers, remaining, knownCards } = state;
    const current = scoreLeaders(board, [], completePlayers);
    const stats = Object.fromEntries(completePlayers.map((player, index) => [player.key, {
      key: player.key,
      currentRank: current.scores[index],
      currentStatus: current.leaders.length > 1 && current.leaders.includes(index) ? "平局领先" : current.leaders.includes(index) ? "领先" : "落后",
      winCards: [],
      tieCards: [],
      lossCards: []
    }]));
    // Five public cards is terminal; there is no next-street out to expose.
    if (board.length < 5) remaining.forEach((candidate) => {
      const result = scoreLeaders(board, [candidate], completePlayers);
      completePlayers.forEach((player, index) => {
        if (!result.leaders.includes(index)) stats[player.key].lossCards.push(candidate.value);
        else if (result.leaders.length === 1) stats[player.key].winCards.push(candidate.value);
        else stats[player.key].tieCards.push(candidate.value);
      });
    });
    return {
      stats,
      remainingCount: remaining.length,
      knownCount: knownCards.length,
      currentLeaders: current.leaders.map((index) => completePlayers[index].key),
      valid: true
    };
  }

  function calculateParticipantOuts(boardValues, players, participantKeys, buyerKey) {
    const state = prepareCardState(boardValues, players);
    if (!state || state.board.length < 3 || state.board.length > 5) return { outCards: [], remainingCount: 0, valid: false };
    const keys = Array.isArray(participantKeys) ? new Set(participantKeys.map(String)) : null;
    const participants = state.players.filter((player) => !keys || keys.has(player.key));
    const buyerIndex = participants.findIndex((player) => player.key === String(buyerKey));
    if (buyerIndex < 0 || participants.length < 2 || state.board.length >= 5) {
      return { outCards: [], remainingCount: state.remaining.length, valid: buyerIndex >= 0 };
    }
    const outCards = [];
    state.remaining.forEach((candidate) => {
      const result = scoreLeaders(state.board, [candidate], participants);
      if (!result.leaders.includes(buyerIndex)) outCards.push(candidate.value);
    });
    return { outCards, remainingCount: state.remaining.length, valid: true };
  }

  function calculateFinalEquities(boardValues, players) {
    const state = prepareCardState(boardValues, players);
    const keys = fallbackPlayers(players).map((player) => player.key);
    if (!state || state.board.length < 3 || state.board.length > 5 || !state.players.length) {
      return Object.fromEntries(keys.map((key) => [key, 0]));
    }
    const { board, players: completePlayers, remaining } = state;
    const equity = Object.fromEntries(completePlayers.map((player) => [player.key, 0]));
    let total = 0;
    const settle = (runout) => {
      const result = scoreLeaders(board, runout, completePlayers);
      result.leaders.forEach((index) => { equity[completePlayers[index].key] += 1 / result.leaders.length; });
      total += 1;
    };

    if (board.length >= 5) settle([]);
    else if (board.length === 4) remaining.forEach((card) => settle([card]));
    else for (let first = 0; first < remaining.length - 1; first += 1) {
      for (let second = first + 1; second < remaining.length; second += 1) settle([remaining[first], remaining[second]]);
    }

    return Object.fromEntries(Object.entries(equity).map(([key, value]) => [key, total ? value / total : 0]));
  }

  function calculateEquityBreakdown(boardValues, players) {
    const state = prepareCardState(boardValues, players);
    const keys = fallbackPlayers(players).map((player) => player.key);
    const empty = Object.fromEntries(keys.map((key) => [key, { win: 0, tie: 0, lose: 0, share: 0 }]));
    if (!state || state.board.length < 3 || state.board.length > 5 || !state.players.length) {
      return { total: 0, remainingCount: 0, byPlayer: empty };
    }
    const { board, players: completePlayers, remaining } = state;
    const counts = Object.fromEntries(completePlayers.map((player) => [player.key, { win: 0, tie: 0, lose: 0, share: 0 }]));
    let total = 0;
    const settle = (runout) => {
      const result = scoreLeaders(board, runout, completePlayers);
      completePlayers.forEach((player, index) => {
        const count = counts[player.key];
        if (result.leaders.length === 1 && result.leaders[0] === index) count.win += 1;
        else if (result.leaders.includes(index)) {
          count.tie += 1;
          count.share += 1 / result.leaders.length;
        } else count.lose += 1;
        if (result.leaders.length === 1 && result.leaders[0] === index) count.share += 1;
      });
      total += 1;
    };
    if (board.length >= 5) settle([]);
    else if (board.length === 4) remaining.forEach((card) => settle([card]));
    else for (let first = 0; first < remaining.length - 1; first += 1) {
      for (let second = first + 1; second < remaining.length; second += 1) settle([remaining[first], remaining[second]]);
    }
    Object.values(counts).forEach((count) => {
      count.win = total ? count.win / total : 0;
      count.tie = total ? count.tie / total : 0;
      count.lose = total ? count.lose / total : 0;
      count.share = total ? count.share / total : 0;
    });
    return { total, remainingCount: remaining.length, byPlayer: counts };
  }

  function calculateSideBuyerOuts(side, boardValues, players) {
    if (!side || !Array.isArray(side.pots) || !side.pots.length || !Array.isArray(players) || !players.length) return {};
    const state = prepareCardState(boardValues, players);
    if (!state || state.board.length < 3 || state.board.length > 5) return {};
    const { board, players: completePlayers, remaining } = state;
    const playerMap = Object.fromEntries(completePlayers.map((player) => [player.key, player]));
    const rankings = side.rankings && typeof side.rankings === "object" ? side.rankings : {};
    const rankFor = (key) => {
      const rank = Number(rankings[key]);
      return Number.isFinite(rank) && rank > 0 ? rank : 4;
    };
    const isFlop = board.length === 3;
    const poolResults = [];

    side.pots.forEach((pot, potIndex) => {
      if (!pot || !Array.isArray(pot.eligible) || !pot.eligible.length) return;
      const bestRank = Math.min(...pot.eligible.map(rankFor));
      const leaders = pot.eligible.filter((key) => rankFor(key) === bestRank);
      const participants = pot.eligible.filter((key) => playerMap[key]);
      leaders.filter((buyer) => playerMap[buyer]).forEach((buyer) => {
        const lossCards = [];
        if (board.length < 5) remaining.forEach((candidate) => {
          const result = scoreLeaders(board, [candidate], participants.map((key) => playerMap[key]));
          const buyerIndex = participants.indexOf(buyer);
          if (buyerIndex >= 0 && !result.leaders.includes(buyerIndex)) lossCards.push(candidate.value);
        });
        poolResults.push({
          potIndex,
          label: pot.label || `边池 ${potIndex}`,
          amount: Number(pot.amount) || 0,
          coverage: (Number(pot.amount) || 0) / Math.max(leaders.length, 1),
          eligible: participants,
          leaders,
          turnLossCards: isFlop ? lossCards : [],
          riverLossCards: isFlop ? [] : lossCards,
          turnOuts: isFlop ? lossCards.length : 0,
          riverOuts: isFlop ? 0 : lossCards.length
        });
      });
    });

    return Object.fromEntries(completePlayers.map((player) => {
      const pools = poolResults.filter((pool) => pool.leaders.includes(player.key));
      if (!pools.length) return [player.key, undefined];
      const turnLossCards = [...new Set(pools.flatMap((pool) => pool.turnLossCards))];
      const riverLossCards = [...new Set(pools.flatMap((pool) => pool.riverLossCards))];
      return [player.key, {
        turnOuts: turnLossCards.length,
        riverOuts: riverLossCards.length,
        turnLossCards,
        riverLossCards,
        pools
      }];
    }).filter(([, value]) => value));
  }

  const api = Object.freeze({
    calculateHandOuts,
    calculateParticipantOuts,
    calculateFinalEquities,
    calculateEquityBreakdown,
    calculateSideBuyerOuts
  });

  if (typeof module === "object" && module.exports) module.exports = api;
  if (global && typeof global === "object") global.PokerAppHandAnalysis = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : {});
