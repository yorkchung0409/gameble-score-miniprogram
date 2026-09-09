'use strict';

function defaultError(message) {
  return new Error(message);
}

function amountToCents(value, label = '金额', errorFactory = defaultError) {
  const normalized = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw errorFactory(`${label}格式无效`);
  }
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart, decimalPart = ''] = unsigned.split('.');
  const cents = (Number(integerPart) * 100 + Number((decimalPart + '00').slice(0, 2))) * (negative ? -1 : 1);
  if (!Number.isSafeInteger(cents)) throw errorFactory(`${label}过大`);
  return cents;
}

function centsToAmount(cents) {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function calculateTeaFeeCents(amountCents, thresholdCents, ratePercent) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return 0;
  if (!Number.isSafeInteger(thresholdCents) || thresholdCents < 0) return 0;
  if (!Number.isSafeInteger(ratePercent) || ratePercent <= 0) return 0;
  if (thresholdCents > 0 && amountCents < thresholdCents) return 0;
  // Amounts are stored in cents. Do not round a fractional cent up: an amount
  // below the smallest supported unit simply stays with the recipient.
  return Math.floor((amountCents * ratePercent) / 100);
}

function calculateThresholdTeaFeeCents(amountCents, thresholdCents, feeCents) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return 0;
  if (!Number.isSafeInteger(thresholdCents) || thresholdCents <= 0) return 0;
  if (!Number.isSafeInteger(feeCents) || feeCents <= 0) return 0;
  return Math.floor(amountCents / thresholdCents) * feeCents;
}

function calculateRoomStats(rows, options = {}) {
  const toCents = options.amountToCents || amountToCents;
  const reversedOriginIds = new Set(rows.map((row) => row.reversalOf).filter(Boolean));
  const balanceMap = new Map();
  let teaFeeTotal = 0;
  let totalTurnover = 0;
  for (const row of rows) {
    balanceMap.set(row.payerId, balanceMap.get(row.payerId) || 0);
    if (row.payeeType === 'user' && row.payeeId) balanceMap.set(row.payeeId, balanceMap.get(row.payeeId) || 0);
    if (row.reversalOf || reversedOriginIds.has(row.id)) continue;
    const amount = toCents(row.amount);
    totalTurnover += Math.abs(amount);
    if (row.payeeType === 'tea_fee') {
      teaFeeTotal += amount;
      balanceMap.set(row.payerId, (balanceMap.get(row.payerId) || 0) - amount);
      continue;
    }
    if (row.payeeType === 'user' && row.payeeId) {
      balanceMap.set(row.payeeId, (balanceMap.get(row.payeeId) || 0) + amount);
      if (row.transactionType === 'manual' && row.autoFeeMode
        && row.autoFeeThresholdAmount != null) {
        const fee = (row.autoFeeMode === 'percentage' || row.autoFeeMode === 'per_player')
          && row.autoFeeRatePercent != null
          ? calculateTeaFeeCents(amount, toCents(row.autoFeeThresholdAmount), Number(row.autoFeeRatePercent))
          : (row.autoFeeMode === 'threshold' || row.autoFeeMode === 'shared_total')
            && row.autoFeeAmount != null
            ? calculateThresholdTeaFeeCents(amount, toCents(row.autoFeeThresholdAmount), toCents(row.autoFeeAmount))
            : 0;
        if (fee > 0) {
          balanceMap.set(row.payeeId, (balanceMap.get(row.payeeId) || 0) - fee);
          teaFeeTotal += fee;
        }
      }
    }
    balanceMap.set(row.payerId, (balanceMap.get(row.payerId) || 0) - amount);
  }
  return { balanceMap, teaFeeTotal, totalTurnover };
}

function canViewRoom({ isArchived, isActiveMember, wasMember }) {
  return isArchived ? Boolean(wasMember) : Boolean(isActiveMember);
}

module.exports = {
  amountToCents,
  centsToAmount,
  calculateTeaFeeCents,
  calculateThresholdTeaFeeCents,
  calculateRoomStats,
  canViewRoom,
};
