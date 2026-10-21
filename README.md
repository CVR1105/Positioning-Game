# Positioning Strategy Simulator

A real-time, multiplayer version of the **Marketing & Positioning Simulation Game**. Up to 10 teams play on their own laptops across up to 8 rounds. A facilitator runs the game and a projector shows the live leaderboard. The team with the highest accumulated profit at the end wins.

## Quick start

Requirements: **Node.js 22.13 or newer** (it uses Node's built-in SQLite, so nothing native needs compiling).

```bash
npm install
npm start
```

The console prints addresses such as:

```
http://localhost:3000
http://192.168.1.23:3000   <- share this one
```

1. **Facilitator**: open the address, choose *Facilitator → New game*, and set the rounds, team limit, timer and a password. You get a 6-character game code.
2. **Projector**: on the classroom screen, open *Big screen* with the game code.
3. **Teams**: on each laptop (same Wi-Fi/LAN), open the network address and enter the game code, a team name and a PIN. Teammates on other laptops join with the **same team name and PIN** and share a live plan.
4. The facilitator presses **Start round**. Teams position products and press **Submit** before the clock runs out. The round closes when the timer ends, when every team has submitted (optional), or when the facilitator closes it.
5. Results appear on every screen. Repeat until the final podium.

Settings (environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_FILE` | `./data/positioning-game.db` | SQLite database file |
| `FACILITATOR_KEY` | *(empty)* | If set, creating a game requires this key |

To host it online instead of on a LAN, deploy to any Node host that has a persistent disk (Render, Railway, Fly.io, a VM). Run `npm start` and point `DB_FILE` at the persistent volume.

## Game rules (taken from the brief and the decision workbook)

- 10×10 perceptual map: rows **A–J** = style/look (A highest), columns **1–10** = quality (10 highest). Each cell holds a fixed demand. START is **J1** and has no demand.
- Segments: Status Seekers **A10** (1,500), Fashion Conscious **D3** (800), Budget Conscious **H3** (1,000), Quality Focused **I8** (800).
- Moving a product costs **200 points per cell**, horizontally or vertically only. The same rate applies to new launches (measured from START) and to repositioning, including moves down.
- Each team starts with **5,000 points**. Each round, it can spend up to its accumulated profit. At most **20 products** per team, and products cannot be withdrawn.
- **Sales** = cell demand ÷ number of products in that cell (rounded).
- **Loyalty bonus**: a product that is not moved earns 10% of its previous round's sales on top, compounding (about +95% by round 8). Moving a product resets it.
- Accumulated profit = 5,000 + Σ(sales − positioning cost). The highest accumulated profit wins.
- A team that doesn't submit keeps its previous positions, at zero cost.

## Privacy and data

- Every team connection gets a view built for that team only. Teams never receive another team's products, cells, drafts or submissions.
- After each round, everyone sees team totals (sales, share, cost, net, accumulated, product count). They also see the anonymous competition heat map (number of products per cell) and the top 10 products, shown by team without their cells. This matches the instructor handouts described in the brief.
- Only the facilitator sees every decision, live.
- All data is stored in SQLite (WAL mode): games, teams, products, drafts, submissions, per-round team results, per-product results, market data and an audit log. Round resolution runs in a single transaction, and the server can restart mid-round without losing state; timers resume.
- PINs and the facilitator password are hashed with scrypt. Sessions use HMAC-signed tokens, which the facilitator can revoke by resetting a team's PIN. Inputs are validated on the server, and joins and logins are rate-limited.
- The facilitator can export everything as **CSV** or **JSON** at any time.

## Project layout

```
server/engine.js     pure game rules (demand map, costs, sales split, loyalty, ranking)
server/game.js       game service: lifecycle, validation, round resolution, per-role views
server/db.js         SQLite schema and helpers
server/index.js      Express + Socket.IO server
public/              index (join/create), team console, facilitator control room, projector screen
test/                rule tests + a full 10-team, 8-round socket test
```

Run the tests with `npm test`.
