'use strict';

const { amountToCents } = require('./mahjong-core');

function emptyHistory() {
  return { version: 1, gameCount: 0, buyInCents: 0, players: {} };
}

function parseHistory(raw) {
  if (raw == null) return emptyHistory();
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (value?.version !== 1 || !value.players || Array.isArray(value.players)
      || !Number.isSafeInteger(value.gameCount) || value.gameCount < 0
      || !Number.isSafeInteger(value.buyInCents) || value.buyInCents < 0) {
    throw new Error('Invalid poker history snapshot');
  }
  for (const player of Object.values(value.players)) {
    for (const key of ['netCents', 'winCents', 'lossCents', 'buyInCents', 'gameCount']) {
      if (!Number.isSafeInteger(player[key]) || (key !== 'netCents' && player[key] < 0)) {
        throw new Error('Invalid poker player snapshot');
      }
    }
  }
  return value;
}

function personalHistory(snapshot, playerId) {
  const player = playerId ? parseHistory(snapshot?.aggregatesJson).players[playerId] : null;
  // Legacy totals belong to the original owner. Settings disallow changing
  // the self player while this un-attributable legacy balance exists.
  return {
    netCents: amountToCents(snapshot?.netProfit || 0) + (player?.netCents || 0),
    gameCount: Number(snapshot?.gameCount || 0) + (player?.gameCount || 0),
  };
}

module.exports = { emptyHistory, parseHistory, personalHistory };
