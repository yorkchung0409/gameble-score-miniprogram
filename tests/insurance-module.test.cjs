const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('outs detail follows automatic cards, disables during manual drag and restores on auto', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const D = require('../insurance-module/store/draft-store');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.onApplyAuto();
    const dataset = { poolId: 'single', buyer: 'A', street: 'turn' };
    const event = { currentTarget: { dataset } };
    const automatic = JSON.parse(JSON.stringify(page.state.insuranceByPool.single.A.turn));
    page.openOutsDetail(event);
    assert.equal(page.data.outsDetail.board.map(card => card.value).join(','), 'As,Kd,Qc');
    assert.equal(page.data.outsDetail.hand.map(card => card.value).join(','), 'Tc,Td');
    assert.deepEqual(page.data.outsDetail.cards.map(card => card.value).sort(), automatic.outCards.slice().sort());
    page.closeOutsDetail();
    page.dispatch({ type: 'EDIT_STREET', ...dataset, field: 'buy', value: 10 });
    page.openOutsDetail(event);
    assert.ok(page.data.outsDetail);
    page.closeOutsDetail();
    page.onOddsSliderChanging({ ...event, detail: { value: 9 } });
    assert.equal(page.data.view.pools[0].buyers[0].turn.canViewOuts, false);
    assert.equal(page.data.view.pools[0].buyers[0].turn.manualOuts, true);
    page.openOutsDetail(event);
    assert.equal(page.data.outsDetail, null);
    assert.equal(page.state.insuranceByPool.single.A.turn.outsSource, 'manual');
    page.onOddsQuickSelect({ currentTarget: { dataset: { ...dataset, oddsIndex: 0 } } });
    page.openOutsDetail(event);
    assert.ok(page.data.outsDetail);
    page.closeOutsDetail();
    page.onBoardCardsSelect({ detail: { values: ['As', 'Kd', 'Qc', '2h'] } });
    page.openOutsDetail(event);
    assert.equal(page.data.outsDetail.settled, true);
    assert.equal(page.data.outsDetail.board.length, 3);
    assert.deepEqual(page.data.outsDetail.cards.map(card => card.value).sort(), automatic.outCards.slice().sort());
    const frozen = JSON.stringify(page.data.outsDetail);
    page.state = D.hydrateSavedDraft({ state: page.state }).state;
    page.renderState(true);
    page.openOutsDetail(event);
    assert.equal(JSON.stringify(page.data.outsDetail), frozen);
    page.closeOutsDetail();
    page.openOutsDetail({ currentTarget: { dataset: { ...dataset, street: 'river' } } });
    assert.equal(page.data.outsDetail.board.length, 4);
    assert.equal(page.data.outsDetail.estimated, false);
    const river = JSON.stringify(page.data.outsDetail);
    page.onBoardCardsSelect({ detail: { values: ['As', 'Kd', 'Qc', '2h', '4h'] } });
    page.openOutsDetail({ currentTarget: { dataset: { ...dataset, street: 'river' } } });
    assert.equal(page.data.outsDetail.settled, true);
    assert.equal(page.data.outsDetail.board.length, 4);
    assert.deepEqual(page.data.outsDetail.cards, JSON.parse(river).cards);
  } finally { harness.restore(); }
});

test('outs detail shows empty automatic cards and identifies flop-only river estimates', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Ad', 'Ac'],
      players: [{ key: 'A', cards: ['Ah', 'Kd'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.onApplyAuto();
    page.openOutsDetail({ currentTarget: { dataset: { poolId: 'single', buyer: 'A', street: 'turn' } } });
    assert.equal(page.data.outsDetail.count, 0);
    assert.equal(page.data.outsDetail.tier, 0);
    page.openOutsDetail({ currentTarget: { dataset: { poolId: 'single', buyer: 'A', street: 'river' } } });
    assert.equal(page.data.outsDetail.estimated, true);
    page.onReset();
    assert.equal(page.data.outsDetail, null);
    page.openOutsDetail({ currentTarget: { dataset: { poolId: 'single', buyer: 'A', street: 'turn' } } });
    assert.equal(page.data.outsDetail, null);
  } finally { harness.restore(); }
});

test('outs entry summarizes full and partial insurance coverage without adding a card row', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.onApplyAuto();
    let street = page.data.view.pools[0].buyers[0].turn;
    assert.equal(street.outsCoverageMode, 'full');
    assert.equal(street.outsCoverageInsured, street.outsCoverageTotal);
    assert.match(street.outsCoverageAria, /全保/);

    const allCards = page.state.insuranceByPool.single.A.turn.allOutCards;
    page.dispatch({ type: 'SELECT_OUTS', poolId: 'single', buyer: 'A', street: 'turn', cards: allCards.slice(0, 1) });
    street = page.data.view.pools[0].buyers[0].turn;
    assert.equal(street.outsCoverageMode, 'partial');
    assert.equal(street.outsCoverageInsured, 1);
    assert.equal(street.outsCoverageUninsured, street.outsCoverageTotal - 1);
    assert.match(street.outsCoverageAria, /已保1张，未保/);
    const markup = fs.readFileSync(path.join(root, 'insurance-module/pages/insurance/index.wxml'), 'utf8');
    assert.match(markup, /outs-detail-trigger-\{\{buyer\.turn\.outsCoverageMode\}\}/);
  } finally { harness.restore(); }
});

test('insurance requires complete hands for every selected player before showing calculated results', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    for (const missing of [['', ''], ['3c', '']]) {
      page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
        players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: missing }] });
      page.onApplyAuto();
      assert.equal(page.data.isCalculated, false);
    }
    page.state = E.reduceRound(page.state, { type: 'SET_PLAYER_CARDS', player: 'B', cards: ['3c', '3d'] });
    page.onApplyAuto();
    assert.equal(page.data.isCalculated, true);
    page.dispatch({ type: 'SET_PLAYER_COUNT', count: 3 });
    page.onApplyAuto();
    assert.equal(page.data.isCalculated, false);
  } finally { harness.restore(); }
});

test('pot and contribution editing does not render until commit and supports blank and decimal values', () => {
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    let writes = 0;
    const setData = page.setData;
    page.setData = function (data) { writes++; setData.call(this, data); };
    for (const field of ['coverage', 'stake', 'A', 'B', 'C', 'D']) {
      const contribution = field.length === 1;
      const dataset = contribution ? { player: field } : { field };
      const input = contribution ? 'onContributionInput' : 'onAmountInput';
      const commit = contribution ? 'onContributionCommit' : 'onAmountCommit';
      const read = () => contribution ? page.state.inputs.contributions[field] : page.state.inputs[field];
      const before = read();
      const beforeWrites = writes;
      for (const value of ['1', '12', '', '0', '12.', '12.5']) {
        page[input]({ currentTarget: { dataset }, detail: { value } });
        assert.equal(writes, beforeWrites);
        assert.equal(read(), before);
      }
      page[commit]({ currentTarget: { dataset } });
      assert.equal(read(), 12.5);
      const committedWrites = writes;
      page[commit]({ currentTarget: { dataset } });
      assert.equal(writes, committedWrites);
      page[input]({ currentTarget: { dataset }, detail: { value: '' } });
      page[commit]({ currentTarget: { dataset } });
      assert.equal(read(), 0);
    }
    page.onAmountInput({ currentTarget: { dataset: { field: 'coverage' } }, detail: { value: '500' } });
    page.onApplyAuto();
    assert.equal(page.state.inputs.coverage, 500);
    page.onAmountInput({ currentTarget: { dataset: { field: 'stake' } }, detail: { value: '25' } });
    page.onHide();
    assert.equal(page.state.inputs.stake, 25);
  } finally { harness.restore(); }
});

test('rake editing preserves the cursor until commit, reprices the view and survives reopening', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ poolMode: 'multi', board: ['7s', '6h', '2c'], contributions: { A: 500, B: 500, C: 300 },
      players: [{ key: 'A', cards: ['Qc', 'Qd'] }, { key: 'B', cards: ['As', 'Kh'] }, { key: 'C', cards: ['7c', '7d'] }] });
    page.onApplyAuto();
    let renders = 0;
    const setData = page.setData;
    page.setData = function (patch) { renders++; setData.call(this, patch); };
    for (const value of ['5', '', '2.', '2.5', '5']) page.onRakeRateInput({ detail: { value } });
    assert.equal(renders, 0);
    assert.equal(page.state.inputs.rakeRate, 0);
    page.onRakeRateCommit();
    assert.equal(page.data.isCalculated, true);
    assert.deepEqual(page.data.view.pools.map(pool => pool.rakeText), ['抽水 5% · 扣 40', '抽水 5% · 扣 20']);
    assert.deepEqual(page.data.view.pools.map(pool => pool.amountText), ['860', '380']);
    assert.equal(page.data.stateRakeRate, '5');
    page.onRakeRateInput({ detail: { value: '101' } }); page.onRakeRateCommit();
    assert.equal(page.state.inputs.rakeRate, 5);
    assert.equal(page.data.isCalculated, true);
    page.onLoad();
    assert.deepEqual(page.data.view.pools.map(pool => pool.rakeText), ['抽水 5% · 扣 40', '抽水 5% · 扣 20']);
    page.onRakeRateInput({ detail: { value: '2.5' } });
    page.onBoardCardsSelect({ detail: { values: ['7s', '6h', '2c', 'Ah'] } });
    assert.equal(page.state.inputs.rakeRate, 2.5);
    assert.equal(page.data.view.rakeLocked, true);
    assert.deepEqual(page.data.view.pools.map(pool => pool.rakeText), ['抽水 2.5% · 扣 20', '抽水 2.5% · 扣 10']);
    page.onRakeRateInput({ detail: { value: '10' } }); page.onRakeRateCommit();
    assert.equal(page.state.inputs.rakeRate, 2.5);
    page.onLoad();
    assert.equal(page.data.view.rakeLocked, true);
    assert.equal(page.data.stateRakeRate, '2.5');
    page.onReset(); assert.equal(page.state.inputs.rakeRate, 0);
  } finally { harness.restore(); }
});

test('calculated sliders preview locally and commit only the released odds tier', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.onApplyAuto();
    const buyer = page.data.view.pools[0].buyers[0].buyer;
    for (const street of ['turn', 'river']) {
      const dataset = { poolId: 'single', buyer, street };
      const event = value => ({ currentTarget: { dataset }, detail: { value } });
      page.setStreetOdds(event(17), 17);
      page.dispatch({ type: 'EDIT_STREET', ...dataset, field: 'buy', value: 500 });
      const originalState = JSON.stringify(page.state);
      const patches = [];
      let renders = 0;
      let saves = 0;
      const render = page.renderState;
      const persist = page.persistDraft;
      const setData = page.setData;
      page.renderState = function (...args) { renders++; return render.apply(this, args); };
      page.persistDraft = function () { saves++; return persist.call(this); };
      page.setData = function (patch) { patches.push(patch); setData.call(this, patch); };
      page.onOddsSliderChanging(event(1));
      let shown = page.data.view.pools[0].buyers[0][street];
      assert.equal(shown.outs, 1);
      assert.equal(shown.odds, 30);
      assert.equal(shown.buy, 34);
      page.onOddsSliderChanging(event(10));
      shown = page.data.view.pools[0].buyers[0][street];
      assert.equal(shown.outs, 10);
      assert.equal(shown.selectedScaleIndex, 10);
      assert.equal(shown.odds, 2.5);
      assert.equal(shown.buy, 400);
      assert.equal(shown.payoutText, '1000.00');
      assert.equal(shown.oddsScaleIndex, 17);
      assert.equal(JSON.stringify(page.state), originalState);
      assert.equal(renders, 0);
      assert.equal(saves, 0);
      assert.ok(patches.every(patch => Object.keys(patch).every(key => key.startsWith('view.pools[') && !key.endsWith('oddsScaleIndex'))));
      page.onOddsSliderChange(event(10));
      assert.equal(renders, 1);
      assert.equal(saves, 1);
      assert.equal(page.state.insuranceByPool.single[buyer][street].outs, 10);
      assert.equal(page.state.insuranceByPool.single[buyer][street].buy, 400);
      assert.equal(page.data.view.pools[0].buyers[0][street].oddsScaleIndex, 10);
      page.onOddsSliderChanging(event(9));
      page.onHide();
      assert.equal(page.state.insuranceByPool.single[buyer][street].outs, 9);
      assert.equal(page.pendingOddsDrag, null);
      page.renderState = render;
      page.persistDraft = persist;
      page.setData = setData;
    }
  } finally { harness.restore(); }
});

test('adding turn and river keeps calculated view and commits pending premiums before settlement', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.onApplyAuto();
    const buyer = page.data.view.pools[0].buyers[0].buyer;
    const select = cards => page.onBoardCardsSelect({ detail: { values: cards } });
    for (const [street, cards, premium] of [
      ['turn', ['As', 'Kd', 'Qc', '2h'], '20'],
      ['river', ['As', 'Kd', 'Qc', '2h', '4h'], '30']
    ]) {
      const dataset = { poolId: 'single', buyer, street, field: 'buy' };
      const before = structuredClone(page.state.insuranceByPool.single[buyer][street]);
      page.onStreetInput({ currentTarget: { dataset }, detail: { value: premium } });
      select(cards);
      assert.equal(page.data.isCalculated, true);
      const frozen = structuredClone(page.state.insuranceByPool.single[buyer][street]);
      assert.equal(frozen.status, 'settled');
      assert.equal(frozen.buy, Number(premium));
      assert.equal(frozen.outs, before.outs);
      assert.equal(frozen.odds, before.odds);
      assert.equal(page.data.view.pools[0].buyers.find(item => item.buyer === buyer)[street].buyInput, premium);
      page.onStreetBuyCommit({ currentTarget: { dataset } });
      select(cards); // Confirming the same cards must not hide the results either.
      page.onApplyAuto();
      assert.deepEqual(page.state.insuranceByPool.single[buyer][street], frozen);
      assert.equal(page.data.isCalculated, true);
      assert.equal(page.state.round.history.find(item => item.street === street && item.buyer === buyer).snapshot.buy, Number(premium));
    }
    assert.equal(page.state.insuranceByPool.single[buyer].turn.buy, 20);
    page.onLoad(); // Saved round reopens with both frozen premiums visible.
    assert.equal(page.data.isCalculated, true);
    assert.equal(page.state.insuranceByPool.single[buyer].turn.buy, 20);
    assert.equal(page.state.insuranceByPool.single[buyer].river.buy, 30);
    select(['As', 'Kd', 'Qc', '5h', '4h']);
    assert.equal(page.data.isCalculated, false); // Replacing known cards still requires calculation.
  } finally { harness.restore(); }
});

test('ended streets collapse independently, keep frozen details, and default to collapsed after reopening', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page, storage } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.onApplyAuto();
    const event = street => ({ currentTarget: { dataset: { poolId: 'single', buyer: 'A', street } } });
    const shown = street => page.data.view.pools[0].buyers.find(item => item.buyer === 'A')[street];
    assert.equal(shown('turn').collapsed, false);
    assert.equal(shown('river').collapsed, false);
    page.toggleSettledStreet(event('turn')); assert.equal(shown('turn').collapsed, false);
    page.dispatch({ type: 'EDIT_STREET', poolId: 'single', buyer: 'A', street: 'turn', field: 'buy', value: 20 });
    page.onBoardCardsSelect({ detail: { values: ['As', 'Kd', 'Qc', '2h'] } });
    assert.equal(shown('turn').collapsed, true);
    assert.equal(shown('turn').settledBuyText, '20');
    assert.equal(shown('turn').settlementSummaryText, '安全');
    assert.equal(shown('river').collapsed, false);
    const frozen = JSON.stringify(page.state);
    const saved = JSON.stringify(storage.get('gameble-score:insurance-round:v1'));
    page.toggleSettledStreet(event('turn'));
    assert.equal(shown('turn').collapsed, false);
    assert.equal(JSON.stringify(page.state), frozen);
    assert.equal(JSON.stringify(storage.get('gameble-score:insurance-round:v1')), saved);
    page.onOddsQuickSelect({ currentTarget: { dataset: { ...event('turn').currentTarget.dataset, oddsIndex: 9 } } });
    page.onOddsQuickSelect({ currentTarget: { dataset: { ...event('turn').currentTarget.dataset, oddsIndex: 0 } } });
    page.onBuyRatioTap({ currentTarget: { dataset: { ...event('turn').currentTarget.dataset, max: 0, ratio: 100 } } });
    assert.equal(JSON.stringify(page.state), frozen, 'expanded ended details must remain read-only');
    page.onApplyAuto(); assert.equal(shown('turn').collapsed, false);
    page.onBoardCardsSelect({ detail: { values: ['As', 'Kd', 'Qc', '2h', '4h'] } });
    assert.equal(shown('turn').collapsed, false);
    assert.equal(shown('river').collapsed, true);
    page.toggleSettledStreet(event('river'));
    page.toggleSettledStreet(event('turn'));
    assert.equal(shown('turn').collapsed, true);
    assert.equal(shown('river').collapsed, false);
    page.onLoad();
    assert.equal(shown('turn').collapsed, true);
    assert.equal(shown('river').collapsed, true);
    assert.equal(shown('turn').buyInput, '20');
  } finally { harness.restore(); }
});

test('ended summaries distinguish payouts, uncovered cards and pending confirmation across pots and buyers', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    const input = { coverage: 1000, stake: 500, board: ['7s', '6h', '2c'],
      players: [{ key: 'A', cards: ['Qc', 'Qd'] }, { key: 'B', cards: ['As', 'Kh'] }] };
    for (const kind of ['hit', 'uncovered', 'needsConfirm']) {
      page.state = E.createRound(input); page.renderState(true);
      if (kind === 'uncovered') page.dispatch({ type: 'SELECT_OUTS', poolId: 'single', buyer: 'A', street: 'turn', cards: ['Kc'] });
      if (kind === 'needsConfirm') page.setStreetOdds({ currentTarget: { dataset: { poolId: 'single', buyer: 'A', street: 'turn' } } }, 9);
      page.dispatch({ type: 'EDIT_STREET', poolId: 'single', buyer: 'A', street: 'turn', field: 'buy', value: 20 });
      page.onBoardCardsSelect({ detail: { values: [...input.board, 'Ah'] } });
      const buyer = page.data.view.pools[0].buyers.find(item => item.buyer === 'A');
      assert.equal(buyer.turn.resolvedStatus, kind);
      assert.equal(buyer.turn.collapsed, true);
      assert.equal(buyer.turn.settlementSummaryText, kind === 'hit' ? `赔付 ¥${buyer.turn.payoutText}` : kind === 'uncovered' ? '未投保牌命中' : '待确认');
      assert.equal(buyer.turn.settlementSummaryClass, kind === 'uncovered' ? 'negative' : '');
    }
    page.state = E.createRound({ poolMode: 'multi', board: input.board, contributions: { A: 100, B: 100, C: 50 },
      players: [...input.players, { key: 'C', cards: ['7c', '7d'] }] });
    page.renderState(true);
    page.onBoardCardsSelect({ detail: { values: [...input.board, 'Ah'] } });
    const targets = page.data.view.pools.flatMap(pool => pool.buyers.filter(buyer => buyer.turn.settled).map(buyer => ({ poolId: pool.id, buyer: buyer.buyer, street: 'turn' })));
    assert.equal(targets.length, 2);
    for (const dataset of targets) page.toggleSettledStreet({ currentTarget: { dataset } });
    page.toggleSettledStreet({ currentTarget: { dataset: targets[0] } });
    const streetFor = dataset => page.data.view.pools.find(pool => pool.id === dataset.poolId).buyers.find(buyer => buyer.buyer === dataset.buyer).turn;
    assert.equal(streetFor(targets[0]).collapsed, true);
    assert.equal(streetFor(targets[1]).collapsed, false);
    const previousKey = streetFor(targets[1]).settledKey;
    page.onBoardCardsSelect({ detail: { values: input.board } });
    page.onApplyAuto();
    page.onBoardCardsSelect({ detail: { values: [...input.board, '3h'] } });
    assert.notEqual(streetFor(targets[1]).settledKey, previousKey);
    assert.equal(streetFor(targets[1]).collapsed, true);
  } finally { harness.restore(); }
});

test('new turn outs only affect river insurance and cannot create retroactive turn insurance', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const input = { coverage: 1000, board: ['Ac', '7h', '2c'],
    players: [{ key: 'A', cards: ['As', 'Ad'] }, { key: 'B', cards: ['Kh', 'Qh'] }] };
  let state = E.createRound(input);
  const flop = structuredClone(state.insuranceByPool.single.A.turn);
  state = E.reduceRound(state, { type: 'SET_BOARD_CARDS', cards: [...input.board, 'Jh'] });
  assert.ok(state.insuranceByPool.single.A.river.outs > flop.outs);
  const frozen = structuredClone(state.insuranceByPool.single.A.turn);
  for (let i = 0; i < 2; i++) {
    state = E.reduceRound(state, { type: 'APPLY_AUTO_OUTS' });
    assert.deepEqual(state.insuranceByPool.single.A.turn, frozen);
    assert.equal(frozen.outs, flop.outs);
    assert.equal(frozen.odds, flop.odds);
  }
  const river = structuredClone(state.insuranceByPool.single.A.river);
  state = E.reduceRound(state, { type: 'SET_BOARD_CARDS', cards: [...input.board, 'Jh', '3h'] });
  state = E.reduceRound(state, { type: 'APPLY_AUTO_OUTS' });
  assert.deepEqual(state.insuranceByPool.single.A.turn, frozen);
  assert.equal(state.insuranceByPool.single.A.river.outs, river.outs);
  assert.equal(state.insuranceByPool.single.A.river.odds, river.odds);
  assert.equal(state.insuranceByPool.single.A.river.resolvedStatus, 'hit');

  // Starting with four/five cards has no pre-deal insurance purchase record.
  for (const board of [[...input.board, 'Jh'], [...input.board, 'Jh', '3h']]) {
    let late = E.createRound({ ...input, board });
    late = E.reduceRound(late, { type: 'APPLY_AUTO_OUTS' });
    for (const record of Object.values(late.insuranceByPool.single)) {
      assert.equal(record.turn.status, 'notApplicable');
      assert.equal(record.turn.odds, 0);
      assert.equal(record.turn.outs, null);
      if (board.length === 5) assert.equal(record.river.status, 'notApplicable');
    }
  }
});

test('a turn hit shows the original purchaser before the new leader without an empty turn card', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  let state = E.createRound({ coverage: 1000, stake: 500, board: ['Jd', 'Qd', '8h'],
    players: [{ key: 'A', cards: ['Jh', 'Th'] }, { key: 'B', cards: ['8d', '7c'] }] });
  state = E.reduceRound(state, { type: 'EDIT_STREET', poolId: 'single', buyer: 'A',
    street: 'turn', field: 'buy', value: 84 });
  state = E.reduceRound(state, { type: 'SET_BOARD_CARDS', cards: ['Jd', 'Qd', '8h', '7s'] });
  const pool = E.selectInsuranceView(state).pools[0];
  assert.deepEqual(pool.leaders, ['B']);
  assert.deepEqual(pool.buyers.map(buyer => buyer.buyer), ['A', 'B']);
  assert.equal(pool.buyers[0].historicalOnly, true);
  assert.equal(pool.buyers[0].turn.status, 'settled');
  assert.equal(pool.buyers[0].turn.resolvedStatus, 'hit');
  assert.equal(pool.buyers[0].turn.buy, 84);
  assert.equal(pool.buyers[0].turn.payout, 504);
  assert.equal(pool.buyers[0].river.status, 'notApplicable');
  assert.equal(pool.buyers[1].turn.status, 'notApplicable');
  assert.equal(pool.buyers[1].river.status, 'current');
  const wxml = fs.readFileSync(path.join(root, 'insurance-module/pages/insurance/index.wxml'), 'utf8');
  assert.match(wxml, /wx:if="\{\{buyer\.turn\.status !== 'notApplicable'\}\}" class="street-card"/);
  assert.match(wxml, /wx:if="\{\{buyer\.river\.status !== 'notApplicable'\}\}" class="street-card"/);
});

test('group card replacement is atomic and appended streets retain snapshots', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const seed = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
    players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
  const hand = E.reduceRound(seed, { type: 'SET_PLAYER_CARDS', player: 'A', cards: ['Td', 'Th'] });
  assert.deepEqual(hand.table.players[0].cards, ['Td', 'Th']);
  const invalid = E.reduceRound(hand, { type: 'SET_PLAYER_CARDS', player: 'A', cards: ['As', 'Th'] });
  assert.equal(invalid.error, 'duplicate-card');
  assert.deepEqual(invalid.table, hand.table);
  const board = E.reduceRound(seed, { type: 'SET_BOARD_CARDS', cards: ['Kd', 'Qc', '2h'] });
  assert.deepEqual(board.table.board, ['Kd', 'Qc', '2h', '', '']);
  const invalidBoard = E.reduceRound(seed, { type: 'SET_BOARD_CARDS', cards: ['As', 'Kd', 'Tc'] });
  assert.equal(invalidBoard.error, 'duplicate-card');
  assert.deepEqual(invalidBoard.table, seed.table);
  const appended = E.reduceRound(seed, { type: 'SET_BOARD_CARDS', cards: ['As', 'Kd', 'Qc', '2h', '4h'] });
  assert.ok(appended.round.history.some(item => item.street === 'turn'));
  assert.ok(appended.round.history.some(item => item.street === 'river'));
  const cleared = E.reduceRound(seed, { type: 'SET_PLAYER_CARDS', player: 'A', cards: [] });
  assert.deepEqual(cleared.table.players[0].cards, ['', '']);
});

test('automatic odds caps stored buy and displayed payout together', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.renderState(true);
    const buyer = page.data.view.pools[0].buyers[0].buyer;
    for (const street of ['turn', 'river']) {
      const dataset = { poolId: 'single', buyer, street };
      page.setStreetOdds({ currentTarget: { dataset } }, 17);
      page.onBuyRatioTap({ currentTarget: { dataset: { ...dataset, max: 834, ratio: 100 } } });
      page.onOddsQuickSelect({ currentTarget: { dataset: { ...dataset, oddsIndex: 0 } } });
      const result = page.data.view.pools[0].buyers.find(item => item.buyer === buyer)[street];
      assert.equal(result.buy, result.maxBuy);
      assert.equal(Number(result.buyInput), result.buy);
      assert.equal(result.payout, result.buy * result.odds);
      assert.equal(page.state.insuranceByPool.single[buyer][street].buy, result.buy);
    }
  } finally { harness.restore(); }
});

test('buy inputs defer normalization, allow clearing and ignore stale blur after shortcuts', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.renderState(true);
    const buyer = page.data.view.pools[0].buyers[0].buyer;
    let writes = 0;
    const setData = page.setData;
    page.setData = function (data) { writes++; setData.call(this, data); };
    for (const preview of [true, false]) {
      for (const street of ['turn', 'river']) {
        const dataset = preview ? { street } : { street, poolId: 'single', buyer, field: 'buy', max: 67 };
        const input = preview ? 'onPreviewBuyInput' : 'onStreetInput';
        const commit = preview ? 'onPreviewBuyCommit' : 'onStreetBuyCommit';
        const shortcut = preview ? 'onPreviewBuyRatioTap' : 'onBuyRatioTap';
        const amount = () => preview ? page.data[street === 'turn' ? 'previewTurn' : 'previewRiver'].buy : page.state.insuranceByPool.single[buyer][street].buy;
        page[shortcut]({ currentTarget: { dataset: { ...dataset, ratio: 50 } } });
        const before = amount();
        const beforeWrites = writes;
        for (const value of ['', '1', '12', '1.', '1.01']) {
          assert.equal(page[input]({ currentTarget: { dataset }, detail: { value } }), undefined);
          assert.equal(amount(), before);
          assert.equal(writes, beforeWrites);
        }
        const event = { currentTarget: { dataset }, detail: { value: '1.01' } };
        assert.equal(page[commit](event), '2');
        assert.equal(amount(), 2);
        const committedWrites = writes;
        page[commit](event); // confirm followed by blur must commit only once
        assert.equal(writes, committedWrites);
        page[input]({ currentTarget: { dataset }, detail: { value: '' } });
        assert.equal(page[commit](event), '');
        assert.equal(amount(), 0);
        page[input]({ currentTarget: { dataset }, detail: { value: '1' } });
        page[shortcut]({ currentTarget: { dataset: { ...dataset, ratio: 100 } } });
        const selected = amount();
        page[commit](event); // late blur must not overwrite the shortcut
        assert.equal(amount(), selected);
      }
    }
  } finally { harness.restore(); }
});

test('custom profiles survive restart, duplicate odds, settlement and repeated calculation', () => {
  const Core = require('../insurance-module/poker-core');
  const E = require('../insurance-module/domain/insurance-engine');
  const D = require('../insurance-module/store/draft-store');
  const original = Core.ODDS.slice();
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 500, stake: 80, board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }] });
    page.renderState(true);
    const buyer = page.data.view.pools[0].buyers[0].buyer;
    const custom = original.slice();
    custom[8] = 3.4;
    custom[9] = 3.4;
    page.openOddsConfig();
    page.setData({ oddsConfigName: '自定义', oddsConfigDraft: custom.map(String) });
    page.saveOddsConfig();
    const event = { currentTarget: { dataset: { poolId: 'single', buyer, street: 'turn' } } };
    page.setStreetOdds(event, 10);
    assert.equal(page.state.insuranceByPool.single[buyer].turn.outs, 10);
    assert.equal(page.data.view.pools[0].buyers[0].turn.selectedScaleIndex, 10);
    const saved = JSON.parse(JSON.stringify(page.state));
    Core.ODDS.splice(0, 17, ...original);
    const restored = D.hydrateSavedDraft({ state: saved, presentation: { isCalculated: true } });
    assert.equal(restored.state.insuranceByPool.single[buyer].turn.odds, 3.4);
    assert.equal(restored.state.insuranceByPool.single[buyer].turn.oddsOverride, 3.4);
    assert.equal(restored.state.insuranceByPool.single[buyer].turn.outs, 10);
    page.state = restored.state;
    page.dispatch({ type: 'EDIT_STREET', poolId: 'single', buyer, street: 'turn', field: 'buy', value: 10 });
    page.onApplyAuto();
    assert.equal(page.state.insuranceByPool.single[buyer].turn.buy, 10);
    page.state = E.reduceRound(page.state, { type: 'SET_BOARD_CARD', index: 3, card: '2h' });
    const settledBefore = JSON.parse(JSON.stringify(page.state.insuranceByPool.single[buyer].turn));
    const historyBefore = JSON.parse(JSON.stringify(page.state.round.history));
    const payoutBefore = E.selectInsuranceView(page.state).pools[0].buyers.find(x => x.buyer === buyer).turn.payout;
    page.openOddsConfig();
    page.setData({ oddsConfigName: '加倍', oddsConfigDraft: custom.map(x => String(x * 2)) });
    page.saveOddsConfig();
    assert.deepEqual(page.state.insuranceByPool.single[buyer].turn, settledBefore);
    assert.deepEqual(page.state.round.history, historyBefore);
    assert.equal(E.selectInsuranceView(page.state).pools[0].buyers.find(x => x.buyer === buyer).turn.payout, payoutBefore);
    const reopened = D.hydrateSavedDraft({ state: page.state }).state;
    assert.equal(reopened.insuranceByPool.single[buyer].turn.odds, settledBefore.odds);
    assert.equal(E.selectInsuranceView(reopened).pools[0].buyers.find(x => x.buyer === buyer).turn.payout, payoutBefore);
  } finally {
    Core.ODDS.splice(0, 17, ...original);
    harness.restore();
  }
});

test('ninth profile is rejected without discarding a profile or applying its odds', () => {
  const Core = require('../insurance-module/poker-core');
  const original = Core.ODDS.slice();
  const harness = createInsurancePage();
  try {
    const { page, storage } = harness;
    page.onLoad();
    page.oddsProfiles = Array.from({ length: 8 }, (_, i) => ({ name: `配置${i}`, values: original.slice() }));
    const before = JSON.stringify(page.oddsProfiles);
    page.openOddsConfig();
    page.setData({ oddsConfigName: '第九套', oddsConfigDraft: original.map(x => String(x * 2)) });
    page.saveOddsConfig();
    assert.equal(JSON.stringify(page.oddsProfiles), before);
    assert.deepEqual(Core.ODDS, original);
    assert.equal(page.data.oddsConfigVisible, true);
    assert.equal(storage.has('insurance_odds_profiles_v1'), false);
    page.setData({ oddsConfigName: '配置0' });
    page.saveOddsConfig();
    assert.equal(page.oddsProfiles.length, 8);
    assert.equal(page.oddsProfiles[0].values[0], original[0] * 2);
  } finally {
    Core.ODDS.splice(0, 17, ...original);
    harness.restore();
  }
});

function createInsurancePage(storage = new Map()) {
  const pagePath = path.join(root, 'insurance-module/pages/insurance/index.js');
  const previousPage = global.Page;
  const previousWx = global.wx;
  let definition;
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync(key) { return storage.get(key); },
    setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
    removeStorageSync(key) { storage.delete(key); },
    showToast() {}
  };
  delete require.cache[require.resolve(pagePath)];
  require(pagePath);
  const page = {
    ...definition,
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(next) {
      for (const [key, value] of Object.entries(next)) {
        const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts[parts.length - 1]] = value;
      }
    }
  };
  return {
    page,
    storage,
    restore() {
      global.Page = previousPage;
      global.wx = previousWx;
    }
  };
}

test('outs selector groups overlap, single-card changes synchronize, and closing cancels the draft', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const Core = require('../insurance-module/poker-core');
  const harness = createInsurancePage();
  try {
    const { page, storage } = harness;
    page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['Qs', 'Js', '2d'],
      players: [{ key: 'A', cards: ['Ac', 'Ad'] }, { key: 'B', cards: ['Ks', 'Ts'] }] });
    page.onApplyAuto();
    const event = { currentTarget: { dataset: { poolId: 'single', buyer: 'A', street: 'turn' } } };
    const original = JSON.stringify(page.state);
    const stored = JSON.stringify(storage.get('gameble-score:insurance-round:v1'));
    page.openOutsDetail(event);
    page.selectAllOuts({ currentTarget: { dataset: { mode: 'clear' } } });
    assert.equal(page.data.outsDetail.count, 0);
    assert.equal(page.data.outsDetail.oddsText, '—');
    page.closeOutsDetail();
    assert.equal(JSON.stringify(page.state), original);
    assert.equal(JSON.stringify(storage.get('gameble-score:insurance-round:v1')), stored);
    page.openOutsDetail(event);
    page.toggleOutsCard({ currentTarget: { dataset: { card: '9s' } } });
    for (const key of ['flush', 'straight', 'straightFlush']) {
      const group = page.data.outsDetail.groups.find(group => group.key === key);
      assert.equal(group.cards.find(card => card.value === '9s').selected, false);
      assert.equal(group.checked, false); assert.equal(group.partial, true);
    }
    page.selectAllOuts({ currentTarget: { dataset: { mode: 'clear' } } });
    page.toggleOutsGroup({ currentTarget: { dataset: { key: 'flush' } } });
    page.toggleOutsGroup({ currentTarget: { dataset: { key: 'straight' } } });
    const chosen = [...new Set(page.data.outsDetail.groups.filter(group => ['flush', 'straight'].includes(group.key)).flatMap(group => group.cards.map(card => card.value)))];
    assert.equal(page.data.outsDetail.count, chosen.length);
    page.confirmOutsSelection();
    assert.equal(page.data.outsDetail, null);
    assert.equal(page.data.view.pools[0].buyers[0].turn.outsCount, chosen.length);
    assert.equal(page.data.view.pools[0].buyers[0].turn.odds, Core.oddsForOuts(chosen.length));
    assert.equal(page.data.view.pools[0].buyers[0].turn.outsLabel, '已选 outs');
    page.openOutsDetail(event); page.selectAllOuts({ currentTarget: { dataset: { mode: 'clear' } } }); page.confirmOutsSelection();
    assert.equal(page.data.view.pools[0].buyers[0].turn.payout, 0);
    assert.equal(page.data.view.pools[0].buyers[0].turn.maxBuy, 0);
    assert.equal(page.data.view.pools[0].buyers[0].turn.canViewOuts, true);
  } finally { harness.restore(); }
});

test('automatic control restores only the requested street selection and manual drag clears its card selection', () => {
  const E = require('../insurance-module/domain/insurance-engine');
  const harness = createInsurancePage();
  try {
    const { page } = harness; page.onLoad();
    page.state = E.createRound({ coverage: 1000, board: ['7s', '6h', '2c'],
      players: [{ key: 'A', cards: ['Qc', 'Qd'] }, { key: 'B', cards: ['As', 'Kh'] }] });
    page.onApplyAuto();
    const dataset = { poolId: 'single', buyer: 'A', street: 'turn' };
    for (const street of ['turn', 'river']) page.dispatch({ type: 'SELECT_OUTS', ...dataset, street, cards: ['Ah'] });
    page.onOddsQuickSelect({ currentTarget: { dataset: { ...dataset, oddsIndex: 0 } } });
    assert.equal(page.state.insuranceByPool.single.A.turn.outCards.length, 6);
    assert.deepEqual(page.state.insuranceByPool.single.A.river.outCards, ['Ah']);
    page.onOddsSliderChange({ currentTarget: { dataset }, detail: { value: 9 } });
    assert.equal(page.data.view.pools[0].buyers[0].turn.canViewOuts, false);
    assert.equal(page.state.insuranceByPool.single.A.turn.allOutCards, undefined);
    page.onOddsQuickSelect({ currentTarget: { dataset: { ...dataset, oddsIndex: 0 } } });
    assert.equal(page.state.insuranceByPool.single.A.turn.outCards.length, 6);
    page.onBoardCardsSelect({ detail: { values: ['7s', '6h', '2c', '3d'] } });
    page.openOutsDetail({ currentTarget: { dataset } });
    const frozen = JSON.stringify(page.state.insuranceByPool.single.A.turn);
    assert.equal(page.data.outsDetail.settled, true);
    page.selectAllOuts({ currentTarget: { dataset: { mode: 'clear' } } });
    page.toggleOutsCard({ currentTarget: { dataset: { card: 'Ah' } } });
    page.confirmOutsSelection();
    assert.equal(JSON.stringify(page.state.insuranceByPool.single.A.turn), frozen);
  } finally { harness.restore(); }
});

test('profile selection highlight follows the draft and resets on cancel', () => {
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    const original = page.activeOddsProfile;
    page.oddsProfiles.push({ name: '另一套', values: original.values.slice() });
    page.openOddsConfig();
    page.onOddsProfileTap({ currentTarget: { dataset: { index: 1 } } });
    assert.equal(page.data.selectedOddsProfile, '另一套');
    assert.equal(page.data.oddsConfigName, '另一套');
    assert.equal(page.activeOddsProfile.name, original.name);
    page.closeOddsConfig();
    page.openOddsConfig();
    assert.equal(page.data.selectedOddsProfile, original.name);
    page.onOddsProfileChange({ detail: { value: 1 } });
    assert.equal(page.data.selectedOddsProfile, '另一套');
    page.saveOddsConfig();
    page.openOddsConfig();
    assert.equal(page.data.selectedOddsProfile, '另一套');
    assert.equal(page.activeOddsProfile.name, '另一套');
  } finally {
    harness.restore();
  }
});

test('deleting odds profiles confirms the selection, switches active odds, and keeps one profile', () => {
  const Core = require('../insurance-module/poker-core');
  const original = Core.ODDS.slice();
  const harness = createInsurancePage();
  try {
    const { page, storage } = harness;
    page.onLoad();
    page.openOddsConfig();
    assert.equal(page.oddsProfiles.length, 1);
    page.deleteOddsConfig();
    assert.equal(page.oddsProfiles.length, 1);

    page.setData({ oddsConfigName: '自定义', oddsConfigDraft: original.map(value => String(value * 2)) });
    page.saveOddsConfig();
    page.openOddsConfig();
    page.setData({ oddsConfigName: '备用', oddsConfigDraft: original.map(value => String(value * 3)) });
    page.saveOddsConfig();
    assert.deepEqual(page.oddsProfiles.map(profile => profile.name), ['备用', '自定义', '默认赔率']);
    assert.equal(page.activeOddsProfile.name, '备用');

    let confirm = false;
    global.wx.showModal = ({ success }) => success({ confirm });
    page.openOddsConfig();
    page.onOddsProfileTap({ currentTarget: { dataset: { index: 1 } } });
    page.setData({ oddsConfigName: '未保存的新名称' });
    page.deleteOddsConfig();
    assert.equal(page.oddsProfiles.length, 3);
    confirm = true;
    page.deleteOddsConfig();
    assert.deepEqual(page.oddsProfiles.map(profile => profile.name), ['备用', '默认赔率']);
    assert.equal(page.activeOddsProfile.name, '备用');
    assert.deepEqual(Core.ODDS, original.map(value => value * 3));
    assert.equal(page.data.selectedOddsProfile, '备用');
    assert.equal(page.data.oddsConfigName, '备用');

    page.deleteOddsConfig();
    assert.deepEqual(page.oddsProfiles.map(profile => profile.name), ['默认赔率']);
    assert.equal(page.activeOddsProfile.name, '默认赔率');
    assert.deepEqual(Core.ODDS, original);
    assert.deepEqual(page.state.oddsConfig, original);
    assert.deepEqual(storage.get('insurance_odds_profiles_v1').map(profile => profile.name), ['默认赔率']);
    assert.deepEqual(storage.get('gameble-score:insurance-round:v1').state.oddsConfig, original);
    page.deleteOddsConfig();
    assert.equal(page.oddsProfiles.length, 1);
    const wxml = fs.readFileSync(path.join(root, 'insurance-module/pages/insurance/index.wxml'), 'utf8');
    assert.match(wxml, /disabled="\{\{oddsProfiles\.length <= 1\}\}" bindtap="deleteOddsConfig">删除配置/);
  } finally {
    Core.ODDS.splice(0, Core.ODDS.length, ...original);
    harness.restore();
  }
});

test('insurance calculator remains a local page with a registered home entry', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const homeWxml = fs.readFileSync(path.join(root, 'pages/home/home.wxml'), 'utf8');
  const homeJs = fs.readFileSync(path.join(root, 'pages/home/home.js'), 'utf8');
  const pageConfig = JSON.parse(fs.readFileSync(
    path.join(root, 'insurance-module/pages/insurance/index.json'),
    'utf8',
  ));
  const Insurance = require(path.join(root, 'insurance-module/domain/insurance-engine'));
  const Core = require(path.join(root, 'insurance-module/poker-core'));
  const insuranceWxml = fs.readFileSync(
    path.join(root, 'insurance-module/pages/insurance/index.wxml'),
    'utf8',
  );
  const insurancePageJs = fs.readFileSync(
    path.join(root, 'insurance-module/pages/insurance/index.js'),
    'utf8',
  );
  const insuranceEngineJs = fs.readFileSync(
    path.join(root, 'insurance-module/domain/insurance-engine.js'),
    'utf8',
  );
  const cardPickerJs = fs.readFileSync(
    path.join(root, 'insurance-module/components/card-picker/index.js'),
    'utf8',
  );
  const cardPickerWxml = fs.readFileSync(
    path.join(root, 'insurance-module/components/card-picker/index.wxml'),
    'utf8',
  );
  const cardPickerWxss = fs.readFileSync(
    path.join(root, 'insurance-module/components/card-picker/index.wxss'),
    'utf8',
  );

  assert.ok(appConfig.pages.includes('insurance-module/pages/insurance/index'));
  assert.match(homeWxml, /bindtap="openInsurance">保险/);
  assert.match(homeJs, /openInsurance\(\)\s*\{\s*wx\.navigateTo\(/);
  assert.equal(pageConfig.usingComponents['card-picker'], '/insurance-module/components/card-picker/index');
  assert.match(insuranceWxml, /<view wx:if="\{\{view\}\}" class="page">/);
  assert.doesNotMatch(insuranceWxml, /class="status-summary"/);
  assert.match(insuranceWxml, /options="\{\{view\.boardOptions\}\}" values="\{\{view\.board\}\}" max="5"/);
  assert.match(insuranceWxml, /bindselect="onBoardCardsSelect"/);
  assert.match(insuranceWxml, /bindtap="onOddsQuickSelect"/);
  assert.doesNotMatch(insuranceWxml, /class="outs-slider"/);
  assert.match(insuranceWxml, /class="street-outs-value"/);
  assert.doesNotMatch(insuranceWxml, /赔率 \/ outs 联动调节/);
  assert.match(insuranceWxml, /class="odds-slider"[\s\S]*bindchanging="onOddsSliderChanging"/);
  assert.match(insuranceWxml, /disabled="\{\{!buyer\.turn\.configurable\}\}"/);
  assert.match(insuranceWxml, /disabled="\{\{!buyer\.river\.configurable\}\}"/);
  assert.match(insuranceWxml, /按当前牌局计算/);
  assert.match(insuranceWxml, /class="recalc-note"/);
  assert.match(insuranceWxml, /class="inline-reset-button"[^>]*bindtap="onReset"/);
  assert.match(insuranceWxml, /wx:if="\{\{!isCalculated \|\| !view\.pools\.length\}\}"/);
  assert.match(insuranceWxml, /wx:if="\{\{isCalculated\}\}"/);
  assert.match(insuranceWxml, /value="\{\{previewTurn\.oddsIndex\}\}"/);
  assert.match(insuranceWxml, /value="\{\{previewRiver\.oddsIndex\}\}"/);
  assert.match(insuranceWxml, /bindchanging="onPreviewOddsChange"/);
  assert.doesNotMatch(insuranceWxml, /preview-outs-picker|onPreviewOutsSelect/);
  assert.match(insuranceWxml, /class="street-outs-value">\{\{previewTurn.outs\}\} 张/);
  assert.match(insuranceWxml, /class="street-outs-value">\{\{previewRiver.outs\}\} 张/);
  assert.match(insuranceWxml, /bindinput="onPreviewBuyInput"/);
  assert.match(insuranceWxml, /bindtap="onPreviewBuyRatioTap"/);
  assert.match(insuranceWxml, /value="\{\{previewTurn\.buyInput\}\}"/);
  assert.match(insuranceWxml, /value="\{\{buyer\.turn\.buyInput\}\}"/);
  assert.match(insuranceWxml, /bindchange="onPreviewBuyerChange"/);
  assert.match(insuranceWxml, /预设购买人/);
  assert.match(insurancePageJs, /const configurable = street\.status === "current" \|\| street\.status === "estimated";/);
  assert.match(insurancePageJs, /function previewStreet\(index, buy = 0, coverage = 0\)/);
  assert.match(insurancePageJs, /onPreviewOddsTap\(event\)/);
  assert.match(insurancePageJs, /onPreviewBuyRatioTap\(event\)/);
  assert.match(insurancePageJs, /applyPreviewBuy\(view\)/);
  assert.match(insurancePageJs, /isCalculated: false/);
  assert.match(insurancePageJs, /calculationInputActions\.has\(action\.type\) && !continuesBoard \? false : this\.presentation\.isCalculated/);
  assert.match(insuranceEngineJs, /applyAutomaticOuts\(current, \{ forceAuto: true, resetSelection:/);
  assert.match(cardPickerJs, /option\.disabled/);
  assert.match(cardPickerWxml, /class="card-modal-action card-action-clear" bindtap="clearCards"/);
  assert.match(cardPickerWxml, /class="card-modal-action card-action-cancel" bindtap="closePicker"/);
  assert.match(cardPickerWxml, /class="card-modal-action card-action-confirm"/);
  assert.doesNotMatch(cardPickerWxss, /\sbutton\s*[,{]/);
  assert.equal(Core.validInsuranceOdds(3.5), 3.5);
  assert.equal(Core.validInsuranceOdds(3.4), 0);

  const state = Insurance.createRound({
    coverage: 500,
    stake: 80,
    board: ['As', 'Kd', 'Qc'],
    players: [
      { key: 'A', cards: ['Tc', 'Td'] },
      { key: 'B', cards: ['3c', '3d'] },
    ],
  });
  const view = Insurance.selectInsuranceView(state);
  assert.equal(view.pools.length, 1);
});

test('manual odds slider keeps odds and outs in one synchronized pair', () => {
  const Insurance = require(path.join(root, 'insurance-module/domain/insurance-engine'));
  const state = Insurance.createRound({
    coverage: 500,
    stake: 80,
    board: ['As', 'Kd', 'Qc'],
    players: [
      { key: 'A', cards: ['Tc', 'Td'] },
      { key: 'B', cards: ['3c', '3d'] }
    ]
  });
  const buyer = Insurance.selectInsuranceView(state).pools[0].buyers[0].buyer;
  const manual = Insurance.reduceRound(state, {
    type: 'EDIT_STREET',
    poolId: 'single',
    buyer,
    street: 'turn',
    field: 'odds',
    value: 2.8
  });
  const turn = manual.insuranceByPool.single[buyer].turn;
  assert.equal(turn.odds, 2.8);
  assert.equal(turn.outs, 9);
  assert.equal(turn.oddsOverride, 2.8);
  const automatic = Insurance.reduceRound(manual, {
    type: 'EDIT_STREET',
    poolId: 'single',
    buyer,
    street: 'turn',
    field: 'odds',
    value: 0
  });
  const restored = automatic.insuranceByPool.single[buyer].turn;
  assert.equal(restored.oddsOverride, 0);
  assert.equal(restored.odds, Insurance.selectInsuranceView(automatic).pools[0].buyers[0].turn.odds);
});

test('custom odds profile remaps every outs value and persists the active configuration', () => {
  const Insurance = require(path.join(root, 'insurance-module/domain/insurance-engine'));
  const Core = require(path.join(root, 'insurance-module/poker-core'));
  const original = Core.ODDS.slice();
  try {
    const custom = original.map((value, index) => Number((value + index / 10).toFixed(2)));
    const state = Insurance.createRound({
      coverage: 500,
      stake: 80,
      board: ['As', 'Kd', 'Qc'],
      players: [{ key: 'A', cards: ['Tc', 'Td'] }, { key: 'B', cards: ['3c', '3d'] }]
    });
    const buyer = Insurance.selectInsuranceView(state).pools[0].buyers[0].buyer;
    const manual = Insurance.reduceRound(state, { type: 'EDIT_STREET', poolId: 'single', buyer, street: 'turn', field: 'odds', value: original[8] });
    Core.ODDS.splice(0, Core.ODDS.length, ...custom);
    const configured = Insurance.reduceRound(manual, { type: 'SET_ODDS_CONFIG', values: custom });
    const turn = configured.insuranceByPool.single[buyer].turn;
    assert.deepEqual(configured.oddsConfig, custom);
    assert.equal(turn.outs, 9);
    assert.equal(turn.odds, custom[8]);
    assert.equal(turn.oddsOverride, custom[8]);
  } finally {
    Core.ODDS.splice(0, Core.ODDS.length, ...original);
  }
});

test('automatic odds control restores board-derived outs after manual adjustment', () => {
  const Insurance = require(path.join(root, 'insurance-module/domain/insurance-engine'));
  const harness = createInsurancePage();
  try {
    const { page } = harness;
    page.onLoad();
    page.state = Insurance.createRound({
      coverage: 500,
      stake: 80,
      board: ['As', 'Kd', 'Qc'],
      players: [
        { key: 'A', cards: ['Tc', 'Td'] },
        { key: 'B', cards: ['3c', '3d'] }
      ]
    });
    page.renderState(false);
    const buyer = page.data.view.pools[0].buyers[0].buyer;
    page.presentation.previewBuyer = buyer;
    page.state = Insurance.reduceRound(page.state, {
      type: 'EDIT_STREET', poolId: 'single', buyer, street: 'turn', field: 'odds', value: 2.8
    });
    page.renderState(true);
    page.onOddsQuickSelect({ currentTarget: { dataset: { oddsIndex: 0 } } });
    const turn = page.state.insuranceByPool.single[buyer].turn;
    assert.equal(turn.oddsOverride, 0);
    assert.equal(turn.source, 'auto');
    assert.equal(turn.outs, turn.outCards.length);
  } finally {
    harness.restore();
  }
});

test('insurance preview and actual buy amounts are capped, applied, and restored', () => {
  const Insurance = require(path.join(root, 'insurance-module/domain/insurance-engine'));
  const harness = createInsurancePage();
  try {
    const { page, storage } = harness;
    page.onLoad();
    assert.equal(page.data.stateCoverage, '');
    assert.equal(page.data.stateStake, '');
    assert.equal(page.data.previewTurn.buyInput, '');
    assert.equal(page.data.previewRiver.buyInput, '');
    page.dispatch({ type: 'SET_AMOUNT', field: 'coverage', value: 100 });
    assert.equal(page.data.stateCoverage, '100');
    page.setPreviewOdds('turn', 1);
    page.setPreviewBuy('turn', 100);
    assert.equal(page.data.previewTurn.buy, 4);
    assert.equal(page.data.previewTurn.payoutText, '120.00');
    assert.equal(storage.get('gameble-score:insurance-round:v1').presentation.previewTurn.buy, 4);
    page.onPreviewBuyRatioTap({ currentTarget: { dataset: { street: 'turn', ratio: 100 } } });
    assert.equal(page.data.previewTurn.buyInput, '4');
    const overflowInput = { currentTarget: { dataset: { street: 'turn' } }, detail: { value: '999' } };
    page.onPreviewBuyInput(overflowInput);
    assert.equal(page.onPreviewBuyCommit(overflowInput), '4');
    for (const street of ['turn', 'river']) {
      for (const ratio of [100, 85, 75, 60, 50]) {
        page.onPreviewBuyRatioTap({ currentTarget: { dataset: { street, ratio } } });
        assert.equal(page.data[street === 'turn' ? 'previewTurn' : 'previewRiver'].buy, Math.ceil(4 * ratio / 100));
      }
      const decimalInput = { currentTarget: { dataset: { street } }, detail: { value: '1.01' } };
      page.onPreviewBuyInput(decimalInput);
      assert.equal(page.onPreviewBuyCommit(decimalInput), '2');
    }

    page.state = Insurance.createRound({
      coverage: 100,
      stake: 10,
      board: ['As', 'Kd', 'Qc'],
      players: [
        { key: 'A', cards: ['Tc', 'Td'] },
        { key: 'B', cards: ['3c', '3d'] }
      ]
    });
    page.renderState(false);
    assert.equal(page.data.view.pools[0].buyers[0].turn.buyInput, '');
    assert.equal(page.data.view.pools[0].buyers[0].river.buyInput, '');
    const view = Insurance.selectInsuranceView(page.state);
    const buyer = view.pools[0].buyers[0].buyer;
    page.presentation.previewBuyer = buyer;
    page.setPreviewBuy('turn', 100);
    page.setPreviewBuy('river', 100);
    page.onApplyAuto();

    const record = page.state.insuranceByPool.single[buyer];
    assert.equal(page.data.isCalculated, true);
    assert.equal(record.turn.buy, page.data.previewTurn.buy);
    assert.equal(record.river.buy, page.data.previewRiver.buy);
    assert.ok(record.turn.buy <= record.coverage / record.turn.odds);
    assert.ok(record.river.buy <= record.coverage / record.river.odds);

    const manuallyCapped = Insurance.reduceRound(page.state, {
      type: 'EDIT_STREET',
      poolId: 'single',
      buyer,
      street: 'turn',
      field: 'buy',
      value: 9999
    });
    const manuallyCappedTurn = manuallyCapped.insuranceByPool.single[buyer].turn;
    assert.equal(manuallyCappedTurn.buy, Math.ceil(record.coverage / manuallyCappedTurn.odds));
    const cappedView = Insurance.selectInsuranceView(manuallyCapped).pools[0].buyers.find((item) => item.buyer === buyer);
    assert.equal(cappedView.turn.buy, manuallyCappedTurn.buy);
    assert.equal(cappedView.turn.payout, manuallyCappedTurn.buy * manuallyCappedTurn.odds);
    const inputEvent = { currentTarget: { dataset: { poolId: 'single', buyer, street: 'turn', field: 'buy' } }, detail: { value: '1.01' } };
    page.onStreetInput(inputEvent);
    assert.equal(page.onStreetBuyCommit(inputEvent), '2');
    for (const ratio of [100, 85, 75, 60, 50]) {
      page.onBuyRatioTap({ currentTarget: { dataset: { poolId: 'single', buyer, street: 'turn', max: 7, ratio } } });
      assert.equal(page.state.insuranceByPool.single[buyer].turn.buy, Math.ceil(7 * ratio / 100));
    }

    const restoredHarness = createInsurancePage(storage);
    try {
      restoredHarness.page.onLoad();
      assert.equal(restoredHarness.page.data.isCalculated, true);
      assert.equal(restoredHarness.page.data.previewTurn.buy, page.data.previewTurn.buy);
      assert.equal(restoredHarness.page.data.previewRiver.buy, page.data.previewRiver.buy);
      assert.equal(restoredHarness.page.data.previewBuyer, buyer);
    } finally {
      restoredHarness.restore();
    }
  } finally {
    harness.restore();
  }
});
