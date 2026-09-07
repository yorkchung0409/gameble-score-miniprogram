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

function displayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function displayDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
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
