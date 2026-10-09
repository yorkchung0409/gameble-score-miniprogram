const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../insurance-module/domain/insurance-engine');
const D = require('../insurance-module/store/draft-store');
const Core = require('../insurance-module/poker-core');
const H = require('../insurance-module/app-hand-analysis');
const { classifyOuts } = require('../insurance-module/domain/outs-selection');
const { calculateSettlement } = require('../insurance-module/domain/selective-settlement');

const round = () => E.createRound({ coverage: 1000, stake: 500, board: ['7s', '6h', '2c'],
  players: [{ key: 'A', cards: ['Qc', 'Qd'] }, { key: 'B', cards: ['As', 'Kh'] }] });
const select = (state, street, cards) => E.reduceRound(state, { type: 'SELECT_OUTS', poolId: 'single', buyer: 'A', street, cards });
const buy = (state, street, value) => E.reduceRound(state, { type: 'EDIT_STREET', poolId: 'single', buyer: 'A', street, field: 'buy', value });
const deal = (state, index, card) => E.reduceRound(state, { type: 'SET_BOARD_CARD', index, card });
const buyer = state => E.selectInsuranceView(state).pools[0].buyers.find(player => player.buyer === 'A');

test('classification covers real outs, overlaps flush/straight, excludes ties and respects pot eligibility', () => {
  const board = ['Qs', 'Js', '2d'];
  const players = [{ key: 'A', cards: ['Ac', 'Ad'] }, { key: 'B', cards: ['Ks', 'Ts'] }];
  const analysis = H.calculateParticipantOuts(board, players, ['A', 'B'], 'A');
  const groups = classifyOuts(board, players, ['A', 'B'], 'A', analysis.outCards);
  for (const key of ['flush', 'straight', 'straightFlush']) {
    assert.ok(groups.find(group => group.key === key).cards.includes('9s'));
    assert.ok(groups.find(group => group.key === key).cards.includes('As'));
  }
  assert.deepEqual([...new Set(groups.flatMap(group => group.cards))].sort(), analysis.outCards.slice().sort());
  assert.equal(analysis.outCards.includes('Kh'), false);
  assert.equal(H.calculateParticipantOuts(board, players, ['A'], 'A').outCards.length, 0);
  assert.deepEqual(classifyOuts(board, players, ['A'], 'A', analysis.outCards), []);
  const tied = H.calculateParticipantOuts(['As', 'Kd', 'Qc', 'Jh'],
    [{ key: 'A', cards: ['2c', '3d'] }, { key: 'B', cards: ['2d', '3c'] }], ['A', 'B'], 'A');
  assert.equal(tied.outCards.includes('Ts'), false);
});

test('overcard, set and full-house outs are distinguished from unavailable/known cards', () => {
  const high = round().insuranceByPool.single.A.turn;
  assert.equal(high.outGroups.find(group => group.key === 'overcard').cards.length, 6);
  assert.equal(high.allOutCards.includes('As'), false);
  const scenarios = [
    { board: ['Qh', '9s', '2d'], a: ['Ac', 'Ad'], b: ['4c', '4d'], card: '4s', type: 'trips' },
    { board: ['Ts', '9d', '2s'], a: ['2c', '2d'], b: ['Th', '9h'], card: 'Tc', type: 'fullHouse' },
    { board: ['Qh', '7s', '2d'], a: ['Ac', 'Ad'], b: ['Qc', '9c'], card: 'Qd', type: 'trips' },
    { board: ['Qh', '7s', '2d'], a: ['Ac', 'Ad'], b: ['Qc', '9c'], card: '9d', type: 'twoPair' },
    { board: ['7s', '8s', '2s', '9d'], a: ['As', 'Ks'], b: ['7c', '7d'], card: '7h', type: 'quads' },
    { board: ['Js', '9d', '2c'], a: ['Ah', 'Qc'], b: ['Kh', 'Td'], card: 'Tc', type: 'pair' },
  ];
  for (const scenario of scenarios) {
    const state = E.createRound({ board: scenario.board, players: [{ key: 'A', cards: scenario.a }, { key: 'B', cards: scenario.b }] });
    const street = state.insuranceByPool.single.A[scenario.board.length === 4 ? 'river' : 'turn'];
    assert.ok(street.allOutCards.includes(scenario.card));
    assert.ok(street.outGroups.find(group => group.key === scenario.type).cards.includes(scenario.card));
  }
});

test('selection deduplicates cards, updates odds/caps, preserves recalculation and resets on changed basis', () => {
  let state = round();
  const all = state.insuranceByPool.single.A.turn.allOutCards;
  state = buy(state, 'turn', 140);
  const picked = all.filter(card => card[0] === 'A');
  state = select(state, 'turn', [...picked, picked[0], 'As']);
  assert.equal(state.insuranceByPool.single.A.turn.outs, 3);
  assert.equal(state.insuranceByPool.single.A.turn.odds, Core.ODDS[2]);
  assert.equal(state.insuranceByPool.single.A.turn.buy, 100);
  assert.deepEqual(state.insuranceByPool.single.A.turn.outCards, picked);
  state = E.reduceRound(state, { type: 'APPLY_AUTO_OUTS' });
  assert.deepEqual(state.insuranceByPool.single.A.turn.outCards, picked);
  state = D.hydrateSavedDraft({ state }).state;
  assert.deepEqual(state.insuranceByPool.single.A.turn.outCards, picked);
  state = E.reduceRound(state, { type: 'SET_BOARD_CARD', index: 1, card: '5h' });
  assert.deepEqual(state.insuranceByPool.single.A.turn.outCards, state.insuranceByPool.single.A.turn.allOutCards);
  state = select(state, 'turn', []);
  assert.equal(state.insuranceByPool.single.A.turn.outs, 0);
  assert.equal(state.insuranceByPool.single.A.turn.odds, 0);
  assert.equal(state.insuranceByPool.single.A.turn.buy, 0);
  state = deal(state, 3, 'Ah');
  assert.equal(state.insuranceByPool.single.A.turn.resolvedStatus, 'uncovered');
});

test('uncovered turn loses stake and paid turn premium, never the preset river premium', () => {
  let state = round();
  const kings = state.insuranceByPool.single.A.turn.allOutCards.filter(card => card[0] === 'K');
  state = select(state, 'turn', kings);
  state = buy(state, 'turn', 100);
  state = buy(state, 'river', 20);
  state = deal(state, 3, 'Ah');
  const saved = JSON.stringify(state.insuranceByPool.single.A.turn);
  assert.equal(state.insuranceByPool.single.A.turn.resolvedStatus, 'uncovered');
  assert.equal(state.insuranceByPool.single.A.river.status, 'notApplicable');
  assert.equal(buyer(state).settlement.rows[0].net, -600);
  assert.equal(buyer(state).settlement.rows[0].receipt, 0);
  assert.equal(buyer(state).turn.payout, 0);
  assert.equal(E.selectInsuranceView(state).summary.settledBuy, 100);
  assert.equal(E.selectInsuranceView(state).summary.settledNet, -600);
  state = E.reduceRound(state, { type: 'APPLY_AUTO_OUTS', resetSelection: true });
  assert.equal(JSON.stringify(state.insuranceByPool.single.A.turn), saved);
  state = D.hydrateSavedDraft({ state }).state;
  assert.equal(buyer(state).settlement.rows[0].net, -600);
  const invalidEdit = select(state, 'turn', kings.concat('Ah'));
  assert.deepEqual(invalidEdit.insuranceByPool.single.A.turn, JSON.parse(saved));
});

test('uncovered river loses stake and both paid premiums, covered hits still pay once', () => {
  let state = buy(round(), 'turn', 100);
  state = select(state, 'river', []); // This flop estimate must not carry into the real river.
  state = deal(state, 3, '3d');
  assert.equal(state.insuranceByPool.single.A.turn.resolvedStatus, 'safe');
  assert.deepEqual(state.insuranceByPool.single.A.river.outCards, state.insuranceByPool.single.A.river.allOutCards);
  const kings = state.insuranceByPool.single.A.river.allOutCards.filter(card => card[0] === 'K');
  state = buy(select(state, 'river', kings), 'river', 20);
  const hit = deal(state, 4, 'Kc');
  assert.equal(hit.insuranceByPool.single.A.river.resolvedStatus, 'hit');
  assert.equal(buyer(hit).settlement.rows[0].receipt, 200);
  state = deal(state, 4, 'Ah');
  assert.equal(state.insuranceByPool.single.A.river.resolvedStatus, 'uncovered');
  assert.equal(buyer(state).settlement.rows[0].net, -620);
  assert.equal(E.selectInsuranceView(state).summary.settledBuy, 120);
  assert.equal(E.selectInsuranceView(state).summary.settledNet, -620);
  assert.equal(D.hydrateSavedDraft({ state }).state.insuranceByPool.single.A.river.resolvedStatus, 'uncovered');
});

test('selective expected value includes uninsured losses instead of treating them as winning the pot', () => {
  const input = { coverage: 1000, stake: 500, firstUnknownCards: 45, secondUnknownCards: 44,
    turn: { outs: 3, odds: 10, buy: 100, outCards: ['Ah', 'Ad', 'Ac'], allOutCards: ['Ah', 'Ad', 'Ac', 'Ks', 'Kd', 'Kc'], selectionApplied: true },
    river: { outs: 0, buy: 0, status: 'current' } };
  const result = calculateSettlement(input);
  assert.ok(Math.abs(result.expectedNet - (3 / 45 * 500 + 3 / 45 * -600 + 39 / 45 * 400)) < 1e-9);
  assert.equal(result.worstNet, -600);
  assert.ok(Math.abs(Object.values(result.probabilities).reduce((a, b) => a + b) - 1) < 1e-9);
  const without = calculateSettlement({ ...input, turn: { ...input.turn, buy: 0 } });
  assert.ok(Math.abs(without.expectedNet - result.expectedNoInsurance) < 1e-9);
});

test('each pot has an independent selection and excludes ineligible opponents', () => {
  let state = E.createRound({ poolMode: 'multi', board: ['7s', '6h', '2c'], contributions: { A: 100, B: 100, C: 50 },
    players: [{ key: 'A', cards: ['Qc', 'Qd'] }, { key: 'B', cards: ['As', 'Kh'] }, { key: 'C', cards: ['7c', '7d'] }] });
  const view = E.selectInsuranceView(state);
  const side = view.pools.find(pool => !pool.eligible.includes('C'));
  const main = view.pools.find(pool => pool.eligible.includes('C'));
  assert.ok(side.buyers.find(buyer => buyer.buyer === 'A'));
  const originalMain = JSON.stringify(state.insuranceByPool[main.id]);
  state = E.reduceRound(state, { type: 'SELECT_OUTS', poolId: side.id, buyer: 'A', street: 'turn', cards: [] });
  assert.equal(state.insuranceByPool[side.id].A.turn.outCards.length, 0);
  assert.equal(JSON.stringify(state.insuranceByPool[main.id]), originalMain);
});

test('legacy all-covered snapshots keep their result and missing selection data defaults to all cards', () => {
  let state = round();
  const expected = E.selectInsuranceView(state).summary.expectedNet;
  for (const street of ['turn', 'river']) {
    delete state.insuranceByPool.single.A[street].allOutCards;
    delete state.insuranceByPool.single.A[street].outGroups;
    delete state.insuranceByPool.single.A[street].selectionApplied;
  }
  state = D.hydrateSavedDraft({ state }).state;
  assert.deepEqual(state.insuranceByPool.single.A.turn.allOutCards, state.insuranceByPool.single.A.turn.outCards);
  assert.equal(E.selectInsuranceView(state).summary.expectedNet, expected);
  state = deal(buy(state, 'turn', 10), 3, 'Ah');
  const net = buyer(state).settlement.expectedNet;
  assert.equal(buyer(D.hydrateSavedDraft({ state }).state).settlement.expectedNet, net);
});

test('more than 17 real outs retain their count and probability while pricing at the last tier', () => {
  let state = E.createRound({ coverage: 1000, board: ['7s', '6s', '2c'],
    players: [{ key: 'A', cards: ['Qh', 'Qd'] }, { key: 'B', cards: ['As', 'Ks'] },
      { key: 'C', cards: ['8h', '9h'] }, { key: 'D', cards: ['Tc', 'Td'] }] });
  const cards = state.insuranceByPool.single.A.turn.allOutCards;
  assert.ok(cards.length > 17);
  state = select(state, 'turn', cards);
  assert.equal(state.insuranceByPool.single.A.turn.outs, 17);
  assert.equal(state.insuranceByPool.single.A.turn.outCards.length, cards.length);
  assert.equal(state.insuranceByPool.single.A.turn.odds, Core.ODDS[16]);
  assert.equal(buyer(state).settlement.probabilities.turnHit, cards.length / 41);
  assert.equal(D.hydrateSavedDraft({ state }).state.insuranceByPool.single.A.turn.outCards.length, cards.length);
});

test('changing an odds profile reprices selected cards but never rewrites a settled premium or payout', () => {
  const original = Core.ODDS.slice();
  try {
    let state = buy(select(round(), 'turn', ['Ah', 'Ad', 'Ac']), 'turn', 100);
    const custom = original.map(odds => odds * 2);
    Core.ODDS.splice(0, 17, ...custom);
    state = E.reduceRound(state, { type: 'SET_ODDS_CONFIG', values: custom });
    assert.deepEqual(state.insuranceByPool.single.A.turn.outCards, ['Ah', 'Ad', 'Ac']);
    assert.equal(state.insuranceByPool.single.A.turn.odds, 20);
    assert.equal(state.insuranceByPool.single.A.turn.buy, 50);
    state = deal(state, 3, 'Ah');
    assert.equal(buyer(state).turn.payout, 1000);
    const frozen = JSON.parse(JSON.stringify(state.insuranceByPool.single.A.turn));
    Core.ODDS.splice(0, 17, ...original);
    state = E.reduceRound(state, { type: 'SET_ODDS_CONFIG', values: original });
    state = D.hydrateSavedDraft({ state }).state;
    assert.deepEqual(state.insuranceByPool.single.A.turn, frozen);
    assert.equal(buyer(state).turn.payout, 1000);
  } finally { Core.ODDS.splice(0, 17, ...original); }
});
