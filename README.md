# Bát Mã Truy Phong · Card Game Platform

> **⚠️ DISCLAIMER — READ BEFORE USING**
>
> This repository is published **for educational and source-code reference purposes only** — specifically to demonstrate game logic implementations (card dealing, hand evaluation, bot AI, real-time multiplayer via Socket.io).
>
> **Do NOT deploy or operate this as a real-money gambling platform** if you are located in Vietnam 🇻🇳 or any other jurisdiction where online gambling is restricted or prohibited by law. The author assumes no legal responsibility for misuse of this code.

---

## Overview

A real-time, mobile-first multiplayer card game platform supporting five Vietnamese and Western card games:

| Game | Type | Players |
|------|------|---------|
| **Blackjack** | Western dealer game | Up to 7 |
| **Xì Dzách** (Vietnamese BJ) | Dealer game, Việt rules | Up to 7 |
| **Texas Hold'em Poker** | Community card game | Up to 8 |
| **Tiến Lên** | Vietnamese climbing game | 2–4 |
| **Phỏm** (Tá Lả) | Vietnamese meld game | 2–4 |

## Tech Stack

- **Backend**: Node.js + Express + Socket.io (real-time multiplayer)
- **Frontend**: Vanilla JS + CSS (no framework)
- **Game logic**: Pure JS in `src/` (one file per game)
- **Deployment-ready**: Vercel / Railway / Render

## Project Structure

```
├── server.js              # Express + Socket.io server, room & game orchestration
├── src/
│   ├── blackjack.js       # Blackjack + Xì Dzách game logic & bot AI
│   ├── poker.js           # Texas Hold'em game logic & bot AI
│   ├── tienlen.js         # Tiến Lên game logic & bot AI
│   └── phom.js            # Phỏm / Tá Lả game logic & bot AI
└── public/
    ├── index.html         # Single-page app shell
    ├── style.css          # Mobile-first responsive CSS
    └── js/
        └── main.js        # Client-side rendering, socket events, seat positioning
```

## Features

- 🎴 **5 card games** with full rule sets and bot opponents
- 📱 **Mobile-first** — optimised for landscape phones (tested on iPhone 14 Pro Max)
- 🔄 **Real-time multiplayer** via Socket.io rooms (4-character room codes)
- 🤖 **Bot AI** that fills empty seats automatically
- 💬 **In-game chat** per room
- 📜 **Round history** panel
- 🃏 **Card deal animations** with staggered fly-in
- 💰 **Chip system** with bet tracking across rounds

## Running Locally

```bash
npm install
node server.js
# → http://localhost:3000
```

## License

MIT — free to study, fork, and modify. Respect local laws regarding gambling applications.
