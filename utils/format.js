const AVATAR_COLORS = [
  '#5C806D',
  '#B87455',
  '#7D8F9A',
  '#9B7E88',
  '#C58B3D',
  '#6F9180',
  '#A76870',
  '#6E7D87',
];

function avatarColor(value) {
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function toCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function formatAmount(value) {
  return (toCents(value) / 100).toFixed(2);
}

function formatNet(value) {
  const cents = toCents(value);
  const sign = cents > 0 ? '+' : cents < 0 ? '-' : '';
  return `${sign}${formatAmount(Math.abs(cents) / 100)}`;
}

function chinaParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // Format server timestamps in a fixed business timezone, independent of the
  // device timezone selected by the user.
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function displayDate(value) {
  if (!value) return '';
  const parts = chinaParts(value);
  if (!parts) return '';
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function displayDateTime(value) {
  if (!value) return '';
  const parts = chinaParts(value);
  if (!parts) return String(value);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

function today() {
  const date = new Date();
  return displayDate(date);
}

module.exports = {
  avatarColor,
  displayDate,
  displayDateTime,
  formatAmount,
  formatNet,
  toCents,
  today,
};
