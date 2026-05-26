const { createDeck, shuffle } = require('./deck');

// ── Card ordering for Tiến Lên ───────────────────────────────────────────────
// Rank: 3 < 4 < ... < K < A < 2
// Suit: ♠ < ♣ < ♦ < ♥

const TL_RANK = { '3':0,'4':1,'5':2,'6':3,'7':4,'8':5,'9':6,'10':7,'J':8,'Q':9,'K':10,'A':11,'2':12 };
const TL_SUIT = { spades:0, clubs:1, diamonds:2, hearts:3 };

function tlValue(card) {
  return TL_RANK[card.rank] * 4 + TL_SUIT[card.suit];
}

function cardEqual(a, b) {
  return a.rank === b.rank && a.suit === b.suit;
}

function sortTL(cards) {
  return [...cards].sort((a, b) => tlValue(a) - tlValue(b));
}

// ── Play validation ──────────────────────────────────────────────────────────

function classifyPlay(cards) {
  if (cards.length === 0) return null;
  const sorted = sortTL(cards);

  if (cards.length === 1) return { type: 'single', cards: sorted };

  if (cards.length === 2) {
    if (sorted[0].rank === sorted[1].rank) return { type: 'pair', cards: sorted };
    return null;
  }

  if (cards.length === 3) {
    if (sorted[0].rank === sorted[1].rank && sorted[1].rank === sorted[2].rank) {
      return { type: 'triple', cards: sorted };
    }
    const seq = isSequence(sorted);
    if (seq) return { type: 'sequence', cards: sorted, length: 3 };
    return null;
  }

  if (cards.length === 4) {
    if (new Set(sorted.map(c => c.rank)).size === 1) {
      return { type: 'quad', cards: sorted }; // bomb
    }
    const seq = isSequence(sorted);
    if (seq) return { type: 'sequence', cards: sorted, length: 4 };
    return null;
  }

  // 5+ cards: sequence or pair sequence
  if (cards.length >= 3 && cards.length % 2 === 0) {
    const ps = isPairSequence(sorted);
    if (ps) return { type: 'pairseq', cards: sorted, length: cards.length / 2 };
  }
  if (cards.length >= 5) {
    const seq = isSequence(sorted);
    if (seq) return { type: 'sequence', cards: sorted, length: cards.length };
  }
  return null;
}

function isSequence(sorted) {
  if (sorted.some(c => c.rank === '2')) return false;
  for (let i = 1; i < sorted.length; i++) {
    if (TL_RANK[sorted[i].rank] !== TL_RANK[sorted[i-1].rank] + 1) return false;
  }
  return true;
}

function isPairSequence(sorted) {
  if (sorted.some(c => c.rank === '2')) return false;
  if (sorted.length % 2 !== 0) return false;
  for (let i = 0; i < sorted.length; i += 2) {
    if (sorted[i].rank !== sorted[i+1].rank) return false;
    if (i > 0 && TL_RANK[sorted[i].rank] !== TL_RANK[sorted[i-2].rank] + 1) return false;
  }
  return true;
}

function canBeat(play, last) {
  if (!last) return true;

  if (play.type === 'quad') {
    if (last.type === 'quad') return TL_RANK[play.cards[0].rank] > TL_RANK[last.cards[0].rank];
    if (last.type === 'single' && last.cards[0].rank === '2') return true;
    if (last.type === 'pair'   && last.cards[0].rank === '2') return true;
    return false;
  }

  if (play.type === 'pairseq' && play.length >= 3) {
    if (last.type === 'single' && last.cards[0].rank === '2') return true;
  }

  if (play.type !== last.type) return false;

  if (play.type === 'single') return tlValue(play.cards[0]) > tlValue(last.cards[0]);
  if (play.type === 'pair') {
    const highP = play.cards[1], highL = last.cards[1];
    if (TL_RANK[highP.rank] !== TL_RANK[highL.rank]) return TL_RANK[highP.rank] > TL_RANK[highL.rank];
    return TL_SUIT[highP.suit] > TL_SUIT[highL.suit];
  }
  if (play.type === 'triple') return TL_RANK[play.cards[0].rank] > TL_RANK[last.cards[0].rank];
  if (play.type === 'sequence') {
    if (play.length !== last.length) return false;
    return tlValue(play.cards[play.cards.length - 1]) > tlValue(last.cards[last.cards.length - 1]);
  }
  if (play.type === 'pairseq') {
    if (play.length !== last.length) return false;
    const ph = play.cards[play.cards.length - 1], lh = last.cards[last.cards.length - 1];
    return TL_RANK[ph.rank] > TL_RANK[lh.rank];
  }
  return false;
}

// ── Tới trắng detection ──────────────────────────────────────────────────────
// Returns a string label if this hand qualifies for an instant-win declaration,
// or null otherwise.

function detectToiTrang(hand) {
  // 1. Four 2s
  if (hand.filter(c => c.rank === '2').length === 4) return 'Tứ quý 2 (tới trắng)';

  // 2. Dragon: 3-4-5-6-7-8-9-10-J-Q-K-A-2 in sequence (all 13 cards)
  if (hand.length === 13) {
    const ranks = new Set(hand.map(c => c.rank));
    const dragon = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
    if (dragon.every(r => ranks.has(r))) return 'Rồng (tới trắng)';
  }

  // 3. Six or more pairs
  const byRank = {};
  hand.forEach(c => { byRank[c.rank] = (byRank[c.rank] || 0) + 1; });
  const pairs = Object.values(byRank).filter(n => n >= 2).length;
  if (pairs >= 6) return `${pairs} đôi (tới trắng)`;

  return null;
}

// ── TienLen Game ─────────────────────────────────────────────────────────────

class TienLen {
  constructor(players, { startingChips = 1000 } = {}) {
    this.startingChips = startingChips;
    this.players = players.map(p => ({
      id: p.id,
      name: p.name,
      hand: [],
      chips: startingChips,
      status: 'active',
      place: null,
      chipDelta: 0,     // chips won/lost this round
      toiTrang: null,   // tới trắng label if applicable
    }));
    this.phase = 'waiting';
    this.currentPlayerIndex = 0;
    this.lastPlay = null;        // { playerId, play } — game logic (null after trick reset)
    this.tableCards = null;      // { playerId, play } — display (persists until new play)
    this.trickWinner = null;     // name of player who won last trick (for display)
    this.trickHistory = [];      // all plays in the current trick [ {playerId, play} ]
    this.lastActiveIndex = -1;
    this.passCount = 0;
    this.winOrder = [];
    this.round = 0;
    this.firstRound = true;
    this.autoRestart = false; // set true when tới trắng detected → server auto-redeal
  }

  start() {
    this.round = 1;
    this._deal();
  }

  _deal() {
    this.phase = 'playing';
    this.firstRound = true;
    this.lastPlay = null;
    this.tableCards = null;
    this.trickWinner = null;
    this.trickHistory = [];
    this.lastActiveIndex = -1;
    this.passCount = 0;
    this.winOrder = [];
    this.autoRestart = false;

    const deck = shuffle(createDeck());
    const n = this.players.length;
    const perPlayer = Math.floor(52 / n);

    for (let i = 0; i < n; i++) {
      this.players[i].hand = sortTL(deck.slice(i * perPlayer, (i + 1) * perPlayer));
      this.players[i].status = 'active';
      this.players[i].place = null;
      this.players[i].chipDelta = 0;
      this.players[i].toiTrang = detectToiTrang(this.players[i].hand);
    }

    // Tới trắng: any player has an instant-win hand → auto-restart after announcement
    if (this.players.some(p => p.toiTrang)) {
      this.autoRestart = true;
    }

    // Find player with 3♠ — always leads first (even if someone has tới trắng)
    for (let i = 0; i < n; i++) {
      if (this.players[i].hand.some(c => c.rank === '3' && c.suit === 'spades')) {
        this.currentPlayerIndex = i;
        break;
      }
    }
  }

  handleAction(playerId, action) {
    if (this.phase !== 'playing') {
      if (action.type === 'newRound') {
        this.round++;
        this._deal();
        return {};
      }
      return { error: 'Game not in playing phase' };
    }

    const cur = this.players[this.currentPlayerIndex];
    if (!cur || cur.id !== playerId) return { error: 'Not your turn' };

    if (action.type === 'pass') {
      if (!this.lastPlay) return { error: 'Cannot pass on the first play' };
      cur.status = 'passed';
      this.passCount++;

      const activePlayers = this.players.filter(p => p.status === 'active');
      if (activePlayers.length <= 1) {
        this._resetRound();
        return {};
      }
      this._nextPlayer();
      return {};
    }

    if (action.type === 'play') {
      const selectedCards = action.cards;
      if (!selectedCards || selectedCards.length === 0) return { error: 'Select cards to play' };

      for (const sc of selectedCards) {
        if (!cur.hand.some(c => cardEqual(c, sc))) return { error: 'Invalid card selection' };
      }

      const play = classifyPlay(selectedCards);
      if (!play) return { error: 'Invalid combination' };

      // First play must include 3♠
      if (this.firstRound && !this.lastPlay) {
        if (!selectedCards.some(c => c.rank === '3' && c.suit === 'spades')) {
          return { error: 'First play must include 3♠' };
        }
      }

      if (!canBeat(play, this.lastPlay?.play)) {
        return { error: 'This combination does not beat the last play' };
      }

      // Remove played cards from hand
      for (const sc of selectedCards) {
        const idx = cur.hand.findIndex(c => cardEqual(c, sc));
        if (idx !== -1) cur.hand.splice(idx, 1);
      }

      // Fresh lead: clear history and start a new trick pile
      if (!this.lastPlay) this.trickHistory = [];
      this.trickHistory.push({ playerId, play });

      this.lastPlay   = { playerId, play };
      this.tableCards = { playerId, play };   // display — persists
      this.trickWinner = null;                // clear "won trick" label
      this.lastActiveIndex = this.currentPlayerIndex;
      this.firstRound = false;
      this.passCount = 0;
      // NOTE: passed players stay passed until _resetRound() — they cannot
      // re-enter the trick after passing, even if someone plays over them.

      // Check win
      if (cur.hand.length === 0) {
        cur.status = 'won';
        cur.place = this.winOrder.length + 1;
        this.winOrder.push(cur.id);

        const remaining = this.players.filter(p => p.status === 'active');
        if (remaining.length <= 1) {
          if (remaining.length === 1) {
            remaining[0].status = 'won';
            remaining[0].place = this.winOrder.length + 1;
            this.winOrder.push(remaining[0].id);
          }
          this.phase = 'ended';
          this._settleChips();
          return {};
        }
      }

      this._nextPlayer();
      return {};
    }

    return { error: 'Unknown action' };
  }

  _settleChips() {
    // Chip transfer: ranked payouts. Unit = startingChips / 10.
    // Scores by place (4p): 1st=+3, 2nd=+1, 3rd=-1, 4th=-3
    // Scores by place (3p): 1st=+2, 2nd=0, 3rd=-2
    // Scores by place (2p): 1st=+1, 2nd=-1
    const n = this.players.length;
    const unit = Math.round(this.startingChips / 10);
    const scoreByPlace = {
      2: [1, -1],
      3: [2, 0, -2],
      4: [3, 1, -1, -3],
    };
    const scores = scoreByPlace[n] || scoreByPlace[4];
    const sorted = [...this.players].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
    sorted.forEach((p, i) => {
      const delta = (scores[i] ?? -scores[0]) * unit;
      p.chipDelta = delta;
      p.chips = Math.max(0, p.chips + delta);
    });
  }

  _resetRound() {
    // Everyone passed — last player who played wins this trick and leads next
    const winner = this.players[this.lastActiveIndex];
    this.trickWinner = winner?.name || null;

    for (const p of this.players) {
      if (p.status === 'passed') p.status = 'active';
    }

    // Clear game-logic lastPlay (anyone can lead) but KEEP tableCards for display
    this.lastPlay = null;
    this.passCount = 0;
    this.currentPlayerIndex = this.lastActiveIndex;
  }

  _nextPlayer() {
    const n = this.players.length;
    let idx = (this.currentPlayerIndex + 1) % n;
    let tries = 0;
    while (tries < n) {
      if (this.players[idx].status === 'active') {
        this.currentPlayerIndex = idx;
        return;
      }
      idx = (idx + 1) % n;
      tries++;
    }
  }

  getStateForPlayer(playerId) {
    // Collect tới trắng announcements from any player
    const toiTrangAnnouncements = this.players
      .filter(p => p.toiTrang)
      .map(p => ({ name: p.name, label: p.toiTrang }));

    return {
      phase: this.phase,
      round: this.round,
      firstRound: this.firstRound,
      currentPlayer: this.players[this.currentPlayerIndex]?.id,

      // Game-logic lastPlay: null after trick reset → pass button disabled correctly
      lastPlay: this.lastPlay
        ? { playerId: this.lastPlay.playerId, cards: this.lastPlay.play.cards, type: this.lastPlay.play.type }
        : null,

      // Display tableCards: persists on table until someone plays new cards
      tableCards: this.tableCards
        ? { playerId: this.tableCards.playerId, cards: this.tableCards.play.cards, type: this.tableCards.play.type }
        : null,

      // Who just won the trick (set during reset, cleared when new play made)
      trickWinner: this.trickWinner,

      // All plays in the current trick (oldest→newest), cleared when new trick starts
      trickHistory: this.trickHistory.map(({ playerId, play }) => ({
        playerId,
        cards: play.cards,
        type: play.type,
      })),

      toiTrangAnnouncements,
      winOrder: this.winOrder,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        chipDelta: this.phase === 'ended' ? p.chipDelta : null,
        cardCount: p.hand.length,
        hand: p.id === playerId ? p.hand : p.hand.map(() => ({ suit: 'hidden', rank: '?' })),
        status: p.status,
        place: p.place,
        toiTrang: p.toiTrang,
        isCurrentPlayer: p.id === this.players[this.currentPlayerIndex]?.id,
        isYou: p.id === playerId,
      })),
    };
  }
}

module.exports = TienLen;
module.exports.classifyPlay = classifyPlay;
module.exports.canBeat = canBeat;
module.exports.tlValue = tlValue;
module.exports.sortTL = sortTL;
