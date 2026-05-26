const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const Blackjack = require('./src/blackjack');
const Poker = require('./src/poker');
const TienLen = require('./src/tienlen');
const Phom = require('./src/phom');
const XiDach = require('./src/xidach');

// Import helper functions for bot AI
const { classifyPlay, canBeat, tlValue, sortTL } = require('./src/tienlen');
const { isMeld, findBestMelds, cardPoints } = require('./src/phom');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
let botCounter = 0;

function generateCode() {
  return Math.random().toString(36).substr(2, 4).toUpperCase();
}

function createBotId() { return `bot_${++botCounter}`; }

// ── State broadcasting ────────────────────────────────────────────────────────

function sendGameState(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.game) return;
  for (const player of room.players) {
    if (player.isBot) continue;
    const state = room.game.getStateForPlayer(player.id);
    io.to(player.id).emit('game-state', state);
  }
}

function broadcastRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const player of room.players) {
    if (player.isBot) continue;
    io.to(player.id).emit('room-state', {
      roomCode,
      players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, isBot: p.isBot })),
      gameType: room.gameType,
      deposit: room.deposit,
      isHost: player.isHost,
    });
  }
}

// ── Bot logic ─────────────────────────────────────────────────────────────────

function rankVal(rank) {
  return ({ '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 })[rank] || 0;
}

function getBlackjackBotAction(gs, botId) {
  const bot = gs.players.find(p => p.id === botId);
  if (!bot) return null;
  if (gs.phase === 'betting') {
    if (bot.chips === 0 || bot.overallStatus === 'out') return { type: 'rebuy' };
    if (bot.overallStatus === 'betting') {
      // Bet ~10% of chips (same ratio as XiDach bots), min 10
      const bet = Math.max(10, Math.floor(bot.chips * 0.1));
      return { type: 'bet', amount: Math.min(bet, bot.chips) };
    }
  }
  // Insurance phase: bots always decline (statistically correct basic strategy)
  if (gs.phase === 'insurance' && !bot.insuranceDecided) {
    return { type: 'insurance-no' };
  }
  if (gs.phase === 'playing' && gs.currentPlayer === botId && bot.status === 'playing') {
    if (bot.value <= 16) return { type: 'hit' };
    return { type: 'stand' };
  }
  return null;
}

function getPokerBotAction(gs, botId) {
  const bot = gs.players.find(p => p.id === botId);
  if (!bot || gs.currentPlayer !== botId || bot.status !== 'active' || !bot.needsToAct) return null;

  const callAmt = (gs.currentBet || 0) - (bot.bet || 0);
  const chips = bot.chips || 0;

  if (gs.phase === 'preflop' && bot.hand?.length === 2 && bot.hand[0]?.suit !== 'hidden') {
    const r1 = rankVal(bot.hand[0].rank), r2 = rankVal(bot.hand[1].rank);
    const strong = r1 === r2 || Math.max(r1, r2) >= 11;
    if (strong) {
      return callAmt <= 0 ? { type: 'check' } : { type: 'call' };
    }
    if (callAmt <= 0) return { type: 'check' };
    if (callAmt > chips * 0.25) return { type: 'fold' };
    return Math.random() < 0.55 ? { type: 'call' } : { type: 'fold' };
  }

  if (callAmt <= 0) return { type: 'check' };
  if (callAmt > chips * 0.4) return { type: 'fold' };
  return { type: 'call' };
}

function getTienLenBotAction(gs, botId) {
  const bot = gs.players.find(p => p.id === botId);
  if (!bot || gs.currentPlayer !== botId || bot.status !== 'active') return null;
  if (gs.phase !== 'playing') return null;

  const hand = sortTL(bot.hand);
  const lastPlay = gs.lastPlay; // null after trick reset → bot is leading freely

  // No active play to beat — bot leads
  if (!lastPlay) {
    // First round: only the player with 3♠ should lead; others should not reach here,
    // but as a safety net: if firstRound and bot doesn't have 3♠, don't play.
    if (gs.firstRound) {
      const threeSpades = hand.find(c => c.rank === '3' && c.suit === 'spades');
      if (threeSpades) return { type: 'play', cards: [threeSpades] };
      return null; // safety: shouldn't happen, but don't play an invalid first move
    }
    // Lead with lowest single
    return { type: 'play', cards: [hand[0]] };
  }

  // Try to beat last play — attempt same-type combos from smallest
  const last = classifyPlay(lastPlay.cards);
  if (!last) return { type: 'pass' };

  const n = lastPlay.cards.length;

  // Try all contiguous windows of size n
  for (let i = 0; i <= hand.length - n; i++) {
    const candidate = hand.slice(i, i + n);
    const classified = classifyPlay(candidate);
    if (classified && canBeat(classified, last)) {
      return { type: 'play', cards: candidate };
    }
  }

  // Also try non-contiguous pairs/triples for pair/triple beats
  if (last.type === 'pair' || last.type === 'triple') {
    const needed = last.type === 'pair' ? 2 : 3;
    const byRank = {};
    hand.forEach(c => { (byRank[c.rank] = byRank[c.rank] || []).push(c); });
    for (const [, group] of Object.entries(byRank).sort((a, b) => tlValue(a[1][0]) - tlValue(b[1][0]))) {
      if (group.length >= needed) {
        const candidate = group.slice(0, needed);
        const classified = classifyPlay(candidate);
        if (classified && canBeat(classified, last)) {
          return { type: 'play', cards: candidate };
        }
      }
    }
  }

  return { type: 'pass' };
}

function getPhomBotAction(gs, botId) {
  const bot = gs.players.find(p => p.id === botId);
  if (!bot || gs.currentPlayer !== botId) return null;
  if (gs.phase === 'ended') return null;

  // Settling phase — bots skip guiQuan and immediately call doneSettling
  if (gs.phase === 'settling') {
    return { type: 'doneSettling' };
  }

  // Draw phase
  if (gs.phase === 'draw' && !gs.drewCard) {
    // Take discard if it helps form a meld, otherwise draw from deck
    if (gs.topDiscard) {
      const hand = bot.hand;
      // Check if topDiscard + 2 cards from hand form a meld
      let canUse = false;
      for (let i = 0; i < hand.length && !canUse; i++) {
        for (let j = i + 1; j < hand.length && !canUse; j++) {
          if (isMeld([gs.topDiscard, hand[i], hand[j]])) canUse = true;
        }
      }
      if (canUse) return { type: 'takeDiscard' };
    }
    return { type: 'draw' };
  }

  // Discard phase
  if (gs.phase === 'discard' && gs.drewCard) {
    const hand = bot.hand;

    // Try to lay down a meld
    const melds = findBestMelds(hand);
    if (melds.length > 0) {
      return { type: 'layDown', cards: melds[0] };
    }

    // Try to add to existing melds on the table
    for (const p of gs.players) {
      if (!p.melds?.length) continue;
      for (let mi = 0; mi < p.melds.length; mi++) {
        for (const c of hand) {
          const newMeld = [...p.melds[mi], c];
          if (isMeld(newMeld)) {
            return { type: 'addToMeld', targetPlayerId: p.id, meldIndex: mi, cards: [c] };
          }
        }
      }
    }

    // Discard the highest-point dead card (one not part of any potential meld)
    const bestMelds = findBestMelds(hand);
    const meldedCards = new Set();
    bestMelds.forEach(m => m.forEach(c => meldedCards.add(c.rank + c.suit)));
    const deadCards = hand.filter(c => !meldedCards.has(c.rank + c.suit));
    const toDiscard = deadCards.length > 0
      ? deadCards.reduce((a, b) => cardPoints(b) > cardPoints(a) ? b : a)
      : hand[hand.length - 1];

    return { type: 'discard', card: toDiscard };
  }

  return null;
}

/* ── Xì Dzách bot ────────────────────────────────────────────────────────── */
function handValueXD(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.rank === 'A') { total += 11; aces++; }
    else if (['J','Q','K'].includes(c.rank)) total += 10;
    else total += parseInt(c.rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function getXiDachBotAction(gs, botId) {
  const bot = gs.players.find(p => p.id === botId);
  if (!bot) return null;

  // Betting phase — rebuy if broke, then bet
  if (gs.phase === 'betting') {
    if (bot.chips === 0 || bot.status === 'out') return { type: 'rebuy' };
    if (bot.status === 'betting') {
      const bet = Math.max(10, Math.floor((bot.chips || 100) * 0.1));
      return { type: 'bet', amount: Math.min(bet, bot.chips) };
    }
  }

  // Playing phase — only act when it's this bot's turn
  if (gs.phase === 'playing' && gs.currentPlayer === botId && bot.status === 'playing') {
    const val = handValueXD(bot.hand);
    // Must hit below 16 (Dằn Non rule), hit up to 17 for safety
    if (val < 17) return { type: 'hit' };
    return { type: 'stand' };
  }

  return null;
}

function getBotAction(gameType, gs, botId) {
  if (gameType === 'blackjack') return getBlackjackBotAction(gs, botId);
  if (gameType === 'xidach')    return getXiDachBotAction(gs, botId);
  if (gameType === 'poker')     return getPokerBotAction(gs, botId);
  if (gameType === 'tienlen')   return getTienLenBotAction(gs, botId);
  if (gameType === 'phom')      return getPhomBotAction(gs, botId);
  return null;
}

// Auto-restart when tới trắng is detected (called right after sendGameState)
function scheduleAutoRestart(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.game) return;

  // Tiến Lên: restart on tới trắng
  if (room.gameType === 'tienlen') {
    if (!room.game.autoRestart) return;
    room.game.autoRestart = false;
    io.to(roomCode).emit('chat', { system: true, message: '🔄 Tới trắng! Chia bài lại sau 4 giây…' });
    setTimeout(() => {
      const r = rooms[roomCode];
      if (!r || !r.game) return;
      r.game.round++;
      r.game._deal();
      sendGameState(roomCode);
      processBotTurns(roomCode);
    }, 4000);
    return;
  }

  // Blackjack / Xì Dzách / Poker: auto-new-round 3s after phase === 'ended'/'showdown'
  if (['blackjack','xidach','poker'].includes(room.gameType)) {
    const gs = room.game.getStateForPlayer(null);
    const isEnded = gs.phase === 'ended' || gs.phase === 'showdown';
    if (!isEnded) return;
    if (room._autoNewRoundPending) return; // already scheduled
    room._autoNewRoundPending = true;
    setTimeout(() => {
      const r = rooms[roomCode];
      if (!r || !r.game) return;
      r._autoNewRoundPending = false;
      const gs2 = r.game.getStateForPlayer(null);
      const stillEnded = gs2.phase === 'ended' || gs2.phase === 'showdown';
      if (!stillEnded) return; // player already started next round

      // Auto-refill broke bots before starting the next round
      for (const p of r.game.players) {
        if (p.chips === 0) {
          p.chips = r.game.startingChips || 1000;
          io.to(roomCode).emit('chat', { system: true, message: `💰 ${p.name} rebought for ${p.chips} chips.` });
        }
      }

      const hostId = r.players.find(p => p.isHost)?.id || r.players[0]?.id;
      const actionType = r.gameType === 'poker' ? 'newHand' : 'newRound';
      r.game.handleAction(hostId, { type: actionType });
      sendGameState(roomCode);
      processBotTurns(roomCode);
    }, 3000);
  }
}

// Schedule bot turns with a realistic delay
function processBotTurns(roomCode, depth = 0) {
  if (depth > 30) return;
  const room = rooms[roomCode];
  if (!room || !room.game) return;

  const bots = room.players.filter(p => p.isBot);
  if (bots.length === 0) return;

  let actingBot = null;
  let action = null;
  for (const bot of bots) {
    const botGs = room.game.getStateForPlayer(bot.id);
    const a = getBotAction(room.gameType, botGs, bot.id);
    if (a) { actingBot = bot; action = a; break; }
  }
  if (!actingBot) return;

  setTimeout(() => {
    const r = rooms[roomCode];
    if (!r || !r.game) return;
    const botGs2 = r.game.getStateForPlayer(actingBot.id);
    const a2 = getBotAction(r.gameType, botGs2, actingBot.id);
    if (!a2) return;
    const result = r.game.handleAction(actingBot.id, a2);
    if (!result || !result.error) {
      sendGameState(roomCode);
      processBotTurns(roomCode, depth + 1);
    }
  }, 900 + Math.random() * 600);
}

// ── Socket events ─────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('create-room', ({ playerName }) => {
    if (!playerName?.trim()) { socket.emit('error', { message: 'Please enter your name' }); return; }
    const roomCode = generateCode();
    rooms[roomCode] = {
      players: [{ id: socket.id, name: playerName.trim(), isHost: true, isBot: false }],
      gameType: null,
      game: null,
      deposit: 1000,  // starting chips for blackjack / poker
    };
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerName = playerName.trim();
    socket.emit('room-created', { roomCode });
    broadcastRoomState(roomCode);
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    if (!playerName?.trim()) { socket.emit('error', { message: 'Please enter your name' }); return; }
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms[code];
    if (!room) { socket.emit('error', { message: 'Room not found. Check the code.' }); return; }
    if (room.game) { socket.emit('error', { message: 'Game already in progress' }); return; }
    const humanCount = room.players.filter(p => !p.isBot).length;
    const roomMax = room.gameType === 'poker' ? 8 : ['blackjack','xidach'].includes(room.gameType) ? 7 : 4;
    if (room.players.length >= roomMax) { socket.emit('error', { message: 'Room is full' }); return; }

    room.players.push({ id: socket.id, name: playerName.trim(), isHost: false, isBot: false });
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = playerName.trim();
    socket.emit('room-joined', { roomCode: code });
    io.to(code).emit('chat', { system: true, message: `${playerName.trim()} joined` });
    broadcastRoomState(code);
  });

  socket.on('add-bot', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) { socket.emit('error', { message: 'Only the host can add bots' }); return; }
    if (room.game) { socket.emit('error', { message: 'Cannot add bot during a game' }); return; }
    if (!room.gameType) { socket.emit('error', { message: 'Select a game first' }); return; }

    // Max players per game type
    const maxPlayers = ['tienlen','phom'].includes(room.gameType) ? 4
                     : room.gameType === 'poker' ? 8
                     : ['blackjack','xidach'].includes(room.gameType) ? 7
                     : 6;
    if (room.players.length >= maxPlayers) {
      socket.emit('error', { message: `Room is full (max ${maxPlayers} for this game)` }); return;
    }

    const botNum = room.players.filter(p => p.isBot).length + 1;
    room.players.push({ id: createBotId(), name: `Bot ${botNum}`, isHost: false, isBot: true });
    broadcastRoomState(socket.roomCode);
  });

  socket.on('remove-bot', ({ botId }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (!botId?.startsWith('bot_')) return;
    room.players = room.players.filter(p => p.id !== botId);
    broadcastRoomState(socket.roomCode);
  });

  socket.on('set-game', ({ gameType }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) { socket.emit('error', { message: 'Only the host can change the game' }); return; }
    if (!['blackjack', 'poker', 'tienlen', 'phom', 'xidach'].includes(gameType)) return;

    // Drop excess bots when switching to fixed-size games
    if (['tienlen', 'phom'].includes(gameType)) {
      const humanCount = room.players.filter(p => !p.isBot).length;
      const botsAllowed = 4 - humanCount;
      let botCount = 0;
      room.players = room.players.filter(p => {
        if (!p.isBot) return true;
        return botCount++ < botsAllowed;
      });
    }
    room.gameType = gameType;
    broadcastRoomState(socket.roomCode);
  });

  socket.on('set-deposit', ({ amount }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    const val = parseInt(amount);
    if (!val || val < 100 || val > 1000000) { socket.emit('error', { message: 'Deposit must be 100–1,000,000' }); return; }
    room.deposit = val;
    broadcastRoomState(socket.roomCode);
  });

  socket.on('start-game', () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) { socket.emit('error', { message: 'Only the host can start the game' }); return; }
    if (!room.gameType) { socket.emit('error', { message: 'Please select a game first' }); return; }

    const n = room.players.length;
    const humanCount = room.players.filter(p => !p.isBot).length;

    if (room.gameType === 'tienlen') {
      if (n !== 4) { socket.emit('error', { message: 'Tiến Lên requires exactly 4 players (add bots to fill)' }); return; }
    } else if (room.gameType === 'phom') {
      if (n !== 4) { socket.emit('error', { message: 'Phỏm requires exactly 4 players (add bots to fill)' }); return; }
    } else if (room.gameType === 'blackjack') {
      if (humanCount < 1) { socket.emit('error', { message: 'Need at least 1 human player' }); return; }
    } else if (room.gameType === 'poker') {
      if (n < 2) { socket.emit('error', { message: 'Poker needs at least 2 players (add a bot!)' }); return; }
    } else if (room.gameType === 'xidach') {
      if (humanCount < 1) { socket.emit('error', { message: 'Need at least 1 human player' }); return; }
    }

    const playerList = room.players.map(p => ({ id: p.id, name: p.name }));

    try {
      const opts = { startingChips: room.deposit || 1000 };
      switch (room.gameType) {
        case 'blackjack': room.game = new Blackjack(playerList, opts); break;
        case 'poker':     room.game = new Poker(playerList, opts); break;
        case 'tienlen':   room.game = new TienLen(playerList, opts); break;
        case 'phom':      room.game = new Phom(playerList, opts); break;
        case 'xidach':    room.game = new XiDach(playerList, opts); break;
      }
    } catch (e) {
      socket.emit('error', { message: 'Failed to start: ' + e.message }); return;
    }

    room.game.start();
    io.to(roomCode).emit('game-started', { gameType: room.gameType });
    sendGameState(roomCode);
    scheduleAutoRestart(roomCode);
    processBotTurns(roomCode);
  });

  socket.on('game-action', (action) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.game) return;

    let result;
    try {
      result = room.game.handleAction(socket.id, action);
    } catch (e) {
      socket.emit('error', { message: 'Action error: ' + e.message }); return;
    }

    if (result?.error) { socket.emit('error', { message: result.error }); return; }

    sendGameState(roomCode);
    scheduleAutoRestart(roomCode);
    processBotTurns(roomCode);
  });

  socket.on('chat', ({ message }) => {
    const roomCode = socket.roomCode;
    if (!roomCode || !message?.trim()) return;
    io.to(roomCode).emit('chat', { playerName: socket.playerName, message: message.trim().substring(0, 300) });
  });

  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.filter(p => !p.isBot).length === 0) { delete rooms[roomCode]; return; }
    if (!room.players.find(p => p.isHost && !p.isBot)) {
      const firstHuman = room.players.find(p => !p.isBot);
      if (firstHuman) firstHuman.isHost = true;
    }
    io.to(roomCode).emit('chat', { system: true, message: `${socket.playerName} left` });
    broadcastRoomState(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Card games → http://localhost:${PORT}`));
