/* ═══════════════════════════════════════════════════════════════════════════
   Xì Dách (Vietnamese Blackjack / Xì Lát)
   Target: closest to 21 without going over.

   Card values
     2–10  → face value
     J/Q/K → 10 pts each
     A     → 11, reduced to 1 if needed to avoid bust

   Phase 1 — naturals (first 2 cards only)
     Xì Bàn : AA              → highest natural, pays 3× bet
     Xì Dách: A + 10/J/Q/K   → 21 in 2 cards, pays 2× bet
     If dealer has natural → dealer wins all (except players with equal/higher)

   Phase 2 — drawing (Bốc / Dằn)
     Must reach ≥ 16 before standing ("đủ tuổi").
     Standing below 16 = "Dằn Non" → auto-lose when dealer checks.
     Over 21 = busted (Quắc).
     5 cards ≤ 21 = "Ngũ Linh" → beats all except another Ngũ Linh
       (lower value wins between two Ngũ Linh).

   Dealer draws until value ≥ 16, then compares with all players.
   ═══════════════════════════════════════════════════════════════════════════ */

const { createDeck, shuffle } = require('./deck');

/* ── Hand value ──────────────────────────────────────────────────────────── */

function handValue(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.rank === 'A')                              { total += 11; aces++; }
    else if (['J','Q','K'].includes(c.rank))         total += 10;
    else                                             total += parseInt(c.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBusted(hand)   { return handValue(hand) > 21; }
function isNguLinh(hand)  { return hand.length === 5 && handValue(hand) <= 21; }

/* ── Naturals ────────────────────────────────────────────────────────────── */

function naturalName(hand) {
  if (hand.length !== 2) return null;
  if (hand.some(c => c.suit === 'hidden')) return null;
  const bothAces = hand.every(c => c.rank === 'A');
  if (bothAces) return 'Xì Bàn';
  const hasAce  = hand.some(c => c.rank === 'A');
  const hasTen  = hand.some(c => ['10','J','Q','K'].includes(c.rank));
  if (hasAce && hasTen) return 'Xì Dách';
  return null;
}

function naturalRank(name) {
  if (name === 'Xì Bàn')  return 2;
  if (name === 'Xì Dách') return 1;
  return 0;
}

/* ── XiDach Game ─────────────────────────────────────────────────────────── */

class XiDach {
  constructor(players, { startingChips = 1000 } = {}) {
    this.startingChips = startingChips;
    this.players = players.map(p => ({
      id: p.id,
      name: p.name,
      hand: [],
      bet: 0,
      chips: startingChips,
      // betting | ready | playing | stood | danNon | busted | nguLinh | xiBan | xiDach
      // xi-win | xi-lose | push-nat
      status: 'betting',
      result: null,    // win | lose | push
      resultAmt: 0,
    }));
    this.dealer = { hand: [], status: 'waiting' };
    this.deck   = [];
    this.phase  = 'betting'; // betting | playing | ended
    this.currentPlayerIndex = 0;
    this.round  = 0;
  }

  start() { this.round = 1; this._newRound(); }

  _newRound() {
    this.phase = 'betting';
    this.deck  = shuffle(createDeck());
    for (const p of this.players) {
      p.hand = []; p.bet = 0; p.status = 'betting';
      p.result = null; p.resultAmt = 0;
    }
    this.dealer.hand   = [];
    this.dealer.status = 'waiting';
    this.currentPlayerIndex = 0;
  }

  handleAction(playerId, action) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };

    /* ── Betting ──────────────────────────────────────────────────────── */
    if (this.phase === 'betting') {
      if (action.type === 'rebuy') {
        if (player.chips > 0) return { error: 'Bạn vẫn còn chip' };
        player.chips  = this.startingChips;
        player.status = 'betting';
        return {};
      }
      if (action.type !== 'bet') return { error: 'Đặt cược trước (Place bet first)' };
      if (player.chips === 0)  return { error: 'Hết chip — nhấn Rebuy để mua lại' };
      const amount = parseInt(action.amount);
      if (!amount || amount < 10 || amount > player.chips)
        return { error: `Cược không hợp lệ (min 10, max ${player.chips})` };
      player.bet    = amount;
      player.chips -= amount;
      player.status = 'ready';
      if (this.players.every(p => p.status === 'ready')) this._dealInitial();
      return {};
    }

    /* ── Playing ──────────────────────────────────────────────────────── */
    if (this.phase === 'playing') {
      const cur = this.players[this.currentPlayerIndex];
      if (!cur || cur.id !== playerId) return { error: 'Chưa đến lượt bạn (Not your turn)' };
      if (player.status !== 'playing')  return { error: 'Không thể hành động' };

      if (action.type === 'boc') {   // draw
        player.hand.push(this.deck.pop());
        const val = handValue(player.hand);
        if (isNguLinh(player.hand)) {
          player.status = 'nguLinh';
          this._nextPlayer();
        } else if (val > 21) {
          player.status = 'busted';
          this._nextPlayer();
        }
        // else: player can keep drawing (or stand)
        return {};
      }

      if (action.type === 'dan') {   // stand
        player.status = handValue(player.hand) < 16 ? 'danNon' : 'stood';
        this._nextPlayer();
        return {};
      }

      return { error: 'Hành động không hợp lệ' };
    }

    /* ── Ended ────────────────────────────────────────────────────────── */
    if (this.phase === 'ended') {
      if (action.type === 'newRound') { this.round++; this._newRound(); return {}; }
    }

    return { error: 'Không đúng lượt' };
  }

  _dealInitial() {
    this.phase = 'playing';
    // Interleaved deal: each player then dealer, twice
    for (let i = 0; i < 2; i++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
      this.dealer.hand.push(this.deck.pop());
    }

    const dealerNat = naturalName(this.dealer.hand);

    // Classify each player based on Phase 1 naturals
    for (const p of this.players) {
      const pNat = naturalName(p.hand);
      if (dealerNat) {
        // Dealer has natural — compare ranks
        const dr = naturalRank(dealerNat);
        const pr = naturalRank(pNat);
        if (!pNat)       p.status = 'xi-lose';
        else if (pr > dr) p.status = 'xi-win';
        else if (pr === dr) p.status = 'push-nat';
        else              p.status = 'xi-lose';
      } else {
        // No dealer natural
        if      (pNat === 'Xì Bàn')  p.status = 'xiBan';
        else if (pNat === 'Xì Dách') p.status = 'xiDach';
        else                          p.status = 'playing';
      }
    }

    if (dealerNat) {
      // Dealer natural: skip player turns, resolve immediately
      this.dealer.status = 'natural';
      this._resolve();
      return;
    }

    // Advance to first player who needs to act
    this.currentPlayerIndex = -1;
    this._nextPlayer();
  }

  _nextPlayer() {
    const n = this.players.length;
    let next = this.currentPlayerIndex + 1;
    while (next < n) {
      if (this.players[next].status === 'playing') {
        this.currentPlayerIndex = next;
        return;
      }
      next++;
    }
    // All players done → dealer draws
    this._dealerDraw();
  }

  _dealerDraw() {
    this.dealer.status = 'drawing';
    while (handValue(this.dealer.hand) < 16) {
      this.dealer.hand.push(this.deck.pop());
    }
    this.dealer.status = 'stood';
    this._resolve();
  }

  _resolve() {
    const dVal      = handValue(this.dealer.hand);
    const dNat      = naturalName(this.dealer.hand);
    const dBust     = dVal > 21;
    const dNguLinh  = isNguLinh(this.dealer.hand);

    for (const p of this.players) {
      const pVal     = handValue(p.hand);
      const pNat     = naturalName(p.hand);

      /* Phase-1 natural resolutions */
      if (p.status === 'xi-lose') {
        p.result = 'lose'; p.resultAmt = -p.bet;
        continue;
      }
      if (p.status === 'push-nat') {
        p.result = 'push'; p.resultAmt = 0; p.chips += p.bet;
        continue;
      }
      if (p.status === 'xi-win') {
        p.result = 'win';
        p.resultAmt = pNat === 'Xì Bàn' ? p.bet * 3 : p.bet * 2;
        p.chips += p.bet + p.resultAmt;
        continue;
      }
      if (p.status === 'xiBan') {
        p.result = 'win'; p.resultAmt = p.bet * 3; p.chips += p.bet + p.resultAmt;
        continue;
      }
      if (p.status === 'xiDach') {
        p.result = 'win'; p.resultAmt = p.bet * 2; p.chips += p.bet + p.resultAmt;
        continue;
      }

      /* Phase-2 resolutions */
      if (p.status === 'danNon' || p.status === 'busted') {
        p.result = 'lose'; p.resultAmt = -p.bet;
        continue;
      }

      // Ngũ Linh
      if (dNguLinh && isNguLinh(p.hand)) {
        if      (pVal < dVal) { p.result = 'win';  p.resultAmt = p.bet * 2; p.chips += p.bet + p.resultAmt; }
        else if (pVal === dVal) { p.result = 'push'; p.resultAmt = 0; p.chips += p.bet; }
        else                  { p.result = 'lose'; p.resultAmt = -p.bet; }
        continue;
      }
      if (isNguLinh(p.hand)) {
        p.result = 'win'; p.resultAmt = p.bet * 2; p.chips += p.bet + p.resultAmt; continue;
      }
      if (dNguLinh) {
        p.result = 'lose'; p.resultAmt = -p.bet; continue;
      }

      // Standard comparison
      if (dBust)       { p.result = 'win';  p.resultAmt = p.bet;  p.chips += p.bet * 2; continue; }
      if (pVal > dVal) { p.result = 'win';  p.resultAmt = p.bet;  p.chips += p.bet * 2; continue; }
      if (pVal < dVal) { p.result = 'lose'; p.resultAmt = -p.bet; continue; }
      /* equal */        p.result = 'push'; p.resultAmt = 0; p.chips += p.bet;
    }

    this.phase = 'ended';
  }

  getStateForPlayer(playerId) {
    const ended = this.phase === 'ended';
    // Hide dealer's second card until game ends (keep suspense)
    const dealerHand = ended
      ? this.dealer.hand
      : this.dealer.hand.map((c, i) => i === 1 ? { suit: 'hidden', rank: '?' } : c);
    const dealerVal  = ended ? handValue(this.dealer.hand) : '?';

    return {
      phase: this.phase,
      round: this.round,
      currentPlayer: this.players[this.currentPlayerIndex]?.id,
      dealer: {
        hand:     dealerHand,
        value:    dealerVal,
        natural:  ended ? naturalName(this.dealer.hand) : null,
        nguLinh:  ended ? isNguLinh(this.dealer.hand)  : false,
        busted:   ended ? handValue(this.dealer.hand) > 21 : false,
        status:   this.dealer.status,
      },
      players: this.players.map(p => ({
        id:              p.id,
        name:            p.name,
        chips:           p.chips,
        bet:             p.bet,
        hand:            p.hand,
        value:           handValue(p.hand),
        natural:         naturalName(p.hand),
        nguLinh:         isNguLinh(p.hand),
        status:          p.status,
        result:          p.result,
        resultAmt:       p.resultAmt,
        isYou:           p.id === playerId,
        isCurrentPlayer: p.id === this.players[this.currentPlayerIndex]?.id,
      })),
    };
  }
}

module.exports = XiDach;
