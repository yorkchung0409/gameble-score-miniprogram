const Core = require("../../poker-core");
const { maximumBuy } = require("../../domain/buy-amount");
const Insurance = require("../../domain/insurance-engine");
const { classifyOuts } = require("../../domain/outs-selection");
const { loadDraft, saveDraft, clearDraft } = require("../../store/draft-store");

const cardChoices = [{ label: "清空", value: "" }, ...Core.CARD_DECK.map((value) => ({ label: value, value }))];
const DEFAULT_ODDS = Core.ODDS.slice();
let oddsValues = [0, ...Core.ODDS];
let oddsLabels = ["自动", ...Core.ODDS.map((value) => `${value}x`)];
let oddsScale = Core.ODDS.map((value, index) => ({ label: String(value), index: index + 1, position: index + 1 }));
const buyRatios = [100, 85, 75, 60, 50].map((value) => ({ value, label: `${value}%` }));
const rankLabels = ["自动", "第 1 名", "第 2 名", "第 3 名", "第 4 名"];
const playerCountLabels = ["2 人", "3 人", "4 人"];
const statusLabels = ["待结算", "已爆", "安全"];
const statusValues = ["unseen", "hit", "safe"];
const calculationInputActions = new Set([
  "RESET",
  "SET_POOL_MODE",
  "SET_PLAYER_COUNT",
  "SET_PLAYER_CARD",
  "SET_PLAYER_CARDS",
  "SET_BOARD_CARDS",
  "SET_BOARD_CARD",
  "SET_AMOUNT",
  "SET_CONTRIBUTION",
  "SET_RANK"
]);

function normalizeOddsConfig(values) {
  if (!Array.isArray(values) || values.length !== DEFAULT_ODDS.length) return DEFAULT_ODDS.slice();
  return values.map((value, index) => Number(value) > 0 && Number.isFinite(Number(value)) ? Number(value) : DEFAULT_ODDS[index]);
}

function applyOddsConfig(values) {
  const normalized = normalizeOddsConfig(values);
  Core.ODDS.splice(0, Core.ODDS.length, ...normalized);
  oddsValues = [0, ...Core.ODDS];
  oddsLabels = ["自动", ...Core.ODDS.map((value) => `${value}x`)];
  oddsScale = Core.ODDS.map((value, index) => ({ label: String(value), index: index + 1, position: index + 1 }));
  return normalized;
}

function inputValue(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number === 0) return "";
  return value === null || value === undefined ? "" : String(value);
}

function previewStreet(index, buy = 0, coverage = 0) {
  const oddsIndex = Math.max(1, Math.min(Core.ODDS.length, Math.trunc(Number(index)) || 1));
  const odds = Core.ODDS[oddsIndex - 1];
  const requestedBuy = Math.ceil(Math.max(0, Number(buy) || 0));
  const previewCoverage = Math.max(0, Number(coverage) || 0);
  const hasCoverage = previewCoverage > 0;
  const maxBuy = hasCoverage ? maximumBuy(previewCoverage, odds) : 0;
  const previewBuy = hasCoverage ? Math.min(requestedBuy, maxBuy) : requestedBuy;
  return {
    oddsIndex,
    outs: oddsIndex,
    oddsText: `${odds}x`,
    buy: previewBuy,
    buyInput: inputValue(previewBuy),
    hasCoverage,
    maxBuy,
    maxBuyLabel: hasCoverage ? `最多可买 ¥${maxBuy}` : "填写可保底池后可使用快捷比例",
    payoutText: (previewBuy * odds).toFixed(2)
  };
}

function compactPreview(street) {
  const current = street && typeof street === "object" ? street : {};
  return {
    oddsIndex: Math.max(1, Math.min(Core.ODDS.length, Math.trunc(Number(current.oddsIndex)) || 1)),
    buy: Math.ceil(Math.max(0, Number(current.buy) || 0))
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
  const players = state && state.table && state.table.players;
  const hasHands = Array.isArray(players) && players.length >= 2
    && players.every(player => Array.isArray(player.cards) && player.cards.length === 2 && player.cards.every(Boolean));
  const hasBuyer = Boolean(view && view.pools && view.pools.some((pool) => Array.isArray(pool.buyers) && pool.buyers.length));
  return hasFlop && hasHands && hasBuyer;
}

function hasOutsDetail(street) {
  return street && street.outs !== null && street.outs !== undefined
    && street.status !== "notApplicable"
    && (street.outsSource === "auto" || (!street.outsSource && (street.source === "auto" || Array.isArray(street.outCards) && street.outCards.length > 0)));
}

function displayCards(values, sort = false) {
  const cards = values.map(value => Core.parseCard(value)).filter(Boolean).map(card => card.value);
  if (sort) cards.sort((a, b) => "AKQJT98765432".indexOf(a[0]) - "AKQJT98765432".indexOf(b[0]) || "shdc".indexOf(a[1]) - "shdc".indexOf(b[1]));
  return cards.map(value => ({ value, rank: value[0] === "T" ? "10" : value[0], suit: { s: "♠", h: "♥", d: "♦", c: "♣" }[value[1]], red: /[hd]/.test(value[1]) }));
}

function decorateView(view, expandedSettledStreets = new Set(), branchId = "") {
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
  const decorateStreet = (street, coverage, poolId, buyer, name) => {
    const override = Core.validInsuranceOdds(street.oddsOverride);
    const odds = Number(street.odds) || 0;
    const scaleIndex = odds > 0 ? Number(street.outs) || 0 : 0;
    const configurable = street.status === "current" || street.status === "estimated";
    const maxBuy = configurable && odds > 0 ? maximumBuy(coverage, odds) : 0;
    const hasOutSelection = Array.isArray(street.allOutCards);
    const totalOuts = hasOutSelection ? street.allOutCards.length : 0;
    const insuredOuts = hasOutSelection ? (street.outCards || []).length : 0;
    const uninsuredOuts = Math.max(0, totalOuts - insuredOuts);
    const outsCoverageMode = !hasOutSelection || totalOuts === 0 ? "empty" : uninsuredOuts > 0 ? "partial" : "full";
    const settled = street.status === "settled";
    const settledKey = JSON.stringify([branchId, poolId, buyer, name, street.boardKey]);
    const settlementSummaryText = street.resolvedStatus === "hit" ? `赔付 ¥${money(street.payout)}`
      : ({ uncovered: "未投保牌命中", safe: "安全", needsConfirm: "待确认" })[street.resolvedStatus] || "已结算";
    return {
      ...street,
      settled,
      settledKey,
      collapsed: settled && !expandedSettledStreets.has(settledKey),
      settledBuyText: String(Number(street.buy) || 0),
      settlementSummaryText,
      settlementSummaryClass: street.resolvedStatus === "uncovered" ? "negative" : street.resolvedStatus === "safe" ? "positive" : "",
      settlementStatusText: ({ hit: "已爆", uncovered: "未投保牌命中，无保险赔付", safe: "安全", needsConfirm: "待确认", settled: "已结算", notApplicable: "未参与" })[street.resolvedStatus || street.status] || "待结算",
      settlementStatusShortText: ({ hit: "已爆", uncovered: "未投保命中", safe: "安全", needsConfirm: "待确认", settled: "已结算", notApplicable: "未参与" })[street.resolvedStatus || street.status] || "待结算",
      outsCount: Array.isArray(street.allOutCards) ? (street.outCards || []).length : street.outs,
      outsCoverageMode,
      outsCoverageTotal: totalOuts,
      outsCoverageInsured: insuredOuts,
      outsCoverageUninsured: uninsuredOuts,
      outsCoverageAria: outsCoverageMode === "partial" ? `已保${insuredOuts}张，未保${uninsuredOuts}张` : outsCoverageMode === "full" ? `全保${totalOuts}张` : `${street.outs || 0}张`,
      outsLabel: street.selectionApplied ? "已选 outs" : "当前 outs",
      outsInput: inputValue(street.outs),
      canViewOuts: hasOutsDetail(street),
      manualOuts: street.outsSource === "manual" || !hasOutsDetail(street) && street.source === "manual",
      oddsPickerIndex: Math.max(0, oddsValues.indexOf(override)),
      oddsLabel: odds ? `${odds}x${override ? " · 手动" : " · 自动"}` : "自动",
      oddsValueText: odds ? `${odds}x` : "—",
      oddsModeText: override ? "手动赔率" : "自动赔率",
      oddsScaleIndex: Math.max(1, scaleIndex),
      selectedScaleIndex: scaleIndex > 0 ? scaleIndex : 0,
      maxBuy,
      maxBuyText: String(maxBuy),
      buyInput: inputValue(street.buy),
      payoutText: money(street.payout),
      configurable
    };
  };
  result.oddsLabels = oddsLabels;
  result.oddsTable = oddsLabels.map((label, index) => ({ label, index }));
  result.oddsScale = oddsScale;
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
    amountText: result.rakeRate > 0 ? String(pool.amount) : money(pool.amount),
    rakeText: result.rakeRate > 0 ? `抽水 ${result.rakeRate}% · 扣 ${Number(pool.rakeAmount.toFixed(2))}` : "",
    leadersText: pool.leaders.length ? pool.leaders.join(", ") : "暂无领先",
    buyers: pool.buyers.map((buyer) => ({
      ...buyer,
      turn: {
        ...decorateStreet(buyer.turn, pool.amount, pool.id, buyer.buyer, "turn"),
        statusPickerIndex: Math.max(0, statusValues.indexOf(buyer.turn.resolvedStatus || buyer.turn.status))
      },
      river: {
        ...decorateStreet(buyer.river, pool.amount, pool.id, buyer.buyer, "river"),
        statusPickerIndex: Math.max(0, statusValues.indexOf(buyer.river.resolvedStatus || buyer.river.status))
      },
      settlement: {
        ...buyer.settlement,
        probabilityTexts: {
          turnHit: percent(buyer.settlement.probabilities.turnHit),
          riverHit: percent(buyer.settlement.probabilities.riverHit),
          uncovered: percent((buyer.settlement.probabilities.turnUncovered || 0) + (buyer.settlement.probabilities.riverUncovered || 0)),
          bothSafe: percent(buyer.settlement.probabilities.bothSafe)
        },
        hasUncoveredRisk: (buyer.settlement.probabilities.turnUncovered || 0) + (buyer.settlement.probabilities.riverUncovered || 0) > 0,
        rows: [
          ...buyer.settlement.rows.filter(row => !['turnUncovered', 'riverUncovered'].includes(row.key)),
          ...['turnUncovered', 'riverUncovered'].flatMap(key => buyer.settlement.rows.filter(row => row.key === key))
        ].map((row) => ({
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
    outsDetail: null,
    view: null,
    mode: "single",
    isCalculated: false,
    previewBuyer: "A",
    previewBuyerIndex: 0,
    previewBuyerOptions: [{ value: "A", label: "玩家 A" }],
    previewTurn: previewStreet(1),
    previewRiver: previewStreet(1),
    oddsConfigVisible: false,
    oddsProfiles: [],
    selectedOddsProfile: "",
    oddsConfigDraft: [],
    oddsConfigRows: Array.from({ length: 17 }, (_, index) => index + 1)
  },

  onLoad() {
    this.expandedSettledStreets = new Set();
    const draft = loadDraft();
    const savedProfiles = wx.getStorageSync("insurance_odds_profiles_v1") || [];
    const profiles = Array.isArray(savedProfiles) && savedProfiles.length ? savedProfiles : [{ name: "默认赔率", values: DEFAULT_ODDS.slice() }];
    const activeValues = draft && draft.state && draft.state.oddsConfig ? draft.state.oddsConfig : profiles[0].values;
    applyOddsConfig(activeValues);
    this.state = draft ? draft.state : Insurance.createRound();
    if (!this.state.oddsConfig) this.state.oddsConfig = Core.ODDS.slice();
    this.state.oddsConfig = applyOddsConfig(this.state.oddsConfig);
    this.oddsProfiles = profiles.map((profile) => ({ name: String(profile.name || "未命名"), values: normalizeOddsConfig(profile.values) }));
    this.activeOddsProfile = this.oddsProfiles.find((profile) => JSON.stringify(profile.values) === JSON.stringify(Core.ODDS)) || this.oddsProfiles[0];
    this.presentation = createPresentation(draft && draft.presentation);
    this.setData({ oddsProfiles: this.oddsProfiles, selectedOddsProfile: this.activeOddsProfile.name });
    this.renderState(this.presentation.isCalculated);
  },

  persistDraft() {
    saveDraft(this.state, this.presentation);
  },

  openOutsDetail(event) {
    this.flushOddsDrag();
    this.flushBuyInputs();
    const { poolId, buyer, street } = event.currentTarget.dataset;
    if (!this.data.isCalculated || !["turn", "river"].includes(street)) return;
    const record = this.state.insuranceByPool[poolId] && this.state.insuranceByPool[poolId][buyer];
    const value = record && record[street];
    if (!hasOutsDetail(value)) return;
    const board = value.sourceBoard && value.sourceBoard.length ? value.sourceBoard : (value.boardKey || "").split("|").filter(Boolean);
    const player = this.state.table.players.find(player => player.key === buyer);
    const hand = value.sourceHand && value.sourceHand.length ? value.sourceHand : player && player.cards || [];
    const allCards = value.allOutCards || value.outCards || [];
    const pool = this.data.view.pools.find(pool => pool.id === poolId);
    const groups = value.outGroups && value.outGroups.length ? value.outGroups
      : classifyOuts(board, this.state.table.players, pool && pool.eligible, buyer, allCards);
    const estimated = street === "river" && board.length === 3;
    this.outsSelectionDraft = {
      title: (street === "turn" ? "转牌保险" : "河牌保险") + (value.status === "settled" ? "outs 明细" : "选择 outs"),
      poolId, buyer, street, branchId: this.state.branchId, boardKey: value.boardKey,
      board: displayCards(board.slice(0, street === "turn" ? 3 : 4)), hand: displayCards(hand),
      allCards: allCards.slice(), selected: (value.outCards || []).slice(), groups,
      frozenOdds: value.odds, estimated, settled: value.status === "settled"
    };
    this.renderOutsSelection();
  },

  renderOutsSelection() {
    const draft = this.outsSelectionDraft;
    if (!draft) return;
    const selected = new Set(draft.selected);
    const cards = displayCards(draft.allCards, true).map(card => ({ ...card, selected: selected.has(card.value) }));
    const groups = draft.groups.map(group => {
      const groupCards = displayCards(group.cards, true).map(card => ({ ...card, selected: selected.has(card.value) }));
      const count = groupCards.filter(card => card.selected).length;
      return { key: group.key, label: group.label, cards: groupCards, count,
        checked: count === groupCards.length, partial: count > 0 && count < groupCards.length };
    });
    const count = cards.filter(card => card.selected).length;
    const tier = Core.normalizedOuts(count, 0);
    const odds = draft.settled ? draft.frozenOdds : Core.oddsForOuts(tier);
    this.setData({ outsDetail: { ...draft, cards, groups, count, total: cards.length, tier,
      oddsText: odds ? `${odds}x` : '—', bodyHeight: 620 } });
  },

  toggleOutsGroup(event) {
    const draft = this.outsSelectionDraft;
    if (!draft || draft.settled) return;
    const group = draft.groups.find(group => group.key === event.currentTarget.dataset.key);
    if (!group) return;
    const selected = new Set(draft.selected);
    const remove = group.cards.every(card => selected.has(card));
    group.cards.forEach(card => remove ? selected.delete(card) : selected.add(card));
    draft.selected = [...selected];
    this.renderOutsSelection();
  },

  toggleOutsCard(event) {
    const draft = this.outsSelectionDraft;
    const card = event.currentTarget.dataset.card;
    if (!draft || draft.settled || !draft.allCards.includes(card)) return;
    const selected = new Set(draft.selected);
    if (selected.has(card)) selected.delete(card); else selected.add(card);
    draft.selected = [...selected];
    this.renderOutsSelection();
  },

  selectAllOuts(event) {
    const draft = this.outsSelectionDraft;
    if (!draft || draft.settled) return;
    draft.selected = event.currentTarget.dataset.mode === 'clear' ? [] : draft.allCards.slice();
    this.renderOutsSelection();
  },

  confirmOutsSelection() {
    const draft = this.outsSelectionDraft;
    if (!draft || draft.settled || draft.branchId !== this.state.branchId) return;
    this.dispatch({ type: 'SELECT_OUTS', poolId: draft.poolId, buyer: draft.buyer, street: draft.street, cards: draft.selected });
    this.outsSelectionDraft = null;
  },

  closeOutsDetail() { this.outsSelectionDraft = null; this.setData({ outsDetail: null }); },
  preventOutsMove() {},

  openOddsConfig() {
    this.setData({
      oddsConfigVisible: true,
      selectedOddsProfile: this.activeOddsProfile ? this.activeOddsProfile.name : "",
      oddsConfigDraft: Core.ODDS.map((value) => String(value)),
      oddsConfigName: this.activeOddsProfile ? this.activeOddsProfile.name : "自定义赔率"
    });
  },

  closeOddsConfig() {
    this.setData({ oddsConfigVisible: false });
  },

  deleteOddsConfig() {
    const name = this.data.selectedOddsProfile;
    if ((this.oddsProfiles || []).length <= 1 || !this.oddsProfiles.some((profile) => profile.name === name)) return;
    wx.showModal({
      title: "删除赔率配置",
      content: `确定删除“${name}”吗？删除后无法恢复。`,
      success: ({ confirm }) => {
        if (!confirm) return;
        const profiles = (this.oddsProfiles || []).filter((profile) => profile.name !== name);
        if (!profiles.length || profiles.length === this.oddsProfiles.length) return;
        const deletedActive = this.activeOddsProfile && this.activeOddsProfile.name === name;
        this.oddsProfiles = profiles;
        if (deletedActive) {
          this.activeOddsProfile = profiles[0];
          const values = applyOddsConfig(this.activeOddsProfile.values);
          this.state = Insurance.reduceRound(this.state, { type: "SET_ODDS_CONFIG", values });
          this.renderState(this.presentation.isCalculated);
          this.persistDraft();
        }
        const active = this.activeOddsProfile;
        this.setData({
          oddsProfiles: profiles,
          selectedOddsProfile: active.name,
          oddsConfigName: active.name,
          oddsConfigDraft: active.values.map(String)
        });
        wx.setStorageSync("insurance_odds_profiles_v1", profiles);
        wx.showToast({ title: "配置已删除", icon: "success" });
      }
    });
  },

  onOddsConfigInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const draft = (this.data.oddsConfigDraft || []).slice();
    draft[index] = event.detail.value;
    this.setData({ oddsConfigDraft: draft });
  },

  onOddsProfileChange(event) {
    const index = Number(event.detail.value);
    const profile = this.oddsProfiles && this.oddsProfiles[index];
    if (!profile) return;
    this.setData({ oddsConfigDraft: profile.values.map(String), oddsConfigName: profile.name, selectedOddsProfile: profile.name });
  },

  onOddsProfileTap(event) {
    const index = Number(event.currentTarget.dataset.index);
    const profile = this.oddsProfiles && this.oddsProfiles[index];
    if (!profile) return;
    this.setData({ oddsConfigDraft: profile.values.map(String), oddsConfigName: profile.name, selectedOddsProfile: profile.name });
  },

  onOddsConfigNameInput(event) {
    this.setData({ oddsConfigName: event.detail.value });
  },

  saveOddsConfig() {
    const values = (this.data.oddsConfigDraft || []).map((value) => Number(String(value).trim()));
    if (values.length !== DEFAULT_ODDS.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
      wx.showToast({ title: "请填写 1–17 张的正数赔率", icon: "none" });
      return;
    }
    const name = String(this.data.oddsConfigName || "自定义赔率").trim() || "自定义赔率";
    if ((this.oddsProfiles || []).length >= 8 && !this.oddsProfiles.some((profile) => profile.name === name)) {
      wx.showToast({ title: "最多保存8套，请选择已有配置修改", icon: "none" });
      return;
    }
    const normalized = applyOddsConfig(values);
    const profiles = (this.oddsProfiles || []).filter((profile) => profile.name !== name);
    profiles.unshift({ name, values: normalized.slice() });
    this.oddsProfiles = profiles;
    this.activeOddsProfile = this.oddsProfiles[0];
    this.state = Insurance.reduceRound(this.state, { type: "SET_ODDS_CONFIG", values: normalized });
    this.setData({ oddsConfigVisible: false, oddsProfiles: this.oddsProfiles, selectedOddsProfile: name });
    wx.setStorageSync("insurance_odds_profiles_v1", this.oddsProfiles);
    this.renderState(this.presentation.isCalculated);
    this.persistDraft();
    wx.showToast({ title: "赔率配置已应用", icon: "success" });
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
      outsDetail: null,
      view: decorateView(view, this.expandedSettledStreets, this.state.branchId),
      mode: this.state.poolMode,
      stateCoverage: inputValue(this.state.inputs.coverage),
      stateStake: inputValue(this.state.inputs.stake),
      stateRakeRate: inputValue(this.state.inputs.rakeRate),
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

  toggleSettledStreet(event) {
    const { poolId, buyer, street } = event.currentTarget.dataset;
    if (!["turn", "river"].includes(street)) return;
    const pools = this.data.view && this.data.view.pools || [];
    const poolIndex = pools.findIndex(pool => pool.id === poolId);
    if (poolIndex < 0) return;
    const buyerIndex = pools[poolIndex].buyers.findIndex(item => item.buyer === buyer);
    if (buyerIndex < 0) return;
    const value = pools[poolIndex].buyers[buyerIndex][street];
    if (!value || !value.settled) return;
    if (!this.expandedSettledStreets) this.expandedSettledStreets = new Set();
    if (value.collapsed) this.expandedSettledStreets.add(value.settledKey);
    else this.expandedSettledStreets.delete(value.settledKey);
    this.setData({ [`view.pools[${poolIndex}].buyers[${buyerIndex}].${street}.collapsed`]: !value.collapsed });
  },

  dispatch(action) {
    const previous = this.state;
    this.state = Insurance.reduceRound(this.state, action);
    const boardAction = action.type === "SET_BOARD_CARDS" || action.type === "SET_BOARD_CARD";
    // Appending a street settles the previous one within the same round.
    // Only replacing/removing known cards starts a new calculation branch.
    const continuesBoard = boardAction && this.state.branchId === previous.branchId;
    this.renderState(calculationInputActions.has(action.type) && !continuesBoard ? false : this.presentation.isCalculated);
    this.persistDraft();
  },

  onModeTap(event) {
    this.dispatch({ type: "SET_POOL_MODE", mode: event.currentTarget.dataset.mode });
  },

  onPlayerCountChange(event) {
    this.dispatch({ type: "SET_PLAYER_COUNT", count: Number(event.detail.value) + 2 });
  },

  onCardSelect(event) {
    this.onRakeRateCommit();
    this.flushOddsDrag();
    this.flushBuyInputs();
    const detail = event.detail || {};
    if (detail.player) {
      this.dispatch({ type: "SET_PLAYER_CARD", player: detail.player, index: detail.cardIndex, card: detail.value });
      return;
    }
    this.dispatch({ type: "SET_BOARD_CARD", index: detail.boardIndex, card: detail.value });
  },

  onBoardCardsSelect(event) {
    this.onRakeRateCommit();
    this.flushOddsDrag();
    this.flushBuyInputs();
    const values = Array.isArray(event.detail && event.detail.values) ? event.detail.values.slice(0, 5) : [];
    this.dispatch({ type: "SET_BOARD_CARDS", cards: values });
  },

  onPlayerCardsSelect(event) {
    this.onRakeRateCommit();
    const player = String(event.detail && event.detail.player || "");
    const values = Array.isArray(event.detail && event.detail.values) ? event.detail.values.slice(0, 2) : [];
    this.dispatch({ type: "SET_PLAYER_CARDS", player, cards: values });
  },

  onAmountInput(event) {
    this.bufferAmountInput({
      type: "SET_AMOUNT",
      field: event.currentTarget.dataset.field,
      value: event.detail.value
    });
  },

  onContributionInput(event) {
    this.bufferAmountInput({
      type: "SET_CONTRIBUTION",
      player: event.currentTarget.dataset.player,
      value: event.detail.value
    });
  },

  onRakeRateInput(event) {
    if (this.data.view.rakeLocked) return;
    this.bufferAmountInput({ type: "SET_RAKE_RATE", field: "rakeRate", value: event.detail.value });
  },

  onRakeRateCommit() {
    this.commitAmountInput("SET_RAKE_RATE", "rakeRate");
  },

  onRankChange(event) {
    this.dispatch({
      type: "SET_RANK",
      player: event.currentTarget.dataset.player,
      value: Number(event.detail.value)
    });
  },

  bufferAmountInput(action) {
    if (!this.pendingAmountInputs) this.pendingAmountInputs = {};
    this.pendingAmountInputs[JSON.stringify([action.type, action.field || action.player])] = action;
  },

  commitAmountInput(type, name) {
    const key = JSON.stringify([type, name]);
    const action = this.pendingAmountInputs && this.pendingAmountInputs[key];
    if (!action) return;
    delete this.pendingAmountInputs[key];
    if (type === "SET_RAKE_RATE" && (!Number.isFinite(Number(action.value)) || Number(action.value) < 0 || Number(action.value) > 100)) {
      this.setData({ stateRakeRate: inputValue(this.state.inputs.rakeRate) });
      wx.showToast({ title: "请输入 0–100 的抽水比例", icon: "none" });
      return;
    }
    this.dispatch(action);
  },

  onAmountCommit(event) {
    this.commitAmountInput("SET_AMOUNT", event.currentTarget.dataset.field);
  },

  onContributionCommit(event) {
    this.commitAmountInput("SET_CONTRIBUTION", event.currentTarget.dataset.player);
  },

  flushAmountInputs() {
    Object.values(this.pendingAmountInputs || {}).forEach((action) => {
      this.commitAmountInput(action.type, action.field || action.player);
    });
  },

  onStreetInput(event) {
    this.bufferBuyInput(event, false);
  },

  buyInputKey(dataset, preview) {
    return JSON.stringify([preview, dataset.poolId || "", dataset.buyer || "", dataset.street]);
  },

  bufferBuyInput(event, preview) {
    const dataset = event.currentTarget.dataset;
    if (!this.pendingBuyInputs) this.pendingBuyInputs = {};
    this.pendingBuyInputs[this.buyInputKey(dataset, preview)] = {
      dataset: { ...dataset }, preview, value: event.detail.value
    };
    // The native input owns its text and cursor until editing is finished.
  },

  commitBuyInput(dataset, preview) {
    const key = this.buyInputKey(dataset, preview);
    const pending = this.pendingBuyInputs && this.pendingBuyInputs[key];
    if (!pending) return;
    delete this.pendingBuyInputs[key];
    if (preview) {
      this.setPreviewBuy(dataset.street, pending.value);
      return this.data[dataset.street === "river" ? "previewRiver" : "previewTurn"].buyInput;
    }
    this.dispatch({
      type: "EDIT_STREET",
      poolId: dataset.poolId,
      buyer: dataset.buyer,
      street: dataset.street,
      field: "buy",
      value: pending.value
    });
    const { poolId, buyer, street } = dataset;
    const record = this.state.insuranceByPool[poolId] && this.state.insuranceByPool[poolId][buyer];
    return record && record[street] ? inputValue(record[street].buy) : "";
  },

  onStreetBuyCommit(event) {
    return this.commitBuyInput(event.currentTarget.dataset, false);
  },

  onPreviewBuyCommit(event) {
    return this.commitBuyInput(event.currentTarget.dataset, true);
  },

  flushBuyInputs() {
    Object.values(this.pendingBuyInputs || {}).forEach(({ dataset, preview }) => this.commitBuyInput(dataset, preview));
  },

  onHide() {
    this.closeOutsDetail();
    this.flushOddsDrag();
    this.flushAmountInputs();
    this.flushBuyInputs();
  },

  onUnload() {
    this.flushOddsDrag();
    this.flushAmountInputs();
    this.flushBuyInputs();
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
    this.pendingOddsDrag = null;
    const index = Number(event.detail.value);
    this.setStreetOdds(event, index);
  },

  onOddsSliderChanging(event) {
    const { poolId, buyer, street } = event.currentTarget.dataset;
    if (street !== "turn" && street !== "river") return;
    const pools = this.data.view.pools;
    const poolIndex = pools.findIndex((pool) => pool.id === poolId);
    if (poolIndex < 0) return;
    const pool = pools[poolIndex];
    const buyerIndex = pool.buyers.findIndex((item) => item.buyer === buyer);
    if (buyerIndex < 0 || !pool.buyers[buyerIndex][street].configurable) return;
    const index = Math.max(1, Math.min(17, Math.trunc(Number(event.detail.value)) || 1));
    const key = JSON.stringify([poolId, buyer, street]);
    const previous = this.pendingOddsDrag;
    if (previous && previous.key === key && previous.index === index) return;
    // Keep the original buy while previewing; passing an expensive odds tier
    // must not permanently shrink the buy before the user releases the thumb.
    const originalBuy = previous && previous.key === key
      ? previous.originalBuy : pool.buyers[buyerIndex][street].buy;
    this.pendingOddsDrag = { key, index, originalBuy, dataset: { poolId, buyer, street } };
    const odds = oddsValues[index];
    const maxBuy = maximumBuy(pool.amount, odds);
    const buy = Math.min(Math.ceil(Math.max(0, Number(originalBuy) || 0)), maxBuy);
    const fields = {
      canViewOuts: false, manualOuts: true,
      outsLabel: "当前 outs", outsCount: index,
      outs: index, outsInput: String(index), selectedScaleIndex: index,
      odds, oddsOverride: odds, oddsValueText: `${odds}x`, oddsModeText: "手动赔率",
      maxBuy, maxBuyText: String(maxBuy), buy, buyInput: inputValue(buy),
      payout: buy * odds, payoutText: (buy * odds).toFixed(2)
    };
    const prefix = `view.pools[${poolIndex}].buyers[${buyerIndex}].${street}`;
    // Do not resend the slider value, its parent object, or the complete view.
    this.setData(Object.fromEntries(Object.entries(fields).map(([field, value]) => [`${prefix}.${field}`, value])));
  },

  flushOddsDrag() {
    const pending = this.pendingOddsDrag;
    if (!pending) return;
    this.pendingOddsDrag = null;
    this.setStreetOdds({ currentTarget: { dataset: pending.dataset } }, pending.index);
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

  onPreviewBuyInput(event) {
    this.bufferBuyInput(event, true);
  },

  onPreviewBuyRatioTap(event) {
    if (this.pendingBuyInputs) delete this.pendingBuyInputs[this.buyInputKey(event.currentTarget.dataset, true)];
    const street = event.currentTarget.dataset.street;
    const field = street === "river" ? "previewRiver" : "previewTurn";
    const current = this.data[field] || previewStreet(1);
    const ratio = Number(event.currentTarget.dataset.ratio) || 0;
    this.setPreviewBuy(street, Math.ceil(current.maxBuy * ratio / 100));
  },

  onPreviewBuyerChange(event) {
    const index = Number(event.detail.value);
    const option = (this.data.previewBuyerOptions || [])[index];
    if (!option) return;
    this.presentation = { ...createPresentation(this.presentation), previewBuyer: option.value };
    this.setData({ previewBuyer: option.value, previewBuyerIndex: index });
    this.persistDraft();
  },

  canConfigureStreet(dataset) {
    const record = this.state.insuranceByPool[dataset.poolId] && this.state.insuranceByPool[dataset.poolId][dataset.buyer];
    const value = record && record[dataset.street];
    return Boolean(value && ["current", "estimated"].includes(value.status));
  },

  setStreetOdds(event, index) {
    if (!this.canConfigureStreet(event.currentTarget.dataset)) return;
    const safeIndex = Math.max(0, Math.min(oddsValues.length - 1, Number(index) || 0));
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: "odds",
      outs: safeIndex,
      value: oddsValues[safeIndex] || 0
    });
  },

  onOddsQuickSelect(event) {
    if (event.currentTarget.dataset.street && !this.canConfigureStreet(event.currentTarget.dataset)) return;
    const index = Number(event.currentTarget.dataset.oddsIndex);
    if (index === 0) {
      this.pendingOddsDrag = null;
      // The automatic control restores the current board calculation for all
      // streets, so a manual odds/outs pair cannot remain partially applied.
      this.state = Insurance.reduceRound(this.state, { type: "APPLY_AUTO_OUTS", resetSelection: true, ...event.currentTarget.dataset });
      const view = Insurance.selectInsuranceView(this.state);
      this.renderState(this.presentation.isCalculated && canShowCalculatedResult(this.state, view));
      this.persistDraft();
      return;
    }
    this.setStreetOdds(event, index);
  },

  onBuyRatioTap(event) {
    if (!this.canConfigureStreet(event.currentTarget.dataset)) return;
    if (this.pendingBuyInputs) delete this.pendingBuyInputs[this.buyInputKey(event.currentTarget.dataset, false)];
    const maxBuy = Number(event.currentTarget.dataset.max) || 0;
    const ratio = Number(event.currentTarget.dataset.ratio) || 0;
    this.dispatch({
      type: "EDIT_STREET",
      poolId: event.currentTarget.dataset.poolId,
      buyer: event.currentTarget.dataset.buyer,
      street: event.currentTarget.dataset.street,
      field: "buy",
      value: Math.ceil(maxBuy * ratio / 100)
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
    this.pendingOddsDrag = null;
    this.flushAmountInputs();
    this.flushBuyInputs();
    const wasCalculated = this.presentation.isCalculated;
    this.state = Insurance.reduceRound(this.state, { type: "APPLY_AUTO_OUTS" });
    const view = Insurance.selectInsuranceView(this.state);
    const isCalculated = canShowCalculatedResult(this.state, view);
    const applied = isCalculated && (wasCalculated || this.applyPreviewBuy(view));
    this.renderState(isCalculated);
    this.persistDraft();
    if (!isCalculated) {
      wx.showToast({ title: "请先录入完整公共牌和手牌", icon: "none" });
    } else if (!applied) {
      wx.showToast({ title: "所选玩家当前不能购买保险", icon: "none" });
    }
  },

  onReset() {
    this.expandedSettledStreets = new Set();
    this.pendingOddsDrag = null;
    this.pendingAmountInputs = {};
    this.pendingBuyInputs = {};
    clearDraft();
    this.presentation = createPresentation();
    this.dispatch({ type: "RESET" });
    wx.showToast({ title: "已重置", icon: "success" });
  }
});
