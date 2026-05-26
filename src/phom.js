/* ═══════════════════════════════════════════════════════════════════════════
   Phỏm (Tá Lả) — Northern Vietnamese card game
   Rules: Miền Bắc edition

   Card order (low → high): A(1) 2 3 4 5 6 7 8 9 10 J(11) Q(12) K(13)
   Phỏm ngang : 3+ cards of the SAME RANK  (any suits)
   Phỏm dọc  : 3+ cards of the SAME SUIT with CONSECUTIVE ranks
               A is always 1 (A-2-3 valid; K-A wrap NOT valid)

   Deal       : dealer gets 10 cards and discards first; others get 9.
   Turn order : counter-clockwise (index decrements).
   Round limit: 4 discards per player; in round 4 players must hạ first.
   Win (ù)    : hand empties (all cards in melds / discarded after laying down).
   Móm        : no melds at all → last place.
   Scoring    : sum of unmelded card values (A=1 … K=13); lowest wins.
   ═══════════════════════════════════════════════════════════════════════════ */

const { createDeck, shuffle } = require('./deck');

/* ── Rank helpers ─────────────────────────────────────────────────────────── */

/** Phỏm rank value: A=1 (lowest) … K=13 (highest), no wrap-around. */
function phomRankVal(rank) {
  const v = { A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,
              '9':9,'10':10, J:11, Q:12, K:13 };
  return v[rank] ?? 0;
}

/** Dead-point value for scoring: same as rank value. */
function cardPoints(card) {
  return phomRankVal(card.rank);
}

/* ── Meld validators ──────────────────────────────────────────────────────── */

function isSet(cards) {
  // Phỏm ngang: 3+ cards same rank, any suits
  return cards.length >= 3 && new Set(cards.map(c => c.rank)).size === 1;
}

function isRun(cards) {
  // Phỏm dọc: 3+ cards SAME SUIT, consecutive ranks (A=1 low, no wrap)
  if (cards.length < 3) return false;
  if (new Set(cards.map(c => c.suit)).size !== 1) return false; // ← SAME SUIT required
  const vals = cards.map(c => phomRankVal(c.rank)).sort((a, b) => a - b);
  if (new Set(vals).size !== vals.length) return false; // no duplicate ranks
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] !== vals[i - 1] + 1) return false;
  }
  return true;
}

function isMeld(cards) { return isSet(cards) || isRun(cards); }

/** Can 'newCard' extend an existing laid-down meld? */
function canExtendMeld(meld, newCard) {
  return isMeld([...meld, newCard]);
}

/** Does 'newCard' + any 2 cards from hand form a valid meld? */
function canFormMeldWith(hand, newCard) {
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      if (isMeld([newCard, hand[i], hand[j]])) return true;
    }
  }
  return false;
}

/* ── Best meld finder (bitmask DFS) ──────────────────────────────────────── */

/**
 * Find the combination of non-overlapping melds that minimises dead points.
 * Uses bitmask pre-computation + DFS; fast for ≤13 cards.
 */
function findBestMelds(hand) {
  const n = hand.length;
  if (n < 3) return [];

  // Pre-compute every valid 3/4/5-card meld (as a bitmask + card list)
  const validMelds = [];
  for (let mask = 0; mask < (1 << n); mask++) {
    const bits = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) bits.push(i);
    if (bits.length < 3 || bits.length > 5) continue;
    const cards = bits.map(i => hand[i]);
    if (isMeld(cards)) validMelds.push({ mask, cards });
  }

  let bestDead = hand.reduce((s, c) => s + cardPoints(c), 0);
  let bestMelds = [];

  function dfs(usedMask, currentMelds, meldStart) {
    const dead = hand.reduce((s, c, i) =>
      (usedMask & (1 << i)) ? s : s + cardPoints(c), 0);
    if (dead < bestDead) {
      bestDead = dead;
      bestMelds = currentMelds.map(m => [...m]);
    }
    if (dead === 0) return;

    for (let mi = meldStart; mi < validMelds.length; mi++) {
      const { mask, cards } = validMelds[mi];
      if (mask & usedMask) continue; // overlaps
      dfs(usedMask | mask, [...currentMelds, cards], mi + 1);
    }
  }

  dfs(0, [], 0);
  return bestMelds;
}

function countDeadPoints(hand) {
  const best = findBestMelds(hand);
  const used = new Set(best.flat());
  return hand.filter(c => !used.has(c)).reduce((s, c) => s + cardPoints(c), 0);
}

/* ── Phỏm Game ────────────────────────────────────────────────────────────── */

const DISCARD_LIMIT = 4; // each player discards at most 4 times per round

class Phom {
  constructor(players, { startingChips = 1000 } = {}) {
    this.startingChips = startingChips;
    this.players = players.map((p, i) => ({
      id: p.id,
      name: p.name,
      hand: [],
      chips: startingChips,
      chipDelta: 0,
      melds: [],       // auto-detected at end; hidden during play
      deadCards: [],   // hand cards not covered by any meld (populated at _startSettling)
      discardCount: 0,
      status: 'active',
      points: 0,
      isMom: false,
      isDealer: i === 0,
    }));
    this.deck         = [];
    this.discard      = [];
    this.discardsByPlayer = {};
    this.phase        = 'waiting';
    this.currentPlayerIndex = 0;
    this.drewCard     = false;
    this.ateDiscard   = false;
    this.round        = 0;
    this.lastWinnerId    = null;
    this.lastDiscarderId = null;
    this.uWinner         = null;
    // Settling phase
    this.settleOrder = [];   // playerIds in reveal order (dealer first, then CCW)
    this.settleIndex = 0;    // who is currently settling (0 = dealer, skipped for gửi)
  }

  start() {
    this.round = 1;
    this._deal();
  }

  _deal() {
    this.phase    = 'discard';
    this.drewCard = true;      // dealer starts in discard phase
    this.ateDiscard  = false;
    this.discard     = [];
    this.uWinner     = null;
    this.settleOrder = [];
    this.settleIndex = 0;
    this.discardsByPlayer = {};
    for (const p of this.players) this.discardsByPlayer[p.id] = [];

    const deck = shuffle(createDeck());
    const dealerIdx = this.players.findIndex(p => p.isDealer);
    const n = this.players.length;

    for (let i = 0; i < n; i++) {
      const isDealer = this.players[i].isDealer;
      this.players[i].hand         = deck.splice(0, isDealer ? 10 : 9);
      this.players[i].melds        = [];
      this.players[i].deadCards    = [];
      this.players[i].discardCount = 0;
      this.players[i].status       = 'active';
      this.players[i].points       = 0;
      this.players[i].isMom        = false;
    }
    this.deck = deck;
    this.currentPlayerIndex = dealerIdx >= 0 ? dealerIdx : 0;
  }

  handleAction(playerId, action) {
    /* ── New round (ended) ──────────────────────────────────────────────── */
    if (this.phase === 'ended') {
      if (action.type === 'newRound') {
        this.round++;
        const winnerIdx = this.lastWinnerId
          ? this.players.findIndex(p => p.id === this.lastWinnerId)
          : (this.currentPlayerIndex + 1) % this.players.length;
        const nextDealerIdx = winnerIdx >= 0 ? winnerIdx : 0;
        this.players.forEach((p, i) => { p.isDealer = i === nextDealerIdx; });
        this.currentPlayerIndex = nextDealerIdx;
        this._deal();
        return {};
      }
      return { error: 'Trò chơi đã kết thúc' };
    }

    /* ── Settling phase — gửi quân in reveal order ──────────────────────── */
    if (this.phase === 'settling') {
      const currentSettlerId = this.settleOrder[this.settleIndex];
      if (!currentSettlerId || playerId !== currentSettlerId)
        return { error: 'Chưa đến lượt gửi của bạn' };
      const settler = this.players.find(p => p.id === currentSettlerId);

      if (action.type === 'guiQuan') {
        const { targetPlayerId, meldIndex, cards } = action;
        // May only gửi to players who appeared BEFORE this one in settleOrder
        const targetPos = this.settleOrder.indexOf(targetPlayerId);
        if (targetPos < 0 || targetPos >= this.settleIndex)
          return { error: 'Chỉ gửi vào phỏm của người đã lộ trước bạn' };
        const target = this.players.find(p => p.id === targetPlayerId);
        if (!target?.melds?.[meldIndex]) return { error: 'Không tìm thấy phỏm' };
        const addCards = this._findInCards(settler.deadCards, cards);
        if (!addCards) return { error: 'Bạn không có những quân bài này' };
        const newMeld = [...target.melds[meldIndex], ...addCards];
        if (!isMeld(newMeld)) return { error: 'Gửi quân không hợp lệ — phỏm sau khi gửi phải hợp lệ' };
        for (const c of addCards) {
          const idx = settler.deadCards.findIndex(h => h.rank === c.rank && h.suit === c.suit);
          if (idx !== -1) settler.deadCards.splice(idx, 1);
        }
        target.melds[meldIndex] = newMeld;
        return {};
      }

      if (action.type === 'doneSettling') {
        this.settleIndex++;
        if (this.settleIndex >= this.settleOrder.length) this._finalize();
        return {};
      }

      return { error: 'Hành động không hợp lệ trong giai đoạn gửi quân' };
    }

    const cur = this.players[this.currentPlayerIndex];
    if (!cur || cur.id !== playerId) return { error: 'Chưa đến lượt bạn (Not your turn)' };

    /* ── DRAW phase ─────────────────────────────────────────────────────── */
    if (this.phase === 'draw') {
      if (action.type === 'draw') {
        if (this.deck.length === 0) { this._startSettling(); return {}; }
        cur.hand.push(this.deck.pop());
        this.drewCard = true;
        this.phase = 'discard';
        return {};
      }

      if (action.type === 'takeDiscard') {
        if (this.discard.length === 0) return { error: 'Không có bài để ăn' };
        const top = this.discard[this.discard.length - 1];
        // Melds are hidden during play, so only allow ăn if hand + card makes a NEW meld
        if (!canFormMeldWith(cur.hand, top))
          return { error: 'Chỉ ăn được khi tạo được phỏm mới với bài trên tay — hãy bốc từ nọc' };
        this.discard.pop();
        cur.hand.push(top);
        this.drewCard   = true;
        this.ateDiscard = true;
        this.phase = 'discard';
        return {};
      }

      return { error: 'Hãy bốc bài hoặc ăn bài đã đánh' };
    }

    /* ── DISCARD phase ───────────────────────────────────────────────────── */
    if (this.phase === 'discard') {
      if (action.type !== 'discard') return { error: 'Hãy đánh một quân bài' };

      const card = action.card;
      const idx = cur.hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
      if (idx === -1) return { error: 'Quân bài không có trong tay' };

      cur.hand.splice(idx, 1);
      this.discard.push(card);
      this.lastDiscarderId = cur.id;
      (this.discardsByPlayer[cur.id] ||= []).push(card);
      cur.discardCount++;
      this.drewCard   = false;
      this.ateDiscard = false;

      // Ù — hand emptied by discarding the last card
      if (cur.hand.length === 0) {
        cur.status = 'won';
        this.uWinner = cur.id;
        this._startSettling();
        return {};
      }

      // All players used up their discard quota OR deck exhausted
      if (this.players.every(p => p.discardCount >= DISCARD_LIMIT)) {
        this._startSettling();
        return {};
      }
      if (this.deck.length === 0) { this._startSettling(); return {}; }

      this._nextPlayer();
      return {};
    }

    return { error: 'Hành động không hợp lệ' };
  }

  /** Find cards in an arbitrary array (used for hand and deadCards). */
  _findInCards(arr, targets) {
    const result = [];
    const temp   = [...arr];
    for (const c of targets) {
      const i = temp.findIndex(h => h.rank === c.rank && h.suit === c.suit);
      if (i === -1) return null;
      result.push(temp.splice(i, 1)[0]);
    }
    return result;
  }

  /** Counter-clockwise: index decrements (wraps). */
  _nextPlayer() {
    const n = this.players.length;
    this.currentPlayerIndex = (this.currentPlayerIndex - 1 + n) % n;
    this.phase      = 'draw';
    this.drewCard   = false;
    this.ateDiscard = false;
  }

  /**
   * End the draw/discard phase — auto-detect melds for every player,
   * then enter the `settling` phase where players gửi quân in turn order.
   * Settle order: dealer first (reveals but can't gửi), then counter-clockwise.
   */
  _startSettling() {
    const n = this.players.length;

    // Auto-detect melds and split each hand into melds + dead cards
    for (const p of this.players) {
      if (p.status === 'won') {
        p.melds     = [];
        p.deadCards = [];
        continue;
      }
      const best    = findBestMelds(p.hand);
      p.melds       = best;
      const tempHand = [...p.hand];
      for (const meld of best) {
        for (const card of meld) {
          const idx = tempHand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
          if (idx !== -1) tempHand.splice(idx, 1);
        }
      }
      p.deadCards = tempHand;
    }

    // Settle order: dealer → counter-clockwise (dealerIdx-1, dealerIdx-2, …)
    const dealerIdx = this.players.findIndex(p => p.isDealer);
    this.settleOrder = [];
    for (let i = 0; i < n; i++) {
      this.settleOrder.push(this.players[(dealerIdx - i + n) % n].id);
    }
    // Start at index 1 — the dealer (index 0) cannot gửi to anyone
    this.settleIndex = 1;
    this.phase = 'settling';

    // Single-player edge case or nobody left to settle
    if (this.settleIndex >= n) this._finalize();
  }

  /** Called when all players have had their gửi turn. Compute final scores. */
  _finalize() {
    this.phase = 'ended';

    for (const p of this.players) {
      p.chipDelta = 0;
      if (p.status === 'won') { p.points = 0; p.isMom = false; continue; }
      p.points = p.deadCards.reduce((s, c) => s + cardPoints(c), 0);
      p.isMom  = p.melds.length === 0; // no phỏm at all = móm
    }

    if (this.uWinner) {
      this.lastWinnerId = this.uWinner;
    } else {
      const nonMom = this.players.filter(p => !p.isMom);
      if (nonMom.length > 0) {
        nonMom.sort((a, b) => a.points - b.points);
        this.lastWinnerId = nonMom[0].id;
      } else {
        const sorted = [...this.players].sort((a, b) => a.points - b.points);
        this.lastWinnerId = sorted[0].id;
      }
    }

    this._settleChips();
  }

  _settleChips() {
    const unit   = Math.round(this.startingChips / 10);
    const winner = this.players.find(p => p.id === this.lastWinnerId);
    if (!winner) return;

    for (const p of this.players) {
      if (p.id === winner.id) continue;
      const factor = (p.isMom ? 2 : 1) * (this.uWinner ? 2 : 1);
      const pay    = unit * factor;
      p.chipDelta       = -pay;
      p.chips           = Math.max(0, p.chips - pay);
      winner.chipDelta += pay;
      winner.chips     += pay;
    }
  }

  getStateForPlayer(playerId) {
    const isSettling = this.phase === 'settling';
    const isEnded    = this.phase === 'ended';
    const revealAll  = isSettling || isEnded;

    // During settling: "current player" is the active settler
    const cur = isSettling
      ? this.players.find(p => p.id === this.settleOrder[this.settleIndex])
      : this.players[this.currentPlayerIndex];

    const topDiscard = this.discard.length > 0 ? this.discard[this.discard.length - 1] : null;

    return {
      phase:  this.phase,
      round:  this.round,
      currentPlayer: cur?.id,
      deckCount:  this.deck.length,
      topDiscard:  revealAll ? null : topDiscard,
      discardsByPlayer: this.discardsByPlayer,
      lastWinnerId:    this.lastWinnerId,
      lastDiscarderId: this.lastDiscarderId,
      uWinner:         this.uWinner,
      discardLimit:    DISCARD_LIMIT,
      // Settling metadata
      settleOrder: this.settleOrder,
      settleIndex: this.settleIndex,
      players: this.players.map(p => ({
        id:          p.id,
        name:        p.name,
        chips:       p.chips,
        chipDelta:   isEnded ? p.chipDelta : null,
        // During play: own hand visible, others hidden
        // During settling/ended: everyone sees dead cards face-up
        hand:       revealAll
                      ? p.deadCards
                      : p.id === playerId ? p.hand
                      : p.hand.map(() => ({ suit: 'hidden', rank: '?' })),
        cardCount:  revealAll ? p.deadCards.length : p.hand.length,
        // Melds only shown at settling/ended
        melds:      revealAll ? p.melds : [],
        deadCards:  revealAll ? p.deadCards : [],
        discardCount: p.discardCount,
        status:     p.status,
        points:     isEnded ? p.points : null,
        isMom:      p.isMom,
        isDealer:   p.isDealer,
        isCurrentPlayer: p.id === cur?.id,
        isYou:      p.id === playerId,
      })),
      drewCard: (!isSettling && cur?.id === playerId) ? this.drewCard : undefined,
    };
  }
}

module.exports = Phom;
module.exports.isMeld      = isMeld;
module.exports.findBestMelds = findBestMelds;
module.exports.cardPoints  = cardPoints;
module.exports.phomRankVal = phomRankVal;
