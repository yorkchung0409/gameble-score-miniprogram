function maximumBuy(coverage, odds) {
  const amount = Number(coverage);
  const multiplier = Number(odds);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return Math.ceil(amount / multiplier);
}

module.exports = { maximumBuy };
