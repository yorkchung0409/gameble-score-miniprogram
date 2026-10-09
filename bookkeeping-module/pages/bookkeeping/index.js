const model = require('../../utils/bookkeeping-model');
const adapter = require('../../utils/bookkeeping-adapter');
const { buildTrendChart, nearestTrendPoint } = require('../../utils/trend-chart');
const { today } = require('../../../utils/format');
const confirm = (title, content) => new Promise(resolve => wx.showModal({ title, content, success: result => resolve(result.confirm), fail: () => resolve(false) }));
const RECENT_CHOICE_KEY = 'gameble-score:bookkeeping:recent-choices:v1';
const emptyForm = () => ({ date: today(), hours: '', profit: '', tag: '', blind: '', note: '' });

function timeRangeFilters(range) {
  const date = today();
  return {
    year: range === 'month' || range === 'year' ? date.slice(0, 4) : model.ALL.year,
    month: range === 'month' ? date.slice(5, 7) + '月' : model.ALL.month,
    date: model.ALL.date,
  };
}

function selectedQuickRange(filters) {
  return ['month', 'year', 'all'].find(range =>
    Object.entries(timeRangeFilters(range)).every(([key, value]) => filters[key] === value)) || '';
}

function loadRecentChoices() {
  if (typeof wx.getStorageSync !== 'function') return { blind: '', tags: [] };
  try {
    const value = wx.getStorageSync(RECENT_CHOICE_KEY);
    const blind = typeof value?.blind === 'string' && value.blind.length <= 30 ? value.blind : '';
    const tags = Array.isArray(value?.tags)
      ? [...new Set(value.tags.filter(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 30))].slice(0, 20)
      : [];
    return { blind, tags };
  } catch (_) { return { blind: '', tags: [] }; }
}

function saveRecentChoices(blind, tags) {
  if (typeof wx.setStorageSync !== 'function') return;
  try {
    wx.setStorageSync(RECENT_CHOICE_KEY, {
      blind: typeof blind === 'string' && blind.length <= 30 ? blind : '',
      tags: [...new Set((Array.isArray(tags) ? tags : []).filter(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 30))].slice(0, 20),
    });
  } catch (_) { /* local preference storage is best effort */ }
}

Page({
  data: {
    numberField: '', numberDraft: '', numberError: '', numberKeys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '删除'],
    choiceManager: '', managerChoices: [],
    calendarVisible: false, calendarMonth: '', calendarDays: [], weekdays: ['日', '一', '二', '三', '四', '五', '六'], blindChoices: [], tagChoices: [], newBlind: '', newTag: '',
    activeFilter: '',
    filterItems: Object.keys(model.ALL).map(key => ({ key, label: model.ALL[key], options: [model.ALL[key]], selected: model.ALL[key], filtered: false })),
    loading: true, loadError: '', saving: false, importBusy: false, exporting: false, editorVisible: false, editingId: '', direction: 'win', form: emptyForm(),
    summary: model.summarize([]), visibleRecords: [], recordCount: 0, hasMore: false, winRankings: [], lossRankings: [], performanceRows: [], trendBars: [], trendPoints: [], trendDisplayPoints: [], trendAxisLabels: [], trendSegments: [], trendZeroTop: 50, trendSelection: null,
    yearOptions: [model.ALL.year], monthOptions: [model.ALL.month], dateOptions: [model.ALL.date], tagOptions: [model.ALL.tag], blindOptions: [model.ALL.blind],
    yearIndex: 0, monthIndex: 0, dateIndex: 0, tagIndex: 0, blindIndex: 0, quickFilter: 'all', trendLimit: 20, trendLimitOptions: [20, 50, 100, 200], performanceMode: 'blind', trendMode: 'cumulative', filtered: false, importPreview: null,
  },

  onLoad() { this.records = []; this.version = 0; this.filters = { ...model.ALL }; this.visibleLimit = 5; this.loadRecords(); },
  onShow() { if (this.loaded && !this.data.editorVisible) this.loadRecords(); },
  onReady() { this.measureTrendChart(); },
  onResize() { this.measureTrendChart(); },
  async onPullDownRefresh() { await this.loadRecords({ force: true }); wx.stopPullDownRefresh(); },
  onShareAppMessage() { return getApp().getDefaultShareMessage(); },
  onHide() { this.closeFilter(); },

  loadRecords(options = {}) {
    const force = options.force === true;
    if (this.fetching) {
      return force ? this.recordLoadPromise.then(() => this.loadRecords({ force: true })) : this.recordLoadPromise;
    }
    if (this.data.saving || this.data.importBusy) return Promise.resolve();
    this.fetching = true;
    this.recordLoadPromise = this.performLoadRecords(force).finally(() => {
      this.fetching = false;
      this.recordLoadPromise = null;
    });
    return this.recordLoadPromise;
  },

  async performLoadRecords(force) {
    try {
      const result = await adapter.load({ force });
      // A refresh started before a save can finish after it; never roll the view back.
      if (result.version < this.version) return;
      if (result.notModified && this.loaded && result.version === this.version) {
        this.setData({ loading: false, loadError: '' });
        return;
      }
      this.records = result.records; this.version = result.version; this.loaded = true;
      this.catalog = { blinds: result.blinds || [], tags: result.tags || [] };
      this.setData({ loading: false, loadError: '' });
      this.rebuildOptions();
    } catch (error) { this.setData({ loading: false, loadError: error.message || '记录加载失败，请重试' }); }
  },

  rebuildOptions() {
    const preset = ['month', 'year'].includes(this.data.quickFilter) ? timeRangeFilters(this.data.quickFilter) : null;
    const selected = { ...this.filters, ...preset };
    const { options, filters } = model.buildOptions(this.records, selected);
    // Calendar selections remain valid even when they currently have no games.
    // Keep the empty range selected rather than silently broadening to all.
    for (const key of ['year', 'month', 'date']) {
      const value = selected[key];
      const valid = key === 'year' ? /^\d{4}$/.test(value) && Number(value) >= 1900
        : key === 'month' ? /^(0[1-9]|1[0-2])月$/.test(value) : model.validDate(value);
      if (!valid) continue;
      if (!options[key].includes(value)) {
        const values = [...options[key].slice(1), value].sort();
        options[key] = [model.ALL[key], ...(key === 'month' ? values : values.reverse())];
      }
      filters[key] = value;
    }
    this.filters = filters;
    const patch = {};
    for (const key of Object.keys(model.ALL)) { patch[key + 'Options'] = options[key]; patch[key + 'Index'] = options[key].indexOf(filters[key]); }
    this.setData({ ...patch, quickFilter: selectedQuickRange(filters), activeFilter: '', filterItems: Object.keys(model.ALL).map(key => ({ key, label: filters[key], selected: filters[key], options: options[key], filtered: filters[key] !== model.ALL[key] })) });
    this.recompute();
  },

  recompute() {
    const result = model.viewModel(this.records, this.filters, this.data.performanceMode, this.data.trendMode, this.data.trendLimit);
    this.filteredRecords = result.filteredRecords;
    this.visibleLimit = 5;
    const { filteredRecords, performanceRows, ...stats } = result;
    let cumulative = 0;
    const details = new Map([...filteredRecords].reverse().map(record => {
      const profit = model.cents(record.profit);
      cumulative += profit;
      return [record.id, { date: record.date, singleProfit: model.amount(profit), singleProfitClass: model.profitClass(profit), cumulativeProfit: model.amount(cumulative), cumulativeProfitClass: model.profitClass(cumulative) }];
    }));
    const chart = buildTrendChart(result.trendBars.map(point => ({ ...point, ...details.get(point.id) })), this.trendPlotSize);
    const trendSelection = chart.trendPoints.find(point => point.id === this.data.trendSelection?.id) || chart.trendPoints[chart.trendPoints.length - 1] || null;
    this.setData({ ...stats, ...chart, trendSelection, performanceRows: performanceRows.slice(-30), visibleRecords: filteredRecords.slice(0, 5), recordCount: filteredRecords.length, hasMore: filteredRecords.length > 5, filtered: this.data.quickFilter !== 'all' || Object.keys(model.ALL).some(key => this.filters[key] !== model.ALL[key]) }, () => this.measureTrendChart());
  },
  loadMore() { this.visibleLimit = Math.min(this.visibleLimit + 5, this.filteredRecords.length); this.setData({ visibleRecords: this.filteredRecords.slice(0, this.visibleLimit), hasMore: this.filteredRecords.length > this.visibleLimit }); },
  loadAllRecords() { this.visibleLimit = this.filteredRecords.length; this.setData({ visibleRecords: this.filteredRecords.slice(), hasMore: false }); },
  toggleFilter(event) {
    const key = event.currentTarget.dataset.key;
    if (!Object.prototype.hasOwnProperty.call(model.ALL, key)) return;
    if (this.data.saving || this.data.importBusy || this.data.editorVisible) return;
    this.setData({ activeFilter: this.data.activeFilter === key ? '' : key });
  },
  closeFilter() { this.setData({ activeFilter: '' }); },
  selectFilterOption(event) {
    const { key, value } = event.currentTarget.dataset;
    if (this.data.activeFilter !== key || !Object.prototype.hasOwnProperty.call(model.ALL, key)) return;
    if (!this.data[key + 'Options'].includes(value)) return;
    this.filters[key] = value;
    this.setData({ quickFilter: selectedQuickRange(this.filters) });
    this.rebuildOptions();
  },
  resetFilters() { this.filters = { ...model.ALL }; this.setData({ quickFilter: 'all' }); this.rebuildOptions(); },
  applyQuickFilter(event) {
    const range = ['month', 'year', 'all'].includes(event.currentTarget.dataset.range) ? event.currentTarget.dataset.range : 'all';
    Object.assign(this.filters, timeRangeFilters(range));
    this.setData({ quickFilter: range, activeFilter: '' });
    this.rebuildOptions();
  },
  changePerformance(event) { this.setData({ performanceMode: event.currentTarget.dataset.mode === 'tag' ? 'tag' : 'blind' }); this.recompute(); },
  changeTrend(event) { this.setData({ trendMode: event.currentTarget.dataset.mode === 'group' ? 'group' : 'cumulative' }); this.recompute(); },
  changeTrendLimit(event) {
    const value = Number(event.currentTarget.dataset.limit);
    if (![20, 50, 100, 200].includes(value)) return;
    this.setData({ trendLimit: value });
    this.recompute();
  },
  measureTrendChart() {
    if (!this.data.trendPoints.length || typeof wx.createSelectorQuery !== 'function') return;
    wx.createSelectorQuery().in(this).select('.trend-chart-plot').boundingClientRect(rect => {
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
      const size = { width: rect.width, height: rect.height };
      if (this.trendPlotSize?.width === size.width && this.trendPlotSize?.height === size.height) return;
      this.trendPlotSize = size;
      const chart = buildTrendChart(this.data.trendPoints, size);
      this.setData({ ...chart, trendSelection: chart.trendPoints.find(point => point.id === this.data.trendSelection?.id) || null });
    }).exec();
  },
  selectTrendPoint(event) {
    const index = event.currentTarget.dataset.index;
    if (index !== undefined) {
      const point = this.data.trendPoints[Number(index)];
      if (point) this.setData({ trendSelection: point });
      return;
    }
    const x = event.detail?.x;
    if (!Number.isFinite(x) || typeof wx.createSelectorQuery !== 'function') return;
    wx.createSelectorQuery().in(this).select('.trend-chart-plot').boundingClientRect(rect => {
      const point = nearestTrendPoint(this.data.trendPoints, x, rect);
      if (point) this.setData({ trendSelection: point });
    }).exec();
  },

  openEditor() {
    if (!this.loaded || this.data.saving || this.data.importBusy || this.data.loadError) return;
    const recent = loadRecentChoices();
    this.formDraft = { ...emptyForm(), blind: recent.blind, tag: recent.tags.join('，') }; this.editVersion = this.version;
    this.prepareEditorChoices(recent.tags);
    this.setData({ editorVisible: true, editingId: '', direction: 'win', form: { ...this.formDraft } });
  },
  openRecord(event) {
    if (this.data.saving || this.data.importBusy || this.data.loadError) return;
    const record = this.records.find(r => r.id === event.currentTarget.dataset.id);
    if (!record) return;
    this.editVersion = this.version;
    const duration = record.duration === undefined ? (record.minutes == null ? null : record.minutes / 60) : record.duration;
    this.formDraft = { date: record.date, note: record.note, blind: record.blind || '', tag: (record.tags || (record.tag ? [record.tag] : [])).join('，'), profit: String(Math.abs(record.profit)), hours: duration == null ? '' : String(duration) };
    this.prepareEditorChoices(record.tags || (record.tag ? [record.tag] : []));
    this.setData({ editorVisible: true, editingId: record.id, direction: record.profit < 0 ? 'loss' : 'win', form: { ...this.formDraft } });
  },
  closeEditor() { if (!this.data.saving) this.setData({ editorVisible: false, choiceManager: '', numberField: '' }); },
  openNumberPad(event) {
    if (this.data.saving) return;
    const field = event.currentTarget.dataset.field;
    if (!['hours', 'profit'].includes(field)) return;
    if (typeof wx.hideKeyboard === 'function') wx.hideKeyboard();
    this.setData({ numberField: field, numberDraft: this.formDraft[field] || '', numberError: '', calendarVisible: false });
  },
  closeNumberPad() { this.setData({ numberField: '', numberError: '' }); },
  pressNumberKey(event) {
    if (!this.data.numberField) return;
    const key = event.currentTarget.dataset.key;
    let value = this.data.numberDraft;
    if (key === '删除') value = value.slice(0, -1);
    else if (key === '清空') value = '';
    else if (key === '.') { if (value.includes('.')) return; value = value ? value + '.' : '0.'; }
    else if (/^\d$/.test(key)) {
      if (value.includes('.') && value.split('.')[1].length >= 2) return;
      if (value.length >= 12) return;
      value = value === '0' ? key : value + key;
    } else return;
    this.setData({ numberDraft: value, numberError: '' });
  },
  confirmNumberPad() {
    const field = this.data.numberField;
    if (!['hours', 'profit'].includes(field)) return;
    const value = this.data.numberDraft.replace(/\.$/, '');
    try {
      if (value !== '') {
        if (field === 'profit') model.cents(value);
        else if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 168) throw new Error('时长最多为 168 小时');
      }
      this.formDraft[field] = value;
      this.setData({ ['form.' + field]: value, numberField: '', numberError: '' });
    } catch (error) { this.setData({ numberError: error.message }); }
  },
  preventMove() {},
  inputField(event) {
    const key = event.currentTarget.dataset.key;
    if (['hours', 'profit', 'tag', 'blind', 'note'].includes(key)) this.formDraft[key] = event.detail.value;
    // Keep native input text untouched while typing, including blanks and decimals.
  },
  prepareEditorChoices(tags) {
    this.draftTags = [...tags]; this.newOptions = { blind: '', tag: '' };
    this.editorCatalog = { blinds: [...(this.catalog?.blinds || [])], tags: [...(this.catalog?.tags || [])] };
    this.setData({ calendarVisible: false, newBlind: '', newTag: '', choiceManager: '', numberField: '' });
    this.refreshEditorChoices();
  },
  refreshEditorChoices() {
    const blinds = [...new Set([...this.editorCatalog.blinds, ...this.records.map(r => r.blind), this.formDraft.blind].filter(Boolean))];
    const tags = [...new Set([...this.editorCatalog.tags, ...this.records.flatMap(r => r.tags || (r.tag ? [r.tag] : [])), ...this.draftTags])];
    this.setData({ blindChoices: blinds.map(value => ({ value, selected: value === this.formDraft.blind })), tagChoices: tags.map(value => ({ value, selected: this.draftTags.includes(value) })) });
    if (this.data.choiceManager) this.refreshManagerChoices();
  },
  openChoiceManager(event) {
    if (this.data.saving) return;
    const kind = event.currentTarget.dataset.kind;
    if (!['blind', 'tag'].includes(kind)) return;
    this.newOptions[kind] = '';
    this.setData({ choiceManager: kind, newBlind: '', newTag: '' });
    this.refreshManagerChoices();
  },
  closeChoiceManager() { this.setData({ choiceManager: '' }); },
  refreshManagerChoices() {
    const kind = this.data.choiceManager;
    const choices = kind === 'blind' ? this.data.blindChoices : this.data.tagChoices;
    this.setData({ managerChoices: choices.map(item => ({ ...item, used: this.records.some(r => kind === 'blind' ? r.blind === item.value : (r.tags || (r.tag ? [r.tag] : [])).includes(item.value)) })) });
  },
  removeEditorChoice(event) {
    if (this.data.saving) return;
    const kind = this.data.choiceManager, value = event.currentTarget.dataset.value;
    if (!['blind', 'tag'].includes(kind)) return;
    const choice = this.data.managerChoices.find(item => item.value === value);
    if (!choice) return;
    if (choice.used) { wx.showToast({ title: '已有记录使用此选项，暂不能删除', icon: 'none' }); return; }
    const key = kind === 'blind' ? 'blinds' : 'tags';
    this.editorCatalog[key] = this.editorCatalog[key].filter(item => item !== value);
    if (kind === 'blind' && this.formDraft.blind === value) this.formDraft.blind = '';
    if (kind === 'tag') this.draftTags = this.draftTags.filter(item => item !== value);
    this.refreshEditorChoices();
  },
  selectEditorChoice(event) {
    if (this.data.saving) return;
    const { kind, value } = event.currentTarget.dataset;
    if (kind === 'blind' && this.data.blindChoices.some(o => o.value === value)) this.formDraft.blind = this.formDraft.blind === value ? '' : value;
    else if (kind === 'tag' && this.data.tagChoices.some(o => o.value === value)) this.draftTags = this.draftTags.includes(value) ? this.draftTags.filter(t => t !== value) : [...this.draftTags, value];
    this.refreshEditorChoices();
  },
  inputNewOption(event) { const kind = event.currentTarget.dataset.kind; if (kind === 'blind' || kind === 'tag') this.newOptions[kind] = event.detail.value; },
  addEditorChoice(event) {
    if (this.data.saving) return;
    const kind = event.currentTarget.dataset.kind;
    if (!['blind', 'tag'].includes(kind)) return;
    const value = (this.newOptions[kind] || '').trim();
    if (!value || value.length > 30) { wx.showToast({ title: '请填写 1–30 字的名称', icon: 'none' }); return; }
    const key = kind === 'blind' ? 'blinds' : 'tags';
    this.editorCatalog[key] = [...new Set([...this.editorCatalog[key], value])];
    if (kind === 'blind') this.formDraft.blind = value;
    else this.draftTags = [...new Set([...this.draftTags, value])];
    this.newOptions[kind] = '';
    this.setData({ [kind === 'blind' ? 'newBlind' : 'newTag']: '' });
    this.refreshEditorChoices();
  },
  toggleCalendar() {
    if (this.data.saving) return;
    const visible = !this.data.calendarVisible;
    if (visible) this.renderCalendar(this.formDraft.date.slice(0, 7));
    this.setData({ calendarVisible: visible });
  },
  renderCalendar(month) {
    const [year, number] = month.split('-').map(Number);
    const start = new Date(year, number - 1, 1).getDay(), count = new Date(year, number, 0).getDate();
    const days = Array.from({ length: start }, (_, i) => ({ key: `empty${i}`, date: '', label: '', selected: false }));
    for (let day = 1; day <= count; day++) { const date = `${month}-${String(day).padStart(2, '0')}`; days.push({ key: date, date, label: day, selected: date === this.formDraft.date }); }
    this.setData({ calendarMonth: month, calendarDays: days });
  },
  moveCalendar(event) {
    if (this.data.saving) return;
    const [year, month] = this.data.calendarMonth.split('-').map(Number);
    const next = new Date(year, month - 1 + Number(event.currentTarget.dataset.step), 1);
    if (next.getFullYear() < 1900 || next.getFullYear() > 9999) return;
    this.renderCalendar(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
  },
  selectCalendarDay(event) {
    if (this.data.saving) return;
    const date = event.currentTarget.dataset.date;
    if (!model.validDate(date)) return;
    this.formDraft.date = date;
    this.setData({ 'form.date': date, calendarVisible: false });
  },
  selectToday() { this.selectCalendarDay({ currentTarget: { dataset: { date: today() } } }); },
  changeDirection(event) { this.setData({ direction: event.currentTarget.dataset.direction === 'loss' ? 'loss' : 'win' }); },

  async persist(records, version = this.version, catalog = this.catalog || {}, mutation) {
    if (this.data.saving) return false;
    this.setData({ saving: true });
    try {
      const result = mutation
        ? await adapter.mutate(records, version, catalog, mutation, this.catalog || {})
        : await adapter.save(records, version, catalog);
      this.records = result.records; this.version = result.version;
      this.catalog = { blinds: result.blinds || catalog.blinds || [], tags: result.tags || catalog.tags || [] };
      this.setData({ loadError: '' }); this.rebuildOptions();
      return true;
    } catch (error) {
      wx.showToast({ title: error.message || '保存失败，记录未更新', icon: 'none' });
      if (error.code === 'VERSION_CONFLICT') this.setData({ loadError: '其他设备已更新，请关闭编辑框并下拉刷新后重试' });
      return false;
    } finally { this.setData({ saving: false }); }
  },

  async saveRecord() {
    if (this.data.saving || this.data.loadError) return;
    try {
      const f = this.formDraft;
      const positive = model.cents(f.profit);
      if (positive < 0) throw new Error('请输入非负积分，通过“赢 / 输”选择方向');
      const id = this.data.editingId || model.newId();
      const existing = this.records.find(r => r.id === id);
      const tagsText = (existing?.tags || []).join('，');
      const tags = this.draftTags || (existing && f.tag === tagsText ? existing.tags : (f.tag || '').split(/[,，]/).map(s => s.trim()).filter(Boolean));
      const record = model.normalizeRecord({ id, date: f.date, note: f.note, blind: f.blind || '', tags, result: this.data.direction === 'loss' ? 'lose' : 'win', amount: positive / 100, duration: f.hours === '' ? null : Number(f.hours) });
      const records = this.data.editingId ? this.records.map(r => r.id === id ? record : r) : [record, ...this.records];
      if (await this.persist(records, this.editVersion, this.editorCatalog, { operation: 'upsert', id })) {
        saveRecentChoices(record.blind, record.tags);
        this.setData({ editorVisible: false }); wx.showToast({ title: '已保存', icon: 'success' });
      }
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
  },
  async deleteRecord() {
    if (!this.data.editingId || this.data.saving || this.data.loadError) return;
    const id = this.data.editingId, version = this.editVersion;
    if (!await confirm('删除这条记录', '删除后会重新计算成绩，是否继续？')) return;
    if (await this.persist(this.records.filter(r => r.id !== id), version, this.catalog || {}, { operation: 'delete', id })) this.setData({ editorVisible: false });
  },
  async clearRecords() {
    if (!this.loaded || this.data.saving || this.data.importBusy || this.data.loadError) return;
    const version = this.version;
    if (!await confirm('清空个人记账', '只清空本人的扑克记账，不影响麻将和保险。清空后可用事先导出的备份恢复，是否继续？')) return;
    if (await this.persist([], version)) this.resetFilters();
  },

  exportBackup() {
    if (!this.loaded || this.data.loadError || this.data.saving || this.data.importBusy || this.data.exporting) return;
    this.setData({ exporting: true });
    let stage = '生成备份';
    try {
      if (!wx.env?.USER_DATA_PATH || typeof wx.getFileSystemManager !== 'function') throw new Error('当前微信环境不支持生成备份文件');
      // Reuse our own export file so repeated exports do not fill local storage.
      const filePath = `${wx.env.USER_DATA_PATH}/poker-bookkeeping-backup.json`;
      const fileSystem = wx.getFileSystemManager();
      // Stay in the button's tap handler: sharing from an async file callback
      // can lose the user gesture required by the phone client.
      fileSystem.writeFileSync(filePath, adapter.export(this.records, this.catalog), 'utf8');
      stage = '分享备份';
      if (typeof wx.shareFileMessage !== 'function') throw new Error('当前微信环境不支持分享文件，请升级微信后重试');
      wx.shareFileMessage({
        filePath, fileName: `扑克记账备份-${today()}.json`,
        fail: error => this.exportFailure(stage, error),
        complete: () => this.setData({ exporting: false }),
      });
    } catch (error) { this.exportFailure(stage, error); }
  },
  exportFailure(stage, error) {
    this.setData({ exporting: false });
    const detail = String(error?.errMsg || error?.message || '微信未返回具体原因');
    if (/\bcancel(?:led)?\b/i.test(detail)) return;
    const hint = stage === '生成备份' ? '请检查手机可用存储空间，然后重新导出。'
      : /not support|unsupported|not implemented/i.test(detail) ? '请在手机微信中导出；如果已在手机，请更新微信后重试。'
      : '备份文件已生成，但未发送成功。请重新点击“导出备份”，选择微信聊天后发送。';
    wx.showModal({ title: `${stage}失败`, content: `${hint}\n\n具体原因：${detail.slice(0, 500)}`, showCancel: false });
  },
  importBackup() { return this.chooseImport('json'); },
  importCsv() { return this.chooseImport('csv'); },
  async chooseImport(type) {
    if (!this.loaded || this.data.saving || this.data.importBusy || this.data.loadError) return;
    this.setData({ importBusy: true });
    const version = this.version;
    let stage = '选择文件';
    try {
      if (typeof wx.chooseMessageFile !== 'function') throw new Error('当前微信环境不支持聊天文件选择，请升级微信后重试');
      const result = await new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: 'file', extension: [type], success: resolve, fail: reject }));
      stage = '读取文件';
      const file = result.tempFiles?.[0];
      if (!file) throw new Error('没有取得所选文件，请重新选择');
      if (file.size > 1000000) throw new Error('请选择不超过 1MB 的文件');
      const filePath = file.path || file.tempFilePath;
      if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('微信没有返回可读取的文件路径，请重新发送文件到聊天后再选择');
      const text = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, encoding: 'utf8', success: r => resolve(r.data), fail: reject }));
      stage = '校验内容';
      if (typeof text !== 'string' || !text.trim()) throw new Error('文件内容为空或不是文本，请重新导出 JSON 备份');
      const incoming = type === 'csv' ? { records: model.parseCsv(text) } : model.parseBook(text);
      const plan = model.planImport({ records: this.records, ...this.catalog }, incoming);
      this.pendingImport = { plan, version };
      this.setData({ importPreview: { imported: plan.imported, added: plan.added, duplicates: plan.duplicates, conflictCount: plan.conflicts.length, conflictPage: 1, conflictPages: Math.ceil(plan.conflicts.length / 20), incomingStats: plan.incomingStats, nextStats: plan.nextStats, conflicts: plan.conflicts.slice(0, 20), csv: type === 'csv' } });
    } catch (error) {
      const detail = String(error?.errMsg || error?.message || '微信未返回具体原因');
      if (!/\bcancel(?:led)?\b/i.test(detail)) {
        const hint = stage === '选择文件' ? '请先将备份文件发送到微信聊天，再从聊天文件中选择。' : stage === '读取文件' ? '请在微信聊天中确认文件能够打开；若文件已过期，请重新发送后再导入。' : '请使用完整的 JSON 备份，原有记录不会被修改。';
        wx.showModal({ title: `${stage}失败`, content: `${hint}\n\n具体原因：${detail.slice(0, 500)}`, showCancel: false });
      }
    }
    finally { if (!this.pendingImport) this.setData({ importBusy: false }); }
  },
  cancelImport() { if (!this.data.saving) { this.pendingImport = null; this.setData({ importPreview: null, importBusy: false }); } },
  changeConflictPage(event) {
    if (!this.pendingImport) return;
    const preview = this.data.importPreview;
    const page = Math.max(1, Math.min(preview.conflictPages, preview.conflictPage + Number(event.currentTarget.dataset.step)));
    this.setData({ importPreview: { ...preview, conflictPage: page, conflicts: this.pendingImport.plan.conflicts.slice((page - 1) * 20, page * 20) } });
  },
  async confirmImport() {
    if (!this.pendingImport || this.data.saving || this.data.loadError) return;
    const { plan, version } = this.pendingImport;
    if (await this.persist(plan.next.records, version, plan.next)) {
      this.cancelImport(); this.resetFilters();
      wx.showModal({ title: '导入完成', content: `新增 ${plan.added} 条，跳过重复 ${plan.duplicates} 条，保留现有冲突记录 ${plan.conflicts.length} 条。`, showCancel: false });
    }
  },
});
