const Core = require('../poker-core');

const GROUPS = [
  ['flush', '买花'], ['straight', '买顺'], ['overcard', '买高张'],
  ['trips', '买三条 / set'], ['twoPair', '买两对'], ['fullHouse', '买葫芦'],
  ['quads', '买四条'], ['straightFlush', '买同花顺'], ['pair', '买一对'], ['other', '其他反超']
];
const TYPES = { 0: 'other', 1: 'pair', 2: 'twoPair', 3: 'trips', 4: 'straight', 5: 'flush', 6: 'fullHouse', 7: 'quads', 8: 'straightFlush' };

function fiveScores(cards, required) {
  const result = [];
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            if (!required || hand.some(card => card.value === required)) result.push(Core.evaluateFive(hand));
          }
  return result;
}

function classifyOuts(board, players, participantKeys, buyerKey, outCards) {
  const prepared = Core.prepareCardState(board, players);
  if (!prepared) return [];
  const eligible = new Set(participantKeys || players.map(player => player.key));
  const participants = prepared.players.filter(player => eligible.has(player.key));
  const buyer = participants.find(player => player.key === buyerKey);
  if (!buyer || participants.length < 2) return [];
  const remaining = new Set(prepared.remaining.map(card => card.value));
  const highestBoard = Math.max(...prepared.board.map(card => card.rank));
  const groups = Object.fromEntries(GROUPS.map(([key]) => [key, new Set()]));
  const opponents = participants.filter(player => player.key !== buyerKey).map(player => ({
    ...player, before: fiveScores([...prepared.board, ...player.cards])
  }));
  for (const value of outCards) {
    const card = Core.parseCard(value);
    if (!card || !remaining.has(value)) continue;
    const buyerScore = Core.evaluateBest([...prepared.board, card, ...buyer.cards]);
    const labels = new Set();
    let loses = false;
    for (const opponent of opponents) {
      const cards = [...prepared.board, card, ...opponent.cards];
      if (Core.compareScore(Core.evaluateBest(cards), buyerScore) <= 0) continue;
      loses = true;
      for (const score of fiveScores(cards, value)) {
        if (Core.compareScore(score, buyerScore) <= 0) continue;
        // Only a new/improved combination counts as a reason for this out.
        if (opponent.before.some(before => before[0] === score[0] && Core.compareScore(before, score) >= 0)) continue;
        let type = TYPES[score[0]];
        if (type === 'pair' && score[1] === card.rank && card.rank > highestBoard
          && opponent.cards.some(hole => hole.rank === card.rank)) type = 'overcard';
        labels.add(type);
        if (type === 'straightFlush') { labels.add('flush'); labels.add('straight'); }
      }
    }
    if (!loses) continue;
    if (!labels.size) labels.add('other');
    for (const label of labels) groups[label].add(value);
  }
  return GROUPS.filter(([key]) => groups[key].size).map(([key, label]) => ({ key, label, cards: [...groups[key]] }));
}

function selectedCards(allCards, requested) {
  const selected = new Set(Array.isArray(requested) ? requested : []);
  return [...new Set(allCards)].filter(card => selected.has(card));
}

module.exports = { GROUPS, classifyOuts, selectedCards };
