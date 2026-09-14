const Core = require("../../poker-core");
const Insurance = require("../../domain/insurance-engine");
const { loadDraft, saveDraft, clearDraft } = require("../../store/draft-store");

const cardChoices = [{ label: "清空", value: "" }, ...Core.CARD_DECK.map((value) => ({ label: value, value }))];
const oddsValues = [0, ...Core.ODDS];
const oddsLabels = ["自动", ...Core.ODDS.map((value) => `${value}x`)];
const oddsScale = Core.ODDS.map((value, index) => ({ label: String(value), index: index + 1, position: index + 1 }));
const buyRatios = [100, 85, 75, 60, 50].map((value) => ({ value, label: `${value}%` }));
const rankLabels = ["自动", "第 1 名", "第 2 名", "第 3 名", "第 4 名"];
const playerCountLabels = ["2 人", "3 人", "4 人"];
const statusLabels = ["未执行", "已爆", "安全"];
const statusValues = ["unseen", "hit", "safe"];
const calculationInputActions = new Set([
  "RESET",
  "SET_POOL_MODE",
  "SET_PLAYER_COUNT",
  "SET_PLAYER_CARD",
  "SET_BOARD_CARD",
  "SET_AMOUNT",
  "SET_CONTRIBUTION",
  "SET_RANK"
]);

function inputValue(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number === 0) return "";
  return value === null || value === undefined ? "" : String(value);
}

function previewStreet(index, buy = 0, coverage = 0) {
  const oddsIndex = Math.max(1, Math.min(Core.ODDS.length, Math.trunc(Number(index)) || 1));
  const odds = Core.ODDS[oddsIndex - 1];
  const requestedBuy = Math.max(0, Number(buy) || 0);
  const previewCoverage = Math.max(0, Number(coverage) || 0);
  const hasCoverage = previewCoverage > 0;
  const maxBuy = hasCoverage ? previewCoverage / odds : 0;
  const previewBuy = hasCoverage ? Math.min(requestedBuy, maxBuy) : requestedBuy;
  return {
    oddsIndex,
    outs: oddsIndex,
    outsPickerIndex: oddsIndex - 1,
    oddsText: `${odds}x`,
    buy: previewBuy,
    buyInput: inputValue(previewBuy),
    hasCoverage,
    maxBuy,
    maxBuyLabel: hasCoverage ? `最多可买 ¥${maxBuy.toFixed(2)}` : "填写可保底池后可使用快捷比例",
    payoutText: (previewBuy * odds).toFixed(2)
  };
}

function compactPreview(street) {
  const current = street && typeof street === "object" ? street : {};
  return {
    oddsIndex: Math.max(1, Math.min(Core.ODDS.length, Math.trunc(Number(current.oddsIndex)) || 1)),
    buy: Math.max(0, Number(current.buy) || 0)
  };
}

function createPresentation(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const previewBuyer = ["A", "B", "C", "D"].includes(source.previewBuyer) ? source.previewBuyer : "A";
  return {
    isCalculated: Boolean(source.isCalculated),
    previewBuyer,
    previewTurn: compactPreview(source.previewTurn),
    previewRiver: compactPreview(source.previewRiver)
  };
}

function canShowCalculatedResult(state, view) {
  const board = state && state.table && Array.isArray(state.table.board) ? state.table.board : [];
  const hasFlop = board.slice(0, 3).every(Boolean);
  const hasBuyer = Boolean(view && view.pools && view.pools.some((pool) => Array.isArray(pool.buyers) && pool.buyers.length));
  return hasFlop && hasBuyer;
}

function decorateView(view) {
  const result = JSON.parse(JSON.stringify(view));
  const money = (value) => Number(value || 0).toFixed(2);
  const percent = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
  const strategyText = (strategy) => Object.fromEntries(Object.entries(strategy || {}).map(([key, value]) => [key, money(value)]));
  const slots = [];
  result.board.forEach((card, index) => slots.push({ key: `board:${index}`, card }));
  result.players.forEach((player) => player.cards.forEach((card, index) => slots.push({ key: `player:${player.key}:${index}`, card })));
  const groupOptions = (prefix, currentValues) => {
    const selected = new Set((currentValues || []).filter(Boolean));
    const used = new Set(slots.filter((slot) => !slot.key.startsWith(prefix) && slot.card).map((slot) => slot.card));
    return cardChoices.map((option) => ({
      ...option,
      disabled: Boolean(option.value && used.has(option.value) && !selected.has(option.value))
    }));
  };
  const decorateStreet = (street, coverage) => {
    const override = Core.validInsuranceOdds(street.oddsOverride);
    const odds = Number(street.odds) || 0;
    const scaleIndex = Core.ODDS.indexOf(odds) + 1;
    const configurable = street.status === "current" || street.status === "estimated";
    const maxBuy = configurable && odds > 0 ? Number(coverage || 0) / odds : 0;
    return {
      ...street,
      outsInput: inputValue(street.outs),
      oddsPickerIndex: Math.max(0, oddsValues.indexOf(override)),
      oddsLabel: odds ? `${odds}x${override ? " · 手动" : " · 自动"}` : "自动",
      oddsValueText: odds ? `${odds}x` : "—",
      oddsModeText: override ? "手动赔率" : "自动赔率",
      oddsScaleIndex: Math.max(1, scaleIndex),
      selectedScaleIndex: scaleIndex > 0 ? scaleIndex : 0,
      maxBuy,
      maxBuyText: money(maxBuy),
      buyInput: inputValue(street.buy),
      payoutText: money(street.payout),
      configurable
    };
  };
  result.oddsLabels = oddsLabels;
  result.oddsTable = oddsLabels.map((label, index) => ({ label, index }));
  result.oddsScale = oddsScale;
  result.previewOutsOptions = Core.ODDS.map((odds, index) => ({
    value: index + 1,
    label: `${index + 1} 张 · ${odds}x`
  }));
  result.buyRatios = buyRatios;
  result.rankLabels = rankLabels;
  result.statusLabels = statusLabels;
  result.playerCountLabels = playerCountLabels;
  result.playerCountPickerIndex = Math.max(0, result.players.length - 2);
  result.boardOptions = groupOptions("board:", result.board);
  result.players = result.players.map((player) => ({
    ...player,
    cardOptions: groupOptions(`player:${player.key}:`, player.cards),
    rankPickerIndex: player.rank || 0,
    nextOutsText: `${player.nextOuts} 张`,
    equityBreakdownText: `${(player.equityBreakdown.win * 100).toFixed(1)}% 胜 / ${(player.equityBreakdown.tie * 100).toFixed(1)}% 平 / ${(player.equityBreakdown.lose * 100).toFixed(1)}% 负`,
    financial: {
      ...player.financial,
      allInText: money(player.financial.allIn),
      actualInPotText: money(player.financial.actualInPot),
      returnedText: money(player.financial.returned),
      plannedBuyText: money(player.financial.plannedBuy),
      expectedNetText: money(player.financial.expectedNet)
    }
  }));
  result.pools = result.pools.map((pool) => ({
    ...pool,
    amountText: money(pool.amount),
    leadersText: pool.leaders.length ? pool.leaders.join(", ") : "暂无领先",
    buyers: pool.buyers.map((buyer) => ({
      ...buyer,
      turn: {
        ...decorateStreet(buyer.turn, pool.amount),
        statusPickerIndex: Math.max(0, statusValues.indexOf(buyer.turn.resolvedStatus || buyer.turn.status))
      },
      river: {
        ...decorateStreet(buyer.river, pool.amount),
        statusPickerIndex: Math.max(0, statusValues.indexOf(buyer.river.resolvedStatus || buyer.river.status))
      },
      settlement: {
        ...buyer.settlement,
        probabilityTexts: {
          turnHit: percent(buyer.settlement.probabilities.turnHit),
          riverHit: percent(buyer.settlement.probabilities.riverHit),
          bothSafe: percent(buyer.settlement.probabilities.bothSafe)
        },
        rows: buyer.settlement.rows.map((row) => ({
          ...row,
          probabilityText: percent(row.probability),
          buyText: money(row.buy),
          receiptText: money(row.receipt),
          netText: money(row.net)
        }))
      },
      strategyEV: {
        ...buyer.strategyEV,
        text: strategyText(buyer.strategyEV)
      }
    })),
    summary: {
      ...pool.summary,
      strategyEVText: strategyText(pool.summary.strategyEV),
      plannedBuyText: money(pool.summary.plannedBuy),
      settledBuyText: money(pool.summary.settledBuy),
      settledReceiptText: money(pool.summary.settledReceipt),
      settledNetText: money(pool.summary.settledNet),
      expectedReceiptText: money(pool.summary.expectedReceipt),
      expectedNoInsuranceText: money(pool.summary.expectedNoInsurance),
      expectedNetText: money(pool.summary.expectedNet),
      worstNetText: money(pool.summary.worstNet),
      bestNetText: money(pool.summary.bestNet)
    }
  }));
  result.summary = {
    ...result.summary,
    strategyEVText: strategyText(result.summary.strategyEV),
    totalAllInText: money(result.summary.totalAllIn),
    totalActualInPotText: money(result.summary.totalActualInPot),
    returnedText: money(result.summary.returned),
    settledBuyText: money(result.summary.settledBuy),
    settledReceiptText: money(result.summary.settledReceipt),
    settledNetText: money(result.summary.settledNet),
    plannedBuyText: result.summary.plannedBuy.toFixed(2),
    expectedNetText: result.summary.expectedNet.toFixed(2),
    expectedNoInsuranceText: result.summary.expectedNoInsurance.toFixed(2),
    worstNetText: result.summary.worstNet.toFixed(2),
    bestNetText: result.summary.bestNet.toFixed(2)
  };
  return result;
}

Page({
  data: {
    view: null,
    mode: "single",
    isCalculated: false,
    previewBuyer: "A",
    previewBuyerIndex: 0,
    previewBuyerOptions: [{ value: "A", label: "玩家 A" }],
    previewTurn: previewStreet(1),
    previewRiver: previewStreet(1)
  },

  onLoad() {
    const draft = loadDraft();
    this.state = draft ? draft.state : Insurance.createRound();
    this.presentation = createPresentation(draft && draft.presentation);
    this.renderState(this.presentation.isCalculated);
  },

  persistDraft() {
    saveDraft(this.state, this.presentation);
  },

  renderState(isCalculated = this.presentation && this.presentation.isCalculated) {
    const view = Insurance.selectInsuranceView(this.state);
    const coverage = this.state.inputs.coverage;
    const presentation = createPresentation(this.presentation);
    const previewTurn = previewStreet(presentation.previewTurn.oddsIndex, presentation.previewTurn.buy, coverage);
    const previewRiver = previewStreet(presentation.previewRiver.oddsIndex, presentation.previewRiver.buy, coverage);
    const previewBuyerOptions = view.players.map((player) => ({ value: player.key, label: `玩家 ${player.key}` }));
    const previewBuyerIndex = Math.max(0, previewBuyerOptions.findIndex((option) => option.value === presentation.previewBuyer));
    const previewBuyer = (previewBuyerOptions[previewBuyerIndex] || previewBuyerOptions[0] || { value: "A" }).value;
    this.presentation = {
      isCalculated: Boolean(isCalculated) && canShowCalculatedResult(this.state, view),
      previewBuyer,
      previewTurn: compactPreview(previewTurn),
      previewRiver: compactPreview(previewRiver)
    };
    this.setData({
      view: decorateView(view),
      mode: this.state.poolMode,
      stateCoverage: inputValue(this.state.inputs.coverage),
      stateStake: inputValue(this.state.inputs.stake),
      contributions: Object.fromEntries(Object.entries(this.state.inputs.contributions || {}).map(([key, value]) => [key, inputValue(value)])),
      isCalculated: this.presentation.isCalculated,
      previewBuyer,
      previewBuyerIndex,
      previewBuyerOptions,
      previewTurn,
      previewRiver
    });
    return view;
  },

  dispatch(action) {
    this.state = Insurance.reduceRound(this.state, action);
    this.renderState(calculationInputActions.has(action.type) ? false : this.presentation.isCalculated);
    this.persistDraft();
  },

  onModeTap(event) {
    this.dispatch({ type: "SET_POOL_MODE", mode: event.currentTarget.dataset.mode });
  },

  onPlayerCountChange(event) {
    this.dispatch({ type: "SET_PLAYER_COUNT", count: Number(event.detail.value) + 2 });
  },

  onCardSelect(event) {
    const detail = event.detail || {};
    if (detail.player) {
      this.dispatch({ type: "SET_PLAYER_CARD", player: detail.player, index: detail.cardIndex, card: detail.value });
      return;
    }
    this.dispatch({ type: "SET_BOARD_CARD", index: detail.boardIndex, card: detail.value });
  },

  onBoardCardsSelect(event) {
    const values = Array.isArray(event.detail && event.detail.values) ? event.detail.values.slice(0, 5) : [];
    const current = this.state.table.board.slice();
    for (let index = current.length - 1; index >= values.length; index -= 1) {
      if (current[index]) this.dispatch({ type: "SET_BOARD_CARD", index, card: "" });
    }
    for (let index = 0; index < values.length; index += 1) {
      if (current[index] !== values[index]) this.dispatch({ type: "SET_BOARD_CARD", index, card: values[index] });
    }
  },

  onPlayerCardsSelect(event) {
    const player = String(event.detail && event.detail.player || "");
    const values = Array.isArray(event.detail && event.detail.values) ? event.detail.values.slice(0, 2) : [];
    const current = (this.state.table.players.find((item) => item.key === player) || { cards: ["", ""] }).cards;
    for (let index = 0; index < 2; index += 1) {
      const next = values[index] || "";
      if (current[index] !== next) this.dispatch({ type: "SET_PLAYER_CARD", player, index, card: next });
    }
  },

  onAmountInput(event) {
    this.dispatch({
      type: "SET_AMOUNT",
      field: event.currentTarget.dataset.field,
      value: event.detail.value
    });
  },

  onContributionInput(event) {
    this.dispatch({
      type: "SET_CONTRIBUTION",
      player: event.currentTarget.dataset.player,
      value: event.detail.value
    });
  },

  onRankChange(event) {
    this.dispatch({
      type: "SET_RANK",
      player: event.currentTarget.dataset.player,
      value: Number(event.detail.value)
    });
  },

  onStreetInput(event) {
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: event.currentTarget.dataset.field,
      value: event.detail.value
    });
  },

  onOutsSliderChange(event) {
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: "outs",
      value: event.detail.value
    });
  },

  onStatusChange(event) {
    const index = Number(event.detail.value);
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: "status",
      value: statusValues[index] || "unseen"
    });
  },

  onOddsChange(event) {
    const index = Number(event.detail.value);
    this.setStreetOdds(event, index);
  },

  onOddsSliderChange(event) {
    const index = Number(event.detail.value);
    this.setStreetOdds(event, index);
  },

  setPreviewOdds(street, index) {
    const field = street === "river" ? "previewRiver" : "previewTurn";
    const current = this.data[field] || previewStreet(1);
    const next = previewStreet(index, current.buy, this.state.inputs.coverage);
    this.presentation = { ...createPresentation(this.presentation), [field]: compactPreview(next) };
    this.setData({ [field]: next });
    this.persistDraft();
  },

  setPreviewBuy(street, buy) {
    const field = street === "river" ? "previewRiver" : "previewTurn";
    const current = this.data[field] || previewStreet(1);
    const next = previewStreet(current.oddsIndex, buy, this.state.inputs.coverage);
    this.presentation = { ...createPresentation(this.presentation), [field]: compactPreview(next) };
    this.setData({ [field]: next });
    this.persistDraft();
  },

  onPreviewOddsChange(event) {
    this.setPreviewOdds(event.currentTarget.dataset.street, event.detail.value);
  },

  onPreviewOddsTap(event) {
    this.setPreviewOdds(event.currentTarget.dataset.street, event.currentTarget.dataset.oddsIndex);
  },

  onPreviewOutsSelect(event) {
    this.setPreviewOdds(event.currentTarget.dataset.street, Number(event.detail.value) + 1);
  },

  onPreviewBuyInput(event) {
    this.setPreviewBuy(event.currentTarget.dataset.street, event.detail.value);
  },

  onPreviewBuyRatioTap(event) {
    const street = event.currentTarget.dataset.street;
    const field = street === "river" ? "previewRiver" : "previewTurn";
    const current = this.data[field] || previewStreet(1);
    const ratio = Number(event.currentTarget.dataset.ratio) || 0;
    this.setPreviewBuy(street, Math.round(current.maxBuy * ratio) / 100);
  },

  onPreviewBuyerChange(event) {
    const index = Number(event.detail.value);
    const option = (this.data.previewBuyerOptions || [])[index];
    if (!option) return;
    this.presentation = { ...createPresentation(this.presentation), previewBuyer: option.value };
    this.setData({ previewBuyer: option.value, previewBuyerIndex: index });
    this.persistDraft();
  },

  setStreetOdds(event, index) {
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: "odds",
      value: oddsValues[index] || 0
    });
  },

  onOddsQuickSelect(event) {
    const index = Number(event.currentTarget.dataset.oddsIndex);
    this.setStreetOdds(event, index);
  },

  onBuyRatioTap(event) {
    const maxBuy = Number(event.currentTarget.dataset.max) || 0;
    const ratio = Number(event.currentTarget.dataset.ratio) || 0;
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: "buy",
      value: Math.round(maxBuy * ratio) / 100
    });
  },

  applyPreviewBuy(view) {
    const pool = view.pools && view.pools[0];
    const buyer = this.presentation && this.presentation.previewBuyer;
    const buyerView = pool && pool.buyers && pool.buyers.find((item) => item.buyer === buyer);
    if (!pool || !buyerView) return false;
    ["turn", "river"].forEach((street) => {
      if (!buyerView[street] || ["notApplicable", "settled"].includes(buyerView[street].status)) return;
      const preview = street === "river" ? this.presentation.previewRiver : this.presentation.previewTurn;
      this.state = Insurance.reduceRound(this.state, {
        type: "EDIT_STREET",
        poolId: pool.id,
        buyer,
        street,
        field: "buy",
        value: preview.buy
      });
    });
    return true;
  },

  onApplyAuto() {
    this.state = Insurance.reduceRound(this.state, { type: "APPLY_AUTO_OUTS" });
    const view = Insurance.selectInsuranceView(this.state);
    const isCalculated = canShowCalculatedResult(this.state, view);
    const applied = isCalculated && this.applyPreviewBuy(view);
    this.renderState(isCalculated);
    this.persistDraft();
    if (!isCalculated) {
      wx.showToast({ title: "请先录入完整公共牌和手牌", icon: "none" });
    } else if (!applied) {
      wx.showToast({ title: "所选玩家当前不能购买保险", icon: "none" });
    }
  },

  onReset() {
    clearDraft();
    this.presentation = createPresentation();
    this.dispatch({ type: "RESET" });
    wx.showToast({ title: "已重置", icon: "success" });
  }
});
