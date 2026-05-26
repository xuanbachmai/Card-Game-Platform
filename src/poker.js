const { createDeck, shuffle, rankValue } = require('./deck');

// ── Hand evaluation ──────────────────────────────────────────────────────────

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...combinations(rest, k - 1).map(c => [first, ...c]),
    ...combinations(rest, k),
  ];
}

function evaluate5(cards) {
  // Returns score array [handRank, ...kickers]; higher = better
  const ranks = cards.map(c => rankValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const rankCounts = {};
  for (const r of ranks) rankCounts[r] = (rankCounts[r] || 0) + 1;
  const counts = Object.values(rankCounts).sort((a, b) => b - a);
  const byCount = Object.entries(rankCounts)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([r]) => Number(r));

  const isFlush = suits.every(s => s === suits[0]);
  const isStr = ranks.length === 5 && ranks[0] - ranks[4] === 4 && new Set(ranks).size === 5;
  const isAceLow = ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2;

  if (isFlush && (isStr || isAceLow)) return [8, isAceLow ? 5 : ranks[0]];
  if (counts[0] === 4) return [7, byCount[0], byCount[1]];
  if (counts[0] === 3 && counts[1] === 2) return [6, byCount[0], byCount[1]];
  if (isFlush) return [5, ...ranks];
  if (isStr) return [4, ranks[0]];
  if (isAceLow) return [4, 5];
  if (counts[0] === 3) return [3, byCount[0], byCount[1], byCount[2]];
  if (counts[0] === 2 && counts[1] === 2) return [2, byCount[0], byCount[1], byCount[2]];
  if (counts[0] === 2) return [1, byCount[0], byCount[1], byCount[2], byCount[3]];
  return [0, ...ranks];
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHandScore(cards) {
  if (cards.length <= 5) return evaluate5(cards);
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const score = evaluate5(combo);
    if (!best || compareScore(score, best) > 0) best = score;
  }
  return best;
}

const HAND_NAMES = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

// ── Poker Game ───────────────────────────────────────────────────────────────

class Poker {
  constructor(players, { startingChips = 1000 } = {}) {
    this.startingChips = startingChips;
    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      hand: [],
      chips: startingChips,
      bet: 0,         // bet in current betting round
      totalBet: 0,    // total bet in this hand
      status: 'active', // active, folded, allin, out
      position: i,
      handScore: null,
      handName: null,
    }));
    this.deck = [];
    this.community = [];
    this.pot = 0;
    this.phase = 'waiting'; // waiting, preflop, flop, turn, river, showdown
    this.currentPlayerIndex = 0;
    this.dealerIndex = 0;
    this.smallBlind = 10;
    this.bigBlind = 20;
    this.currentBet = 0;
    this.needsToAct = new Set();
    this.winners = null;
    this.round = 0;
  }

  start() {
    this.round = 1;
    this._startHand();
  }

  _startHand() {
    this.deck = shuffle(createDeck());
    this.community = [];
    this.pot = 0;
    this.winners = null;

    for (const p of this.players) {
      p.hand = [];
      p.bet = 0;
      p.totalBet = 0;
      p.handScore = null;
      p.handName = null;
      p.status = p.chips > 0 ? 'active' : 'out';
    }

    const active = this.players.filter(p => p.status === 'active');
    if (active.length < 2) { this.phase = 'ended'; return; }

    // Deal 2 cards each
    for (let i = 0; i < 2; i++) {
      for (const p of this.players) {
        if (p.status === 'active') p.hand.push(this.deck.pop());
      }
    }

    // Post blinds
    const n = this.players.length;
    const sbIdx = this._nextActiveFrom((this.dealerIndex + 1) % n);
    const bbIdx = this._nextActiveFrom((sbIdx + 1) % n);

    this._postBlind(sbIdx, this.smallBlind);
    this._postBlind(bbIdx, this.bigBlind);
    this.currentBet = this.bigBlind;

    // UTG acts first preflop; all active players need to act
    this.needsToAct = new Set(this.players.filter(p => p.status === 'active').map(p => p.id));
    const utgIdx = this._nextActiveFrom((bbIdx + 1) % n);
    this.currentPlayerIndex = utgIdx;

    this.phase = 'preflop';
  }

  _postBlind(idx, amount) {
    const p = this.players[idx];
    if (!p || p.status !== 'active') return;
    const actual = Math.min(amount, p.chips);
    p.chips -= actual;
    p.bet += actual;
    p.totalBet += actual;
    this.pot += actual;
    if (p.chips === 0) p.status = 'allin';
  }

  _nextActiveFrom(idx) {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.players[(idx + i) % n];
      if (p.status === 'active') return (idx + i) % n;
    }
    return idx;
  }

  handleAction(playerId, action) {
    if (this.phase === 'showdown' || this.phase === 'waiting') {
      if (action.type === 'newHand') {
        this.round++;
        this.dealerIndex = this._nextActiveFrom((this.dealerIndex + 1) % this.players.length);
        this._startHand();
        return {};
      }
      return { error: 'Game not in progress' };
    }

    const cur = this.players[this.currentPlayerIndex];
    if (!cur || cur.id !== playerId) return { error: 'Not your turn' };
    if (cur.status !== 'active') return { error: 'Cannot act' };
    if (!this.needsToAct.has(playerId)) return { error: 'You have already acted' };

    if (action.type === 'fold') {
      cur.status = 'folded';
      this.needsToAct.delete(playerId);
    } else if (action.type === 'check') {
      if (cur.bet < this.currentBet) return { error: 'Cannot check — must call or raise' };
      this.needsToAct.delete(playerId);
    } else if (action.type === 'call') {
      const toCall = Math.min(this.currentBet - cur.bet, cur.chips);
      cur.chips -= toCall;
      cur.bet += toCall;
      cur.totalBet += toCall;
      this.pot += toCall;
      if (cur.chips === 0) cur.status = 'allin';
      this.needsToAct.delete(playerId);
    } else if (action.type === 'raise') {
      const raiseTo = parseInt(action.amount);
      if (isNaN(raiseTo) || raiseTo <= this.currentBet) {
        return { error: 'Raise must be higher than current bet of ' + this.currentBet };
      }
      const toAdd = Math.min(raiseTo - cur.bet, cur.chips);
      cur.chips -= toAdd;
      cur.bet += toAdd;
      cur.totalBet += toAdd;
      this.pot += toAdd;
      this.currentBet = cur.bet;
      if (cur.chips === 0) cur.status = 'allin';
      this.needsToAct.delete(playerId);
      // Everyone else active must act again
      for (const p of this.players) {
        if (p.id !== playerId && p.status === 'active') {
          this.needsToAct.add(p.id);
        }
      }
    } else {
      return { error: 'Unknown action' };
    }

    // Check if only one non-folded player remains
    const alive = this.players.filter(p => p.status !== 'folded' && p.status !== 'out');
    if (alive.length === 1) {
      alive[0].chips += this.pot;
      this.winners = [{ id: alive[0].id, name: alive[0].name, handName: 'Last standing' }];
      this.phase = 'showdown';
      this.dealerIndex = this._nextActiveFrom((this.dealerIndex + 1) % this.players.length);
      return {};
    }

    // Advance to next player who needs to act
    this._advancePlayer();

    return {};
  }

  _advancePlayer() {
    const n = this.players.length;
    // Find next player who needs to act
    for (let i = 1; i <= n; i++) {
      const idx = (this.currentPlayerIndex + i) % n;
      const p = this.players[idx];
      if (p.status === 'active' && this.needsToAct.has(p.id)) {
        this.currentPlayerIndex = idx;
        return;
      }
    }
    // No one needs to act — end betting round
    this._endBettingRound();
  }

  _endBettingRound() {
    // Reset per-round bets
    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;

    // Find first active player after dealer for next round
    const firstIdx = this._nextActiveFrom((this.dealerIndex + 1) % this.players.length);
    this.currentPlayerIndex = firstIdx;
    this.needsToAct = new Set(this.players.filter(p => p.status === 'active').map(p => p.id));

    if (this.phase === 'preflop') {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else if (this.phase === 'flop') {
      this.community.push(this.deck.pop());
      this.phase = 'turn';
    } else if (this.phase === 'turn') {
      this.community.push(this.deck.pop());
      this.phase = 'river';
    } else if (this.phase === 'river') {
      this._showdown();
    }

    // If everyone is all-in, run out the board
    const activeCount = this.players.filter(p => p.status === 'active').length;
    if (activeCount === 0 && this.phase !== 'showdown') {
      this._runoutBoard();
    }
  }

  _runoutBoard() {
    while (this.community.length < 5) {
      this.community.push(this.deck.pop());
    }
    this._showdown();
  }

  _showdown() {
    this.phase = 'showdown';
    const eligible = this.players.filter(p => p.status !== 'folded' && p.status !== 'out');

    for (const p of eligible) {
      const allCards = [...p.hand, ...this.community];
      p.handScore = bestHandScore(allCards);
      p.handName = HAND_NAMES[p.handScore[0]];
    }

    // Simple pot split (ignores side pots for simplicity)
    eligible.sort((a, b) => compareScore(b.handScore, a.handScore));
    const best = eligible[0].handScore;
    const winnerList = eligible.filter(p => compareScore(p.handScore, best) === 0);
    const share = Math.floor(this.pot / winnerList.length);
    for (const w of winnerList) w.chips += share;

    this.winners = winnerList.map(w => ({ id: w.id, name: w.name, handName: w.handName }));
    this.dealerIndex = this._nextActiveFrom((this.dealerIndex + 1) % this.players.length);
  }

  getStateForPlayer(playerId) {
    const isShowdown = this.phase === 'showdown';
    return {
      phase: this.phase,
      round: this.round,
      community: this.community,
      pot: this.pot,
      currentBet: this.currentBet,
      currentPlayer: this.players[this.currentPlayerIndex]?.id,
      dealerIndex: this.dealerIndex,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      winners: this.winners,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        totalBet: p.totalBet,
        status: p.status,
        position: p.position,
        hand: (p.id === playerId || isShowdown)
          ? p.hand
          : p.hand.map(() => ({ suit: 'hidden', rank: '?' })),
        handName: isShowdown ? p.handName : undefined,
        isCurrentPlayer: p.id === this.players[this.currentPlayerIndex]?.id,
        isDealer: p.position === this.dealerIndex,
        isYou: p.id === playerId,
        needsToAct: this.needsToAct.has(p.id),
      })),
    };
  }
}

module.exports = Poker;
