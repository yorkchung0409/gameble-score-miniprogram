const MAX_RECORDS = 2000;
const ALL = { year: '全部年份', month: '全部月份', date: '全部日期', tag: '全部标签', blind: '全部盲注' };
const tagsOf = r => r.tags || (r.tag ? [r.tag] : []);
function strings(values, label) {
  if (!Array.isArray(values) || values.length > 2000 || values.some(v => typeof v !== 'string' || !v.trim() || v.length > 30)) throw new Error(`${label}格式不正确（每项最多 30 字）`);
  return [...new Set(values)];
}

function cents(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('盈亏请填写数字，最多两位小数');
  const amount = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 10000000000) throw new Error('单场盈亏不能超过一亿积分');
  return amount;
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date && date >= '1900-01-01';
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || !validDate(record.date)) throw new Error('记录日期不正确');
  if (typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.id)) throw new Error('记录编号不正确');
  const web = ['result', 'amount', 'duration'].some(key => Object.prototype.hasOwnProperty.call(record, key));
  let minutes, profit, result, duration;
  if (web) {
    if (!['win', 'lose'].includes(record.result)) throw new Error('输赢类型只能为 win 或 lose');
    const value = cents(record.amount);
    if (value < 0) throw new Error('金额不能为负数');
    result = record.result; profit = (result === 'lose' ? -value : value) / 100;
    duration = record.duration == null ? null : record.duration;
    if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 168)) throw new Error('时长必须为空或 0–168 小时');
    minutes = duration === null ? null : duration * 60;
  } else {
    minutes = record.minutes == null || record.minutes === '' ? null : Number(record.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080)) throw new Error('时长请填写 0–10080 分钟的整数');
    profit = cents(record.profit) / 100; result = profit < 0 ? 'lose' : 'win';
    duration = minutes === null ? null : minutes / 60;
  }
  const tag = record.tag == null ? '' : record.tag;
  const note = record.note == null ? '' : record.note;
  if (typeof tag !== 'string' || tag.trim().length > 30) throw new Error('标签最多 30 字');
  if (typeof note !== 'string' || note.trim().length > 200) throw new Error('备注最多 200 字');
  const tags = strings(record.tags === undefined ? (tag ? [tag.trim()] : []) : record.tags, '标签');
  const blind = record.blind == null ? '' : record.blind;
  if (typeof blind !== 'string' || blind.length > 30) throw new Error('盲注最多 30 字');
  return { id: record.id, date: record.date, result, amount: Math.abs(profit), duration, blind, tags, note,
    minutes, profit, tag: tags[0] || '' };
}

function normalizeRecords(records) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error('记录格式不正确或超过 2000 条');
  const ids = new Set();
  return records.map((record, index) => {
    let normalized;
    try { normalized = normalizeRecord(record); } catch (error) { throw new Error(`第 ${index + 1} 条：${error.message}`); }
    if (ids.has(normalized.id)) throw new Error('备份中存在重复的记录编号');
    ids.add(normalized.id);
    return normalized;
  });
}

function newId() { return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`; }
function amount(value) { return `${value > 0 ? '+' : value < 0 ? '-' : ''}${(Math.abs(value) / 100).toFixed(2)}`; }
function profitClass(value) { return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'; }
function decorate(record) {
  const hours = record.duration === undefined ? (record.minutes == null ? null : record.minutes / 60) : record.duration;
  return { ...record, tagDisplay: tagsOf(record).join(' / '), durationDisplay: hours == null ? '时长未填' : `${Number(hours.toFixed(2))} 小时`, profitDisplay: amount(cents(record.profit)), profitClass: profitClass(record.profit) };
}

function buildOptions(records, selected = {}) {
  const unique = (values) => [...new Set(values)].sort().reverse();
  const options = {
    year: [ALL.year, ...unique(records.map(r => r.date.slice(0, 4)))],
    month: [ALL.month, ...unique(records.map(r => r.date.slice(5, 7) + '月')).reverse()],
    date: [ALL.date, ...unique(records.map(r => r.date))],
    tag: [ALL.tag, ...unique(records.flatMap(tagsOf))],
    blind: [ALL.blind, ...unique(records.map(r => r.blind).filter(Boolean))],
  };
  const filters = {};
  for (const key of Object.keys(ALL)) filters[key] = options[key].includes(selected[key]) ? selected[key] : ALL[key];
  return { options, filters };
}

function summarize(records) {
  let total = 0, minutes = 0, wins = 0;
  for (const record of records) { total += cents(record.profit); minutes += record.minutes || 0; if (cents(record.profit) > 0) wins += 1; }
  return { games: records.length, hours: (minutes / 60).toFixed(2), profitCents: total, profit: amount(total), hourly: amount(minutes ? Math.round(total * 60 / minutes) : 0), winRate: records.length ? (wins / records.length * 100).toFixed(0) : '0', average: amount(records.length ? Math.round(total / records.length) : 0), profitClass: profitClass(total) };
}

function viewModel(records, filters, performanceMode, trendMode, trendLimit = 12) {
  const filtered = records.filter(r =>
    (filters.year === ALL.year || r.date.slice(0, 4) === filters.year) &&
    (filters.month === ALL.month || r.date.slice(5, 7) + '月' === filters.month) &&
    (filters.date === ALL.date || r.date === filters.date) &&
    (filters.tag === ALL.tag || tagsOf(r).includes(filters.tag)) &&
    (!filters.blind || filters.blind === ALL.blind || r.blind === filters.blind));
  const ordered = filtered.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const groups = new Map();
  for (const record of ordered) {
    const keys = performanceMode === 'tag' ? (tagsOf(record).length ? tagsOf(record) : ['未分类']) : [performanceMode === 'blind' ? record.blind || '未填盲注' : record.date];
    for (const key of keys) groups.set(key, (groups.get(key) || 0) + cents(record.profit));
  }
  const max = Math.max(1, ...Array.from(groups.values()).map(Math.abs));
  const performanceRows = Array.from(groups, ([label, value]) => ({ label, profit: amount(value), width: Math.round(Math.abs(value) / max * 100), profitClass: profitClass(value) }));
  let cumulative = 0;
  const points = ordered.map(record => {
    cumulative += cents(record.profit);
    const value = trendMode === 'cumulative' ? cumulative : cents(record.profit);
    return { id: record.id, label: record.date.slice(5), value, profit: amount(value), profitClass: profitClass(value) };
  });
  const peak = Math.max(1, ...points.map(p => Math.abs(p.value)));
  const limit = Number.isInteger(trendLimit) ? Math.min(Math.max(trendLimit, 1), 200) : 12;
  const trendBars = points.slice(-limit).map(p => ({ ...p, height: p.value ? Math.max(2, Math.round(Math.abs(p.value) / peak * 70)) : 0 }));
  return { summary: summarize(filtered), filteredRecords: ordered.reverse().map(decorate), winRankings: filtered.filter(r => r.profit > 0).sort((a, b) => b.profit - a.profit).slice(0, 5).map(decorate), lossRankings: filtered.filter(r => r.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, 5).map(decorate), performanceRows, trendBars };
}

function parseBackup(text) {
  return parseBook(text).records;
}

function parseBook(input) {
  let payload;
  try { payload = typeof input === 'string' ? JSON.parse(input.replace(/^\uFEFF/, '')) : input; } catch { throw new Error('备份不是有效的 JSON'); }
  if (Array.isArray(payload)) payload = { records: payload };
  if (!payload || typeof payload !== 'object') throw new Error('备份格式不正确');
  if (payload.version !== undefined && ![1, 2].includes(payload.version)) throw new Error('不支持这个备份版本');
  if (payload.format !== undefined && payload.format !== 'york-bookkeeping') throw new Error('不支持这个备份格式');
  const records = normalizeRecords(payload.records);
  const blinds = strings(payload.blinds === undefined ? [] : payload.blinds, '盲注选项');
  const tags = strings(payload.tags === undefined ? [] : payload.tags, '标签选项');
  return { records, blinds: [...new Set([...blinds, ...records.map(r => r.blind).filter(Boolean)])], tags: [...new Set([...tags, ...records.flatMap(tagsOf)])] };
}

// Persist only canonical Web fields; profit/minutes/tag are derived UI aliases.
function backupObject(book) {
  const normalized = parseBook(book);
  return { format: 'york-bookkeeping', version: 2, ...normalized, records: normalized.records.map(({ minutes, profit, tag, ...record }) => record) };
}

function planImport(current, incoming) {
  const before = parseBook(current), source = parseBook(incoming);
  const byId = new Map(before.records.map(r => [r.id, r]));
  const additions = [], conflicts = []; let duplicates = 0;
  for (const record of source.records) {
    const existing = byId.get(record.id);
    if (!existing) additions.push(record);
    else if (JSON.stringify(existing) === JSON.stringify(record)) duplicates++;
    else conflicts.push({ id: record.id, date: record.date, existing: decorate(existing), incoming: decorate(record) });
  }
  const next = parseBook({ records: [...before.records, ...additions], blinds: [...new Set([...before.blinds, ...source.blinds])], tags: [...new Set([...before.tags, ...source.tags])] });
  return { next, imported: source.records.length, added: additions.length, duplicates, conflicts, incomingStats: summarize(source.records), nextStats: summarize(next.records) };
}

// Supports quoted commas, escaped quotes and line breaks from spreadsheet CSV exports.
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const source = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"' && !field && !closed) quoted = true;
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') { if (row.some(v => v.trim())) rows.push(row); row = []; if (char === '\r' && source[i + 1] === '\n') i += 1; }
    } else { if (closed || char === '"') throw new Error('CSV 引号格式不正确'); field += char; }
  }
  if (quoted) throw new Error('CSV 引号没有闭合');
  row.push(field); if (row.some(v => v.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV 没有记录');
  const headers = rows.shift().map(v => v.trim().toLowerCase());
  const aliases = { date: ['date', '日期'], minutes: ['minutes', '时长', '时长（分钟）', '分钟'], profit: ['profit', '盈亏', '本局盈亏'], tag: ['tag', '标签'], note: ['note', '备注'] };
  const indexes = {};
  for (const key of Object.keys(aliases)) indexes[key] = headers.findIndex(h => aliases[key].includes(h));
  if (['date', 'minutes', 'profit'].some(key => indexes[key] < 0)) throw new Error('CSV 必须含日期、时长（分钟）、盈亏三列');
  return normalizeRecords(rows.map((values, i) => {
    if (values.length !== headers.length) throw new Error(`CSV 第 ${i + 2} 行列数不正确`);
    const record = { id: newId() };
    for (const key of Object.keys(aliases)) record[key] = indexes[key] < 0 ? '' : values[indexes[key]];
    record.date = record.date.trim();
    return record;
  }));
}

module.exports = { MAX_RECORDS, ALL, cents, amount, profitClass, validDate, normalizeRecord, normalizeRecords, newId, buildOptions, summarize, viewModel, parseBackup, parseBook, backupObject, planImport, parseCsv };
