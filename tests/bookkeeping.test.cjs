const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../bookkeeping-module/utils/bookkeeping-model');
const root = path.resolve(__dirname, '..');
const record = (id = 'a', profit = 10, date = '2026-09-28', tag = '') => ({ id, date, minutes: 60, profit, tag, note: '' });

test('normalized zero-profit records never count as profitable games', () => {
  const records = model.normalizeRecords([
    { id: 'win', date: '2026-09-29', result: 'win', amount: 10, duration: 1 },
    { id: 'zero', date: '2026-09-29', result: 'win', amount: 0, duration: 1 },
  ]);
  assert.equal(model.summarize(records).winRate, '50');
  assert.equal(model.summarize([records[1]]).winRate, '0');
  const roundTrip = model.parseBook(model.backupObject({ records })).records;
  assert.equal(model.summarize(roundTrip).winRate, '50');
});

test('bookkeeping validates blanks, dates, integer duration, precision and duplicates', () => {
  assert.throws(() => model.normalizeRecord(record('a', '')), /盈亏/);
  assert.throws(() => model.normalizeRecord(record('a', '1.001')), /两位/);
  assert.throws(() => model.normalizeRecord(record('a', 1, '2026-02-30')), /日期/);
  assert.throws(() => model.normalizeRecord({ ...record(), minutes: 1.5 }), /时长/);
  assert.throws(() => model.normalizeRecord(record('a', Infinity)), /盈亏/);
  assert.equal(model.normalizeRecord(record('a', '-0.01')).profit, -0.01);
  assert.equal(model.normalizeRecord(record('a', 0)).profit, 0);
  assert.throws(() => model.normalizeRecords([record(), record()]), /重复/);
  assert.throws(() => model.parseBackup('{"version":3,"records":[]}'), /版本/);
});

test('integer-cent statistics and filters reflect wins, losses and draws', () => {
  const records = [record('a', .1), record('b', .2), record('c', -.3), record('d', 0)];
  const stats = model.summarize(records);
  assert.equal(stats.profit, '0.00');
  assert.equal(stats.hours, '4.00');
  assert.equal(stats.winRate, '50');
  const { options, filters } = model.buildOptions([record('a', 10, '2025-01-01', '朋友局')], { year: '2026', tag: '已删除' });
  assert.equal(filters.year, model.ALL.year);
  assert.equal(filters.tag, model.ALL.tag);
  assert.equal(options.year[1], '2025');
  assert.equal(model.viewModel(records, { ...model.ALL, date: '2025-01-01' }, 'date', 'group').summary.games, 0);
});

test('trend includes earlier cumulative profit, has signed bounded bars and distinct modes', () => {
  const records = Array.from({ length: 14 }, (_, i) => record('r' + String(i).padStart(2, '0'), i === 0 ? 100 : -10));
  const cumulative = model.viewModel(records, model.ALL, 'date', 'cumulative');
  const single = model.viewModel(records, model.ALL, 'date', 'group');
  assert.equal(cumulative.trendBars.length, 12);
  assert.equal(cumulative.trendBars[0].value, 8000);
  assert.equal(cumulative.trendBars[11].value, -3000);
  assert.equal(single.trendBars[0].value, -1000);
  assert.ok(cumulative.trendBars.every(p => p.height >= 0 && p.height <= 70));
  assert.equal(new Set(cumulative.trendBars.map(p => p.id)).size, 12);
  assert.equal(cumulative.winRankings.length, 1);
  assert.equal(cumulative.lossRankings.length, 5);
});

test('bookkeeping offers quick time filters and renders trend points with connecting segments', () => {
  const { page } = pageHarness({});
  page.records = model.normalizeRecords([
    record('current-month', 10, '2026-09-28'),
    record('current-year', -5, '2026-04-12'),
    record('last-year', 8, '2025-12-20'),
  ]);
  page.recompute();
  assert.equal(page.data.trendLimit, 20);
  assert.equal(page.data.summary.games, 3);
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'month' } } });
  assert.equal(page.data.quickFilter, 'month');
  assert.equal(page.data.summary.games, 1);
  assert.equal(page.filters.year, '2026');
  assert.equal(page.filters.month, '09月');
  assert.equal(page.data.filterItems.find(item => item.key === 'year').selected, '2026');
  assert.equal(page.data.filterItems.find(item => item.key === 'month').label, '09月');
  assert.equal(page.data.yearOptions[page.data.yearIndex], '2026');
  assert.equal(page.data.monthOptions[page.data.monthIndex], '09月');
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'year' } } });
  assert.equal(page.data.summary.games, 2);
  assert.equal(page.filters.year, '2026');
  assert.equal(page.filters.month, model.ALL.month);
  assert.equal(page.data.filterItems.find(item => item.key === 'month').selected, model.ALL.month);
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'all' } } });
  assert.equal(page.data.summary.games, 3);
  assert.equal(page.filters.year, model.ALL.year);
  assert.equal(page.filters.month, model.ALL.month);
  assert.equal(page.data.trendPoints.length, 3);
  assert.equal(page.data.trendSegments.length, 2);
  assert.ok(page.data.trendSegments.every(segment => Number.isFinite(segment.angle)));
  page.setData({ trendMode: 'group' }); page.recompute();
  assert.ok(page.data.trendSegments.some(segment => segment.profitClass === 'positive'));
  assert.ok(page.data.trendSegments.some(segment => segment.profitClass === 'negative'));
  const markup = fs.readFileSync(path.join(root, 'bookkeeping-module/pages/bookkeeping/index.wxml'), 'utf8');
  assert.match(markup, /class="trend-line /);
  assert.match(markup, /data-range="month"/);
});

test('quick ranges keep empty current periods selected through reloads and preserve tag/blind filters', () => {
  const { page } = pageHarness({});
  page.records = model.normalizeRecords([{ ...record('old', 10, '2025-04-12', '朋友'), blind: '1/2' }]);
  page.filters = { ...model.ALL, date: '2025-04-12', tag: '朋友', blind: '1/2' };
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'month' } } });
  assert.equal(page.data.summary.games, 0);
  assert.equal(page.filters.year, '2026');
  assert.equal(page.filters.month, '09月');
  assert.equal(page.filters.date, model.ALL.date);
  assert.equal(page.filters.tag, '朋友');
  assert.equal(page.filters.blind, '1/2');
  page.rebuildOptions();
  assert.equal(page.data.summary.games, 0);
  assert.equal(page.data.filterItems.find(item => item.key === 'year').label, '2026');
  assert.equal(page.data.filterItems.find(item => item.key === 'month').selected, '09月');
  page.toggleFilter({ currentTarget: { dataset: { key: 'year' } } });
  page.selectFilterOption({ currentTarget: { dataset: { key: 'year', value: model.ALL.year } } });
  assert.equal(page.filters.month, '09月');
  assert.equal(page.data.quickFilter, '');
  assert.equal(page.data.summary.games, 0);
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'year' } } });
  assert.equal(page.data.summary.games, 0);
  assert.equal(page.filters.year, '2026');
  assert.equal(page.filters.month, model.ALL.month);
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'all' } } });
  assert.equal(page.data.summary.games, 1);
  assert.equal(page.filters.date, model.ALL.date);
  assert.equal(page.filters.tag, '朋友');
  assert.equal(page.filters.blind, '1/2');
});

test('manual selections after quick filters use the displayed range and update quick button state', () => {
  const { page } = pageHarness({});
  page.records = model.normalizeRecords([
    record('month-friend', 10, '2026-09-28', '朋友'),
    record('month-other', 20, '2026-09-29', '线上'),
    record('earlier', 5, '2026-04-12', '朋友'),
    record('old', 8, '2025-09-28', '朋友'),
  ]);
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'month' } } });
  const select = (key, value) => {
    page.toggleFilter({ currentTarget: { dataset: { key } } });
    page.selectFilterOption({ currentTarget: { dataset: { key, value } } });
  };
  select('tag', '朋友');
  assert.equal(page.data.quickFilter, 'month');
  assert.equal(page.data.summary.games, 1);
  select('month', '04月');
  assert.equal(page.data.quickFilter, '');
  assert.equal(page.filters.year, '2026');
  assert.equal(page.data.visibleRecords[0].id, 'earlier');
  select('month', model.ALL.month);
  assert.equal(page.data.quickFilter, 'year');
  assert.equal(page.data.summary.games, 2);
  page.applyQuickFilter({ currentTarget: { dataset: { range: 'all' } } });
  assert.equal(page.data.quickFilter, 'all');
  assert.equal(page.data.summary.games, 3);
});

test('tag aggregation handles arbitrary tag strings without prototype collisions', () => {
  const view = model.viewModel([record('a', 1, '2026-01-01', '__proto__'), record('b', 2, '2026-01-01', '__proto__')], model.ALL, 'tag', 'group');
  assert.equal(view.performanceRows[0].profit, '+3.00');
});

test('trend renders every game without crowding dates and preserves unsampled losses', () => {
  const { buildTrendChart } = require('../bookkeeping-module/utils/trend-chart');
  const points = Array.from({ length: 200 }, (_, index) => ({ id: 'p' + index, label: '10-01', value: index === 101 ? -500 : 100, profitClass: index === 101 ? 'negative' : 'positive' }));
  for (const count of [1, 20, 50, 100, 200]) {
    const chart = buildTrendChart(points.slice(0, count));
    assert.equal(chart.trendPoints.length, count);
    assert.ok(chart.trendAxisLabels.length <= 5);
    assert.equal(chart.trendAxisLabels[0].id, points[0].id);
    assert.equal(chart.trendAxisLabels.at(-1).id, points[count - 1].id);
    assert.ok(chart.trendPoints.every(point => point.top > 0 && point.top < 100));
    assert.equal(chart.trendDisplayPoints.length, count <= 20 ? count : 0);
  }
  const chart = buildTrendChart(points);
  assert.ok(chart.trendSegments.some(segment => segment.key.includes('p101') && segment.profitClass === 'negative'));
  assert.equal(chart.trendSegments.length, 201);
  assert.equal(buildTrendChart([{ id: 'zero', value: 0 }]).trendZeroTop, 50);
});

test('trend segments meet their nodes at measured widths and change colour at zero', () => {
  const { buildTrendChart } = require('../bookkeeping-module/utils/trend-chart');
  for (const size of [{ width: 310, height: 120 }, { width: 640, height: 240 }]) {
    const chart = buildTrendChart([{ id: 'a', value: 100 }, { id: 'b', value: -100 }], size);
    assert.equal(chart.trendSegments.length, 2);
    assert.deepEqual(chart.trendSegments.map(segment => segment.profitClass), ['positive', 'negative']);
    chart.trendSegments.forEach((segment, index) => {
      const radians = segment.angle * Math.PI / 180;
      const x = segment.left + segment.width * Math.cos(radians);
      const y = segment.top + segment.width * size.width / size.height * Math.sin(radians);
      const end = index === 0 ? { left: 50, top: chart.trendZeroTop } : chart.trendPoints[1];
      assert.ok(Math.abs(x - end.left) < 1e-8);
      assert.ok(Math.abs(y - end.top) < 1e-8);
    });
  }
});

test('trend taps show single and full filtered cumulative profit outside the recent window', () => {
  const rect = { left: 25, width: 300, height: 120 };
  const { page } = pageHarness({}, {
    createSelectorQuery: () => ({ in() { return this; }, select() { return this; }, boundingClientRect(callback) { callback(rect); return this; }, exec() {} }),
  });
  page.records = model.normalizeRecords(Array.from({ length: 25 }, (_, index) => record('r' + String(index).padStart(2, '0'), index === 0 ? 100 : -1)));
  page.recompute();
  assert.equal(page.data.trendSelection.id, 'r24');
  assert.equal(page.data.trendSelection.singleProfit, '-1.00');
  assert.equal(page.data.trendSelection.cumulativeProfit, '+76.00');
  page.measureTrendChart();
  page.selectTrendPoint({ currentTarget: { dataset: {} }, detail: { x: rect.left } });
  assert.equal(page.data.trendSelection.id, 'r05');
  assert.equal(page.data.trendSelection.cumulativeProfit, '+95.00');
  page.changeTrend({ currentTarget: { dataset: { mode: 'group' } } });
  assert.equal(page.data.trendSelection.id, 'r05');
  assert.equal(page.data.trendSelection.profit, '-1.00');
  assert.equal(page.data.trendSelection.cumulativeProfit, '+95.00');
  page.selectTrendPoint({ currentTarget: { dataset: {} }, detail: { x: 10000 } });
  assert.equal(page.data.trendSelection.id, 'r24');
  page.selectTrendPoint({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(page.data.trendSelection.id, 'r05');
  page.records = []; page.recompute();
  assert.equal(page.data.trendSelection, null);
});

test('CSV accepts quoted commas, Unicode, BOM and newlines; rejects malformed rows', () => {
  const records = model.parseCsv('\uFEFF日期,时长（分钟）,盈亏,标签,备注\r\n2026-09-28,60,-12.34,"朋友,周末","第一行\n第二行"');
  assert.equal(records[0].tag, '朋友,周末');
  assert.equal(records[0].note, '第一行\n第二行');
  assert.equal(records[0].profit, -12.34);
  assert.throws(() => model.parseCsv('date,minutes,profit\n2026-09-28,60,'), /盈亏/);
  assert.throws(() => model.parseCsv('date,minutes,profit\n2026-09-28,60,1,extra'), /列数/);
});

function pageHarness(adapter, wxOverrides = {}) {
  adapter = { ...adapter, mutate: adapter.mutate || ((records, version, catalog) => adapter.save(records, version, catalog)) };
  let definition; const notices = [];
  const filename = path.join(root, 'bookkeeping-module/pages/bookkeeping/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: d => { definition = d; },
    require: name => name.includes('adapter') ? adapter : name.includes('model') ? model : name.includes('trend-chart') ? require('../bookkeeping-module/utils/trend-chart') : { today: () => '2026-09-28' },
    wx: { showToast: x => notices.push(x), stopPullDownRefresh() {}, showModal: x => { notices.push(x); x.success?.({ confirm: true }); }, ...wxOverrides },
    getApp: () => ({}),
  });
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)) };
  page.setData = function(patch) { for (const [key, value] of Object.entries(patch)) { assert.notEqual(value, undefined); this.data[key] = value; } };
  page.records = []; page.version = 0; page.filters = { ...model.ALL }; page.loaded = true;
  return { page, notices };
}

test('cloud reload rebuilds filter options and record edits use signed amounts without rewriting typed text', async () => {
  let saved;
  const { page } = pageHarness({ load: async () => ({ records: [record('a', 1, '2025-01-01', '周末')], version: 1 }), save: async (records, version) => { saved = { records, version }; return { records, version: version + 1 }; } });
  await page.loadRecords();
  assert.ok(page.data.tagOptions.includes('周末'));
  page.openEditor();
  page.inputField({ currentTarget: { dataset: { key: 'profit' } }, detail: { value: '12.30' } });
  page.inputField({ currentTarget: { dataset: { key: 'hours' } }, detail: { value: '1.5' } });
  assert.equal(page.data.form.profit, '');
  page.changeDirection({ currentTarget: { dataset: { direction: 'loss' } } });
  await page.saveRecord();
  assert.equal(saved.records[0].profit, -12.3);
  assert.equal(saved.records[0].duration, 1.5);
  assert.equal(saved.version, 1);
  assert.equal(page.data.editorVisible, false);
});

test('save failures preserve editor and do not update data; rapid double tap sends one write', async () => {
  let reject, calls = 0;
  const { page } = pageHarness({ save: () => { calls++; return new Promise((_, fail) => { reject = fail; }); } });
  page.openEditor(); page.formDraft.hours = '1'; page.formDraft.profit = '10';
  const first = page.saveRecord();
  await page.saveRecord();
  assert.equal(calls, 1);
  reject(Object.assign(new Error('另一台设备已更新'), { code: 'VERSION_CONFLICT' }));
  await first;
  assert.equal(page.records.length, 0);
  assert.equal(page.data.editorVisible, true);
  assert.match(page.data.loadError, /刷新/);
});

test('a slow refresh cannot replace a newer successful save', async () => {
  let finishRead;
  const { page } = pageHarness({
    load: () => new Promise(resolve => { finishRead = resolve; }),
    save: async records => ({ records, version: 2 }),
  });
  page.version = 1;
  const refresh = page.loadRecords();
  await page.persist([record('new', 25)]);
  finishRead({ records: [], version: 1 });
  await refresh;
  assert.equal(page.version, 2);
  assert.equal(page.records[0].id, 'new');
  assert.equal(page.data.summary.profit, '+25.00');
  assert.equal(page.fetching, false);
});

test('unchanged returns preserve expanded records and selection while pull refresh forces a full load', async () => {
  const options = [];
  let changed = false;
  const source = model.normalizeRecords(Array.from({ length: 12 }, (_, index) => record('r' + index, 10)));
  const { page } = pageHarness({ load: async option => { options.push(option); return changed || option.force ? { records: source, version: 2 } : { records: source, version: 1, notModified: true }; } });
  page.loaded = false;
  await page.loadRecords();
  assert.equal(page.data.summary.games, 12);
  page.loadMore();
  page.selectTrendPoint({ currentTarget: { dataset: { index: 0 } } });
  const selectedId = page.data.trendSelection.id;
  assert.equal(page.data.visibleRecords.length, 10);
  await page.loadRecords();
  assert.equal(page.data.visibleRecords.length, 10);
  assert.equal(page.data.trendSelection.id, selectedId);
  await page.onPullDownRefresh();
  assert.equal(options.at(-1).force, true);
  assert.equal(page.version, 2);
  assert.equal(page.data.visibleRecords.length, 5);
  changed = true;
  await page.loadRecords();
  assert.equal(page.data.summary.games, 12);
});

test('pull refresh waits for an in-flight version check and then performs the requested full load', async () => {
  let finishCheck;
  const calls = [];
  const { page } = pageHarness({ load: option => {
    calls.push(option.force);
    if (!option.force) return new Promise(resolve => { finishCheck = resolve; });
    return Promise.resolve({ records: [record('new', 20)], version: 2 });
  } });
  page.version = 1;
  const check = page.loadRecords();
  const refresh = page.onPullDownRefresh();
  assert.equal(calls.length, 1);
  finishCheck({ notModified: true, version: 1 });
  await Promise.all([check, refresh]);
  assert.deepEqual(calls, [false, true]);
  assert.equal(page.version, 2);
  assert.equal(page.records[0].id, 'new');
  assert.equal(page.fetching, false);
});

test('cloud deployment validation stays identical to frontend validation', () => {
  assert.equal(fs.readFileSync(path.join(root, 'bookkeeping-module/utils/bookkeeping-model.js'), 'utf8'), fs.readFileSync(path.join(root, 'cloudfunctions/gameble-bootstrap-probe/bookkeeping-model.js'), 'utf8'));
});

const webRecord = (overrides = {}) => ({ id: 'web_1', date: '2026-09-28', result: 'lose', amount: 12.5, duration: null, blind: '0.5/1', tags: ['线上', '周末'], note: '原始备注', ...overrides });

test('custom number pad handles decimals, deletion, blank values and cancel without a system input', () => {
  const { page } = pageHarness({}); page.openEditor();
  const open = field => page.openNumberPad({ currentTarget: { dataset: { field } } });
  const key = value => page.pressNumberKey({ currentTarget: { dataset: { key: value } } });
  open('profit'); ['0', '0', '.', '2', '.', '5', '9'].forEach(key);
  assert.equal(page.data.numberDraft, '0.25');
  assert.equal(page.formDraft.profit, '');
  page.confirmNumberPad(); assert.equal(page.formDraft.profit, '0.25');
  open('profit'); key('删除'); assert.equal(page.data.numberDraft, '0.2');
  page.closeNumberPad(); assert.equal(page.formDraft.profit, '0.25');
  open('profit'); key('清空'); page.confirmNumberPad(); assert.equal(page.formDraft.profit, '');
  open('hours'); ['1', '6', '9'].forEach(key); page.confirmNumberPad();
  assert.match(page.data.numberError, /168/); assert.equal(page.formDraft.hours, '');
  key('清空'); ['1', '.', '5'].forEach(key); page.confirmNumberPad();
  assert.equal(page.formDraft.hours, '1.5'); assert.equal(page.data.numberField, '');
  open('hours'); key('清空'); page.confirmNumberPad(); assert.equal(page.formDraft.hours, '');
  const markup = fs.readFileSync(path.join(root, 'bookkeeping-module/pages/bookkeeping/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /<input[^>]*form\.(?:hours|profit)/);
});

test('editor adds quick choices without duplicates, saves selection and cancels draft-only additions', async () => {
  let saved;
  const { page } = pageHarness({ save: async (records, version, catalog) => { saved = { records, catalog }; return { records, version: version + 1, ...catalog }; } });
  page.catalog = { blinds: ['1.5/3'], tags: ['已有', '线上'] };
  page.openEditor();
  const event = (kind, value) => ({ currentTarget: { dataset: { kind, value } }, detail: { value } });
  assert.ok(page.data.blindChoices.some(o => o.value === '1.5/3'));
  page.inputNewOption(event('blind', '3/6')); page.addEditorChoice(event('blind'));
  page.inputNewOption(event('tag', '周末')); page.addEditorChoice(event('tag'));
  page.inputNewOption(event('tag', '周末')); page.addEditorChoice(event('tag'));
  page.selectEditorChoice(event('tag', '线上'));
  assert.equal(page.draftTags.length, 2);
  assert.deepEqual(page.catalog.blinds, ['1.5/3']);
  page.formDraft.profit = '20'; await page.saveRecord();
  assert.equal(saved.records[0].blind, '3/6'); assert.equal(saved.records[0].tags.length, 2);
  assert.ok(saved.catalog.tags.includes('周末'));
  page.openEditor(); page.inputNewOption(event('tag', '不保存')); page.addEditorChoice(event('tag'));
  page.closeEditor(); page.openEditor();
  assert.equal(page.data.tagChoices.some(o => o.value === '不保存'), false);
});

test('new bookkeeping entries reuse the last saved blind and tags on this device', async () => {
  let stored;
  const { page } = pageHarness({ save: async (records, version, catalog) => ({ records, version: version + 1, ...catalog }) }, {
    getStorageSync: () => stored,
    setStorageSync: (_key, value) => { stored = value; },
  });
  page.catalog = { blinds: ['0.5/1'], tags: ['线上', '周末'] };
  page.openEditor();
  const choice = (kind, value) => ({ currentTarget: { dataset: { kind, value } } });
  page.selectEditorChoice(choice('blind', '0.5/1'));
  page.selectEditorChoice(choice('tag', '线上'));
  page.formDraft.profit = '20';
  await page.saveRecord();
  assert.equal(stored.blind, '0.5/1');
  assert.deepEqual(Array.from(stored.tags), ['线上']);

  page.openEditor();
  assert.equal(page.formDraft.blind, '0.5/1');
  assert.deepEqual(Array.from(page.draftTags), ['线上']);
  assert.equal(page.data.blindChoices.find(item => item.value === '0.5/1').selected, true);
  assert.equal(page.data.tagChoices.find(item => item.value === '线上').selected, true);
});

test('custom calendar handles leap days, year rollover and selection without native picker', () => {
  const { page } = pageHarness({}); page.openEditor();
  page.renderCalendar('2024-02');
  assert.equal(page.data.calendarDays.filter(d => d.date).length, 29);
  page.renderCalendar('2025-02');
  assert.equal(page.data.calendarDays.filter(d => d.date).length, 28);
  page.renderCalendar('2025-12'); page.moveCalendar({ currentTarget: { dataset: { step: 1 } } });
  assert.equal(page.data.calendarMonth, '2026-01');
  page.selectCalendarDay({ currentTarget: { dataset: { date: '2026-01-15' } } });
  assert.equal(page.formDraft.date, '2026-01-15'); assert.equal(page.data.calendarVisible, false);
  page.selectCalendarDay({ currentTarget: { dataset: { date: '2026-02-30' } } });
  assert.equal(page.formDraft.date, '2026-01-15');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'bookkeeping-module/pages/bookkeeping/index.wxml'), 'utf8'), /<picker\b/);
});

test('choice manager removes unused choices and selected drafts but protects historical records', () => {
  const { page, notices } = pageHarness({});
  page.records = model.normalizeRecords([webRecord()]);
  page.catalog = { blinds: ['0.5/1', '5/10'], tags: ['线上', '周末', '备用'] };
  page.openEditor();
  page.openChoiceManager({ currentTarget: { dataset: { kind: 'blind' } } });
  page.selectEditorChoice({ currentTarget: { dataset: { kind: 'blind', value: '5/10' } } });
  page.removeEditorChoice({ currentTarget: { dataset: { value: '5/10' } } });
  assert.equal(page.formDraft.blind, '');
  assert.equal(page.data.blindChoices.some(o => o.value === '5/10'), false);
  page.removeEditorChoice({ currentTarget: { dataset: { value: '0.5/1' } } });
  assert.match(notices.at(-1).title, /已有记录/);
  assert.equal(page.records[0].blind, '0.5/1');
  page.openChoiceManager({ currentTarget: { dataset: { kind: 'tag' } } });
  page.selectEditorChoice({ currentTarget: { dataset: { kind: 'tag', value: '备用' } } });
  page.removeEditorChoice({ currentTarget: { dataset: { value: '备用' } } });
  assert.equal(page.draftTags.includes('备用'), false);
  page.closeChoiceManager(); assert.equal(page.data.choiceManager, '');
  assert.equal(page.data.editorVisible, true);
  assert.ok(page.catalog.tags.includes('备用'));
});

test('backup shares within the tap and exports the complete book even when filtered', () => {
  const files = new Map(), shares = [];
  let inTap = true;
  const { page, notices } = pageHarness({ export: require('../bookkeeping-module/utils/bookkeeping-adapter').export }, {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => ({
      writeFileSync: (path, text, encoding) => { assert.equal(encoding, 'utf8'); files.set(path, text); },
      writeFile: options => queueMicrotask(() => { files.set(options.filePath, options.data); options.success(); }),
    }),
    shareFileMessage: options => {
      assert.equal(inTap, true, 'sharing must not wait for an asynchronous file callback');
      assert.ok(files.has(options.filePath)); shares.push(options);
    },
  });
  page.records = model.normalizeRecords(Array.from({ length: 936 }, (_, i) => record(`r${i}`, i, '2026-09-28', i % 2 ? '线上' : '线下')));
  page.catalog = { blinds: ['0.5/1'], tags: ['未使用的标签'] };
  page.filters.tag = '线上'; page.rebuildOptions();
  page.exportBackup(); inTap = false;
  assert.equal(shares.length, 1);
  const book = JSON.parse(files.get(shares[0].filePath));
  assert.equal(book.version, 2);
  assert.equal(book.records.length, 936);
  assert.ok(book.blinds.includes('0.5/1'));
  assert.ok(book.tags.includes('未使用的标签'));
  assert.equal(model.parseBook(book).records.length, 936);
  assert.equal(shares[0].fileName, '扑克记账备份-2026-09-28.json');
  assert.equal(page.data.exporting, true);
  page.exportBackup(); assert.equal(shares.length, 1);
  shares[0].complete(); assert.equal(page.data.exporting, false);
  inTap = true; page.exportBackup();
  assert.equal(shares.length, 2);
  assert.equal(files.size, 1, 'repeated exports reuse the local staging file');
  shares[1].complete(); assert.equal(notices.length, 0);
});

test('backup distinguishes write and share failures and releases the retry guard', () => {
  const write = pageHarness({ export: () => '{}' }, {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => ({ writeFileSync: () => { throw new Error('writeFileSync:fail quota exceeded'); } }),
    shareFileMessage: () => assert.fail('must not share a failed write'),
  });
  write.page.exportBackup();
  assert.equal(write.notices[0].title, '生成备份失败');
  assert.match(write.notices[0].content, /quota exceeded/);
  assert.equal(write.page.data.exporting, false);
  for (const throws of [false, true]) {
    let attempts = 0;
    const share = pageHarness({ export: () => '{}' }, {
      env: { USER_DATA_PATH: 'wxfile://usr' },
      getFileSystemManager: () => ({ writeFileSync() {} }),
      shareFileMessage: options => {
        attempts++;
        const error = { errMsg: 'shareFileMessage:fail can only be invoked by user TAP gesture' };
        if (throws) throw error;
        options.fail(error); options.complete();
      },
    });
    share.page.exportBackup();
    assert.equal(share.notices[0].title, '分享备份失败');
    assert.match(share.notices[0].content, /user TAP gesture/);
    assert.equal(share.page.data.exporting, false);
    share.page.exportBackup(); assert.equal(attempts, 2);
  }
});

test('backup cancellation is silent and saving or importing prevents export', () => {
  let attempts = 0;
  const { page, notices } = pageHarness({ export: () => '{}' }, {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => ({ writeFileSync() {} }),
    shareFileMessage: options => { attempts++; options.fail({ errMsg: 'shareFileMessage:fail cancel' }); options.complete(); },
  });
  for (const key of ['saving', 'importBusy', 'loadError']) {
    page.data[key] = key === 'loadError' ? '加载失败' : true;
    page.exportBackup(); assert.equal(attempts, 0);
    page.data[key] = key === 'loadError' ? '' : false;
  }
  page.exportBackup();
  assert.equal(attempts, 1);
  assert.equal(page.data.exporting, false);
  assert.equal(notices.length, 0);
});

test('file import uses returned paths and reaches preview without writing cloud data', async () => {
  for (const key of ['path', 'tempFilePath']) {
    let readPath;
    const { page } = pageHarness({}, {
      chooseMessageFile: o => o.success({ tempFiles: [{ [key]: 'wxfile://backup.json', size: 200 }] }),
      getFileSystemManager: () => ({ readFile: o => { readPath = o.filePath; o.success({ data: JSON.stringify({ records: [webRecord()] }) }); } }),
    });
    await page.importBackup();
    assert.equal(readPath, 'wxfile://backup.json');
    assert.equal(page.data.importPreview.added, 1);
    assert.equal(page.records.length, 0);
    page.cancelImport(); assert.equal(page.data.importBusy, false);
  }
});

test('file import distinguishes picker and read errors, exposes errMsg, and silently cancels', async () => {
  const choose = pageHarness({}, { chooseMessageFile: o => o.fail({ errMsg: 'chooseMessageFile:fail permission denied' }) });
  await choose.page.importBackup();
  assert.equal(choose.notices[0].title, '选择文件失败');
  assert.match(choose.notices[0].content, /permission denied/);
  assert.equal(choose.page.data.importBusy, false);
  const read = pageHarness({}, {
    chooseMessageFile: o => o.success({ tempFiles: [{ path: 'wxfile://expired.json', size: 10 }] }),
    getFileSystemManager: () => ({ readFile: o => o.fail({ errMsg: 'readFile:fail no such file' }) }),
  });
  await read.page.importBackup();
  assert.equal(read.notices[0].title, '读取文件失败');
  assert.match(read.notices[0].content, /no such file/);
  assert.equal(read.page.data.importBusy, false); assert.equal(read.page.records.length, 0);
  const cancelled = pageHarness({}, { chooseMessageFile: o => o.fail({ errMsg: 'chooseMessageFile:fail cancel' }) });
  await cancelled.page.importBackup(); assert.equal(cancelled.notices.length, 0);
  assert.equal(cancelled.page.data.importBusy, false);
});

test('record list starts with latest five, adds five, and loads all within current filters', () => {
  const { page } = pageHarness({});
  page.records = Array.from({ length: 13 }, (_, i) => record(`r${i}`, 10, `2026-09-${String(i + 1).padStart(2, '0')}`, i < 3 ? '朋友' : '周末'));
  page.rebuildOptions();
  assert.equal(page.data.visibleRecords.length, 5);
  assert.equal(page.data.visibleRecords[0].date, '2026-09-13');
  assert.equal(page.data.summary.games, 13);
  page.loadMore(); assert.equal(page.data.visibleRecords.length, 10);
  page.loadMore(); assert.equal(page.data.visibleRecords.length, 13); assert.equal(page.data.hasMore, false);
  page.recompute(); page.loadAllRecords(); assert.equal(page.data.visibleRecords.length, 13);
  assert.equal(new Set(page.data.visibleRecords.map(r => r.id)).size, 13);
  page.filters.tag = '朋友'; page.rebuildOptions(); page.loadAllRecords();
  assert.equal(page.data.visibleRecords.length, 3); assert.equal(page.data.hasMore, false);
});

test('custom filters switch menus, apply exact values and dismiss without changing the selection', () => {
  const { page } = pageHarness({});
  page.records = model.normalizeRecords([record('a', 10, '2025-01-01', '周末'), record('b', 20, '2026-01-01', '朋友')]);
  page.rebuildOptions();
  const event = (key, value) => ({ currentTarget: { dataset: { key, value } } });
  page.toggleFilter(event('year')); assert.equal(page.data.activeFilter, 'year');
  page.toggleFilter(event('tag')); assert.equal(page.data.activeFilter, 'tag');
  page.selectFilterOption(event('tag', '周末'));
  assert.equal(page.data.activeFilter, ''); assert.equal(page.data.recordCount, 1);
  assert.equal(page.data.filterItems.find(f => f.key === 'tag').label, '周末');
  page.toggleFilter(event('tag')); page.closeFilter();
  assert.equal(page.filters.tag, '周末');
  page.toggleFilter(event('tag')); page.selectFilterOption(event('tag', '不存在'));
  assert.equal(page.filters.tag, '周末');
  page.selectFilterOption(event('tag', model.ALL.tag));
  assert.equal(page.data.recordCount, 2);
  page.toggleFilter(event('year')); page.toggleFilter(event('year'));
  assert.equal(page.data.activeFilter, '');
  page.toggleFilter(event('date')); page.onHide(); assert.equal(page.data.activeFilter, '');
});

test('Web JSON and v2 backups preserve empty hours, stakes, multiple tags and unused dictionaries', () => {
  const source = { records: [webRecord(), webRecord({ id: 'web_2', duration: 1.25, result: 'win', amount: 30 })], blinds: ['5/10'], tags: ['未使用'] };
  const book = model.parseBook('\uFEFF' + JSON.stringify(source));
  assert.equal(book.records[0].minutes, null);
  assert.equal(book.records[1].minutes, 75);
  assert.equal(model.summarize(book.records).profit, '+17.50');
  assert.equal(model.summarize(book.records).hours, '1.25');
  const exported = model.backupObject(book);
  assert.deepEqual(exported.records, source.records);
  assert.ok(exported.blinds.includes('5/10'));
  assert.ok(exported.tags.includes('未使用'));
  assert.deepEqual(model.parseBook(exported), book);
  assert.equal(model.viewModel(book.records, { ...model.ALL, tag: '周末', blind: '0.5/1' }, 'tag', 'cumulative').summary.games, 2);
  assert.equal(model.viewModel(book.records, model.ALL, 'blind', 'cumulative').performanceRows[0].label, '0.5/1');
});

test('merge skips repeat imports, preserves conflicting IDs and never partially accepts invalid files', () => {
  const current = { records: [webRecord()] };
  const input = { records: [webRecord(), webRecord({ id: 'web_2', amount: 99 })] };
  const first = model.planImport(current, input);
  assert.equal(first.added, 1); assert.equal(first.duplicates, 1);
  assert.equal(model.planImport(first.next, input).added, 0);
  const conflict = model.planImport(current, { records: [webRecord({ amount: 100 })] });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.next.records[0].profit, -12.5);
  assert.throws(() => model.planImport(current, { records: [webRecord(), webRecord({ id: 'bad', result: 'unknown' })] }), /第 2 条/);
  assert.throws(() => model.parseBook({ records: [webRecord(), webRecord()] }), /重复/);
  assert.throws(() => model.parseBook({ records: [], format: 'other' }), /格式/);
  assert.equal(current.records[0].amount, 12.5);
});

test('v1 backups and stored arrays convert once; Web fields beat obsolete aliases', () => {
  const legacy = model.parseBook({ version: 1, records: [record('legacy', -5)] });
  assert.equal(legacy.records[0].duration, 1);
  assert.equal(legacy.records[0].blind, '');
  assert.deepEqual(model.parseBook(model.backupObject(legacy)), legacy);
  assert.equal(model.parseBook([record()]).records.length, 1);
  const mixed = model.normalizeRecord({ ...webRecord(), minutes: 999, profit: 999, tag: '旧值' });
  assert.equal(mixed.profit, -12.5); assert.equal(mixed.minutes, null); assert.equal(mixed.tag, '线上');
});

test('editing an imported record retains tags, stake and unknown duration', async () => {
  let saved;
  const { page } = pageHarness({ save: async (records, version, catalog) => { saved = { records, catalog }; return { records, version: version + 1, ...catalog }; } });
  const book = model.parseBook({ records: [webRecord()], blinds: ['5/10'], tags: ['未使用'] });
  page.records = book.records; page.catalog = { blinds: book.blinds, tags: book.tags };
  page.openRecord({ currentTarget: { dataset: { id: 'web_1' } } });
  assert.equal(page.data.form.hours, '');
  page.inputField({ currentTarget: { dataset: { key: 'note' } }, detail: { value: '仅改备注' } });
  await page.saveRecord();
  assert.deepEqual(saved.records[0].tags, ['线上', '周末']);
  assert.equal(saved.records[0].blind, '0.5/1'); assert.equal(saved.records[0].duration, null);
  assert.equal(saved.records[0].profit, -12.5); assert.ok(saved.catalog.blinds.includes('5/10'));
});

test('hour editing converts legacy minutes once and preserves existing hour precision', async () => {
  for (const source of [
    { ...record('old'), minutes: 90 },
    { ...record('one_minute'), minutes: 1 },
    webRecord({ duration: 1.25 }),
    webRecord({ duration: 0 }),
  ]) {
    let saved;
    const { page } = pageHarness({ save: async (records, version) => { saved = records; return { records, version: version + 1 }; } });
    const book = model.parseBook({ records: [source] });
    page.records = book.records;
    const hours = book.records[0].duration;
    page.openRecord({ currentTarget: { dataset: { id: source.id } } });
    assert.equal(Number(page.formDraft.hours), hours);
    page.formDraft.note = 'only note changed';
    await page.saveRecord();
    assert.equal(saved[0].duration, hours);
    assert.equal(model.summarize(saved).hours, model.summarize(book.records).hours);
    assert.equal(model.viewModel(saved, model.ALL, 'blind', 'cumulative').filteredRecords[0].durationDisplay, `${Number(hours.toFixed(2))} 小时`);
    const exported = model.parseBook(model.backupObject({ records: saved }));
    assert.equal(exported.records[0].duration, hours);
  }
  const csv = model.parseCsv('date,minutes,profit\n2026-10-08,90,10');
  assert.equal(csv[0].duration, 1.5);
  assert.equal(model.viewModel(csv, model.ALL, 'blind', 'group').filteredRecords[0].durationDisplay, '1.5 小时');
});

test('import preview cancellation writes nothing and confirmation saves merge at captured version', async () => {
  let calls = 0, savedVersion;
  const { page } = pageHarness({ save: async (records, version, catalog) => { calls++; savedVersion = version; return { records, version: version + 1, ...catalog }; } });
  const plan = model.planImport({ records: [] }, { records: [webRecord()] });
  page.pendingImport = { plan, version: 3 }; page.data.importPreview = {}; page.data.importBusy = true;
  page.cancelImport(); assert.equal(calls, 0); assert.equal(page.data.importBusy, false);
  page.pendingImport = { plan, version: 3 }; page.data.importPreview = {}; page.data.importBusy = true;
  await page.confirmImport();
  assert.equal(calls, 1); assert.equal(savedVersion, 3); assert.equal(page.records.length, 1);
  assert.equal(page.data.importPreview, null);
});
