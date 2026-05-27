/* ── Session persistence ─────────────────────────────────────────────────── */
let sessionId = localStorage.getItem('bat_ma_session');
if (!sessionId) {
  sessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).substr(2) + Date.now().toString(36);
  localStorage.setItem('bat_ma_session', sessionId);
}

/* ── State ───────────────────────────────────────────────────────────────── */
const socket = io();
const state = {
  myId: null, myName: '', roomCode: null,
  isHost: false, gameType: null, gameState: null,
  selectedCards: [],
  prevHandCount: {},
  betSelection: 0,   // current chip-stack bet amount (resets each turn)
  deposit: 1000,     // host-set starting chips for BJ/Poker
  dealRound: 0,      // last round we triggered the deal animation for
  pendingDealAnim: false, // true during the frames where all cards should animate
  dealInProgress: false,  // true for the full animation window — suppresses mid-deal re-renders
  queuedGameState: null,  // last game-state received while dealInProgress; rendered after animation
  phomHandOrder: [],      // Phỏm: user's preferred card order (array of rank+suit keys)
  prevTableKey:   '',     // TienLen: fingerprint of last rendered tableCards (to detect new plays)
  prevDiscardKey: '',     // Phỏm: fingerprint of last rendered topDiscard
  tlSorted:       false,  // TienLen: whether hand is currently sorted
  tlOriginalHand: [],     // TienLen: original dealt order
  tlHandKey:      '',     // TienLen: fingerprint to detect new deal
  roundHistory:   [],     // [{round, winners:[{name,result,chipDelta}]}]
  lastRecordedRound: 0,   // prevents double-recording the same round
  needsReLayout: false,   // set true when a resize fires during dealInProgress
  savedChips: parseInt(localStorage.getItem('bat_ma_chips')) || null,
  leaderboard: [],        // [{game, result, chipDelta, round}]
};

/* Module-level fan drag state (pointer drag-to-reorder) */
let _fanDrag = null;

/* Cross-seat GUI drag — for gửi quân in settling phase */
let _guiDrag = null;   // { card: {rank,suit} }
let _guiGhost = null;  // floating card element

function _startGuiDrag(card, e) {
  _guiDrag  = { card };
  _guiGhost = makeCard(card, { sm: false });
  Object.assign(_guiGhost.style, {
    position: 'fixed', zIndex: '9999', pointerEvents: 'none',
    transform: 'rotate(-6deg) scale(1.12)', opacity: '0.88',
    transition: 'none',
    left: (e.clientX - 32) + 'px', top: (e.clientY - 55) + 'px',
  });
  document.body.appendChild(_guiGhost);
  document.querySelectorAll('.meld-drop-zone').forEach(m => m.classList.add('meld-drop-active'));
}

document.addEventListener('pointermove', e => {
  if (!_guiDrag || !_guiGhost) return;
  _guiGhost.style.left = (e.clientX - 32) + 'px';
  _guiGhost.style.top  = (e.clientY - 55) + 'px';
  // Hit-test: briefly hide ghost to find element underneath
  _guiGhost.style.visibility = 'hidden';
  const under = document.elementFromPoint(e.clientX, e.clientY);
  _guiGhost.style.visibility = '';
  const meldRow = under?.closest('[data-meld-target]');
  document.querySelectorAll('.meld-drop-hover').forEach(m => m.classList.remove('meld-drop-hover'));
  if (meldRow) meldRow.classList.add('meld-drop-hover');
});

document.addEventListener('pointerup', e => {
  if (!_guiDrag) return;
  const card = _guiDrag.card;
  _guiDrag = null;
  if (_guiGhost) { _guiGhost.remove(); _guiGhost = null; }
  document.querySelectorAll('.meld-drop-hover').forEach(m => m.classList.remove('meld-drop-hover'));
  document.querySelectorAll('.meld-drop-zone').forEach(m => m.classList.remove('meld-drop-active'));
  // Check drop target
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const meldRow = under?.closest('[data-meld-target]');
  if (meldRow) {
    const targetPlayerId = meldRow.dataset.targetPlayerId;
    const meldIndex = parseInt(meldRow.dataset.meldIndex, 10);
    emit('game-action', { type: 'guiQuan', targetPlayerId, meldIndex, cards: [card] });
    state.selectedCards = [];
  }
});

/* ── Constants ───────────────────────────────────────────────────────────── */
const SUIT_SYM  = { spades:'♠', clubs:'♣', diamonds:'♦', hearts:'♥' };
const RED_SUITS = new Set(['hearts','diamonds']);
const GAME_NAMES = { blackjack:'Blackjack', xidach:'Xì Dzách · Luật Việt', poker:'Poker', tienlen:'Tiến Lên', phom:'Phỏm · Tá Lả' };

/* Seat angles are now computed dynamically via evenAngles() — no hardcoded arrays needed */

/* ── Card building — Year of the Horse style ─────────────────────────────── */

/* Painterly SVG suit glyphs (matching horse-cards.jsx SuitGlyph) */
function suitSvg(suit, size = 14) {
  const red = '#b8252b', blk = '#1a1410';
  const fill = (suit === 'hearts' || suit === 'diamonds') ? red : blk;
  const paths = {
    spades:   `<path d="M12 2 C 6 9, 2 13, 2 17 C 2 20, 5 22, 8 21 C 10 20.5, 11 19, 11 17 L 10 22 L 14 22 L 13 17 C 13 19, 14 20.5, 16 21 C 19 22, 22 20, 22 17 C 22 13, 18 9, 12 2 Z" fill="${fill}"/>`,
    hearts:   `<path d="M12 21 C 4 15, 2 11, 2 7 C 2 4, 4 2, 7 2 C 9.5 2, 11 4, 12 6 C 13 4, 14.5 2, 17 2 C 20 2, 22 4, 22 7 C 22 11, 20 15, 12 21 Z" fill="${fill}"/>`,
    diamonds: `<path d="M12 2 L 22 12 L 12 22 L 2 12 Z" fill="${fill}"/>`,
    clubs:    `<circle cx="12" cy="6" r="4.4" fill="${fill}"/><circle cx="6.5" cy="14.5" r="4.4" fill="${fill}"/><circle cx="17.5" cy="14.5" r="4.4" fill="${fill}"/><path d="M10 14 L 11 22 L 13 22 L 14 14 Z" fill="${fill}"/>`,
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle">${paths[suit] || ''}</svg>`;
}

/* Chinese characters for face cards */
const FACE_HAN = { K: '王', Q: '后', J: '士' };

function makeCard(card, { sm = false, animate = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (sm ? ' sm' : '') + (animate ? ' deal-anim' : '');

  if (!card || card.suit === 'hidden') {
    el.classList.add('hidden');
    return el;
  }

  el.classList.add(RED_SUITS.has(card.suit) ? 'red' : 'black');

  const rank = card.rank;
  const suit = card.suit;
  const sym  = suitSvg(suit, sm ? 9 : 13);
  const symBig = suitSvg(suit, sm ? 16 : 24);
  const han  = FACE_HAN[rank];

  if (han) {
    // Face card — warrior portrait center
    el.innerHTML =
      `<div class="card-tl"><span class="card-rk">${rank}</span>${sym}</div>` +
      `<div class="card-warrior">
         <div class="card-warrior-inner">
           <div class="card-han">${han}</div>
           <div class="card-rank-full">${rank}</div>
         </div>
       </div>` +
      `<div class="card-br"><span class="card-rk">${rank}</span>${sym}</div>`;
  } else if (rank === 'A') {
    // Ace — large suit in center with decorative frame
    el.innerHTML =
      `<div class="card-tl"><span class="card-rk">${rank}</span>${sym}</div>` +
      `<div class="card-mid" style="font-size:${sm ? '18px' : '32px'}">${suitSvg(suit, sm ? 18 : 32)}</div>` +
      `<div class="card-br"><span class="card-rk">${rank}</span>${sym}</div>`;
  } else {
    // Number card — rank + suit
    el.innerHTML =
      `<div class="card-tl"><span class="card-rk">${rank}</span>${sym}</div>` +
      `<div class="card-mid">${symBig}</div>` +
      `<div class="card-br"><span class="card-rk">${rank}</span>${sym}</div>`;
  }
  return el;
}

/* ── Deal animation helpers ──────────────────────────────────────────────── */

/* Returns deal config for a player at the given angle on the oval.
   dx/dy = CSS translate from player's resting position BACK toward the center deck.
   rot   = starting card rotation.
   playerIdx / numPlayers drive the round-robin stagger. */
function getDealConfig(angleDeg, playerIdx, numPlayers) {
  const rad = angleDeg * Math.PI / 180;
  const dx  = Math.round(-300 * Math.cos(rad));
  const dy  = Math.round( 220 * Math.sin(rad));
  const rot = Math.round(-20  * Math.cos(rad)); // slight directional tilt
  return { dx, dy, rot, playerIdx, numPlayers };
}

/* Briefly shows a deck graphic in the center of the table during dealing. */
function showDealDeck() {
  const wrapper = document.querySelector('.table-wrapper');
  if (!wrapper) return;
  wrapper.querySelectorAll('.deal-deck').forEach(el => el.remove());
  const deck = document.createElement('div');
  deck.className = 'deal-deck';
  wrapper.appendChild(deck);
  setTimeout(() => { if (deck.parentNode) deck.remove(); }, 2600);
}

/* ── Fan rendering ───────────────────────────────────────────────────────── */
function renderFan(container, cards, { sm = false, selectable = false, selectedSet = null, animate = false, faceDown = false, dealConfig = null, onReorder = null, mustLeadKey = null } = {}) {
  container.innerHTML = '';
  const N = cards.length;
  if (!N) return;

  const cw = sm ? parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-w-sm')) || 44
                : parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-w'))    || 65;
  const spread  = Math.min(55, N * 5);
  // sm fans (opponent seats) are capped tighter so that when rotated 90° for side seats
  // the visual height stays within the table area even for large hands (Phỏm 9 cards).
  const maxStep = sm ? Math.min(cw * 0.50, 160 / N) : Math.min(cw * 0.68, 280 / N);
  const xStep   = maxStep;
  const totalW  = Math.round((N - 1) * xStep + cw);

  container.style.width  = totalW + 'px';
  container.style.height = '';

  // Insert indicator line (created once, shared across all card handlers)
  let insertLine = null;
  if (onReorder) {
    insertLine = document.createElement('div');
    insertLine.className = 'drag-insert-line';
    insertLine.style.display = 'none';
    container.appendChild(insertLine);
  }

  cards.forEach((card, i) => {
    const displayCard = faceDown ? { suit: 'hidden', rank: '?' } : card;
    const angle  = N > 1 ? -spread / 2 + (i / (N - 1)) * spread : 0;
    const key    = card.rank + card.suit;
    const picked = selectable && selectedSet && selectedSet.has(key);

    // Full-deal: all cards animate with round-robin stagger (dealConfig set)
    // Single-draw: only the last card (i === N-1) animates from center (no dealConfig)
    const isNewCard = animate && !dealConfig && i === N - 1;
    const el = makeCard(displayCard, { sm, animate: (animate && !!dealConfig) || isNewCard });
    if (mustLeadKey && key === mustLeadKey && !picked) el.classList.add('must-lead');

    el.dataset.rank = card.rank;
    el.dataset.suit = card.suit;

    el.style.position      = 'absolute';
    el.style.left          = i * xStep + 'px';
    el.style.bottom        = '0';
    el.style.transformOrigin = 'bottom center';
    el.style.transform     = `rotate(${angle}deg)${picked ? ' translateY(-18px)' : ''}`;
    el.style.zIndex        = i;
    el.style.transition    = 'transform 0.15s ease, box-shadow 0.15s';

    if (animate && dealConfig) {
      // Round-robin full-deal stagger
      el.style.setProperty('--deal-x', dealConfig.dx + 'px');
      el.style.setProperty('--deal-y', dealConfig.dy + 'px');
      el.style.setProperty('--deal-rot', dealConfig.rot + 'deg');
      // BJ/XiDach: slower stagger (0.12s) so each card is clearly visible mid-deal
      const stagger = (state.gameType === 'blackjack' || state.gameType === 'xidach') ? 0.12 : 0.035;
      const delay = (dealConfig.playerIdx + i * dealConfig.numPlayers) * stagger;
      el.style.animationDelay = delay.toFixed(3) + 's';
      // Play deal sound with matching stagger delay
      if (typeof SFX !== 'undefined') setTimeout(() => SFX.deal(), delay * 1000);
    } else if (isNewCard) {
      // Single drawn card flies in from centre (above)
      el.style.setProperty('--deal-x', '0px');
      el.style.setProperty('--deal-y', '-150px');
      el.style.setProperty('--deal-rot', '-5deg');
      if (typeof SFX !== 'undefined') SFX.deal();
    }

    if (selectable && !faceDown) {
      el.classList.add('sel');
      if (picked) { el.classList.add('picked'); }
      el.addEventListener('mouseenter', () => {
        if (_fanDrag) return; // skip hover while dragging
        el.style.zIndex = 100;
        if (!picked) el.style.transform = `rotate(${angle}deg) translateY(-12px)`;
      });
      el.addEventListener('mouseleave', () => {
        if (_fanDrag) return;
        el.style.zIndex = i;
        if (!picked) el.style.transform = `rotate(${angle}deg)`;
      });
      el.addEventListener('click', () => {
        if (_fanDrag?.moved) return; // ignore click after drag
        if (selectedSet.has(key)) state.selectedCards = state.selectedCards.filter(k => k !== key);
        else state.selectedCards.push(key);
        renderGame(state.gameState);
      });
    }

    // ── Drag-to-reorder (Phỏm) ──────────────────────────────────────────────
    if (onReorder) {
      el.style.touchAction = 'none';
      el.style.cursor = 'grab';

      el.addEventListener('pointerdown', e => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.style.scale = '1.08';
        _fanDrag = { el, fromIdx: i, angle, startX: e.clientX, moved: false, insertIdx: i };
        el.style.transition = 'none';
        el.style.zIndex = '999';
        el.style.cursor = 'grabbing';
      });

      el.addEventListener('pointermove', e => {
        if (!_fanDrag || _fanDrag.el !== el) return;
        const dx = e.clientX - _fanDrag.startX;
        if (Math.abs(dx) > 5) _fanDrag.moved = true;
        if (_fanDrag.moved) {
          el.style.transform = `translateX(${dx}px) rotate(${angle * 0.3}deg) translateY(-28px) scale(1.08)`;
          el.style.opacity = '0.82';
          // Calculate live insertIdx
          const rect = container.getBoundingClientRect();
          const localX = e.clientX - rect.left;
          let insertIdx = 0;
          for (let j = 0; j < N; j++) {
            if (localX > j * xStep + xStep * 0.5) insertIdx = j + 1;
          }
          _fanDrag.insertIdx = Math.max(0, Math.min(insertIdx, N));
          // Position insert line
          insertLine.style.display = 'block';
          insertLine.style.left = (_fanDrag.insertIdx * xStep) + 'px';
        }
      });

      el.addEventListener('pointerup', e => {
        if (!_fanDrag || _fanDrag.el !== el) return;
        const ctx = _fanDrag;
        _fanDrag = null;
        insertLine.style.display = 'none';
        el.style.scale = '';
        el.style.transition = 'transform 0.15s ease, box-shadow 0.15s';
        el.style.transform = `rotate(${angle}deg)`;
        el.style.opacity = '';
        el.style.zIndex = i;
        el.style.cursor = 'grab';
        if (!ctx.moved) return;
        let toIdx = ctx.insertIdx ?? ctx.fromIdx;
        // Adjust for removal: inserting after the card's original position means one less slot
        if (toIdx > ctx.fromIdx) toIdx--;
        toIdx = Math.max(0, Math.min(toIdx, N - 1));
        if (toIdx !== ctx.fromIdx) onReorder(ctx.fromIdx, toIdx);
      });

      el.addEventListener('pointercancel', () => {
        if (!_fanDrag || _fanDrag.el !== el) return;
        _fanDrag = null;
        insertLine.style.display = 'none';
        el.style.scale = '';
        el.style.transition = 'transform 0.15s ease, box-shadow 0.15s';
        el.style.transform = `rotate(${angle}deg)`;
        el.style.opacity = '';
        el.style.zIndex = i;
        el.style.cursor = 'grab';
      });
    }

    container.appendChild(el);
  });
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  updateRotateHint();
}

function updateRotateHint() {
  const hint = document.getElementById('rotate-hint');
  if (!hint) return;
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const mobile   = window.matchMedia('(max-width: 900px)').matches;
  hint.style.display = (portrait && mobile) ? 'flex' : 'none';
}

async function tryOrientationLock() {
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape-primary');
      updateRotateHint(); // hide hint if lock succeeded
    }
  } catch (e) {
    // iOS or desktop — orientation lock not supported; hint stays visible
  }
}

document.getElementById('rotate-fs-btn')?.addEventListener('click', tryOrientationLock);

// On page load: if mobile + portrait, try to lock automatically
if (window.matchMedia('(orientation: portrait) and (max-width: 900px)').matches) {
  tryOrientationLock();
}

/* ── Responsive re-render — seats recalculate from live getBoundingClientRect ──
   Problem: orientationchange fires BEFORE the browser has resized the viewport,
   so rAF still sees the old oval dimensions. ResizeObserver fires AFTER layout
   is stable (the browser guarantees this), making it the correct hook.
   We debounce it so rapid resize events (drag-resize, pinch-zoom) collapse into
   one render. For orientation we also bump the delay to 350 ms — iOS/Android
   can take 200–300 ms to fully commit the new viewport dimensions.
────────────────────────────────────────────────────────────────────────────── */
let _resizeTimer = null;
function _scheduleRender(delay = 80) {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    updateRotateHint();
    if (!state.gameState) return;
    if (state.dealInProgress) {
      // Can't re-render mid-deal (it would interrupt card animations).
      // Flag it so the deal-end timeout re-layouts once animations finish.
      state.needsReLayout = true;
    } else {
      renderGame(state.gameState);
    }
  }, delay);
}

// ResizeObserver watches the table-wrapper (the element that actually changes
// size). It fires after every layout pass where the wrapper's size changed.
(function _attachResizeObserver() {
  if (typeof ResizeObserver === 'undefined') return; // very old browsers
  const wrapper = document.querySelector('.table-wrapper');
  if (!wrapper) {
    // Game screen not mounted yet — retry once the DOM is ready
    document.addEventListener('DOMContentLoaded', _attachResizeObserver);
    return;
  }
  let _prevW = 0, _prevH = 0;
  const ro = new ResizeObserver(entries => {
    const { width, height } = entries[0].contentRect;
    // Skip if dimensions didn't actually change (avoids no-op renders)
    if (Math.abs(width - _prevW) < 1 && Math.abs(height - _prevH) < 1) return;
    _prevW = width; _prevH = height;
    _scheduleRender(80);
  });
  ro.observe(wrapper);
})();

// Orientation change: give the browser 350 ms to finish its viewport flip
// before measuring the oval. This covers the slowest Android/iOS devices.
window.addEventListener('orientationchange', () => {
  updateRotateHint();
  _scheduleRender(350);
});

// Plain resize (desktop drag-resize, split-screen on tablet) — still useful.
window.addEventListener('resize', () => {
  updateRotateHint();
  // ResizeObserver will also fire, but belt-and-suspenders for browsers
  // where the observer might be blocked (e.g., cross-origin iframe edge cases).
  _scheduleRender(80);
});
/* ── Round History ───────────────────────────────────────────────────────── */
function refreshHistoryPanel() {
  const panel = document.getElementById('history-panel');
  if (!panel) return;
  const body = panel.querySelector('.history-body');
  if (!body) return;
  if (!state.roundHistory.length) {
    body.innerHTML = '<p class="history-empty">No rounds played yet.</p>';
    return;
  }
  body.innerHTML = '';
  // Newest first
  [...state.roundHistory].reverse().forEach(({ round, entries }) => {
    const section = document.createElement('div');
    section.className = 'history-round';
    const hdr = document.createElement('div');
    hdr.className = 'history-round-hdr';
    hdr.textContent = `Round ${round}`;
    section.appendChild(hdr);
    entries.forEach(e => {
      const row = document.createElement('div');
      row.className = 'history-row ' + (e.result === 'win' ? 'h-win' : e.result === 'push' ? 'h-push' : e.result === 'loss' ? 'h-loss' : '');
      const icon = e.result === 'win' ? '🏆' : e.result === 'push' ? '🤝' : e.result === 'loss' ? '💀' : '•';
      const deltaStr = e.chipDelta != null ? (e.chipDelta > 0 ? ` +${e.chipDelta}` : ` ${e.chipDelta}`) : '';
      const chipsStr = e.chips != null ? ` (${e.chips})` : '';
      row.innerHTML = `<span class="h-icon">${icon}</span><span class="h-name">${escHtml(e.name)}</span><span class="h-delta">${deltaStr}${chipsStr}</span>`;
      section.appendChild(row);
    });
    body.appendChild(section);
  });
}

document.getElementById('btn-history')?.addEventListener('click', () => {
  const panel = document.getElementById('history-panel');
  if (!panel) return;
  document.getElementById('stats-panel')?.classList.remove('open');
  const open = panel.classList.toggle('open');
  if (open) refreshHistoryPanel();
});
document.getElementById('btn-history-close')?.addEventListener('click', () => {
  document.getElementById('history-panel')?.classList.remove('open');
});
document.getElementById('btn-stats')?.addEventListener('click', () => {
  const panel = document.getElementById('stats-panel');
  if (!panel) return;
  document.getElementById('history-panel')?.classList.remove('open');
  const open = panel.classList.toggle('open');
  if (open) refreshStatsPanel();
});
document.getElementById('btn-stats-close')?.addEventListener('click', () => {
  document.getElementById('stats-panel')?.classList.remove('open');
});

function refreshStatsPanel() {
  const body = document.getElementById('stats-body');
  if (!body) return;
  const lb = state.leaderboard;
  if (!lb.length) {
    body.innerHTML = '<p class="history-empty">No rounds recorded yet.</p>';
    return;
  }
  const wins   = lb.filter(e => e.result === 'win').length;
  const losses = lb.filter(e => e.result === 'lose').length;
  const draws  = lb.filter(e => e.result === 'draw').length;
  const netDelta = lb.reduce((sum, e) => sum + (e.chipDelta || 0), 0);
  const netCls   = netDelta > 0 ? 'positive' : netDelta < 0 ? 'negative' : '';
  body.innerHTML = `
    <div class="stats-summary">
      <div class="stats-block">
        <div class="stats-block-val s-win">${wins}</div>
        <div class="stats-block-lbl">Wins</div>
      </div>
      <div class="stats-block">
        <div class="stats-block-val s-loss">${losses}</div>
        <div class="stats-block-lbl">Losses</div>
      </div>
      <div class="stats-block">
        <div class="stats-block-val s-draw">${draws}</div>
        <div class="stats-block-lbl">Draws</div>
      </div>
      <div class="stats-block">
        <div class="stats-block-val s-net ${netCls}">${netDelta > 0 ? '+' : ''}${netDelta}</div>
        <div class="stats-block-lbl">Net Chips</div>
      </div>
    </div>
    <table class="stats-table">
      <thead><tr><th>Result</th><th>Game</th><th>Round</th><th>Chips</th></tr></thead>
      <tbody>
        ${[...lb].reverse().slice(0, 20).map(e => {
          const icon = e.result === 'win' ? '🏆' : e.result === 'lose' ? '💀' : '🤝';
          const rowCls = e.result === 'win' ? 's-win-row' : e.result === 'lose' ? 's-loss-row' : 's-draw-row';
          const deltaStr = e.chipDelta != null ? (e.chipDelta > 0 ? `+${e.chipDelta}` : `${e.chipDelta}`) : '—';
          const gameName = GAME_NAMES[e.game] || e.game || '—';
          return `<tr class="${rowCls}">
            <td>${icon} ${e.result.toUpperCase()}</td>
            <td>${escHtml(gameName)}</td>
            <td>${e.round ?? '—'}</td>
            <td>${deltaStr}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

function setError(id, msg) { const el = document.getElementById(id); if (el) el.textContent = msg || ''; }
function clearError(id) { setError(id, ''); }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function emit(event, data) { socket.emit(event, data); }

function addChat(data) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  if (data.system) { div.className = 'chat-msg system'; div.textContent = data.message; }
  else { div.className = 'chat-msg'; div.innerHTML = `<span class="sender">${escHtml(data.playerName)}:</span> ${escHtml(data.message)}`; }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function shouldAnimate(playerId, newCount) {
  const prev = state.prevHandCount[playerId] ?? -1;
  state.prevHandCount[playerId] = newCount;
  // pendingDealAnim covers both renders on a new round (immediate + rAF re-render)
  return state.pendingDealAnim || prev === -1 || (newCount > 1 && newCount > prev);
}

/* Returns me.hand sorted by the player's chosen order (Phỏm).
   New cards (not yet in order list) sort to the end. */
function getPhomHandSorted(hand) {
  if (!state.phomHandOrder.length) return hand;
  // Prune keys no longer in hand (discarded / used)
  const handKeys = new Set(hand.map(c => c.rank + c.suit));
  state.phomHandOrder = state.phomHandOrder.filter(k => handKeys.has(k));
  if (!state.phomHandOrder.length) return hand;
  const orderMap = Object.fromEntries(state.phomHandOrder.map((k, i) => [k, i]));
  return [...hand].sort((a, b) => {
    const ia = orderMap[a.rank + a.suit] ?? 9999;
    const ib = orderMap[b.rank + b.suit] ?? 9999;
    return ia - ib;
  });
}

/* ── Play-to-table animation helpers ─────────────────────────────────────── */

/* Returns the oval angle (degrees) for a given playerId in gs.
   270° = bottom (you), others spread around top half. */
function getPlayerAngle(gs, playerId) {
  const me = gs.players.find(p => p.isYou);
  if (playerId === me?.id) return 270;
  const others = gs.players.filter(p => !p.isYou);
  const idx = others.findIndex(p => p.id === playerId);
  if (idx < 0) return 90;
  return fullTableAngles(others.length)[idx] ?? 90;
}

/* Apply a "fly from seat → table center" animation to a card element.
   angleDeg: seat angle on the oval (same convention as createSeat).
   delayS:   optional stagger delay in seconds. */
function applyPlayAnim(el, angleDeg, delayS = 0) {
  const rad = angleDeg * Math.PI / 180;
  // Offset points FROM the seat toward centre (positive = farther from centre)
  const px = Math.round( Math.cos(rad) * 260);
  const py = Math.round(-Math.sin(rad) * 200);
  el.style.setProperty('--play-x', px + 'px');
  el.style.setProperty('--play-y', py + 'px');
  if (delayS) el.style.animationDelay = delayS.toFixed(3) + 's';
  el.classList.add('play-anim');
}

/* ── Result splash (win / lose / push) ──────────────────────────────────── */
let _splashTimer = null;
function showResultSplash(result, amtText = '') {
  // Clear any existing splash
  const old = document.getElementById('result-splash');
  if (old) old.remove();
  if (_splashTimer) clearTimeout(_splashTimer);

  const labels = { win: '🏆 THẮNG!', lose: '💸 THUA', push: '🤝 HÒA' };
  const cls    = result === 'win' ? 'win' : result === 'lose' ? 'lose' : 'push';
  const label  = labels[result] || '';
  if (!label) return;

  const el = document.createElement('div');
  el.id = 'result-splash';
  el.className = cls;
  el.innerHTML = label + (amtText ? `<span class="result-sub">${amtText}</span>` : '');
  document.body.appendChild(el);

  // Fade out after 2 s
  _splashTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 420);
  }, 2000);
}

/* ── Lobby ───────────────────────────────────────────────────────────────── */

// Show saved chips indicator on lobby load
(function showSavedChipsHint() {
  const el = document.getElementById('saved-chips-display');
  if (!el) return;
  if (state.savedChips) {
    el.textContent = `Your chips from last session: ${state.savedChips.toLocaleString()}`;
    el.style.display = 'block';
  }
})();

document.getElementById('btn-create').addEventListener('click', () => {
  clearError('lobby-error');
  const name = document.getElementById('player-name').value.trim();
  if (!name) { setError('lobby-error', 'Please enter your name'); return; }
  const pin = document.getElementById('room-pin')?.value.trim() || null;
  state.myName = name;
  emit('create-room', { playerName: name, sessionId, pin: pin || undefined });
});
document.getElementById('btn-join').addEventListener('click', () => {
  clearError('lobby-error');
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!name) { setError('lobby-error', 'Please enter your name'); return; }
  if (!code) { setError('lobby-error', 'Please enter a room code'); return; }
  const pin = document.getElementById('join-pin')?.value.trim() || null;
  state.myName = name;
  emit('join-room', { playerName: name, roomCode: code, sessionId, pin: pin || undefined });
});
document.getElementById('player-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-create').click(); });
document.getElementById('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btn-join').click(); });

/* ── Room ────────────────────────────────────────────────────────────────── */
document.getElementById('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomCode).catch(() => {});
  const btn = document.getElementById('btn-copy-code');
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = 'Copy Code'; }, 1500);
});
document.getElementById('btn-leave').addEventListener('click', () => location.reload());
document.getElementById('btn-leave-game').addEventListener('click', () => location.reload());
document.querySelectorAll('.game-card').forEach(card => {
  card.addEventListener('click', () => {
    if (!state.isHost) return;
    emit('set-game', { gameType: card.dataset.game });
  });
});
document.getElementById('btn-start').addEventListener('click', () => {
  clearError('room-error');
  emit('start-game');
});

/* ── Chat ────────────────────────────────────────────────────────────────── */
const chatPanel = document.getElementById('chat-panel');
document.getElementById('chat-toggle').addEventListener('click', () => chatPanel.classList.toggle('open'));
document.getElementById('chat-close').addEventListener('click',  () => chatPanel.classList.remove('open'));
document.getElementById('btn-chat-send').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  emit('chat', { message: msg });
  input.value = '';
}

/* ── Socket events ───────────────────────────────────────────────────────── */
socket.on('connect', () => {
  state.myId = socket.id;
  // Attempt to reconnect to a previous room session
  emit('reconnect-room', { sessionId });
});

socket.on('room-created', ({ roomCode }) => {
  state.roomCode = roomCode;
  document.getElementById('room-code-display').textContent = roomCode;
  showScreen('screen-room');
});
socket.on('room-joined', ({ roomCode }) => {
  state.roomCode = roomCode;
  document.getElementById('room-code-display').textContent = roomCode;
  showScreen('screen-room');
});

socket.on('room-reconnected', ({ roomCode, gameType, inGame }) => {
  state.roomCode = roomCode;
  state.gameType = gameType;
  document.getElementById('room-code-display').textContent = roomCode;
  if (inGame) {
    document.getElementById('game-title').textContent = GAME_NAMES[gameType] || gameType;
    const gs = document.getElementById('screen-game');
    gs.className = gs.className.replace(/\b\w+-game\b/g, '').trim();
    if (gameType) gs.classList.add(gameType + '-game');
    showScreen('screen-game');
  } else {
    showScreen('screen-room');
  }
});

socket.on('room-state', ({ players, gameType, isHost, deposit, hasPIN }) => {
  state.isHost = isHost;
  state.gameType = gameType;
  state.deposit = deposit ?? 1000;

  // Show lock icon next to room code if room has PIN
  const codeDisplay = document.getElementById('room-code-display');
  if (codeDisplay) {
    let lockEl = document.getElementById('room-pin-lock');
    if (hasPIN && !lockEl) {
      lockEl = document.createElement('span');
      lockEl.id = 'room-pin-lock';
      lockEl.className = 'room-lock-icon';
      lockEl.textContent = '🔒';
      lockEl.title = 'PIN protected';
      codeDisplay.parentNode.insertBefore(lockEl, codeDisplay.nextSibling);
    } else if (!hasPIN && lockEl) {
      lockEl.remove();
    }
  }

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    let inner = `${p.isHost ? '<span class="crown">♛</span>' : ''} ${escHtml(p.name)}`;
    if (p.isBot) inner += ' <span style="font-size:0.65rem;color:var(--text-dim)">[Bot]</span>';
    if (isHost && p.isBot) inner += ` <button class="btn btn-small btn-ghost" style="padding:2px 6px;margin-left:4px;font-size:0.68rem" onclick="emit('remove-bot',{botId:'${p.id}'})">✕</button>`;
    chip.innerHTML = inner;
    list.appendChild(chip);
  });
  document.getElementById('player-count').textContent = players.length;

  document.querySelectorAll('.game-card').forEach(c => {
    c.classList.toggle('selected', c.dataset.game === gameType);
    c.style.cursor = isHost ? 'pointer' : 'default';
  });

  let botRow = document.getElementById('bot-controls');
  if (!botRow) {
    botRow = document.createElement('div');
    botRow.id = 'bot-controls';
    botRow.style.cssText = 'margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
    document.getElementById('btn-start').before(botRow);
  }
  botRow.innerHTML = '';
  if (isHost && gameType) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-secondary btn-small';
    addBtn.textContent = '+ Add Bot';
    addBtn.onclick = () => emit('add-bot');
    botRow.appendChild(addBtn);
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:0.73rem;color:var(--text-dim)';
    hint.textContent = 'Bots play automatically';
    botRow.appendChild(hint);
  }

  // ── Deposit setting (blackjack / poker only) ──
  let depositRow = document.getElementById('deposit-row');
  if (!depositRow) {
    depositRow = document.createElement('div');
    depositRow.id = 'deposit-row';
    depositRow.className = 'deposit-row';
    document.getElementById('btn-start').before(depositRow);
  }
  depositRow.innerHTML = '';
  if (gameType && ['blackjack','xidach','poker'].includes(gameType)) {
    const lbl = document.createElement('label');
    lbl.textContent = '💰 Số chip · Deposit:';
    depositRow.appendChild(lbl);
    if (isHost) {
      const PRESETS = [1000, 2000, 5000, 10000];
      PRESETS.forEach(val => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-small ' + ((deposit ?? 1000) === val ? 'btn-action' : 'btn-ghost');
        btn.textContent = val >= 1000 ? (val / 1000) + 'K' : val;
        btn.onclick = () => emit('set-deposit', { amount: val });
        depositRow.appendChild(btn);
      });
      // "Use my chips" button if savedChips exists
      if (state.savedChips && state.savedChips >= 100) {
        const useBtn = document.createElement('button');
        useBtn.className = 'use-chips-btn';
        useBtn.textContent = `Use my chips (${state.savedChips.toLocaleString()})`;
        useBtn.onclick = () => emit('set-deposit', { amount: state.savedChips });
        depositRow.parentNode.insertBefore(useBtn, depositRow.nextSibling);
      }
    } else {
      const span = document.createElement('span');
      span.className = 'deposit-display';
      span.textContent = (deposit ?? 1000).toLocaleString() + ' chips';
      depositRow.appendChild(span);
    }
  }

  const REQ = { blackjack:{min:1,max:7,note:'Max 7 players'},
                xidach:   {min:1,max:7,note:'Max 7 players'},
                poker:    {min:2,max:8,note:'Max 8 players (add bots!)'},
                tienlen:  {min:4,max:4,note:'Must be exactly 4 players — add bots to fill'},
                phom:     {min:4,max:4,note:'Must be exactly 4 players — add bots to fill'} };
  const req = REQ[gameType];
  const n   = players.length;
  const ok  = req ? (n >= req.min && n <= req.max) : n >= 2;

  let reqHint = document.getElementById('player-req-hint');
  if (!reqHint) {
    reqHint = document.createElement('p');
    reqHint.id = 'player-req-hint';
    reqHint.style.cssText = 'font-size:0.73rem;color:var(--text-dim);margin-bottom:8px;';
    document.getElementById('btn-start').before(reqHint);
  }
  reqHint.textContent = req ? req.note : '';

  const btn = document.getElementById('btn-start');
  btn.disabled = !isHost || !gameType || !ok;
  btn.textContent = isHost ? 'Start Game' : 'Waiting for host…';
});

socket.on('game-started', ({ gameType }) => {
  state.gameType = gameType;
  state.selectedCards = [];
  state.prevHandCount = {};
  document.getElementById('game-title').textContent = GAME_NAMES[gameType] || gameType;
  // Tag the game screen with the game type so CSS can target it
  const gs = document.getElementById('screen-game');
  gs.className = gs.className.replace(/\b\w+-game\b/g, '').trim();
  gs.classList.add(gameType + '-game');
  showScreen('screen-game');
  document.getElementById('chat-messages').innerHTML = '';
  addChat({ system: true, message: `${GAME_NAMES[gameType]} started! Good luck. 🍀` });
  // Re-render after layout settles so createSeat can measure the actual oval via getBoundingClientRect.
  // Use the same debounced scheduler (80 ms) that the ResizeObserver uses — reliable across devices.
  _scheduleRender(80);
});

socket.on('game-state', gs => {
  const prevGs = state.gameState;
  state.gameState = gs;
  // Trigger chip flight animations before rebuilding the DOM
  handleChipAnimations(prevGs, gs);

  // Persist chip count to localStorage
  const me = gs.players?.find(p => p.isYou);
  if (me?.chips !== undefined) {
    localStorage.setItem('bat_ma_chips', me.chips);
    state.savedChips = me.chips;
  }

  // Win/lose splash for BJ & XiDach when round ends
  if (['blackjack','xidach'].includes(state.gameType)) {
    const wasPlaying = prevGs && prevGs.phase !== 'ended';
    const nowEnded   = gs.phase === 'ended';
    if (wasPlaying && nowEnded) {
      const me = gs.players?.find(p => p.isYou);
      if (me) {
        // BJ has multiple hands — check any win
        const hands = me.hands?.length ? me.hands : [me];
        const results = hands.map(h => h.result).filter(Boolean);
        const hasWin  = results.some(r => r === 'win' || r === 'blackjack');
        const hasLose = results.some(r => r === 'loss' || r === 'bust' || r === 'lose');
        const allPush = results.length && results.every(r => r === 'push');
        const amt     = me.resultAmt ?? (me.chips - (prevGs?.players?.find(p=>p.isYou)?.chips ?? me.chips));
        const amtStr  = amt > 0 ? `+${amt} chips` : amt < 0 ? `${amt} chips` : '';
        const result  = hasWin ? 'win' : allPush ? 'push' : hasLose ? 'lose' : null;
        if (result) showResultSplash(result, amtStr);
        // Sound effects
        if (typeof SFX !== 'undefined') {
          if (hasWin) SFX.win();
          else if (hasLose && !allPush) SFX.lose();
        }
      }
    }
    // Dealer reveals hole card (playing→dealer or insurance→playing)
    const prevPhase = prevGs?.phase;
    const curPhase  = gs.phase;
    if ((prevPhase === 'playing' || prevPhase === 'insurance') && curPhase === 'dealer') {
      if (typeof SFX !== 'undefined') SFX.flip();
    }
  }

  // Win/lose for other games
  if (['tienlen','phom','poker'].includes(state.gameType)) {
    const wasPlaying = prevGs && prevGs.phase !== 'ended' && prevGs.phase !== 'showdown';
    const nowEnded   = gs.phase === 'ended' || gs.phase === 'showdown';
    if (wasPlaying && nowEnded && typeof SFX !== 'undefined') {
      const me = gs.players?.find(p => p.isYou);
      const delta = me?.chipDelta;
      if (delta != null) {
        if (delta > 0) SFX.win();
        else if (delta < 0) SFX.lose();
      }
    }
  }

  // Record round history when a round ends (once per round)
  if (gs.phase === 'ended' && gs.round && gs.round !== state.lastRecordedRound) {
    state.lastRecordedRound = gs.round;
    const entries = (gs.players || []).map(p => {
      let result = null;
      // Blackjack / XiDach: use hand result
      if (p.hands?.length) {
        const r = p.hands[0]?.result;
        result = r === 'win' || r === 'blackjack' ? 'win'
               : r === 'push' ? 'push' : 'loss';
      } else if (p.result) {
        result = p.result;
      } else if (p.chipDelta != null) {
        result = p.chipDelta > 0 ? 'win' : p.chipDelta < 0 ? 'loss' : 'push';
      } else if (p.winner) {
        result = 'win';
      }
      const delta = p.chipDelta ?? p.resultAmt ?? null;
      return { name: p.name, result, chipDelta: delta, chips: p.chips ?? null };
    });
    state.roundHistory.push({ round: gs.round, entries });

    // Update session leaderboard with the local player's result
    const myEntry = entries.find(e => {
      const mePlayer = gs.players?.find(p => p.isYou);
      return mePlayer && e.name === mePlayer.name;
    });
    if (myEntry) {
      const leaderResult = myEntry.result === 'win' ? 'win'
                         : myEntry.result === 'loss' ? 'lose'
                         : 'draw';
      state.leaderboard.push({
        game: state.gameType,
        result: leaderResult,
        chipDelta: myEntry.chipDelta,
        round: gs.round,
      });
    }

    refreshHistoryPanel();
    refreshStatsPanel();
  }

  // Suppress re-renders that arrive during the deal animation (bots acting)
  // so the flying-card animation isn't wiped by a DOM rebuild.
  if (state.dealInProgress && gs.round === state.dealRound) {
    state.queuedGameState = gs;
    return;
  }
  renderGame(gs);
});
socket.on('chat', data => addChat(data));
socket.on('player-left', ({ name }) => addChat({ system: true, message: name + ' left the game' }));

socket.on('error', ({ message }) => {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const errEl = active.querySelector('.error-msg');
  if (errEl) { errEl.textContent = message; setTimeout(() => { errEl.textContent = ''; }, 4000); }
  else addChat({ system: true, message: '⚠ ' + message });
});

/* ── Render dispatcher ───────────────────────────────────────────────────── */
function renderGame(gs) {
  // Detect a new deal round — animate cards and block mid-deal re-renders
  if (gs.round && gs.round !== state.dealRound) {
    state.dealRound = gs.round;
    state.pendingDealAnim = true;
    state.dealInProgress = true;
    state.queuedGameState = null;
    state.phomHandOrder  = []; // reset user card order on new round
    state.prevTableKey   = '';
    state.prevDiscardKey = '';
    showDealDeck();
    if (typeof SFX !== 'undefined') SFX.shuffle();

    // pendingDealAnim: cleared after 2 frames so BOTH renders (sync + rAF) animate
    requestAnimationFrame(() => requestAnimationFrame(() => { state.pendingDealAnim = false; }));

    // dealInProgress: cleared after the full animation finishes, then flush queued state
    // Phỏm: dealer gets 10 (max), others 9; TienLen: 13; BJ/Xidach: 2; Poker: 2
    const isDealerGame = ['blackjack','xidach'].includes(state.gameType);
    const cardsPerPlayer = state.gameType === 'tienlen' ? 13
                         : state.gameType === 'phom'    ? 10
                         : 2;
    const numP    = gs.players.length + (isDealerGame ? 1 : 0);
    const STAGGER = isDealerGame ? 0.12 : 0.035; // slower for BJ/XiDach
    const ANIM    = isDealerGame ? 0.55 : 0.38;
    const maxDelay = ((numP - 1) + (cardsPerPlayer - 1) * numP) * STAGGER;
    const totalMs  = Math.ceil((maxDelay + ANIM) * 1000) + 400;
    setTimeout(() => {
      state.dealInProgress = false;
      if (state.queuedGameState) {
        renderGame(state.queuedGameState);
        state.queuedGameState = null;
      } else if (state.needsReLayout) {
        // A resize/orientation-change happened during the animation — re-layout now.
        renderGame(state.gameState);
      }
      state.needsReLayout = false;
    }, totalMs);
  }

  document.getElementById('game-round').textContent = gs.round ? `Round ${gs.round}` : '';
  clearAllZones();
  clearCenter();
  document.getElementById('action-area').innerHTML = '';
  document.getElementById('melds-area').innerHTML = '';

  switch (state.gameType) {
    case 'blackjack': renderBlackjack(gs); break;
    case 'xidach':    renderXiDach(gs);    break;
    case 'poker':     renderPoker(gs);     break;
    case 'tienlen':   renderTienLen(gs);   break;
    case 'phom':      renderPhom(gs);      break;
  }

  // Glow the action bar when it's the human's turn
  const me = gs.players?.find(p => p.isYou);
  const isMyTurn = me && gs.currentPlayer === me.id && me.status === 'active' && gs.phase !== 'ended';
  document.querySelector('.action-bar')?.classList.toggle('your-turn', !!isMyTurn);
}

function clearAllZones() {
  // Remove all dynamically created player seats
  document.querySelectorAll('.player-seat').forEach(el => el.remove());
  // Clear your seat content
  document.getElementById('your-name-label').textContent = '';
  document.getElementById('your-hand').innerHTML = '';
  document.getElementById('your-info').innerHTML = '';
}

function clearCenter() {
  ['community-cards','pot-display','last-play-display','discard-area','status-message']
    .forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
}

/* ── Seat positioning ────────────────────────────────────────────────────── */
/*
  Convention: 0°=right, 90°=top, 180°=left, 270°=bottom (you).

  All angles below:
    DEALER games (BJ / XiDach) — dealer sits at 90°, you at 270°.
      ≤5 bots: upper arc only (safe from overlap with your fixed seat).
       6 bots: mirrored layout — right/left sides + upper-right/left + lower-right/left.
    FULL TABLE games (Poker / TienLen / Phom) — same layout as dealer games for 6.
      For 6 bots user requested:
        Bot1=right-side(0°), Bot2=upper-right(45°),
        Bot3=lower-right(315°) [opposite Bot2],
        Bot4=lower-left(225°) [opposite Bot5],
        Bot5=upper-left(135°), Bot6=left-side(180°)
*/
// Short landscape phone — no room for lower-arc seats
const _isShortLandscape = () =>
  window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches;

const SEAT_LAYOUTS = {
  // BJ/XiDach: dealer always at 90°.
  // Desktop (≥861px or portrait): Bot3=314° (opposite Bot2=46°), Bot4=226° (opposite Bot5=134°)
  // Short landscape phone: no room below the oval — keep all-upper-arc.
  dealer: {
    1: [90],
    2: [60, 120],
    3: [42, 90, 138],
    4: [25, 68, 112, 155],
    5: [18, 54, 90, 126, 162],
    // 6-player full-ring: right(equator)·upper-right·lower-right·lower-left·upper-left·left(equator)
    // 5°/175° → sinA=0.087 < 0.12 threshold → true side-seat mode → exactly at oval equator
    6: [5, 46, 314, 226, 134, 175],
  },
  // Fallback for 6-bot BJ on short landscape phones (no room for lower-arc)
  dealer_mobile: {
    // 5°/175° at equator; 65°/115° leave a 50° gap around dealer at 90°
    6: [5, 44, 65, 115, 136, 175],
  },
  // Poker / TienLen / Phỏm — clock-face seating.
  // You = 6 o'clock (bottom).  Opponents fill the rim: right → top → left.
  // Angles ≤ ~7° or ≥ ~173° have sinA < 0.12 → side-seat row layout
  // (fan + info rendered side-by-side, hugging the oval edge).
  full: {
    1: [90],                           // top only
    2: [5, 175],                       // 3 o'clock · 9 o'clock
    3: [350, 75, 145],                 // lower-right · upper-center-right · upper-left
    4: [5, 60, 120, 175],              // 3 · upper-right · upper-left · 9
    5: [5, 45, 90, 135, 175],          // 3 · upper-right · 12 · upper-left · 9
    6: [5, 38, 72, 108, 142, 175],
    7: [5, 32, 62, 90, 118, 148, 175],
  },
};

function topArcAngles(n) {
  // Check whether lower-arc seats would overflow the table-wrapper's overflow:hidden
  // before committing to a layout that uses them.
  //
  // For angles like 314°/226° (sinA ≈ -0.719, oval height = 60% of wrapper):
  //   rimY   ≈ 0.5·wh + 0.30·wh·0.719  ≈ 0.716·wh
  //   bottom ≈ rimY + lowerGAP + approxSeatH
  // Solving for the minimum wrapper height where bottom ≤ wh gives ~521px.
  // Add viewport chrome (HUD 42 + action 60) → viewport min ≈ 623px.
  // We compute this live so it adapts to any resize, not just portrait/landscape.
  function _lowerArcFits() {
    const wrapper = document.querySelector('.table-wrapper');
    if (!wrapper) return false;
    const { height: wh, width: ww } = wrapper.getBoundingClientRect();
    if (!wh) return false;
    const isLandscapePhone = window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    const isDesktop        = window.matchMedia('(min-width: 861px)').matches;
    // Mirror the exact lowerGAP from createSeat — flush games have 0 gap
    const isFlushGame = ['blackjack','xidach','poker'].includes(state.gameType);
    const lowerGap = isFlushGame ? 0 : (isLandscapePhone ? 10 : isDesktop ? 8 : 6);
    // Read live card height so SEAT_H matches whatever breakpoint is active
    const cardHSm = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-h-sm')) || 62;
    const SEAT_H  = cardHSm + 40; // fan cards + name label + bet text + gaps
    // Match live oval CSS heights per breakpoint
    const ovalHPct = isDesktop ? 0.60 : isLandscapePhone ? 0.68 : ww >= 681 ? 0.52 : ww >= 421 ? 0.48 : 0.44;
    // rimY for 314°/226°: sinA = sin(46°) = 0.719, below center → adds to ocy
    const rimYRatio = 0.5 + (ovalHPct / 2) * 0.719;
    return (rimYRatio * wh + lowerGap + SEAT_H) <= wh;
  }

  // Use the mobile (all-upper-arc) fallback when lower-arc seats won't fit
  if (SEAT_LAYOUTS.dealer_mobile[n] && !_lowerArcFits()) {
    return SEAT_LAYOUTS.dealer_mobile[n];
  }
  const m = SEAT_LAYOUTS.dealer;
  if (m[n]) return m[n];
  const step = 160 / (n + 1);
  return Array.from({ length: n }, (_, i) => 10 + step * (i + 1));
}
function fullTableAngles(n) {
  const m = SEAT_LAYOUTS.full;
  if (m[n]) return m[n];
  const step = 160 / (n + 1);
  return Array.from({ length: n }, (_, i) => 10 + step * (i + 1));
}

/*
  createSeat — places an opponent seat on the oval rim.

  Strategy (simple, no fancy anchoring):
  1. Measure the actual felt-oval via getBoundingClientRect.
  2. Compute the point on the ellipse at angleDeg.
  3. Push it outward by a fixed number of pixels so the seat CENTER sits just
     outside the rim.
  4. Always use translate(-50%, -50%) to center the seat on that point.
     Simple, predictable, no per-angle special cases.
*/
function createSeat(angleDeg) {
  const wrapper = document.querySelector('.table-wrapper');
  const oval    = document.querySelector('.felt-oval');

  const rad  = angleDeg * Math.PI / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  let leftPct, topPct, transformStr;

  if (oval) {
    const wr = wrapper.getBoundingClientRect();
    const or = oval.getBoundingClientRect();

    const ocx = (or.left + or.width  / 2) - wr.left;
    const ocy = (or.top  + or.height / 2) - wr.top;
    const ax  = or.width  / 2;
    const ay  = or.height / 2;

    // Point exactly on the oval rim at this angle
    const rimX = ocx + ax * cosA;
    const rimY = ocy - ay * sinA;

    // Responsive gaps — zero for dealer/poker games (cards flush with rim), small for others
    const isLandscapePhone = window.matchMedia('(orientation: landscape) and (max-height: 500px)').matches;
    const isDesktop        = window.matchMedia('(min-width: 861px)').matches;
    const isFlushGame = ['blackjack','xidach','poker'].includes(state.gameType);
    const GAP      = isFlushGame ? 0 : (isLandscapePhone ? 2 : isDesktop ? 8 : 4);
    const lowerGAP = isFlushGame ? 0 : (isLandscapePhone ? 10 : isDesktop ? 8 : 6);

    // SIDE_PUSH: distance from oval rim to the visual centre of a rotated vertical fan.
    // Visual width of fan-hand-sm when rotated 90° = CSS height = card-h-sm + 20px.
    // Read the live CSS custom property so it matches the active responsive breakpoint.
    const cardHSm  = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-h-sm')) || 62;
    const SIDE_PUSH = Math.floor((cardHSm + 20) / 2) + 2;

    // Side seat detection: abs(sinA) < 0.12 means nearly horizontal (0° or 180°).
    const isSideSeat = Math.abs(sinA) < 0.12;

    let anchorX = rimX, anchorY = rimY;
    let txStr = '-50%', tyStr = '-50%';

    if (isSideSeat) {
      // Side seat — row layout (fan + info side by side).
      // Anchor just outside the oval rim; translate so the fan edge touches the rim.
      anchorY = rimY;
      tyStr   = '-50%';
      if (cosA >= 0) {
        // Right side: seat starts at rim, grows rightward → translate(0, -50%)
        anchorX = rimX + GAP;
        txStr   = '0%';
      } else {
        // Left side: seat ends at rim, grows leftward → translate(-100%, -50%)
        anchorX = rimX - GAP;
        txStr   = '-100%';
      }
    } else if (sinA > 0) {
      // Horizontal fan, upper position: bottom edge of seat at rim - GAP
      anchorX = rimX;
      anchorY = rimY - GAP;
      txStr   = '-50%';
      tyStr   = '-100%';
    } else {
      // Horizontal fan, lower position: top edge at rim + lowerGAP
      anchorX = rimX;
      anchorY = rimY + lowerGAP;
      txStr   = '-50%';
      tyStr   = '0%';
    }

    leftPct      = (anchorX / wr.width)  * 100;
    topPct       = (anchorY / wr.height) * 100;
    transformStr = `translate(${txStr}, ${tyStr})`;
  } else {
    // Fallback (oval not yet measured) — percentages must match the CSS .felt-oval sizes
    // Mobile-first: base = smallest mobile, scale up
    let wPct = 90, hPct = 44;
    if (window.matchMedia('(orientation: landscape) and (max-height: 520px)').matches) { wPct = 42; hPct = 68; }
    else if (window.matchMedia('(min-width: 861px)').matches) { wPct = 55; hPct = 60; }
    else if (window.matchMedia('(min-width: 681px)').matches) { wPct = 68; hPct = 52; }
    else if (window.matchMedia('(min-width: 421px)').matches) { wPct = 85; hPct = 48; }
    leftPct      = 50 + (wPct / 2 + 1) * cosA;
    topPct       = 50 - (hPct / 2 + 3) * sinA;
    transformStr = 'translate(-50%, -50%)';
  }

  const seat = document.createElement('div');
  seat.className       = 'player-seat';
  seat.style.left      = leftPct + '%';
  seat.style.top       = topPct  + '%';
  seat.style.transform = transformStr;
  wrapper.appendChild(seat);
  return seat;
}

/* ── Chip flight animation ───────────────────────────────────────────────── */
const CHIP_COLORS = ['#f5f0e8','#e53935','#1976d2','#2e7d32','#616161','#7b1fa2','#f9a825'];

function _chipRect(playerId) {
  if (!playerId) return null;
  if (playerId === 'center') {
    const felt = document.querySelector('.felt-oval');
    if (felt) { const r = felt.getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2 }; }
    return { cx: window.innerWidth/2, cy: window.innerHeight/2 };
  }
  const me = state.gameState?.players?.find(p => p.isYou);
  if (me?.id === playerId) {
    const el = document.getElementById('seat-you');
    if (el) { const r = el.getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + 30 }; }
  }
  const seat = document.querySelector(`[data-player-id="${playerId}"]`);
  if (seat) { const r = seat.getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2 }; }
  return null;
}

function flyChips(fromId, toId, amount, baseDelay = 0) {
  const from = _chipRect(fromId);
  const to   = _chipRect(toId);
  if (!from || !to) return;
  const count = Math.max(1, Math.min(6, Math.ceil(amount / 150)));
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const chip = document.createElement('div');
      chip.className = 'fly-chip';
      chip.style.cssText =
        `position:fixed;width:18px;height:18px;border-radius:50%;z-index:9999;pointer-events:none;` +
        `background:${CHIP_COLORS[i % CHIP_COLORS.length]};` +
        `border:2px solid rgba(255,255,255,0.35);box-shadow:0 2px 8px rgba(0,0,0,0.55);` +
        `left:${from.cx - 9}px;top:${from.cy - 9}px;transition:none;`;
      document.body.appendChild(chip);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const jx = (Math.random() - 0.5) * 16, jy = (Math.random() - 0.5) * 16;
        chip.style.transition = 'left 0.52s cubic-bezier(0.4,0,0.2,1),top 0.52s cubic-bezier(0.4,0,0.2,1),opacity 0.25s 0.3s';
        chip.style.left = (to.cx - 9 + jx) + 'px';
        chip.style.top  = (to.cy - 9 + jy) + 'px';
        chip.style.opacity = '0';
        setTimeout(() => chip.remove(), 600);
      }));
    }, baseDelay + i * 75);
  }
}

/* Called on every game-state update with the previous snapshot */
function handleChipAnimations(prev, next) {
  if (!prev || !next) return;
  const gt = state.gameType;
  if (!['blackjack','xidach','poker'].includes(gt)) return;

  const prevPlayers = prev.players || [];
  const nextPlayers = next.players || [];

  if (gt === 'poker') {
    // Chips flying TO pot when totalBet increases
    nextPlayers.forEach(np => {
      const pp = prevPlayers.find(x => x.id === np.id);
      const delta = (np.totalBet ?? np.bet ?? 0) - (pp?.totalBet ?? pp?.bet ?? 0);
      if (delta > 0) flyChips(np.id, 'center', delta);
    });
    // Chips flying BACK on showdown
    if (prev.phase !== 'showdown' && next.phase === 'showdown') {
      nextPlayers.forEach(np => {
        const pp = prevPlayers.find(x => x.id === np.id);
        if (pp && np.chips > pp.chips) flyChips('center', np.id, np.chips - pp.chips, 300);
      });
    }
  }

  if (gt === 'blackjack' || gt === 'xidach') {
    // Chips TO center when betting → playing
    if (prev.phase === 'betting' && next.phase === 'playing') {
      nextPlayers.forEach((np, i) => {
        const bet = np.bet ?? np.hands?.[0]?.bet ?? 0;
        if (bet > 0) flyChips(np.id, 'center', bet, i * 120);
      });
    }
    // Chips BACK to player at round end
    const prevPhase = prev.phase;
    const nextPhase = next.phase;
    if (prevPhase !== 'ended' && nextPhase === 'ended') {
      nextPlayers.forEach((np, i) => {
        const pp = prevPlayers.find(x => x.id === np.id);
        if (pp && np.chips > pp.chips) flyChips('center', np.id, np.chips - pp.chips, 400 + i * 120);
      });
    }
  }
}

/* Build a full opponent seat at angleDeg */
function buildOpponentSeat(angleDeg, player, isCurrent, { showHand = false, sm = true, cardCount = 0, extras = [], playerIdx = 0, numPlayers = 4, noChips = false } = {}) {
  const seat = createSeat(angleDeg);
  seat.dataset.playerId = player.id;

  const rad  = angleDeg * Math.PI / 180;
  const sinA = Math.sin(rad);
  const cosA = Math.cos(rad);

  // Cards
  const fan = document.createElement('div');
  fan.className = sm ? 'fan-hand-sm' : 'fan-hand';
  const animate = shouldAnimate(player.id, player.hand ? player.hand.length : cardCount);
  const dealConfig = (animate && state.pendingDealAnim) ? getDealConfig(angleDeg, playerIdx, numPlayers) : null;
  const cards = player.hand || Array(cardCount).fill({ suit: 'hidden', rank: '?' });
  renderFan(fan, cards, { sm, faceDown: !showHand, animate, dealConfig });

  // Card fan rotation — pick exact cardinal direction based on sinA/cosA (avoids Math.round half-even bugs).
  // Side seats (abs(sinA) < 0.12): vertical fan pointing inward.
  // Upper arc (sinA > 0): horizontal fan pointing down (180°).
  // Lower arc (sinA < -0.12): horizontal fan pointing up (0°).
  const isSideFan = Math.abs(sinA) < 0.12;
  let fanDeg;
  if (isSideFan) {
    fanDeg = cosA >= 0 ? -90 : 90;  // right side → -90°, left side → 90°
  } else if (sinA > 0) {
    fanDeg = 180;  // upper arc: fan points down toward table
  } else {
    fanDeg = 0;    // lower arc: fan points up toward table
  }
  fan.style.transform = `rotate(${fanDeg}deg)`;

  // Name label
  const nameEl = document.createElement('div');
  nameEl.className = 'zone-name' + (isCurrent ? ' active-turn' : '');
  nameEl.textContent = player.name;
  if (player.isDealer) {
    const d = document.createElement('span');
    d.className = 'dealer-btn'; d.textContent = 'D';
    nameEl.appendChild(d);
  }

  // Info group: name + chips + bet + status badges — all grouped together
  // so they stay on the far side of the fan (outside the oval in the black area).
  const infoGroup = document.createElement('div');
  infoGroup.className = 'seat-info-group';
  infoGroup.appendChild(nameEl);

  if (!noChips && player.chips !== undefined) {
    const chipsEl = document.createElement('div');
    chipsEl.className = 'zone-chips';
    chipsEl.textContent = player.chips + ' chips';
    infoGroup.appendChild(chipsEl);
  }
  extras.forEach(e => infoGroup.appendChild(e));

  const hasBetExtra = extras.some(e => e.classList?.contains('zone-bet'));
  if (player.totalBet && !hasBetExtra) {
    const bet = document.createElement('div');
    bet.className = 'zone-bet';
    bet.textContent = 'Bet: ' + player.totalBet;
    infoGroup.appendChild(bet);
  }
  if (player.status === 'folded') {
    const s = document.createElement('div'); s.className = 'zone-status'; s.textContent = 'Folded';
    infoGroup.appendChild(s);
  }

  // Order: fan closer to oval rim, infoGroup further out in the black area.
  // Use sinA threshold for side detection — same logic as createSeat (avoids snapMod asymmetry bug at 225°).
  const isSideSeat = Math.abs(sinA) < 0.12;

  if (isSideSeat) {
    // Side seat (0° right, 180° left): fan + infoGroup side by side (row).
    // Fan closer to oval, info label beside it — keeps total height small.
    seat.style.flexDirection = 'row';
    seat.style.alignItems    = 'center';
    seat.style.gap           = '4px';
    infoGroup.style.textAlign = cosA >= 0 ? 'left' : 'right';
    infoGroup.style.maxWidth  = '90px';
    if (cosA >= 0) {
      // Right side: fan left (near oval), info right
      seat.appendChild(fan);
      seat.appendChild(infoGroup);
    } else {
      // Left side: info left, fan right (near oval)
      seat.appendChild(infoGroup);
      seat.appendChild(fan);
    }
  } else if (sinA > 0) {
    // Upper arc (horizontal fan): info on TOP (outer), fan on BOTTOM (near rim)
    seat.appendChild(infoGroup);
    seat.appendChild(fan);
  } else {
    // Lower arc (horizontal fan): fan on TOP (near rim), info on BOTTOM (outer)
    seat.appendChild(fan);
    seat.appendChild(infoGroup);
  }
}

/* ── Your zone ───────────────────────────────────────────────────────────── */
function renderYourZone(me, { selectable = false, playerIdx = 0, numPlayers = 4, handOverride = null, onReorder = null, mustLeadKey = null } = {}) {
  const displayName = me?.name || state.myName || '?';
  document.getElementById('your-name-label').innerHTML =
    `${displayName} <span style="font-size:0.7em;opacity:0.6;font-weight:400">(you)</span>`;
  const hand = handOverride || me.hand || [];
  const animate = shouldAnimate(me.id, hand.length);
  // Full-deal only: animate all cards with stagger; single draw: last card only (no dealConfig)
  const dealConfig = (animate && state.pendingDealAnim) ? getDealConfig(270, playerIdx, numPlayers) : null;
  const handEl = document.getElementById('your-hand');
  const selectedSet = new Set(state.selectedCards);
  renderFan(handEl, hand, { selectable, selectedSet, animate, dealConfig, onReorder, mustLeadKey });
}

/* ═══════════════════════════════════════════════════════════════════════════
   XÌ DÁCH (Vietnamese Blackjack — target 21)
═══════════════════════════════════════════════════════════════════════════ */
function xdStatusBadge(p) {
  // Returns a DOM element for the player's current status, or null
  if (p.natural)              return makeTextEl(p.natural, 'zone-status xd-natural');
  if (p.nguLinh)              return makeTextEl('Ngũ Linh 🀄', 'zone-status xd-natural');
  if (p.status === 'busted')  return makeTextEl('Quắc 💥', 'zone-status xd-bust');
  if (p.status === 'danNon')  return makeTextEl('Dằn Non ⚠', 'zone-status xd-bust');
  return null;
}

function renderXiDach(gs) {
  const me     = gs.players.find(p => p.isYou);
  const others = gs.players.filter(p => !p.isYou);
  const numPlayersTotal = gs.players.length + 1; // +1 for dealer

  /* ── Dealer seat (top center 90°) ─────────────────────────────────────── */
  const dealerSeat = createSeat(90);
  const dFan = document.createElement('div');
  dFan.className = 'fan-hand';   // full-size, readable from player's side
  const animDealer = shouldAnimate('dealer', gs.dealer.hand?.length || 0);
  const dealerCfg  = (animDealer && state.pendingDealAnim)
    ? getDealConfig(90, gs.players.length, numPlayersTotal) : null;
  renderFan(dFan, gs.dealer.hand || [], { sm: false, animate: animDealer, dealConfig: dealerCfg });
  // No rotation — card face readable from player perspective

  const dNameEl = document.createElement('div');
  dNameEl.className = 'zone-name';
  dNameEl.textContent = 'Dealer';

  const dInfo = document.createElement('div');
  dInfo.className = 'zone-status';
  const dNat = gs.dealer.natural;
  const dVal = gs.dealer.value;
  let dInfoText = '';
  if (dNat)                    dInfoText = dNat;
  else if (gs.dealer.nguLinh)  dInfoText = 'Ngũ Linh!';
  else if (gs.dealer.busted)   dInfoText = 'Quắc 💥';
  else if (dVal && dVal !== '?') dInfoText = `${dVal}`;
  dInfo.textContent = dInfoText;

  dealerSeat.append(dFan, dNameEl, dInfo);

  /* ── Other player seats ────────────────────────────────────────────────── */
  const bjAngles = topArcAngles(others.length);
  others.forEach((p, i) => {
    const origIdx = gs.players.indexOf(p);
    const extras  = [];
    const badge   = xdStatusBadge(p);
    if (badge) extras.push(badge);
    if (p.bet)    extras.push(makeTextEl(`Bet: ${p.bet}`, 'zone-bet'));
    buildOpponentSeat(bjAngles[i] ?? 60, p, p.id === gs.currentPlayer, {
      showHand: gs.phase === 'ended', sm: true, noChips: true,
      playerIdx: origIdx, numPlayers: numPlayersTotal,
      extras,
    });
  });

  /* ── Your hand ─────────────────────────────────────────────────────────── */
  renderYourZone(me, {
    selectable: false,
    playerIdx: gs.players.indexOf(me),
    numPlayers: numPlayersTotal,
  });

  const myVal  = me?.value ?? 0;
  const myNat  = me?.natural;
  const myNgu  = me?.nguLinh;
  const myBust = me?.status === 'busted';
  const myDN   = me?.status === 'danNon';

  const info = document.getElementById('your-info');
  const xdBetting = gs.phase === 'betting';
  info.innerHTML = `
    <span class="chips">Chips: ${me?.chips ?? 0}</span>
    ${!xdBetting && (me?.bet ?? 0) ? `<span class="bet-d">Bet: ${me.bet}</span>` : ''}
    ${!xdBetting ? (myNat ? `<span class="badge badge-win">${myNat}</span>`
            : myNgu ? `<span class="badge badge-win">Ngũ Linh 🀄</span>`
            : myBust ? `<span class="badge badge-loss">Quắc 💥</span>`
            : myDN   ? `<span class="badge badge-loss">Dằn Non ⚠</span>`
            : '') : ''}
    ${me?.result ? badgeHtml(me.result) : ''}
  `;

  /* ── Actions ───────────────────────────────────────────────────────────── */
  const actions = document.getElementById('action-area');
  const status  = document.getElementById('status-message');

  if (gs.phase === 'betting') {
    if (me?.status === 'betting') {
      if ((me?.chips ?? 0) === 0) {
        status.textContent = 'Hết chip! · Out of chips';
        actions.appendChild(makeBtn(`Rebuy (+${state.deposit} chips)`, 'btn-primary',
          () => emit('game-action', { type: 'rebuy' })));
      } else {
        status.textContent = '';
        state.betSelection = 0;
        actions.appendChild(buildChipUI({
          maxChips:     me?.chips ?? state.deposit,
          confirmLabel: 'Đặt Cược',
          minAmount:    10,
          onConfirm: (amt) => emit('game-action', { type: 'bet', amount: amt }),
        }));
      }
    } else {
      status.textContent = 'Đã đặt cược. Chờ người chơi khác…';
    }
    return;
  }

  if (gs.phase === 'playing') {
    if (me?.id === gs.currentPlayer && me?.status === 'playing') {
      const underAge = myVal < 16;
      status.textContent = `Điểm: ${myVal}`;

      actions.append(
        makeBtn('Bốc · Draw', 'btn-action', () => emit('game-action', { type: 'boc' })),
        makeBtn(
          underAge ? `Dằn Non (${myVal}) ⚠` : 'Dằn · Stand',
          underAge ? 'btn-ghost' : 'btn-call',
          () => emit('game-action', { type: 'dan' }),
        ),
      );
    } else {
      const cur = gs.players.find(p => p.id === gs.currentPlayer);
      status.textContent = cur ? `${cur.name} đang bốc bài…` : 'Đang chờ…';
    }
    return;
  }

  if (gs.phase === 'ended') {
    const resMap = { win: 'THẮNG 🎉', lose: 'THUA', push: 'HÒA (Chạy Làng)' };
    const resLbl = resMap[me?.result] || '';
    const amt    = me?.resultAmt ?? 0;
    const amtTxt = amt > 0 ? `+${amt}` : `${amt}`;

    if (myNat)      status.textContent = `${myNat} — ${resLbl} · ${amtTxt} chips`;
    else if (myNgu) status.textContent = `Ngũ Linh — ${resLbl} · ${amtTxt} chips`;
    else            status.textContent = resLbl ? `${resLbl} · ${amtTxt} chips` : '';

    if (gs.dealer.natural) {
      document.getElementById('status-message').textContent +=
        gs.dealer.natural ? `  |  Nhà cái: ${gs.dealer.natural}` : '';
    }

    actions.appendChild(makeBtn('Ván Mới · Next Round', 'btn-primary',
      () => emit('game-action', { type: 'newRound' })));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   BLACKJACK
═══════════════════════════════════════════════════════════════════════════ */
function renderBlackjack(gs) {
  const me     = gs.players.find(p => p.isYou);
  const others = gs.players.filter(p => !p.isYou);
  // Deal order: all players first (by position in gs.players), dealer last
  const numPlayersTotal = gs.players.length + 1; // +1 for dealer

  // Dealer always at top center (90°)
  const dealerSeat = createSeat(90);
  const dFan = document.createElement('div');
  dFan.className = 'fan-hand';   // full-size, readable from player's side
  const animDealer = shouldAnimate('dealer', gs.dealer.hand?.length || 0);
  const dealerConfig = animDealer ? getDealConfig(90, gs.players.length, numPlayersTotal) : null;
  renderFan(dFan, gs.dealer.hand || [], { sm: false, animate: animDealer, dealConfig: dealerConfig });
  // No rotation — card face readable from player perspective

  const dNameEl2 = document.createElement('div');
  dNameEl2.className = 'zone-name';
  dNameEl2.textContent = 'Dealer';

  const dVal = document.createElement('div');
  dVal.className = 'zone-status';
  const bjDealerVal = gs.dealer.value;
  if (bjDealerVal && bjDealerVal !== '?' && gs.phase !== 'playing' && gs.phase !== 'insurance') {
    dVal.textContent = `${bjDealerVal}${gs.dealer.status === 'busted' ? ' 💥' : ''}`;
  }
  dealerSeat.append(dFan, dNameEl2, dVal);

  // Other human/bot players spread around the oval avoiding 90°
  const bjAngles = topArcAngles(others.length);
  others.forEach((p, i) => {
    const origIdx = gs.players.indexOf(p);
    const extras  = [];
    // Show all split hands inline in the seat
    if (p.hands?.length > 1) {
      const splitWrap = makeEl('div', 'bj-split-hands');
      p.hands.forEach((h, hi) => {
        const hEl = makeEl('div', 'bj-split-hand' + (hi === p.activeHandIndex && p.isCurrentPlayer ? ' bj-active-hand' : ''));
        const hFan = makeEl('div', 'fan-hand-sm');
        renderFan(hFan, h.cards, { sm: true });
        const hLbl = makeEl('div', 'zone-status');
        hLbl.textContent = `${h.value} · Bet:${h.bet}${h.result ? ' · ' + h.result.toUpperCase() : ''}`;
        hEl.append(hFan, hLbl);
        splitWrap.appendChild(hEl);
      });
      extras.push(splitWrap);
    } else {
      if (p.result) extras.push(makeBadge(p.result));
      if (gs.phase === 'ended' && p.value) extras.push(makeTextEl(`${p.value} pts`, 'zone-status'));
    }
    // Show a shield badge during insurance phase so the user can see who has decided
    if (gs.phase === 'insurance') {
      const insBadge = makeEl('div', 'zone-status');
      insBadge.textContent = p.insuranceDecided ? '🛡️ ✓' : '🛡️ …';
      extras.push(insBadge);
    }
    buildOpponentSeat(bjAngles[i] ?? 60, p, p.id === gs.currentPlayer, {
      showHand: gs.phase === 'ended', sm: true,
      playerIdx: origIdx, numPlayers: numPlayersTotal, extras,
    });
  });

  // Your hand — show all split hands if any
  const myHands = me?.hands ?? [];
  const activeHand = myHands[me?.activeHandIndex ?? 0];

  if (myHands.length > 1) {
    // Render split hands side-by-side in your zone
    const handEl = document.getElementById('your-hand');
    handEl.innerHTML = '';
    handEl.style.display = 'flex';
    handEl.style.gap = '18px';
    handEl.style.justifyContent = 'center';
    myHands.forEach((h, hi) => {
      const wrap = makeEl('div', 'bj-split-hand' + (hi === (me?.activeHandIndex ?? 0) ? ' bj-active-hand' : ''));
      const fan  = makeEl('div', 'fan-hand');
      renderFan(fan, h.cards, { sm: false });
      const lbl  = makeEl('div', 'zone-status');
      lbl.textContent = `Điểm: ${h.value}${h.result ? ' · ' + h.result.toUpperCase() : ''}`;
      wrap.append(fan, lbl);
      handEl.appendChild(wrap);
    });
    const _dn = me?.name || state.myName || '?';
    document.getElementById('your-name-label').innerHTML =
      `${_dn} <span style="font-size:0.7em;opacity:0.6;font-weight:400">(you)</span>`;
  } else {
    renderYourZone(me, { selectable: false, playerIdx: gs.players.indexOf(me), numPlayers: numPlayersTotal });
  }

  const info = document.getElementById('your-info');
  const bjBetting = gs.phase === 'betting';
  info.innerHTML = `
    <span class="chips">Chips: ${me?.chips ?? 0}</span>
    ${!bjBetting && (activeHand?.bet ?? me?.bet ?? 0) ? `<span class="bet-d">Bet: ${activeHand?.bet ?? me?.bet ?? 0}</span>` : ''}
    ${gs.myInsuranceBet ? `<span class="bet-d">🛡️ ${gs.myInsuranceBet}</span>` : ''}
    ${myHands.length > 1 ? `<span class="badge badge-warn">Hand ${(me.activeHandIndex??0)+1}/${myHands.length}</span>` : ''}
    ${activeHand?.result ? badgeHtml(activeHand.result) : (me?.result ? badgeHtml(me.result) : '')}
  `;

  // Actions
  const actions = document.getElementById('action-area');
  const status  = document.getElementById('status-message');

  if (gs.phase === 'betting') {
    if (me?.overallStatus === 'betting') {
      if ((me?.chips ?? 0) === 0) {
        status.textContent = 'Out of chips!';
        actions.appendChild(makeBtn(`Rebuy (+${state.deposit} chips)`, 'btn-primary',
          () => emit('game-action', { type: 'rebuy' })));
      } else {
        status.textContent = '';
        state.betSelection = 0;
        actions.appendChild(buildChipUI({
          maxChips: me?.chips ?? state.deposit,
          confirmLabel: 'Place Bet',
          minAmount: 10,
          onConfirm: (amt) => emit('game-action', { type: 'bet', amount: amt }),
        }));
      }
    } else if (me?.overallStatus === 'out') {
      status.textContent = 'Out of chips!';
      actions.appendChild(makeBtn(`Rebuy (+${state.deposit} chips)`, 'btn-primary',
        () => emit('game-action', { type: 'rebuy' })));
    } else { status.textContent = 'Bet placed. Waiting for others…'; }
  } else if (gs.phase === 'insurance') {
    if (!gs.myInsuranceDecided) {
      const maxBet = gs.myInsuranceMax ?? 0;
      status.textContent = '';
      const insRow = makeEl('div', 'poker-action-row');
      const insWrap = makeEl('div', 'insurance-prompt');
      insWrap.innerHTML =
        `<div class="insurance-title">🛡️ Insurance?</div>` +
        `<div class="insurance-sub">Dealer shows <strong>A</strong> — insure for <strong>${maxBet}</strong> chips (pays 2:1 if dealer has Blackjack)</div>`;
      const yesBtn = makeBtn('Yes — Insure', 'btn-insurance-yes',
        () => emit('game-action', { type: 'insurance-yes' }), maxBet === 0 || (me?.chips ?? 0) < maxBet);
      const noBtn  = makeBtn('No Thanks',    'btn-insurance-no',
        () => emit('game-action', { type: 'insurance-no' }));
      insRow.append(yesBtn, noBtn);
      actions.append(insWrap, insRow);
    } else {
      status.textContent = 'Insurance decided. Waiting for others…';
    }
  } else if (gs.phase === 'playing') {
    if (me?.id === gs.currentPlayer) {
      const hand   = activeHand;
      const canDbl = hand?.cards?.length === 2 && (me?.chips ?? 0) >= (hand?.bet ?? 0);
      // Can split: 2 cards, same rank only (standard rules — Q+J cannot split), enough chips, max 4 hands
      const [s1, s2] = hand?.cards ?? [];
      const sameRank = s1 && s2 && s1.rank === s2.rank;
      const canSplit = hand?.cards?.length === 2 && sameRank &&
        (me?.chips ?? 0) >= (hand?.bet ?? 0) && myHands.length < 4;

      const handLabel = myHands.length > 1 ? ` (Hand ${(me.activeHandIndex??0)+1})` : '';
      status.textContent = handLabel ? handLabel.trim() : '';

      const bjRow = makeEl('div', 'poker-action-row');
      bjRow.append(
        makeBtn('Hit',    'btn-action', () => emit('game-action',{type:'hit'})),
        makeBtn('Stand',  'btn-call',   () => emit('game-action',{type:'stand'})),
        makeBtn('Double', 'btn-raise',  () => emit('game-action',{type:'double'}), !canDbl),
        makeBtn('Split',  'btn-split',  () => emit('game-action',{type:'split'}),  !canSplit),
      );
      actions.appendChild(bjRow);
    } else {
      const cur = gs.players.find(p => p.id === gs.currentPlayer);
      status.textContent = cur ? `${cur.name}'s turn…` : '';
    }
  } else if (gs.phase === 'dealer') {
    status.textContent = 'Dealer is playing…';
  } else if (gs.phase === 'ended') {
    // Summarise all hands
    if (myHands.length > 1) {
      const summary = myHands.map((h, i) =>
        `Hand ${i+1}: ${h.result?.toUpperCase() ?? '—'} (${h.value})`).join(' · ');
      status.textContent = summary;
    } else {
      const lbl = { win:'WIN 🎉', loss:'Loss', push:'Push', bust:'Bust', blackjack:'Blackjack! 🃏' };
      status.textContent = lbl[me?.result] || '';
    }
    actions.appendChild(makeBtn('Next Round','btn-primary', () => emit('game-action',{type:'newRound'})));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   POKER
═══════════════════════════════════════════════════════════════════════════ */
function renderPoker(gs) {
  const me     = gs.players.find(p => p.isYou);
  const others = gs.players.filter(p => !p.isYou);
  const angles = fullTableAngles(others.length); // full oval spread
  const numPlayersTotal = gs.players.length;

  others.forEach((p, i) => {
    const origIdx = gs.players.indexOf(p);
    const extras = [];
    if (p.totalBet)                              extras.push(makeTextEl(`Bet: ${p.totalBet}`, 'zone-bet'));
    if (p.status === 'folded')                   extras.push(makeTextEl('Folded', 'zone-status'));
    if (gs.phase === 'showdown' && p.handName)   extras.push(makeTextEl(p.handName, 'zone-status'));
    buildOpponentSeat(angles[i], p, p.id === gs.currentPlayer, {
      sm: true, showHand: gs.phase === 'showdown', extras,
      playerIdx: origIdx, numPlayers: numPlayersTotal,
    });
  });

  // Community cards
  if (gs.community?.length) {
    const comm = document.getElementById('community-cards');
    const animComm = shouldAnimate('community', gs.community.length);
    renderFan(comm, gs.community, { animate: animComm });
  }
  const potEl = document.getElementById('pot-display');
  if (gs.pot) potEl.textContent = `Pot: ${gs.pot}`;

  const phaseLabel = { preflop:'Pre-Flop', flop:'Flop', turn:'Turn', river:'River', showdown:'Showdown' };
  document.getElementById('game-round').textContent = `Round ${gs.round} · ${phaseLabel[gs.phase] || gs.phase}`;

  // Your hand
  renderYourZone(me, { selectable: false, playerIdx: gs.players.indexOf(me), numPlayers: numPlayersTotal });
  const info = document.getElementById('your-info');
  info.innerHTML = `
    <span class="chips">Chips: ${me?.chips ?? 0}</span>
    ${me?.totalBet ? `<span class="bet-d">Bet: ${me.totalBet}</span>` : ''}
    ${me?.isDealer ? '<span class="badge">Dealer</span>' : ''}
    ${gs.phase === 'showdown' && me?.handName ? `<span class="badge badge-win">${me.handName}</span>` : ''}
    ${me?.status === 'folded' ? '<span class="badge badge-loss">Folded</span>' : ''}
  `;

  // Actions
  const actions = document.getElementById('action-area');
  const status  = document.getElementById('status-message');

  if (gs.phase === 'showdown') {
    const wNames = (gs.winners||[]).map(w => w.name + (w.handName ? ` (${w.handName})` : '')).join(', ');
    status.textContent = wNames ? 'Winner: ' + wNames : '';
    actions.appendChild(makeBtn('Next Hand','btn-primary', () => emit('game-action',{type:'newHand'})));
    return;
  }

  if (me?.id === gs.currentPlayer && me?.status === 'active') {
    status.textContent = '';
    const callAmt = (gs.currentBet || 0) - (me.bet || 0);
    const minRaise = (gs.currentBet || 0) + (gs.bigBlind || 10);

    // Row 1: Fold + Call/Check + All-In
    const row1 = makeEl('div', 'poker-action-row');
    row1.append(
      makeBtn('Fold', 'btn-fold btn-small', () => emit('game-action',{type:'fold'})),
      callAmt <= 0
        ? makeBtn('Check', 'btn-call btn-small', () => emit('game-action',{type:'check'}))
        : makeBtn(`Call ${callAmt}`, 'btn-call btn-small', () => emit('game-action',{type:'call'})),
      makeBtn('All-In', 'btn-allin btn-small', () => emit('game-action',{type:'raise', amount:(me?.chips??0)+(me?.bet??0)}),
        (me?.chips??0) === 0),
    );
    actions.appendChild(row1);

    // Row 2: chip selector + raise — compact inline layout
    if ((me?.chips ?? 0) > 0) {
      state.betSelection = 0;
      const row2 = makeEl('div', 'poker-action-row');
      row2.appendChild(buildChipUI({
        maxChips: me?.chips ?? state.deposit,
        confirmLabel: 'Raise',
        minAmount: minRaise,
        onConfirm: (amt) => emit('game-action', { type: 'raise', amount: amt }),
      }));
      actions.appendChild(row2);
    }
  } else {
    const cur = gs.players.find(p => p.id === gs.currentPlayer);
    status.textContent = cur ? `Waiting for ${cur.name}…` : '';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   TIẾN LÊN
═══════════════════════════════════════════════════════════════════════════ */
function renderTienLen(gs) {
  const me     = gs.players.find(p => p.isYou);
  const others = gs.players.filter(p => !p.isYou);
  const angles = fullTableAngles(others.length);
  const numPlayersTotal = gs.players.length;

  others.forEach((p, i) => {
    const origIdx = gs.players.indexOf(p);
    const extras = [];
    if (p.place) extras.push(makeTextEl(`🏆 #${p.place}`, 'zone-status'));
    else if (p.status === 'passed') extras.push(makeTextEl('Passed', 'zone-status tl-passed'));
    // Show chip delta only at round end
    if (gs.phase === 'ended' && p.chipDelta != null) {
      const sign = p.chipDelta > 0 ? '+' : '';
      extras.push(makeTextEl(`${sign}${p.chipDelta} chips`,
        'zone-status ' + (p.chipDelta >= 0 ? 'chip-gain' : 'chip-loss')));
    }
    buildOpponentSeat(angles[i], p, p.id === gs.currentPlayer, {
      sm: true, faceDown: true, cardCount: p.cardCount, extras, noChips: true,
      playerIdx: origIdx, numPlayers: numPlayersTotal,
    });
  });

  // ── Center display: latest play only (no history labels) ──
  const lp = document.getElementById('last-play-display');

  // Tới trắng announcements shown prominently above the cards
  if (gs.toiTrangAnnouncements?.length) {
    gs.toiTrangAnnouncements.forEach(({ name, label }) => {
      const ann = makeEl('div', 'toi-trang-ann');
      ann.textContent = `🎉 ${name}: ${label}`;
      lp.appendChild(ann);
    });
  }

  if (gs.tableCards) {
    // Face-down when trick just won (no active play to beat) = cards being "swept away"
    const faceDown = !gs.lastPlay;
    const cardsKey  = gs.tableCards.cards.map(c => c.rank + c.suit).join(',');
    const isNewPlay = !faceDown && cardsKey !== state.prevTableKey;
    if (!faceDown) state.prevTableKey = cardsKey;

    const row = makeEl('div', 'trick-cards-latest' + (faceDown ? ' trick-face-down' : ''));
    const playAngle = isNewPlay ? getPlayerAngle(gs, gs.tableCards.playerId) : null;
    gs.tableCards.cards.forEach((c, idx) => {
      const cardEl = makeCard(faceDown ? { suit: 'hidden', rank: '?' } : c);
      if (isNewPlay) applyPlayAnim(cardEl, playAngle, idx * 0.055);
      row.appendChild(cardEl);
    });
    lp.appendChild(row);

  }

  // Your hand (selectable) — detect new deal to reset sort state
  const tlHandKey = (me?.hand||[]).map(c => c.rank+c.suit).sort().join(',');
  if (tlHandKey !== state.tlHandKey) {
    state.tlHandKey      = tlHandKey;
    state.tlOriginalHand = [...(me?.hand||[])];
    state.tlSorted       = false;
  }
  state.selectedCards = state.selectedCards.filter(k => (me?.hand||[]).some(c => c.rank+c.suit === k));

  // First play of the round: auto-select 3♠ if it's the human's turn and nothing selected yet
  const isFirstPlay = gs.firstRound && !gs.lastPlay && me?.id === gs.currentPlayer && me?.status === 'active';
  if (isFirstPlay && state.selectedCards.length === 0) {
    const hasSpade3 = (me?.hand||[]).find(c => c.rank === '3' && c.suit === 'spades');
    if (hasSpade3) state.selectedCards = ['3spades'];
  }

  const tlDisplayHand = state.tlSorted ? _tlSortHand(me?.hand||[]) : state.tlOriginalHand.filter(c => (me?.hand||[]).some(h => h.rank+h.suit === c.rank+c.suit));
  const meForRender = { ...me, hand: tlDisplayHand };
  const mustLeadKey = isFirstPlay ? '3spades' : null;
  renderYourZone(meForRender, { selectable: true, playerIdx: gs.players.indexOf(me), numPlayers: numPlayersTotal, mustLeadKey });
  const info = document.getElementById('your-info');
  const tlDelta = gs.phase === 'ended' && me?.chipDelta != null ? me.chipDelta : null;
  info.innerHTML = `
    <span class="chips">${me?.chips ?? 0}${tlDelta != null ? ` <em style="color:${tlDelta>=0?'#4caf50':'#e53935'}">(${tlDelta>0?'+':''}${tlDelta})</em>` : ''}</span>
    ${me?.place ? `<span class="badge badge-win">#${me.place} Finished</span>` : ''}
    ${me?.status === 'passed' ? `<span class="badge badge-passed">Passed</span>` : ''}
    ${me?.toiTrang ? `<span class="badge badge-win">${me.toiTrang}</span>` : ''}
  `;

  const actions = document.getElementById('action-area');
  const status  = document.getElementById('status-message');

  if (gs.phase === 'ended') {
    const ranking = gs.players.filter(p => p.place).sort((a,b) => a.place-b.place)
      .map(p => {
        const delta = p.chipDelta;
        const chip  = delta != null ? ` (${delta > 0 ? '+' : ''}${delta})` : '';
        return `#${p.place} ${p.name}${chip}`;
      }).join(' · ');
    status.textContent = 'Game over! ' + ranking;
    actions.appendChild(makeBtn('New Round','btn-primary', () => emit('game-action',{type:'newRound'})));
    return;
  }

  const tlRow = makeEl('div', 'poker-action-row');

  if (me?.id === gs.currentPlayer && me?.status === 'active') {
    const sel = new Set(state.selectedCards);
    const isLead = !gs.lastPlay;
    status.textContent = sel.size ? `${sel.size} card(s) selected` : '';

    const playBtn = makeBtn(
      sel.size ? `▶ Play (${sel.size})` : '▶ Play',
      sel.size ? 'btn-tl-play btn-tl-play--ready' : 'btn-tl-play',
      () => { const cards=(me.hand||[]).filter(c=>sel.has(c.rank+c.suit)); emit('game-action',{type:'play',cards}); state.selectedCards=[]; },
      sel.size === 0);
    const passBtn = makeBtn('✕ Pass', isLead ? 'btn-tl-pass btn-tl-pass--disabled' : 'btn-tl-pass',
      () => { emit('game-action',{type:'pass'}); state.selectedCards=[]; },
      isLead);
    tlRow.append(playBtn, passBtn);
  } else {
    const cur = gs.players.find(p => p.id === gs.currentPlayer);
    status.textContent = cur ? `Waiting for ${cur.name}…` : '';
  }

  if (tlRow.children.length) actions.appendChild(tlRow);

  // Win order sidebar
  if (gs.winOrder?.length) {
    const m = document.getElementById('melds-area');
    const t = makeTextEl('Finished', 'meld-group-title'); m.appendChild(t);
    gs.winOrder.forEach((id, i) => {
      const p = gs.players.find(pl => pl.id===id);
      m.appendChild(makeTextEl(`#${i+1} ${p?.name||id}`, ''));
    });
  }
}

/* ── Tiến Lên card sort helper ──────────────────────────────────────────── */
function _tlCardOrder(card) {
  const rankVal = {'3':0,'4':1,'5':2,'6':3,'7':4,'8':5,'9':6,'10':7,'J':8,'Q':9,'K':10,'A':11,'2':12}[card.rank] ?? 0;
  const suitVal = {spades:0, clubs:1, diamonds:2, hearts:3}[card.suit] ?? 0;
  return rankVal * 4 + suitVal;
}
function _tlSortHand(hand) {
  return [...hand].sort((a, b) => _tlCardOrder(a) - _tlCardOrder(b));
}

/* ── Phỏm client-side meld helpers (mirror of server logic) ─────────────── */
function _phomRankVal(rank) {
  return { A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13 }[rank] ?? 0;
}
function _phomIsMeld(cards) {
  if (cards.length < 3) return false;
  if (new Set(cards.map(c => c.rank)).size === 1) return true; // set
  if (new Set(cards.map(c => c.suit)).size !== 1) return false; // run must be same suit
  const vals = cards.map(c => _phomRankVal(c.rank)).sort((a,b) => a-b);
  if (new Set(vals).size !== vals.length) return false;
  for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i-1]+1) return false;
  return true;
}
/** Can player take top discard? True if card forms new meld with 2 hand cards OR extends any meld */
function phomCanTakeDiscard(hand, card, allMelds) {
  // New meld: card + any 2 from hand
  for (let i = 0; i < hand.length; i++)
    for (let j = i+1; j < hand.length; j++)
      if (_phomIsMeld([card, hand[i], hand[j]])) return true;
  // Extend existing meld
  for (const meld of allMelds)
    if (_phomIsMeld([...meld, card])) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHỎM
═══════════════════════════════════════════════════════════════════════════ */
function renderPhom(gs) {
  const me     = gs.players.find(p => p.isYou);
  const others = gs.players.filter(p => !p.isYou);
  const angles = fullTableAngles(others.length);
  const sel    = new Set(state.selectedCards);
  const numPlayersTotal = gs.players.length;

  // Counter-clockwise: next player index is (currentIdx - 1 + n) % n
  const curIdx       = gs.players.findIndex(p => p.id === gs.currentPlayer);
  const nextPlayerId = gs.players[(curIdx - 1 + gs.players.length) % gs.players.length]?.id;

  // Precompute all currently laid-down melds (for ăn eligibility check)
  const allMelds = gs.players.flatMap(p => p.melds ?? []);
  const myHand   = me?.hand ?? [];
  // Is the top discard takeable by the current player?
  const isMyDrawTurn = me?.id === gs.currentPlayer && gs.phase === 'draw' && !gs.drewCard;
  const topDiscardEligible = isMyDrawTurn && gs.topDiscard
    ? phomCanTakeDiscard(myHand, gs.topDiscard, allMelds)
    : false;

  others.forEach((p, i) => {
    const origIdx = gs.players.indexOf(p);
    const extras = [];

    // Chips always visible in seat
    if (gs.phase !== 'ended') {
      extras.push(makeTextEl(`${p.chips ?? 0} chips`, 'zone-status'));
    }
    // Discard count badge (e.g. "2/4 lượt")
    if (gs.phase !== 'ended') {
      extras.push(makeTextEl(`${p.discardCount ?? 0}/${gs.discardLimit ?? 4} lượt`, 'zone-status'));
    }
    // card count removed per UI cleanup
    if (gs.phase === 'ended') {
      if (p.isMom) extras.push(makeTextEl('Móm 😬', 'zone-status phom-mom'));
      else extras.push(makeTextEl(`${p.points} điểm chết`, 'zone-status'));
      if (p.chipDelta != null) {
        extras.push(makeTextEl(
          `${p.chipDelta > 0 ? '+' : ''}${p.chipDelta} chips`,
          'zone-status ' + (p.chipDelta >= 0 ? 'chip-gain' : 'chip-loss'),
        ));
      }
    }
    // Melds — shown only during settling/ended (auto-detected at round end)
    const revealOpp = gs.phase === 'settling' || gs.phase === 'ended';
    if (revealOpp && p.melds?.length) {
      const meldWrap = makeEl('div', 'seat-melds');
      const meldLbl = makeTextEl('Phỏm', 'phom-discard-lbl');
      meldWrap.appendChild(meldLbl);
      p.melds.forEach((meld, meldIdx) => {
        const row = makeEl('div', 'seat-meld-row');
        meld.forEach(c => row.appendChild(makeCard(c, { sm: true })));
        // Drop-zone only for earlier settlers when it's my settle turn
        const mySettlePos = gs.settleOrder?.indexOf(me?.id) ?? -1;
        const targetSettlePos = gs.settleOrder?.indexOf(p.id) ?? -1;
        const isDroppable = gs.phase === 'settling'
          && mySettlePos === gs.settleIndex
          && targetSettlePos >= 0 && targetSettlePos < mySettlePos;
        if (isDroppable) {
          row.setAttribute('data-meld-target', '');
          row.dataset.targetPlayerId = p.id;
          row.dataset.meldIndex = String(meldIdx);
          row.classList.add('meld-drop-zone');
          row.title = `Gửi quân vào phỏm ${meldIdx + 1} của ${p.name}`;
        }
        meldWrap.appendChild(row);
      });
      extras.push(meldWrap);
    }

    // Dead cards — shown face-up during settling/ended so everyone can verify
    if (revealOpp && p.deadCards?.length) {
      const deadWrap = makeEl('div', 'phom-player-discards');
      const deadGrid = makeEl('div', 'phom-discard-grid');
      p.deadCards.forEach(c => deadGrid.appendChild(makeCard(c, { sm: true })));
      deadWrap.appendChild(deadGrid);
      deadWrap.appendChild(makeTextEl('bài chết', 'phom-discard-lbl'));
      extras.push(deadWrap);
    }

    // Per-player discard grid (only during draw/discard phase)
    const playerDiscards = !revealOpp ? (gs.discardsByPlayer?.[p.id] ?? []) : [];
    if (playerDiscards.length > 0) {
      const grid = makeEl('div', 'phom-discard-grid');
      playerDiscards.forEach((card, ci) => {
        const isTop = ci === playerDiscards.length - 1 && p.id === gs.lastDiscarderId;
        const cEl = makeCard(card, { sm: true });
        if (isTop) {
          cEl.classList.add('phom-top-discard');
          if (topDiscardEligible) {
            cEl.classList.add('phom-can-an');
            cEl.title = 'Ăn bài này (click to take)';
            cEl.addEventListener('click', () => emit('game-action', { type: 'takeDiscard' }));
          } else if (isMyDrawTurn) {
            cEl.classList.add('phom-cant-an');
            cEl.title = 'Không thể ăn — phải bốc từ nọc';
          }
        }
        grid.appendChild(cEl);
      });
      const lbl = makeTextEl('bài đánh', 'phom-discard-lbl');
      const wrap = makeEl('div', 'phom-player-discards');
      wrap.appendChild(grid);
      wrap.appendChild(lbl);
      extras.push(wrap);
    }

    buildOpponentSeat(angles[i], p, p.id === gs.currentPlayer, {
      sm: true, cardCount: p.cardCount, extras,
      playerIdx: origIdx, numPlayers: numPlayersTotal,
    });
  });

  // ── Centre table: deck pile + top discard ───────────────────────────────────
  const discardArea = document.getElementById('discard-area');
  discardArea.classList.add('phom-center');

  if (gs.deckCount > 0) {
    const pile = makeEl('div','deck-pile phom-deck');
    pile.appendChild(makeTextEl(gs.deckCount,'deck-count'));
    const deckLbl = makeTextEl('nọc (deck)','phom-discard-lbl');
    const deckWrap = makeEl('div','phom-discard-wrap');
    deckWrap.appendChild(pile);
    deckWrap.appendChild(deckLbl);
    if (isMyDrawTurn) {
      pile.style.cursor = 'pointer'; pile.title = 'Bốc bài từ nọc (Draw)';
      pile.classList.add('phom-can-draw');
      pile.addEventListener('click', () => emit('game-action',{type:'draw'}));
    }
    discardArea.appendChild(deckWrap);
  }

  // Top discard — shown on the table next to the deck so everyone can see it
  if (gs.topDiscard && gs.phase !== 'ended') {
    const tdCard = makeCard(gs.topDiscard, { sm: false });
    if (topDiscardEligible) {
      tdCard.classList.add('phom-top-discard');
      tdCard.title = 'Lấy bài này (take discard)';
      tdCard.style.cursor = 'pointer';
      tdCard.addEventListener('click', () => emit('game-action', { type: 'takeDiscard' }));
    }
    const tdLbl  = makeTextEl('bài bỏ', 'phom-discard-lbl');
    const tdWrap = makeEl('div', 'phom-discard-wrap');
    tdWrap.appendChild(tdCard);
    tdWrap.appendChild(tdLbl);
    discardArea.appendChild(tdWrap);
  }

  // ── Your hand (or dead cards during settling) — drag-to-reorder ─────────
  const revealPhase = gs.phase === 'settling' || gs.phase === 'ended';
  state.selectedCards = state.selectedCards.filter(k => (me?.hand||[]).some(c => c.rank+c.suit===k));
  // During settling, me.hand = deadCards (server maps it that way); no reorder needed then
  const displayedHand = revealPhase ? (me?.hand || []) : getPhomHandSorted(me?.hand || []);
  renderYourZone(me, {
    selectable: true,
    playerIdx: gs.players.indexOf(me),
    numPlayers: numPlayersTotal,
    handOverride: displayedHand,
    onReorder: revealPhase ? null : (fromIdx, toIdx) => {
      const keys = displayedHand.map(c => c.rank + c.suit);
      const [moved] = keys.splice(fromIdx, 1);
      keys.splice(toIdx, 0, moved);
      state.phomHandOrder = keys;
      renderGame(state.gameState);
    },
  });

  // During settling: make dead cards gui-draggable for cross-seat gửi
  if (gs.phase === 'settling' && me?.id === gs.currentPlayer) {
    const mySettlePos = gs.settleOrder?.indexOf(me?.id) ?? -1;
    const hasTargets = gs.settleOrder?.slice(0, mySettlePos).some(pid => {
      const p = gs.players.find(q => q.id === pid);
      return p?.melds?.length > 0;
    });
    if (hasTargets) {
      const handEl = document.getElementById('your-hand');
      handEl.querySelectorAll('.card:not(.hidden)').forEach(cardEl => {
        const rank = cardEl.dataset.rank;
        const suit = cardEl.dataset.suit;
        if (!rank || !suit) return;
        cardEl.style.cursor = 'grab';
        cardEl.addEventListener('pointerdown', e => {
          if (e.button !== 0 && e.pointerType === 'mouse') return;
          // Delay start slightly so clicks still work
          const startTimer = setTimeout(() => {
            _startGuiDrag({ rank, suit }, e);
            cardEl.style.opacity = '0.4';
          }, 120);
          const cancel = () => { clearTimeout(startTimer); cardEl.removeEventListener('pointerup', cancel); };
          cardEl.addEventListener('pointerup', cancel, { once: true });
        });
      });
    }
  }

  // Your melds (auto-detected, shown during settling/ended) + discard history
  const seatYou = document.getElementById('seat-you');
  seatYou.querySelectorAll('.your-melds, .phom-player-discards').forEach(el => el.remove());

  if (revealPhase && me?.melds?.length) {
    const myMeldsWrap = makeEl('div', 'your-melds');
    const lbl = makeTextEl('Phỏm của bạn', 'phom-discard-lbl');
    myMeldsWrap.appendChild(lbl);
    me.melds.forEach(meld => {
      const row = makeEl('div', 'seat-meld-row your-meld-row');
      meld.forEach(c => row.appendChild(makeCard(c, { sm: true })));
      myMeldsWrap.appendChild(row);
    });
    seatYou.appendChild(myMeldsWrap);
  }

  // Your own discard history — only show older discards (not topDiscard, which is on the table)
  if (!revealPhase) {
    const myDiscards = gs.discardsByPlayer?.[me?.id] ?? [];
    // All but the last card (topDiscard is shown on the table center already)
    const olderDiscards = myDiscards.length > 1 ? myDiscards.slice(0, -1) : [];
    if (olderDiscards.length > 0) {
      const myDiscardWrap = makeEl('div', 'phom-player-discards your-discards');
      const myGrid = makeEl('div', 'phom-discard-grid');
      olderDiscards.forEach(card => myGrid.appendChild(makeCard(card, { sm: true })));
      myDiscardWrap.appendChild(myGrid);
      myDiscardWrap.appendChild(makeTextEl('bài đã đánh', 'phom-discard-lbl'));
      seatYou.appendChild(myDiscardWrap);
    }
  }

  const myDiscardCount = me?.discardCount ?? 0;
  const discardLimit   = gs.discardLimit ?? 4;
  const inRound4       = myDiscardCount >= discardLimit - 1;

  const info = document.getElementById('your-info');
  const myChipDelta = gs.phase === 'ended' && me?.chipDelta != null ? me.chipDelta : null;
  const isSettling  = gs.phase === 'settling';

  info.innerHTML = `
    <span class="chips">Chips: ${me?.chips ?? 0}${myChipDelta != null ? ` <em style="color:${myChipDelta>=0?'#4caf50':'#e53935'}">(${myChipDelta>0?'+':''}${myChipDelta})</em>` : ''}</span>
    ${!isSettling && gs.phase !== 'ended' ? `<span>${me?.hand?.length??0} quân · ${myDiscardCount}/${discardLimit} lượt đánh</span>` : ''}
    ${isSettling ? `<span>${me?.hand?.length??0} bài chết · ${me?.melds?.length||0} phỏm</span>` : ''}
    ${gs.phase==='ended' && me?.isMom ? `<span class="badge badge-loss">Móm 😬</span>` : ''}
    ${gs.phase==='ended' && !me?.isMom ? `<span>Điểm chết: ${me?.points??0}</span>` : ''}
    ${!isSettling && gs.phase !== 'ended' ? `<span class="reorder-hint">kéo để sắp xếp</span>` : ''}
  `;

  const actions = document.getElementById('action-area');
  const status  = document.getElementById('status-message');

  /* ── Ended ──────────────────────────────────────────────────────────────── */
  if (gs.phase === 'ended') {
    if (gs.uWinner) {
      const winner = gs.players.find(p => p.id === gs.uWinner);
      status.textContent = winner ? `🎉 ${winner.name} Ù! Thắng ngay lập tức!` : 'Ù!';
    } else {
      const winner  = gs.players.find(p => p.id === gs.lastWinnerId);
      const momList = gs.players.filter(p => p.isMom).map(p => p.name).join(', ');
      status.textContent = winner
        ? `${winner.name} thắng (${winner.points ?? 0} điểm chết)${momList ? ' · Móm: ' + momList : ''}`
        : 'Kết thúc';
    }
    const chipSummary = gs.players
      .map(p => { if (p.chipDelta == null) return null; return `${p.name} (${p.chipDelta>0?'+':''}${p.chipDelta})`; })
      .filter(Boolean).join(' · ');
    if (chipSummary) {
      const chipEl = makeEl('div', 'status-chip-summary');
      chipEl.textContent = chipSummary;
      status.appendChild(chipEl);
    }
    actions.appendChild(makeBtn('Ván Mới · New Round', 'btn-primary', () => emit('game-action', { type: 'newRound' })));
    return;
  }

  /* ── Settling (gửi quân) ─────────────────────────────────────────────────── */
  if (isSettling) {
    const settlerIdx = gs.settleIndex ?? 1;
    const settleOrder = gs.settleOrder ?? [];
    const currentSettlerId = settleOrder[settlerIdx];
    const isMyTurn = me?.id === currentSettlerId;

    // Players who revealed before current settler — their melds are available targets
    const availableMeldTargets = settleOrder
      .slice(0, settlerIdx)
      .map(pid => gs.players.find(p => p.id === pid))
      .filter(p => p?.melds?.length > 0);

    if (!isMyTurn) {
      const cur = gs.players.find(p => p.id === currentSettlerId);
      status.textContent = cur ? `${cur.name} đang gửi quân…` : 'Đang gửi quân…';
      return;
    }

    const selArr = [...sel];
    const deadCards = me?.hand ?? []; // during settling hand = deadCards

    if (deadCards.length === 0) {
      status.textContent = 'Không còn bài chết — bấm Xong để tiếp tục';
    } else if (selArr.length === 0) {
      status.textContent = `${deadCards.length} bài chết — chọn quân muốn gửi, hoặc bấm Xong để bỏ qua`;
    } else {
      status.textContent = `${selArr.length} quân đang chọn — bấm vào phỏm bên dưới để gửi`;
    }

    // Gửi buttons for each accessible meld
    if (selArr.length > 0) {
      availableMeldTargets.forEach(target => {
        target.melds.forEach((meld, meldIdx) => {
          const meldLabel = meld.map(c => c.rank + SUIT_SYM[c.suit]).join('');
          actions.appendChild(makeBtn(
            `Gửi → ${target.name} [${meldLabel}]`, 'btn-ghost',
            () => {
              const cards = deadCards.filter(c => sel.has(c.rank + c.suit));
              if (!cards.length) return;
              emit('game-action', { type: 'guiQuan', targetPlayerId: target.id, meldIndex: meldIdx, cards });
              state.selectedCards = [];
            },
          ));
        });
      });
    }

    // Always show Done button
    actions.appendChild(makeBtn(
      availableMeldTargets.length === 0 ? 'Lộ Phỏm · Reveal' : 'Xong · Done',
      'btn-call',
      () => emit('game-action', { type: 'doneSettling' }),
    ));
    return;
  }

  /* ── Draw / Discard (normal play) ────────────────────────────────────────── */
  if (me?.id !== gs.currentPlayer) {
    const cur = gs.players.find(p => p.id === gs.currentPlayer);
    status.textContent = cur ? `Chờ ${cur.name}…` : '';
    return;
  }

  const selArr = [...sel];

  if (gs.phase === 'draw' && !gs.drewCard) {
    status.textContent = '';
  } else {
    status.textContent = selArr.length ? `${selArr.length} quân đang chọn` : '';

    // Discard (exactly 1 card selected)
    if (selArr.length === 1) {
      const card = (me.hand || []).find(c => c.rank + c.suit === selArr[0]);
      if (card) {
        actions.appendChild(makeBtn(
          `Đánh ${card.rank}${SUIT_SYM[card.suit]}`, 'btn-danger',
          () => { emit('game-action', { type: 'discard', card }); state.selectedCards = []; },
        ));
      }
    } else {
      actions.appendChild(makeBtn('Chọn 1 quân để đánh', 'btn-ghost', null, true));
    }
  }
}

/* ── Chip-stack bet UI ───────────────────────────────────────────────────── */
// denominations → chip class, colour label
const CHIP_DENOMS = [
  { val: 1,    cls: 'c1',   label: '1'   },
  { val: 5,    cls: 'c5',   label: '5'   },
  { val: 10,   cls: 'c10',  label: '10'  },
  { val: 25,   cls: 'c25',  label: '25'  },
  { val: 100,  cls: 'c100', label: '100' },
  { val: 500,  cls: 'c500', label: '500' },
  { val: 1000, cls: 'c1k',  label: '1K'  },
];

function buildChipUI({ maxChips = 1000, onConfirm, confirmLabel = 'Confirm', minAmount = 1 } = {}) {
  // Returns a wrapper div with chip buttons + tally + confirm button
  const wrap = makeEl('div', 'chip-ui');

  // Filter denoms to ones ≤ maxChips
  const denoms = CHIP_DENOMS.filter(d => d.val <= maxChips);

  const row = makeEl('div', 'chip-row');
  denoms.forEach(({ val, cls, label }) => {
    const btn = makeEl('button', `chip-btn ${cls}`);
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (state.betSelection + val > maxChips) return;
      state.betSelection += val;
      if (typeof SFX !== 'undefined') SFX.chip();
      updateTally();
    });
    row.appendChild(btn);
  });
  wrap.appendChild(row);

  const remainLabel = makeEl('div', 'chip-remain');
  remainLabel.textContent = `${maxChips} left`;
  wrap.appendChild(remainLabel);

  const tallyRow = makeEl('div', 'chip-tally-row');
  const tally = makeEl('div', 'chip-tally');
  tally.textContent = '0';
  const clearBtn = makeBtn('Clear', 'btn-ghost btn-small', () => { state.betSelection = 0; updateTally(); });
  const confirmBtn = makeBtn(confirmLabel, 'btn-action', () => {
    if (state.betSelection < minAmount) return;
    onConfirm(state.betSelection);
    state.betSelection = 0;
  });
  confirmBtn.disabled = true;
  tallyRow.append(tally, clearBtn, confirmBtn);
  wrap.appendChild(tallyRow);

  function updateTally() {
    tally.textContent = state.betSelection > 0 ? state.betSelection : '0';
    confirmBtn.disabled = state.betSelection < minAmount;
    const rem = maxChips - state.betSelection;
    remainLabel.textContent = `${rem} left`;
    remainLabel.style.color = rem < maxChips * 0.2 ? 'var(--cinnabar-bright)' : '';
  }

  return wrap;
}

/* ── Small DOM helpers ───────────────────────────────────────────────────── */
function makeEl(tag, cls) { const el = document.createElement(tag); if (cls) el.className = cls; return el; }
function makeTextEl(text, cls) { const el = makeEl('div', cls); el.textContent = text; return el; }
function makeBtn(label, cls, onClick, disabled = false) {
  const b = makeEl('button', 'btn ' + cls);
  b.textContent = label; b.disabled = disabled;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
function makeInput(type, value, min, max, step) {
  const el = document.createElement('input');
  el.type = type; el.value = value; el.min = min; el.max = max; el.step = step;
  return el;
}
function makeBadge(result) {
  const map = { win:'badge-win', loss:'badge-loss', push:'badge-push', bust:'badge-bust', blackjack:'badge-bj' };
  const lbl = { win:'WIN', loss:'LOSS', push:'PUSH', bust:'BUST', blackjack:'BJ!' };
  const el = makeEl('span','badge '+(map[result]||''));
  el.textContent = lbl[result] || result;
  return el;
}
function badgeHtml(result) {
  const map = { win:'badge-win', loss:'badge-loss', push:'badge-push', bust:'badge-bust', blackjack:'badge-bj' };
  const lbl = { win:'WIN', loss:'LOSS', push:'PUSH', bust:'BUST', blackjack:'BJ!' };
  return `<span class="badge ${map[result]||''}">${lbl[result]||result}</span>`;
}
