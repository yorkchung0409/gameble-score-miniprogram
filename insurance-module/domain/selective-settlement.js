const Core = require('../poker-core');

// Keep the established payout contract for covered hits. An uncovered loss
// loses the stake AND all premiums paid before that loss; no later premium is paid.
function calculateSettlement(input) {
  const base = Core.calculateTwoStreetSettlement(input);
  const turn = input.turn || {}, river = input.river || {};
  const count = street => Array.isArray(street.allOutCards) ? street.allOutCards.length : Number(street.outs) || 0;
  const insured = street => Array.isArray(street.allOutCards) ? (street.outCards || []).length : Number(street.outs) || 0;
  if (!turn.selectionApplied && !river.selectionApplied && count(turn) <= 17 && count(river) <= 17
    && turn.status !== 'uncovered' && river.status !== 'uncovered') return base;
  const rate = (amount, denominator) => denominator > 0 ? Math.min(1, Math.max(0, amount / denominator)) : 0;
  const turnLoss = rate(count(turn), base.firstUnknownCards);
  const turnCovered = rate(insured(turn), base.firstUnknownCards);
  const riverLoss = rate(count(river), base.secondUnknownCards);
  const riverCovered = rate(insured(river), base.secondUnknownCards);
  const rows = [];
  const probabilities = { turnHit: 0, turnUncovered: 0, riverHit: 0, riverUncovered: 0, bothSafe: 0 };
  const add = (key, label, probability, buy, receipt, payout, net) => {
    probabilities[key] = probability;
    rows.push({ key, label, probability, buy, receipt, payout, net });
  };
  const tBuy = base.turnBuy, rBuy = base.riverBuy, stake = base.stake;
  const tHit = p => add('turnHit', '转牌爆保险（终局）', p, tBuy, base.turnPayout, base.turnPayout, base.turnPayout - stake);
  const tUncovered = p => add('turnUncovered', '转牌未投保牌命中 · 无保险赔付', p, tBuy, 0, 0, -stake - tBuy);
  const riverRows = safeRate => {
    if (river.status === 'uncovered') add('riverUncovered', '河牌未投保牌命中 · 无保险赔付', safeRate, tBuy + rBuy, 0, 0, -stake - tBuy - rBuy);
    else if (river.status === 'hit') add('riverHit', '转牌安全 · 河牌爆保险', safeRate, tBuy + rBuy, base.riverPayout, base.riverPayout, base.riverPayout - stake - tBuy);
    else if (river.status === 'safe') add('bothSafe', '转牌河牌双安全', safeRate, tBuy + rBuy, base.coverage, 0, base.coverage - stake - tBuy - rBuy);
    else if (base.hasRiverInput) {
      add('riverHit', '转牌安全 · 河牌爆保险', safeRate * riverCovered, tBuy + rBuy, base.riverPayout, base.riverPayout, base.riverPayout - stake - tBuy);
      if (riverLoss > riverCovered) add('riverUncovered', '河牌未投保牌命中 · 无保险赔付', safeRate * (riverLoss - riverCovered), tBuy + rBuy, 0, 0, -stake - tBuy - rBuy);
      add('bothSafe', '转牌河牌双安全', safeRate * (1 - riverLoss), tBuy + rBuy, base.coverage, 0, base.coverage - stake - tBuy - rBuy);
    } else add('riverPending', '转牌安全 · 等待河牌', safeRate, tBuy, base.coverage, 0, base.coverage - stake - tBuy);
  };
  const turnStatus = turn.status === 'uncovered' ? 'uncovered' : base.resolvedTurnStatus;
  if (turnStatus === 'hit') tHit(1);
  else if (turnStatus === 'uncovered') tUncovered(1);
  else if (turnStatus === 'safe') riverRows(1);
  else {
    tHit(turnCovered);
    if (turnLoss > turnCovered) tUncovered(turnLoss - turnCovered);
    riverRows(1 - turnLoss);
  }
  const possible = rows.filter(row => row.probability > 0);
  const noInsurance = row => ['turnHit', 'turnUncovered', 'riverHit', 'riverUncovered'].includes(row.key) ? -stake : base.coverage - stake;
  const expectedNet = rows.reduce((total, row) => total + row.probability * row.net, 0);
  return {
    ...base, rows, probabilities, resolvedTurnStatus: turnStatus,
    plannedBuy: ['hit', 'uncovered'].includes(turnStatus) ? tBuy : base.plannedBuy,
    expectedNet, expectedDouble: expectedNet,
    expectedReceipt: rows.reduce((total, row) => total + row.probability * row.receipt, 0),
    expectedNoInsurance: rows.reduce((total, row) => total + row.probability * noInsurance(row), 0),
    worstNet: possible.length ? Math.min(...possible.map(row => row.net)) : 0,
    bestNet: possible.length ? Math.max(...possible.map(row => row.net)) : 0
  };
}

module.exports = { calculateSettlement };
