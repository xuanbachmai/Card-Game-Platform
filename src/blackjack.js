/* ═══════════════════════════════════════════════════════════════════════════
   Blackjack — standard Western rules (6-deck shoe)

   Actions:  bet · hit · stand · double · split · newRound
   Split:    available on first 2 cards of identical rank (K+K yes, K+Q no); costs equal bet.
             Each split hand is played independently left-to-right.
             Split Aces receive one card each and auto-stand.
   Double:   first 2 cards of a hand only; one card then stand.
   Blackjack: natural 21 on first 2 non-split cards → 3:2 payout.
   Dealer:   hits until ≥ 17.
   ═══════════════════════════════════════════════════════════════════════════ */

const { createDeck, shuffle } = require('./deck');

/* ── Hand value ──────────────────────────────────────────────────────────── */
function handValue(cards) {
  let val = 0, aces = 0;
  for (const c of cards) {
    if (c.rank === 'A')                       { val += 11; aces++; }
    else if (['J','Q','K'].includes(c.rank))  val += 10;
    else                                      val += parseInt(c.rank);
  }
  while (val > 21 && aces > 0) { val -= 10; aces--; }
  return val;
}

function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function makeHand(cards, bet) {
  return { cards, bet, status: 'playing', result: null };
}

class Blackjack {
  constructor(players, { startingChips = 1000 } = {}) {
    this.startingChips = startingChips;
    this.players = players.map(p => ({
      id: p.id,
      name: p.name,
      chips: startingChips,
      hands: [],           // [{cards, bet, status, result}]
      activeHandIndex: 0,
      overallStatus: 'betting', // betting|ready|playing|done|out
    }));
    this.dealer = { hand: [], status: 'waiting' };
    this.deck   = [];
    this.phase  = 'betting';
    this.currentPlayerIndex = 0;
    this.round  = 0;
  }

  start() {
    this.round = 1;
    this._newRound();
  }

  _newRound() {
    this.phase = 'betting';
    this.deck  = shuffle([...createDeck(), ...createDeck(), ...createDeck(), ...createDeck(), ...createDeck(), ...createDeck()]);
    for (const p of this.players) {
      p.hands           = [];
      p.activeHandIndex = 0;
      p.overallStatus   = p.chips > 0 ? 'betting' : 'out';
    }
    this.dealer.hand   = [];
    this.dealer.status = 'waiting';
    this.currentPlayerIndex = 0;
  }

  /* active hand of current player */
  _curHand() {
    const p = this.players[this.currentPlayerIndex];
    return p?.hands[p.activeHandIndex] ?? null;
  }

  handleAction(playerId, action) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return { error: 'Player not found' };

    /* ── BETTING ──────────────────────────────────────────────────────── */
    if (this.phase === 'betting') {
      if (action.type === 'rebuy') {
        if (player.chips > 0) return { error: 'You still have chips' };
        player.chips        = this.startingChips;
        player.overallStatus = 'betting';
        return {};
      }
      if (action.type !== 'bet') return { error: 'Place your bet first' };
      if (player.overallStatus === 'out') return { error: 'Out of chips — click Rebuy first' };
      const amount = parseInt(action.amount);
      if (!amount || amount < 10 || amount > player.chips)
        return { error: `Invalid bet (min 10, max ${player.chips})` };
      player._pendingBet  = amount;
      player.chips       -= amount;
      player.overallStatus = 'ready';
      if (this.players.filter(p => p.overallStatus !== 'out').every(p => p.overallStatus === 'ready'))
        this._dealInitial();
      return {};
    }

    /* ── INSURANCE ───────────────────────────────────────────────────── */
    if (this.phase === 'insurance') {
      if (player.insuranceDecided) return { error: 'Already decided' };
      if (action.type === 'insurance-yes') {
        const maxInsurance = Math.floor(player.hands[0]?.bet / 2) || 0;
        if (player.chips < maxInsurance) return { error: 'Not enough chips for insurance' };
        player.chips       -= maxInsurance;
        player.insuranceBet = maxInsurance;
        player.insuranceDecided = true;
      } else if (action.type === 'insurance-no') {
        player.insuranceBet = 0;
        player.insuranceDecided = true;
      } else {
        return { error: 'Choose insurance-yes or insurance-no' };
      }
      // Once all active players have decided, resolve insurance
      const allDecided = this.players
        .filter(p => p.overallStatus !== 'out')
        .every(p => p.insuranceDecided);
      if (allDecided) this._resolveInsurance();
      return {};
    }

    /* ── PLAYING ──────────────────────────────────────────────────────── */
    if (this.phase === 'playing') {
      const cur = this.players[this.currentPlayerIndex];
      if (!cur || cur.id !== playerId) return { error: 'Not your turn' };
      const hand = this._curHand();
      if (!hand || hand.status !== 'playing') return { error: 'Cannot act' };

      switch (action.type) {

        case 'hit': {
          hand.cards.push(this.deck.pop());
          const v = handValue(hand.cards);
          if (v > 21)  { hand.status = 'busted'; this._advanceHand(); }
          else if (v === 21) { hand.status = 'stood'; this._advanceHand(); }
          break;
        }

        case 'stand': {
          hand.status = 'stood';
          this._advanceHand();
          break;
        }

        case 'double': {
          if (hand.cards.length !== 2) return { error: 'Double only on first 2 cards' };
          if (player.chips < hand.bet)  return { error: 'Not enough chips to double' };
          player.chips -= hand.bet;
          hand.bet     *= 2;
          hand.cards.push(this.deck.pop());
          hand.status = handValue(hand.cards) > 21 ? 'busted' : 'stood';
          this._advanceHand();
          break;
        }

        case 'split': {
          if (hand.cards.length !== 2) return { error: 'Split only on first 2 cards' };
          const [c1, c2] = hand.cards;
          // Standard rules: split only on same rank (Q+J cannot split even though both = 10)
          const sameRank = c1.rank === c2.rank;
          if (!sameRank) return { error: 'Can only split cards of the same rank' };
          if (player.chips < hand.bet)  return { error: 'Not enough chips to split' };
          if (player.hands.length >= 4) return { error: 'Maximum 4 hands (3 splits)' };

          player.chips -= hand.bet;

          // Split: first hand keeps c1 + new card; insert new hand with c2 + new card
          hand.cards = [c1, this.deck.pop()];
          const newHand = makeHand([c2, this.deck.pop()], hand.bet);
          player.hands.splice(player.activeHandIndex + 1, 0, newHand);

          // Split aces: each gets exactly one card, then auto-stand
          if (c1.rank === 'A') {
            hand.status   = 'stood'; // no more cards on split ace
            newHand.status = 'stood';
            this._advanceHand();
          } else {
            // Check if the new first card gives 21 → auto-stand
            if (handValue(hand.cards) === 21) {
              hand.status = 'stood';
              this._advanceHand();
            }
          }
          break;
        }

        default: return { error: 'Unknown action' };
      }
      return {};
    }

    /* ── ENDED ────────────────────────────────────────────────────────── */
    if (this.phase === 'ended') {
      if (action.type === 'newRound') { this.round++; this._newRound(); return {}; }
    }

    return { error: 'Invalid action for current phase' };
  }

  _dealInitial() {
    // Give each ready player one hand with their pending bet
    for (const p of this.players) {
      if (p.overallStatus !== 'ready') continue;
      p.hands = [makeHand([], p._pendingBet)];
      p.activeHandIndex = 0;
      p.overallStatus = 'playing';
      p.insuranceBet = 0;        // insurance side-bet amount
      p.insuranceDecided = false; // has this player answered the insurance prompt?
    }

    // Interleaved deal: 2 cards each
    for (let i = 0; i < 2; i++) {
      for (const p of this.players) {
        if (p.hands.length > 0) p.hands[0].cards.push(this.deck.pop());
      }
      this.dealer.hand.push(this.deck.pop());
    }

    // Check naturals
    for (const p of this.players) {
      const h = p.hands[0];
      if (!h) continue;
      if (isBlackjack(h.cards)) { h.status = 'blackjack'; p.overallStatus = 'done'; }
    }

    // Insurance: offer when dealer's upcard is an Ace
    const dealerUpcard = this.dealer.hand[0];
    if (dealerUpcard && dealerUpcard.rank === 'A') {
      this.phase = 'insurance';
      // Players who have busted/blackjack already are auto-decided (no insurance needed)
      for (const p of this.players) {
        if (p.overallStatus === 'done' || p.overallStatus === 'out') {
          p.insuranceDecided = true;
        }
      }
      return;
    }

    this.phase = 'playing';
    this.currentPlayerIndex = 0;
    this._skipToActivePlayer();
  }

  _resolveInsurance() {
    const dealerBJ = isBlackjack(this.dealer.hand);
    for (const p of this.players) {
      if (p.insuranceBet > 0) {
        if (dealerBJ) {
          // Insurance pays 2:1 — player gets back 3× the insurance bet
          p.chips += p.insuranceBet * 3;
        }
        // If no dealer BJ, insurance bet is already deducted — nothing to do
      }
    }

    if (dealerBJ) {
      // Resolve whole round now — dealer blackjack beats everyone except player BJ (push)
      this._resolveRound();
      return;
    }

    // No dealer BJ — proceed to normal play
    this.phase = 'playing';
    this.currentPlayerIndex = 0;
    this._skipToActivePlayer();
  }

  /* Move to next unplayed hand, or next player, or dealer */
  _advanceHand() {
    const p = this.players[this.currentPlayerIndex];
    if (!p) { this._dealerTurn(); return; }

    // Look for next hand of this player that still needs playing
    for (let hi = p.activeHandIndex + 1; hi < p.hands.length; hi++) {
      if (p.hands[hi].status === 'playing') {
        p.activeHandIndex = hi;
        return; // stay on same player, new hand
      }
    }

    // All hands of this player done
    p.overallStatus = 'done';
    this.currentPlayerIndex++;
    this._skipToActivePlayer();
  }

  _skipToActivePlayer() {
    while (this.currentPlayerIndex < this.players.length) {
      const p = this.players[this.currentPlayerIndex];
      if (p.overallStatus === 'playing') {
        // Find their first unplayed hand
        p.activeHandIndex = p.hands.findIndex(h => h.status === 'playing');
        if (p.activeHandIndex !== -1) return;
      }
      this.currentPlayerIndex++;
    }
    this._dealerTurn();
  }

  _dealerTurn() {
    this.phase = 'dealer';
    while (handValue(this.dealer.hand) < 17) this.dealer.hand.push(this.deck.pop());
    const dv = handValue(this.dealer.hand);
    this.dealer.status = dv > 21 ? 'busted' : 'stood';
    this._resolveRound();
  }

  _resolveRound() {
    this.phase = 'ended';
    const dv      = handValue(this.dealer.hand);
    const dealerBJ = isBlackjack(this.dealer.hand);

    for (const p of this.players) {
      if (p.overallStatus === 'out') continue;
      for (const hand of p.hands) {
        const pv = handValue(hand.cards);
        const pBJ = hand.status === 'blackjack';

        if (hand.status === 'busted') {
          hand.result = 'bust';
          continue;
        }
        if (pBJ) {
          if (dealerBJ) { hand.result = 'push';      p.chips += hand.bet; }
          else          { hand.result = 'blackjack';  p.chips += Math.floor(hand.bet * 2.5); }
          continue;
        }
        if (dealerBJ) {
          hand.result = 'loss';
          continue;
        }
        if (this.dealer.status === 'busted') { hand.result = 'win';  p.chips += hand.bet * 2; }
        else if (pv > dv)                    { hand.result = 'win';  p.chips += hand.bet * 2; }
        else if (pv === dv)                  { hand.result = 'push'; p.chips += hand.bet; }
        else                                 { hand.result = 'loss'; }
      }
    }
  }

  getStateForPlayer(playerId) {
    const playing    = this.phase === 'playing';
    const insurance  = this.phase === 'insurance';
    // Hide dealer's hole card during playing and insurance phases
    const hiddenHole = playing || insurance;
    const dealerHand = hiddenHole
      ? [this.dealer.hand[0], { suit: 'hidden', rank: '?' }]
      : this.dealer.hand;

    const curPlayer = playing ? this.players[this.currentPlayerIndex] : null;

    const me = this.players.find(p => p.id === playerId);

    return {
      phase: this.phase,
      round: this.round,
      currentPlayer: curPlayer?.id ?? null,
      // Insurance info for the client
      insuranceOpen:    insurance,
      myInsuranceBet:   me?.insuranceBet ?? 0,
      myInsuranceMax:   Math.floor((me?.hands[0]?.bet ?? 0) / 2),
      myInsuranceDecided: me?.insuranceDecided ?? false,
      dealer: {
        hand:   dealerHand,
        value:  hiddenHole ? handValue([this.dealer.hand[0]]) : handValue(this.dealer.hand),
        status: this.dealer.status,
      },
      players: this.players.map(p => {
        const activeHand = p.hands[p.activeHandIndex] ?? p.hands[0];
        return {
          id:              p.id,
          name:            p.name,
          chips:           p.chips,
          overallStatus:   p.overallStatus,
          activeHandIndex: p.activeHandIndex,
          insuranceDecided: p.insuranceDecided ?? false,
          hands:           p.hands.map(h => ({
            cards:  h.cards,
            bet:    h.bet,
            value:  handValue(h.cards),
            status: h.status,
            result: h.result,
          })),
          /* convenience aliases for backward-compat with simple renders */
          hand:   activeHand?.cards ?? [],
          value:  handValue(activeHand?.cards ?? []),
          bet:    activeHand?.bet ?? 0,
          status: activeHand?.status ?? p.overallStatus,
          result: activeHand?.result ?? null,
          isCurrentPlayer: p.id === curPlayer?.id,
          isYou:           p.id === playerId,
          /* Split availability flag */
          canSplit: (() => {
            const ah = activeHand;
            if (!ah || ah.cards.length !== 2) return false;
            const [c1, c2] = ah.cards;
            return c1.rank === c2.rank && p.chips >= ah.bet && p.hands.length < 4;
          })(),
        };
      }),
    };
  }
}

module.exports = Blackjack;
