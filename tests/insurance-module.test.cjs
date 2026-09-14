const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

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
    setData(next) { Object.assign(this.data, next); }
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
  assert.match(insuranceWxml, /^<view wx:if="\{\{view\}\}" class="page">/);
  assert.doesNotMatch(insuranceWxml, /class="status-summary"/);
  assert.match(insuranceWxml, /options="\{\{view\.boardOptions\}\}" values="\{\{view\.board\}\}" max="5"/);
  assert.match(insuranceWxml, /bindselect="onBoardCardsSelect"/);
  assert.match(insuranceWxml, /bindtap="onOddsQuickSelect"/);
  assert.match(insuranceWxml, /disabled="\{\{!buyer\.turn\.configurable\}\}"/);
  assert.match(insuranceWxml, /disabled="\{\{!buyer\.river\.configurable\}\}"/);
  assert.match(insuranceWxml, /按当前牌局计算/);
  assert.match(insuranceWxml, /class="recalc-note"/);
  assert.match(insuranceWxml, /class="inline-reset-button" bindtap="onReset"/);
  assert.match(insuranceWxml, /wx:if="\{\{!isCalculated \|\| !view\.pools\.length\}\}"/);
  assert.match(insuranceWxml, /wx:if="\{\{isCalculated\}\}"/);
  assert.match(insuranceWxml, /value="\{\{previewTurn\.oddsIndex\}\}"/);
  assert.match(insuranceWxml, /value="\{\{previewRiver\.oddsIndex\}\}"/);
  assert.match(insuranceWxml, /bindchanging="onPreviewOddsChange"/);
  assert.match(insuranceWxml, /bindchange="onPreviewOutsSelect"/);
  assert.match(insuranceWxml, /bindinput="onPreviewBuyInput"/);
  assert.match(insuranceWxml, /bindtap="onPreviewBuyRatioTap"/);
  assert.match(insuranceWxml, /value="\{\{previewTurn\.buyInput\}\}"/);
  assert.match(insuranceWxml, /value="\{\{buyer\.turn\.buyInput\}\}"/);
  assert.match(insuranceWxml, /bindchange="onPreviewBuyerChange"/);
  assert.match(insuranceWxml, /预设购买人/);
  assert.match(insurancePageJs, /const configurable = street\.status === "current" \|\| street\.status === "estimated";/);
  assert.match(insurancePageJs, /function previewStreet\(index, buy = 0, coverage = 0\)/);
  assert.match(insurancePageJs, /onPreviewOddsTap\(event\)/);
  assert.match(insurancePageJs, /onPreviewOutsSelect\(event\)/);
  assert.match(insurancePageJs, /onPreviewBuyRatioTap\(event\)/);
  assert.match(insurancePageJs, /applyPreviewBuy\(view\)/);
  assert.match(insurancePageJs, /isCalculated: false/);
  assert.match(insurancePageJs, /calculationInputActions\.has\(action\.type\) \? false : this\.presentation\.isCalculated/);
  assert.match(insuranceEngineJs, /applyAutomaticOuts\(current, \{ forceAuto: true \}\)/);
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
    assert.equal(page.data.previewTurn.buy, 100 / 30);
    assert.equal(page.data.previewTurn.payoutText, '100.00');
    assert.equal(storage.get('gameble-score:insurance-round:v1').presentation.previewTurn.buy, 100 / 30);

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
    assert.equal(manuallyCappedTurn.buy, record.coverage / manuallyCappedTurn.odds);

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
