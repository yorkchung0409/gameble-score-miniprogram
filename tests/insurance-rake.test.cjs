const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../insurance-module/domain/insurance-engine');
const D = require('../insurance-module/store/draft-store');
const input = { poolMode: 'multi', board: ['7s', '6h', '2c'], contributions: { A: 500, B: 500, C: 300 },
  players: [{ key: 'A', cards: ['Qc', 'Qd'] }, { key: 'B', cards: ['As', 'Kh'] }, { key: 'C', cards: ['7c', '7d'] }] };
const buyerIn = (view, id, key) => view.pools.find(pool => pool.id === id).buyers.find(buyer => buyer.buyer === key);

test('percentage rake reduces each pot, preserves stakes and excludes uncalled returns', () => {
  const state = E.createRound({ ...input, rakeRate: 5, contributions: { A: 700, B: 500, C: 300 } });
  const view = E.selectInsuranceView(state);
  assert.deepEqual(view.pools.map(pool => [pool.grossAmount, pool.rakeAmount, pool.amount]), [[900, 40, 860], [400, 20, 380]]);
  assert.equal(view.totalRake, 60);
  assert.equal(view.summary.totalAllIn, 1500);
  assert.equal(view.summary.totalActualInPot, 1300);
  assert.equal(view.summary.returned, 200);
  assert.deepEqual(view.players.map(player => player.financial.actualInPot), [500, 500, 300]);
  const winner = buyerIn(view, view.pools[0].id, 'C');
  assert.equal(winner.settlement.rows.find(row => row.key === 'bothSafe').receipt, 860);
  assert.equal(winner.settlement.rows.find(row => row.key === 'bothSafe').net, 560);
});

test('net amounts round per pot to the nearest ten instead of rounding a combined pot or rounding rake first', () => {
  const view = E.selectInsuranceView(E.createRound({ ...input, contributions: { A: 106, B: 106, C: 101 }, rakeRate: 5 }));
  assert.deepEqual(view.pools.map(pool => pool.grossAmount), [303, 10]);
  assert.deepEqual(view.pools.map(pool => pool.amount), [290, 10]);
  assert.equal(view.totalRake, 13);
  const oneHundredThirtyThree = E.selectInsuranceView(E.createRound({ ...input, contributions: { A: 70, B: 70, C: 0 }, rakeRate: 5 }));
  assert.deepEqual(oneHundredThirtyThree.pools.map(pool => pool.amount), [130]);
  const oneHundredSeventyEight = E.selectInsuranceView(E.createRound({ ...input, contributions: { A: 94, B: 94, C: 0 }, rakeRate: 5 }));
  assert.deepEqual(oneHundredSeventyEight.pools.map(pool => pool.amount), [180]);
  const halves = E.selectInsuranceView(E.createRound({ ...input, contributions: { A: 55, B: 55, C: 50 }, rakeRate: 55 }));
  assert.deepEqual(halves.pools.map(pool => pool.amount), [70, 0]);
  const decimalRate = E.selectInsuranceView(E.createRound({ ...input, rakeRate: 2.5 }));
  assert.deepEqual(decimalRate.pools.map(pool => pool.amount), [880, 390]);
  assert.equal(decimalRate.totalRake, 30);
});

test('rake reprices premiums without changing outs, manual odds, selections or pot identities', () => {
  let state = E.createRound(input);
  const beforeView = E.selectInsuranceView(state);
  const id = beforeView.pools[1].id;
  const edit = (street, field, value) => { state = E.reduceRound(state, { type: 'EDIT_STREET', poolId: id, buyer: 'A', street, field, value }); };
  edit('turn', 'odds', 2.8); edit('turn', 'buy', 143);
  const cards = state.insuranceByPool[id].A.river.allOutCards.filter(card => card[0] === 'A');
  state = E.reduceRound(state, { type: 'SELECT_OUTS', poolId: id, buyer: 'A', street: 'river', cards });
  edit('river', 'buy', 40);
  const before = structuredClone(state.insuranceByPool[id].A);
  const branch = state.branchId;
  state = E.reduceRound(state, { type: 'SET_RAKE_RATE', value: 5 });
  const record = state.insuranceByPool[id].A;
  assert.equal(state.branchId, branch);
  assert.equal(record.coverage, 380);
  assert.equal(record.turn.buy, 136);
  assert.equal(record.river.buy, 38);
  for (const street of ['turn', 'river']) {
    assert.equal(record[street].outs, before[street].outs);
    assert.equal(record[street].odds, before[street].odds);
    assert.equal(record[street].outsSource, before[street].outsSource);
    assert.deepEqual(record[street].outCards, before[street].outCards);
  }
  assert.deepEqual(E.selectInsuranceView(state).pools.map(pool => pool.id), beforeView.pools.map(pool => pool.id));
  const reopened = D.hydrateSavedDraft({ state }).state;
  assert.equal(reopened.inputs.rakeRate, 5);
  for (const [poolId, buyers] of Object.entries(state.insuranceByPool)) {
    for (const [key, saved] of Object.entries(buyers)) {
      const restored = reopened.insuranceByPool[poolId][key];
      assert.equal(restored.coverage, saved.coverage);
      for (const street of ['turn', 'river']) {
        for (const field of ['buy', 'outs', 'odds', 'oddsOverride', 'source', 'outsSource', 'selectionApplied', 'outCards', 'allOutCards']) {
          assert.deepEqual(restored[street][field], saved[street][field]);
        }
      }
    }
  }
});

test('zero and full rake, invalid percentages and single-pot mode have defined behavior', () => {
  let state = E.createRound(input);
  const original = structuredClone(state);
  for (const value of [-1, 101, 'invalid', Infinity]) {
    const rejected = E.reduceRound(state, { type: 'SET_RAKE_RATE', value });
    assert.equal(rejected.inputs.rakeRate, 0);
    assert.deepEqual(rejected.insuranceByPool, original.insuranceByPool);
    assert.match(rejected.error, /0–100/);
  }
  state = E.reduceRound(state, { type: 'SET_RAKE_RATE', value: 100 });
  const view = E.selectInsuranceView(state);
  assert.equal(view.totalRake, 1300);
  assert.ok(view.pools.every(pool => pool.amount === 0));
  assert.ok(Object.values(state.insuranceByPool).every(buyers => Object.values(buyers).every(record => record.coverage === 0 && record.turn.buy === 0 && record.river.buy === 0)));
  assert.ok(view.pools.flatMap(pool => pool.buyers).every(buyer => buyer.settlement.rows.find(row => row.key === 'bothSafe').receipt === 0));
  state = E.reduceRound(state, { type: 'SET_RAKE_RATE', value: '' });
  assert.equal(state.inputs.rakeRate, 0);
  assert.deepEqual(E.selectInsuranceView(state).pools.map(pool => pool.amount), [900, 400]);
  const single = E.createRound({ ...input, poolMode: 'single', coverage: 1234.5, stake: 500, rakeRate: 5 });
  const singleView = E.selectInsuranceView(single);
  assert.equal(singleView.pools[0].amount, 1234.5);
  assert.equal(singleView.totalRake, 0);
  assert.equal(singleView.rakeRate, 0);
});

test('dealt rake stays locked and saved snapshots retain the same payout and net result', () => {
  let state = E.createRound({ ...input, rakeRate: 5 });
  const id = E.selectInsuranceView(state).pools[1].id;
  state = E.reduceRound(state, { type: 'EDIT_STREET', poolId: id, buyer: 'A', street: 'turn', field: 'buy', value: 30 });
  state = E.reduceRound(state, { type: 'SET_BOARD_CARD', index: 3, card: 'Ah' });
  const turn = structuredClone(state.insuranceByPool[id].A.turn);
  const view = E.selectInsuranceView(state);
  assert.equal(view.rakeLocked, true);
  const rejected = E.reduceRound(state, { type: 'SET_RAKE_RATE', value: 10 });
  assert.equal(rejected.inputs.rakeRate, 5);
  assert.deepEqual(rejected.insuranceByPool[id].A.turn, turn);
  const reopened = D.hydrateSavedDraft({ state }).state;
  assert.equal(E.selectInsuranceView(reopened).rakeLocked, true);
  assert.equal(E.selectInsuranceView(reopened).summary.settledNet, view.summary.settledNet);
  assert.deepEqual(reopened.insuranceByPool[id].A.turn, turn);
});

test('old zero-rake drafts keep their branch key, selections and ended history', () => {
  let state = E.createRound(input);
  state = E.reduceRound(state, { type: 'SET_BOARD_CARD', index: 3, card: 'Ah' });
  delete state.inputs.rakeRate;
  const previous = E.selectInsuranceView(state);
  const restored = D.hydrateSavedDraft({ state }).state;
  assert.equal(restored.inputs.rakeRate, 0);
  assert.equal(restored.round.branchKey, state.round.branchKey);
  assert.deepEqual(restored.round.history, state.round.history);
  assert.equal(E.selectInsuranceView(restored).summary.settledNet, previous.summary.settledNet);
});
