'use strict';
const E = require('./engine');
const { hashSecret, verifySecret, randomCode } = require('./security');

const TEAM_COLORS = [
  '#3b82f6', '#f97316', '#22c55e', '#e11d48', '#a855f7',
  '#eab308', '#06b6d4', '#ec4899', '#84cc16', '#94a3b8',
];

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function cleanName(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

class GameService {
  constructor(db, tokens, { onChange = () => {}, now = () => Date.now() } = {}) {
    this.db = db;
    this.tokens = tokens;
    this.onChange = onChange;
    this.now = now;
    this.timers = new Map();
    this.online = new Map(); // `${gameId}:${teamId}` -> socket count
    this.stopped = false;
  }

  shutdown() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ---------- lifecycle ----------

  restoreTimers() {
    const open = this.db.all(`SELECT id, deadline FROM games WHERE status = 'open' AND deadline IS NOT NULL`);
    for (const g of open) this.scheduleClose(g.id, g.deadline);
  }

  scheduleClose(gameId, deadline) {
    clearTimeout(this.timers.get(gameId));
    this.timers.delete(gameId);
    if (!deadline) return;
    const ms = Math.max(0, deadline - this.now());
    // setTimeout caps at ~24.8 days; round timers are minutes, but stay safe.
    const t = setTimeout(() => {
      this.timers.delete(gameId);
      if (this.stopped) return;
      try {
        const g = this.getGame(gameId);
        if (g && g.status === 'open' && g.deadline && g.deadline <= this.now() + 50) {
          this.closeRound(gameId, 'timer');
        } else if (g && g.status === 'open' && g.deadline) {
          this.scheduleClose(gameId, g.deadline);
        }
      } catch (err) {
        console.error('[timer] failed to close round', gameId, err);
      }
    }, Math.min(ms, 2 ** 31 - 1));
    t.unref?.();
    this.timers.set(gameId, t);
  }

  audit(gameId, actor, action, detail) {
    this.db.run(
      `INSERT INTO audit_log (game_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)`,
      gameId, this.now(), actor, action, detail == null ? null : JSON.stringify(detail),
    );
  }

  // ---------- games ----------

  createGame(opts) {
    const name = cleanName(opts.name, 60) || 'Positioning Simulation';
    const adminPassword = String(opts.adminPassword ?? '');
    if (adminPassword.length < 4) throw new GameError('Facilitator password must be at least 4 characters.');
    const totalRounds = clampInt(opts.totalRounds, 1, E.MAX_ROUNDS, E.MAX_ROUNDS);
    const maxTeams = clampInt(opts.maxTeams, 1, E.MAX_TEAMS, E.MAX_TEAMS);
    const roundSeconds = clampInt(opts.roundSeconds, 0, 3600, 600);
    const autoClose = opts.autoClose === false || opts.autoClose === 0 ? 0 : 1;

    let id;
    for (let i = 0; i < 20; i++) {
      id = randomCode(6);
      if (!this.db.get(`SELECT 1 FROM games WHERE id = ?`, id)) break;
    }
    const t = this.now();
    this.db.run(
      `INSERT INTO games (id, name, total_rounds, max_teams, round_seconds, auto_close, admin_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, totalRounds, maxTeams, roundSeconds, autoClose, hashSecret(adminPassword), t, t,
    );
    this.audit(id, 'admin', 'create_game', { name, totalRounds, maxTeams, roundSeconds, autoClose });
    return { gameId: id, adminToken: this.issueAdminToken(id) };
  }

  issueAdminToken(gameId) {
    const g = this.requireGame(gameId);
    return this.tokens.issue({ r: 'admin', g: gameId, v: g.token_version });
  }

  adminLogin(gameId, password) {
    const g = this.requireGame(gameId);
    if (!verifySecret(password, g.admin_hash)) throw new GameError('Wrong facilitator password.', 401);
    return { adminToken: this.issueAdminToken(gameId) };
  }

  getGame(gameId) {
    return this.db.get(`SELECT * FROM games WHERE id = ?`, String(gameId || '').toUpperCase()) || null;
  }

  requireGame(gameId) {
    const g = this.getGame(gameId);
    if (!g) throw new GameError('Game not found. Check the game code.', 404);
    return g;
  }

  touch(gameId) {
    this.db.run(`UPDATE games SET updated_at = ? WHERE id = ?`, this.now(), gameId);
  }

  updateSettings(gameId, opts) {
    const g = this.requireGame(gameId);
    const roundSeconds = opts.roundSeconds == null ? g.round_seconds : clampInt(opts.roundSeconds, 0, 3600, g.round_seconds);
    const autoClose = opts.autoClose == null ? g.auto_close : (opts.autoClose ? 1 : 0);
    let totalRounds = g.total_rounds;
    if (opts.totalRounds != null) {
      totalRounds = clampInt(opts.totalRounds, Math.max(1, g.current_round), E.MAX_ROUNDS, g.total_rounds);
    }
    if (g.status === 'finished') throw new GameError('Game is finished.');
    this.db.run(
      `UPDATE games SET round_seconds = ?, auto_close = ?, total_rounds = ?, updated_at = ? WHERE id = ?`,
      roundSeconds, autoClose, totalRounds, this.now(), g.id,
    );
    this.audit(g.id, 'admin', 'settings', { roundSeconds, autoClose, totalRounds });
    this.onChange(g.id);
    if (autoClose && g.status === 'open') this.maybeAutoClose(g.id);
  }

  // ---------- teams ----------

  verifyAuth(token) {
    const p = this.tokens.verify(token);
    if (!p) return null;
    const g = this.getGame(p.g);
    if (!g) return null;
    if (p.r === 'admin') return g.token_version === p.v ? { role: 'admin', gameId: g.id } : null;
    if (p.r === 'team') {
      const t = this.db.get(`SELECT id, token_version FROM teams WHERE id = ? AND game_id = ?`, p.t, g.id);
      if (!t || t.token_version !== p.v) return null;
      return { role: 'team', gameId: g.id, teamId: t.id };
    }
    return null;
  }

  joinTeam(gameId, teamName, pin) {
    const g = this.requireGame(gameId);
    const name = cleanName(teamName, 24);
    pin = String(pin ?? '').trim();
    if (name.length < 2) throw new GameError('Team name must be at least 2 characters.');
    if (!/^\d{4,8}$/.test(pin)) throw new GameError('PIN must be 4–8 digits.');

    return this.db.tx(() => {
      const existing = this.db.get(`SELECT * FROM teams WHERE game_id = ? AND name = ?`, g.id, name);
      if (existing) {
        if (!verifySecret(pin, existing.pin_hash)) {
          throw new GameError('That team name is taken and the PIN does not match. Pick another name or enter the correct PIN.', 401);
        }
        this.audit(g.id, `team:${existing.id}`, 'rejoin', null);
        return {
          teamId: existing.id,
          token: this.tokens.issue({ r: 'team', g: g.id, t: existing.id, v: existing.token_version }),
          rejoined: true,
        };
      }
      const lateJoin = g.status === 'finished' || g.current_round > 1 || (g.current_round === 1 && g.status !== 'open');
      if (lateJoin) throw new GameError('This game has already progressed past round 1 – new teams can no longer join. Existing teams can rejoin with their PIN.', 403);
      const count = this.db.get(`SELECT COUNT(*) AS n FROM teams WHERE game_id = ?`, g.id).n;
      if (count >= g.max_teams) throw new GameError(`This game is full (${g.max_teams} teams).`, 403);
      const used = new Set(this.db.all(`SELECT number FROM teams WHERE game_id = ?`, g.id).map((r) => r.number));
      let number = 1;
      while (used.has(number)) number++;
      const color = TEAM_COLORS[(number - 1) % TEAM_COLORS.length];
      const res = this.db.run(
        `INSERT INTO teams (game_id, number, name, color, pin_hash, accumulated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        g.id, number, name, color, hashSecret(pin), E.STARTING_BUDGET, this.now(),
      );
      const teamId = Number(res.lastInsertRowid);
      this.audit(g.id, `team:${teamId}`, 'join', { name });
      this.touch(g.id);
      queueMicrotask(() => this.onChange(g.id));
      return { teamId, token: this.tokens.issue({ r: 'team', g: g.id, t: teamId, v: 1 }), rejoined: false };
    });
  }

  resetTeamPin(gameId, teamId, pin) {
    const g = this.requireGame(gameId);
    pin = String(pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pin)) throw new GameError('PIN must be 4–8 digits.');
    const res = this.db.run(
      `UPDATE teams SET pin_hash = ?, token_version = token_version + 1 WHERE id = ? AND game_id = ?`,
      hashSecret(pin), teamId, g.id,
    );
    if (!res.changes) throw new GameError('Team not found.', 404);
    this.audit(g.id, 'admin', 'reset_pin', { teamId });
    this.onChange(g.id, { kickTeam: teamId });
  }

  renameTeam(gameId, teamId, newName) {
    const g = this.requireGame(gameId);
    const name = cleanName(newName, 24);
    if (name.length < 2) throw new GameError('Team name must be at least 2 characters.');
    try {
      const res = this.db.run(`UPDATE teams SET name = ? WHERE id = ? AND game_id = ?`, name, teamId, g.id);
      if (!res.changes) throw new GameError('Team not found.', 404);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new GameError('Another team already has that name.');
      throw err;
    }
    this.audit(g.id, 'admin', 'rename_team', { teamId, name });
    this.onChange(g.id);
  }

  removeTeam(gameId, teamId) {
    const g = this.requireGame(gameId);
    if (g.current_round > 1 || (g.current_round === 1 && g.status !== 'open')) {
      throw new GameError('Teams can only be removed before round 1 results are in.');
    }
    const res = this.db.run(`DELETE FROM teams WHERE id = ? AND game_id = ?`, teamId, g.id);
    if (!res.changes) throw new GameError('Team not found.', 404);
    this.audit(g.id, 'admin', 'remove_team', { teamId });
    this.onChange(g.id, { kickTeam: teamId });
    if (g.status === 'open') this.maybeAutoClose(g.id);
  }

  teams(gameId) {
    return this.db.all(
      `SELECT id, number, name, color, accumulated,
              (SELECT COUNT(*) FROM products p WHERE p.team_id = t.id) AS product_count
         FROM teams t WHERE game_id = ? ORDER BY number`,
      gameId,
    );
  }

  products(teamId) {
    return this.db.all(
      `SELECT id, seq, cell, created_round, last_sales, cum_bonus FROM products WHERE team_id = ? ORDER BY seq`,
      teamId,
    );
  }

  setOnline(gameId, teamId, delta) {
    const k = `${gameId}:${teamId}`;
    const n = Math.max(0, (this.online.get(k) || 0) + delta);
    if (n) this.online.set(k, n);
    else this.online.delete(k);
  }

  // ---------- decisions ----------

  /**
   * Normalise and validate a plan: [{seq, cell}]. Existing products omitted from
   * the plan stay where they are. New products must use the next sequence numbers.
   */
  normalizePlan(products, plan) {
    if (!Array.isArray(plan)) throw new GameError('Plan must be a list of products.');
    if (plan.length > E.MAX_PRODUCTS) throw new GameError(`At most ${E.MAX_PRODUCTS} products.`);
    const bySeq = new Map();
    for (const item of plan) {
      const seq = Number(item?.seq);
      const cell = String(item?.cell ?? '').toUpperCase();
      if (!Number.isInteger(seq) || seq < 1 || seq > E.MAX_PRODUCTS) throw new GameError('Invalid product number.');
      if (!E.isValidCell(cell)) throw new GameError(`Invalid cell "${item?.cell}". Use A–J and 1–10, e.g. H3.`);
      if (bySeq.has(seq)) throw new GameError(`Product #${seq} appears twice.`);
      bySeq.set(seq, cell);
    }
    const n = products.length;
    const out = products.map((p) => ({ seq: p.seq, cell: bySeq.get(p.seq) ?? p.cell, isNew: false, from: p.cell }));
    const newSeqs = [...bySeq.keys()].filter((s) => s > n).sort((a, b) => a - b);
    newSeqs.forEach((s, i) => {
      if (s !== n + 1 + i) throw new GameError('New products must be numbered in order after your existing products.');
      const cell = bySeq.get(s);
      if (cell === E.START) throw new GameError(`New product #${s} must be positioned somewhere other than START (J1).`);
      out.push({ seq: s, cell, isNew: true, from: E.START });
    });
    if (out.length > E.MAX_PRODUCTS) throw new GameError(`At most ${E.MAX_PRODUCTS} products per team.`);
    let cost = 0;
    for (const p of out) {
      p.cost = E.moveCost(p.from, p.cell);
      cost += p.cost;
    }
    return { plan: out.map(({ seq, cell }) => ({ seq, cell })), lines: out, cost };
  }

  saveDecision(gameId, teamId, plan, { submit = false, by = null, clientId = null } = {}) {
    const g = this.requireGame(gameId);
    if (g.status !== 'open') throw new GameError('The round is not open for decisions right now.', 409);
    const team = this.db.get(`SELECT * FROM teams WHERE id = ? AND game_id = ?`, teamId, g.id);
    if (!team) throw new GameError('Team not found.', 404);
    const products = this.products(teamId);
    const norm = this.normalizePlan(products, plan);
    if (submit && norm.cost > Math.max(0, team.accumulated)) {
      throw new GameError(`This plan costs ${norm.cost.toLocaleString()} but your budget is ${team.accumulated.toLocaleString()}.`);
    }
    const t = this.now();
    const json = JSON.stringify(norm.plan);
    const who = cleanName(by, 24) || null;
    const client = cleanName(clientId, 40) || null;
    this.db.tx(() => {
      const row = this.db.get(
        `SELECT 1 FROM decisions WHERE game_id = ? AND team_id = ? AND round = ?`, g.id, teamId, g.current_round,
      );
      if (!row) {
        this.db.run(
          `INSERT INTO decisions (game_id, team_id, round, updated_at) VALUES (?, ?, ?, ?)`,
          g.id, teamId, g.current_round, t,
        );
      }
      // Every save updates the shared draft; only a submit replaces the plan that counts.
      this.db.run(
        `UPDATE decisions SET draft_json = ?, draft_cost = ?, draft_at = ?, draft_by = ?, draft_client = ?, updated_at = ?
          WHERE game_id = ? AND team_id = ? AND round = ?`,
        json, norm.cost, t, who, client, t, g.id, teamId, g.current_round,
      );
      if (submit) {
        this.db.run(
          `UPDATE decisions SET plan_json = ?, cost = ?, submitted_at = ?, submitted_by = ?
            WHERE game_id = ? AND team_id = ? AND round = ?`,
          json, norm.cost, t, who, g.id, teamId, g.current_round,
        );
      }
      if (submit) this.audit(g.id, `team:${teamId}`, 'submit', { round: g.current_round, cost: norm.cost, plan: norm.plan, by: who });
    });
    this.onChange(g.id, { teamOnly: submit ? null : teamId });
    if (submit) this.maybeAutoClose(g.id);
    return { cost: norm.cost, submitted: submit, at: t };
  }

  withdrawSubmission(gameId, teamId) {
    const g = this.requireGame(gameId);
    if (g.status !== 'open') throw new GameError('The round is not open for decisions right now.', 409);
    this.db.run(
      `UPDATE decisions SET plan_json = NULL, cost = NULL, submitted_at = NULL, submitted_by = NULL
        WHERE game_id = ? AND team_id = ? AND round = ?`,
      g.id, teamId, g.current_round,
    );
    this.audit(g.id, `team:${teamId}`, 'withdraw', { round: g.current_round });
    this.onChange(g.id);
  }

  maybeAutoClose(gameId) {
    const g = this.getGame(gameId);
    if (!g || g.status !== 'open' || !g.auto_close) return;
    const teamCount = this.db.get(`SELECT COUNT(*) AS n FROM teams WHERE game_id = ?`, g.id).n;
    if (!teamCount) return;
    const submitted = this.db.get(
      `SELECT COUNT(*) AS n FROM decisions WHERE game_id = ? AND round = ? AND submitted_at IS NOT NULL`,
      g.id, g.current_round,
    ).n;
    if (submitted >= teamCount) {
      // Small grace period so the last team sees its "submitted" confirmation before the reveal.
      setTimeout(() => {
        if (this.stopped) return;
        try {
          const cur = this.getGame(gameId);
          if (cur && cur.status === 'open' && cur.current_round === g.current_round) this.closeRound(gameId, 'all_submitted');
        } catch (err) {
          console.error('[auto-close]', err);
        }
      }, 1500).unref?.();
    }
  }

  // ---------- rounds ----------

  startRound(gameId) {
    const g = this.requireGame(gameId);
    if (g.status === 'open') throw new GameError('A round is already running.');
    if (g.status === 'finished') throw new GameError('The game is finished.');
    if (g.current_round >= g.total_rounds) throw new GameError('All rounds have been played.');
    const teamCount = this.db.get(`SELECT COUNT(*) AS n FROM teams WHERE game_id = ?`, g.id).n;
    if (!teamCount) throw new GameError('At least one team must join before starting.');
    const round = g.current_round + 1;
    const deadline = g.round_seconds > 0 ? this.now() + g.round_seconds * 1000 : null;
    this.db.run(
      `UPDATE games SET status = 'open', current_round = ?, deadline = ?, updated_at = ? WHERE id = ?`,
      round, deadline, this.now(), g.id,
    );
    this.audit(g.id, 'admin', 'start_round', { round, deadline });
    this.scheduleClose(g.id, deadline);
    this.onChange(g.id, { event: { type: 'round_started', round } });
  }

  extendTimer(gameId, seconds) {
    const g = this.requireGame(gameId);
    if (g.status !== 'open') throw new GameError('No round is running.');
    const s = clampInt(seconds, -3600, 3600, 60);
    const base = g.deadline && g.deadline > this.now() ? g.deadline : this.now();
    const deadline = Math.max(this.now() + 5000, base + s * 1000);
    this.db.run(`UPDATE games SET deadline = ?, updated_at = ? WHERE id = ?`, deadline, this.now(), g.id);
    this.audit(g.id, 'admin', 'extend_timer', { seconds: s });
    this.scheduleClose(g.id, deadline);
    this.onChange(g.id);
  }

  stopTimer(gameId) {
    const g = this.requireGame(gameId);
    if (g.status !== 'open') throw new GameError('No round is running.');
    this.db.run(`UPDATE games SET deadline = NULL, updated_at = ? WHERE id = ?`, this.now(), g.id);
    this.scheduleClose(g.id, null);
    this.audit(g.id, 'admin', 'stop_timer', null);
    this.onChange(g.id);
  }

  endGame(gameId) {
    const g = this.requireGame(gameId);
    if (g.status === 'finished') return;
    if (g.status === 'open') {
      this.db.run(`UPDATE games SET total_rounds = current_round WHERE id = ?`, g.id);
      this.closeRound(g.id, 'ended');
      return;
    }
    this.db.run(
      `UPDATE games SET status = 'finished', total_rounds = MAX(current_round, 1), deadline = NULL, updated_at = ? WHERE id = ?`,
      this.now(), g.id,
    );
    this.audit(g.id, 'admin', 'end_game', null);
    this.onChange(g.id, { event: { type: 'game_finished' } });
  }

  closeRound(gameId, reason = 'admin') {
    const result = this.db.tx(() => {
      const g = this.requireGame(gameId);
      if (g.status !== 'open') throw new GameError('No round is running.', 409);
      const round = g.current_round;
      const teams = this.db.all(`SELECT * FROM teams WHERE game_id = ? ORDER BY number`, g.id);

      const input = [];
      const meta = new Map(); // teamId -> { submitted, newProducts: [{seq, cell}] }
      for (const team of teams) {
        const products = this.products(team.id);
        const dec = this.db.get(
          `SELECT plan_json, submitted_at FROM decisions WHERE game_id = ? AND team_id = ? AND round = ? AND plan_json IS NOT NULL`,
          g.id, team.id, round,
        );
        let lines = products.map((p) => ({ seq: p.seq, cell: p.cell, isNew: false, from: p.cell }));
        let submitted = false;
        if (dec && dec.submitted_at) {
          try {
            const norm = this.normalizePlan(products, JSON.parse(dec.plan_json));
            if (norm.cost <= Math.max(0, team.accumulated)) {
              lines = norm.lines;
              submitted = true;
            }
          } catch (err) {
            console.warn('[close] ignoring invalid stored plan', team.id, err.message);
          }
        }
        const bySeq = new Map(products.map((p) => [p.seq, p]));
        input.push({
          teamId: team.id,
          accumulated: team.accumulated,
          products: lines.map((l) => {
            const p = bySeq.get(l.seq);
            return {
              id: p ? p.id : `new:${team.id}:${l.seq}`,
              seq: l.seq,
              prevCell: p ? p.cell : null,
              cell: l.cell,
              prevSales: p ? p.last_sales : 0,
              prevBonus: p ? p.cum_bonus : 0,
            };
          }),
        });
        meta.set(team.id, { submitted });
      }

      const res = E.resolveRound(input);

      // Persist products (creating rows for new launches).
      const idMap = new Map();
      for (const t of input) {
        for (const p of t.products) {
          if (typeof p.id === 'string') {
            const ins = this.db.run(
              `INSERT INTO products (game_id, team_id, seq, cell, created_round) VALUES (?, ?, ?, ?, ?)`,
              g.id, t.teamId, p.seq, p.cell, round,
            );
            idMap.set(p.id, { id: Number(ins.lastInsertRowid), seq: p.seq });
          } else {
            idMap.set(p.id, { id: p.id, seq: p.seq });
          }
        }
      }
      for (const pr of res.products) {
        const ref = idMap.get(pr.productId);
        pr.productId = ref.id;
        pr.seq = ref.seq;
        this.db.run(`UPDATE products SET cell = ?, last_sales = ?, cum_bonus = ? WHERE id = ?`, pr.cell, pr.sales, pr.cumBonus, ref.id);
        this.db.run(
          `INSERT INTO product_results (game_id, round, team_id, product_id, seq, from_cell, cell, is_new, moved,
                                        competitors, base, loyalty, cum_bonus, sales, cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          g.id, round, pr.teamId, ref.id, ref.seq, pr.from, pr.cell, pr.isNew ? 1 : 0, pr.moved ? 1 : 0,
          pr.competitors, pr.base, pr.loyalty, pr.cumBonus, pr.sales, pr.cost,
        );
      }
      for (const tr of res.teams) {
        this.db.run(`UPDATE teams SET accumulated = ? WHERE id = ?`, tr.accumulated, tr.teamId);
        this.db.run(
          `INSERT INTO round_results (game_id, round, team_id, sales, cost, net, best, loyalty, share, accumulated,
                                      round_rank, overall_rank, product_count, submitted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          g.id, round, tr.teamId, tr.sales, tr.cost, tr.net, tr.best, tr.loyalty, tr.share, tr.accumulated,
          tr.roundRank, tr.overallRank, tr.productCount, meta.get(tr.teamId).submitted ? 1 : 0,
        );
      }

      const prevRows = this.db.all(`SELECT * FROM round_results WHERE game_id = ? AND round = ?`, g.id, round - 1);
      const prevMarket = this.db.get(`SELECT market_json FROM round_market WHERE game_id = ? AND round = ?`, g.id, round - 1);
      const news = buildNews({ round, teams, res, prevRows, prevMarket: prevMarket ? JSON.parse(prevMarket.market_json) : null });
      const awards = buildAwards({ teams, res });
      this.db.run(
        `INSERT INTO round_market (game_id, round, cell_counts, market_json, news_json, awards_json, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        g.id, round, JSON.stringify(res.cellCounts), JSON.stringify(res.market), JSON.stringify(news),
        JSON.stringify(awards), this.now(),
      );

      const finished = round >= g.total_rounds;
      this.db.run(
        `UPDATE games SET status = ?, deadline = NULL, updated_at = ? WHERE id = ?`,
        finished ? 'finished' : 'results', this.now(), g.id,
      );
      this.audit(g.id, reason === 'admin' ? 'admin' : 'system', 'close_round', { round, reason });
      return { round, finished };
    });

    this.scheduleClose(gameId, null);
    this.onChange(gameId, { event: { type: 'round_results', round: result.round, finished: result.finished } });
    return result;
  }

  // ---------- views ----------

  history(gameId) {
    const rows = this.db.all(`SELECT * FROM round_results WHERE game_id = ? ORDER BY round, team_id`, gameId);
    const markets = this.db.all(`SELECT * FROM round_market WHERE game_id = ? ORDER BY round`, gameId);
    const top = this.db.all(
      `SELECT round, team_id, seq, sales FROM product_results WHERE game_id = ? ORDER BY round, sales DESC, team_id, seq`,
      gameId,
    );
    return markets.map((m) => ({
      round: m.round,
      results: rows.filter((r) => r.round === m.round).map((r) => ({
        teamId: r.team_id,
        sales: r.sales,
        cost: r.cost,
        net: r.net,
        best: r.best,
        loyalty: r.loyalty,
        share: r.share,
        accumulated: r.accumulated,
        roundRank: r.round_rank,
        overallRank: r.overall_rank,
        productCount: r.product_count,
        submitted: !!r.submitted,
      })),
      market: JSON.parse(m.market_json),
      cellCounts: JSON.parse(m.cell_counts),
      news: JSON.parse(m.news_json),
      awards: JSON.parse(m.awards_json),
      // Top 10 shows who owns the best sellers, but not where they are positioned.
      top10: top.filter((t) => t.round === m.round).slice(0, 10).map((t) => ({ teamId: t.team_id, seq: t.seq, sales: t.sales })),
    }));
  }

  publicView(gameId) {
    const g = this.requireGame(gameId);
    const submittedSet = new Set(
      g.status === 'open'
        ? this.db.all(
          `SELECT team_id FROM decisions WHERE game_id = ? AND round = ? AND submitted_at IS NOT NULL`,
          g.id, g.current_round,
        ).map((r) => r.team_id)
        : [],
    );
    return {
      game: {
        id: g.id,
        name: g.name,
        status: g.status,
        round: g.current_round,
        totalRounds: g.total_rounds,
        maxTeams: g.max_teams,
        roundSeconds: g.round_seconds,
        autoClose: !!g.auto_close,
        deadline: g.deadline,
        serverNow: this.now(),
      },
      teams: this.teams(g.id).map((t) => ({
        id: t.id,
        number: t.number,
        name: t.name,
        color: t.color,
        accumulated: t.accumulated,
        productCount: t.product_count,
        online: (this.online.get(`${g.id}:${t.id}`) || 0) > 0,
        submitted: submittedSet.has(t.id),
      })),
      history: this.history(g.id),
    };
  }

  teamPrivate(gameId, teamId) {
    const g = this.requireGame(gameId);
    const team = this.db.get(`SELECT id, number, name, color, accumulated FROM teams WHERE id = ? AND game_id = ?`, teamId, g.id);
    if (!team) return null;
    const products = this.products(teamId);
    const results = this.db.all(
      `SELECT * FROM product_results WHERE game_id = ? AND team_id = ? ORDER BY round, seq`, g.id, teamId,
    );
    const dec = g.status === 'open'
      ? this.db.get(`SELECT * FROM decisions WHERE game_id = ? AND team_id = ? AND round = ?`, g.id, teamId, g.current_round)
      : null;
    return {
      ...team,
      budget: team.accumulated,
      products: products.map((p) => ({
        id: p.id,
        seq: p.seq,
        cell: p.cell,
        createdRound: p.created_round,
        lastSales: p.last_sales,
        cumBonus: p.cum_bonus,
        history: results.filter((r) => r.product_id === p.id).map((r) => ({
          round: r.round, from: r.from_cell, cell: r.cell, isNew: !!r.is_new, moved: !!r.moved,
          competitors: r.competitors, base: r.base, loyalty: r.loyalty, sales: r.sales, cost: r.cost,
        })),
      })),
      decision: dec
        ? {
          round: dec.round,
          submitted: dec.submitted_at
            ? { plan: JSON.parse(dec.plan_json), cost: dec.cost, at: dec.submitted_at, by: dec.submitted_by }
            : null,
          draft: dec.draft_at
            ? { plan: JSON.parse(dec.draft_json), cost: dec.draft_cost, at: dec.draft_at, by: dec.draft_by, client: dec.draft_client }
            : null,
        }
        : null,
    };
  }

  teamView(gameId, teamId) {
    return { ...this.publicView(gameId), me: this.teamPrivate(gameId, teamId) };
  }

  adminView(gameId) {
    const pub = this.publicView(gameId);
    const detail = pub.teams.map((t) => this.teamPrivate(gameId, t.id));
    const audit = this.db.all(
      `SELECT at, actor, action, detail FROM audit_log WHERE game_id = ? ORDER BY id DESC LIMIT 60`, gameId,
    );
    return { ...pub, detail, audit };
  }

  exportCsv(gameId) {
    const g = this.requireGame(gameId);
    const teams = new Map(this.teams(g.id).map((t) => [t.id, t]));
    const lines = [];
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    lines.push(['section', 'round', 'team_number', 'team_name', 'sales', 'positioning_cost', 'net_profit', 'market_share',
      'best_product_sales', 'loyalty_bonus', 'accumulated_profit', 'round_rank', 'overall_rank', 'products', 'submitted'].join(','));
    for (const r of this.db.all(`SELECT * FROM round_results WHERE game_id = ? ORDER BY round, overall_rank`, g.id)) {
      const t = teams.get(r.team_id) || {};
      lines.push(['team_result', r.round, t.number, t.name, r.sales, r.cost, r.net, (r.share * 100).toFixed(2) + '%', r.best,
        r.loyalty, r.accumulated, r.round_rank, r.overall_rank, r.product_count, r.submitted ? 'yes' : 'no (carried over)'].map(esc).join(','));
    }
    lines.push('');
    lines.push(['section', 'round', 'team_number', 'team_name', 'product', 'from_cell', 'to_cell', 'new', 'moved',
      'products_in_cell', 'base_sales', 'loyalty_bonus', 'total_sales', 'positioning_cost'].join(','));
    for (const r of this.db.all(`SELECT * FROM product_results WHERE game_id = ? ORDER BY round, team_id, seq`, g.id)) {
      const t = teams.get(r.team_id) || {};
      lines.push(['product_result', r.round, t.number, t.name, r.seq, r.from_cell, r.cell, r.is_new ? 'yes' : 'no',
        r.moved ? 'yes' : 'no', r.competitors, r.base, r.loyalty, r.sales, r.cost].map(esc).join(','));
    }
    return lines.join('\n');
  }

  exportJson(gameId) {
    const g = this.requireGame(gameId);
    const { admin_hash, ...game } = g;
    return {
      exportedAt: new Date(this.now()).toISOString(),
      game,
      teams: this.teams(g.id),
      products: this.db.all(`SELECT * FROM products WHERE game_id = ?`, g.id),
      decisions: this.db.all(`SELECT * FROM decisions WHERE game_id = ?`, g.id),
      roundResults: this.db.all(`SELECT * FROM round_results WHERE game_id = ?`, g.id),
      productResults: this.db.all(`SELECT * FROM product_results WHERE game_id = ?`, g.id),
      market: this.db.all(`SELECT * FROM round_market WHERE game_id = ?`, g.id),
    };
  }

  deleteGame(gameId) {
    const g = this.requireGame(gameId);
    this.scheduleClose(g.id, null);
    this.db.run(`DELETE FROM games WHERE id = ?`, g.id);
    this.audit(g.id, 'admin', 'delete_game', null);
  }

  listGames() {
    return this.db.all(
      `SELECT id, name, status, current_round, total_rounds, created_at,
              (SELECT COUNT(*) FROM teams t WHERE t.game_id = g.id) AS teams
         FROM games g ORDER BY created_at DESC LIMIT 100`,
    );
  }
}

// ---------- news & awards (public information only) ----------

const fmt = (n) => Math.round(n).toLocaleString('en-US');

function buildNews({ round, teams, res, prevRows, prevMarket }) {
  const name = new Map(teams.map((t) => [t.id, t.name]));
  const news = [];
  const byAcc = [...res.teams].sort((a, b) => b.accumulated - a.accumulated);
  const byNet = [...res.teams].sort((a, b) => b.net - a.net);
  if (byAcc[0]) news.push({ kind: 'leader', text: `${name.get(byAcc[0].teamId)} leads the market with ${fmt(byAcc[0].accumulated)} accumulated profit.` });
  if (byNet[0] && res.teams.length > 1) news.push({ kind: 'round', text: `${name.get(byNet[0].teamId)} posts the best result of round ${round}: ${byNet[0].net >= 0 ? '+' : ''}${fmt(byNet[0].net)} net profit.` });

  if (prevMarket && prevMarket.totalSales > 0) {
    const g = (res.market.totalSales - prevMarket.totalSales) / prevMarket.totalSales;
    news.push({ kind: 'market', text: `Total market sales ${g >= 0 ? 'grew' : 'fell'} ${Math.abs(g * 100).toFixed(0)}% to ${fmt(res.market.totalSales)} points.` });
  } else {
    news.push({ kind: 'market', text: `The market opens with ${fmt(res.market.totalSales)} points of sales across ${res.market.totalProducts} products.` });
  }

  const launches = res.products.filter((p) => p.isNew).length;
  const moves = res.products.filter((p) => !p.isNew && p.moved).length;
  if (launches) news.push({ kind: 'launch', text: `${launches} new product${launches === 1 ? '' : 's'} launched this round.` });
  if (moves) news.push({ kind: 'move', text: `${moves} product${moves === 1 ? ' was' : 's were'} repositioned.` });

  for (const s of E.SEGMENTS) {
    const c = res.cellCounts[s.cell] || 0;
    const d = E.demandOf(s.cell);
    if (c === 0) news.push({ kind: 'opportunity', text: `Nobody is serving the ${s.name} segment (${s.cell}) – ${fmt(d)} points left on the table.` });
    else if (c >= 3) news.push({ kind: 'crowded', text: `${s.name} (${s.cell}) is crowded: ${c} products are splitting ${fmt(d)} points.` });
  }

  if (prevRows.length) {
    const prev = new Map(prevRows.map((r) => [r.team_id, r.overall_rank]));
    let best = null;
    for (const t of res.teams) {
      const p = prev.get(t.teamId);
      if (p && p - t.overallRank > 0 && (!best || p - t.overallRank > best.gain)) best = { teamId: t.teamId, gain: p - t.overallRank, rank: t.overallRank };
    }
    if (best) news.push({ kind: 'climber', text: `${name.get(best.teamId)} climbs ${best.gain} place${best.gain === 1 ? '' : 's'} to #${best.rank} overall.` });
  }
  return news;
}

function buildAwards({ teams, res }) {
  const awards = [];
  const pick = (list, key, filter = () => true) => {
    const c = list.filter(filter);
    if (!c.length) return null;
    const max = Math.max(...c.map((x) => x[key]));
    return c.filter((x) => x[key] === max);
  };
  const add = (id, icon, title, desc, winners, value) => {
    if (!winners || !winners.length) return;
    awards.push({ id, icon, title, desc, teamIds: winners.map((w) => w.teamId), value });
  };

  const sales = pick(res.teams, 'sales', (t) => t.sales > 0);
  add('market_leader', '👑', 'Market Leader', 'Highest sales this round', sales, sales?.[0].sales);

  const roi = res.teams.filter((t) => t.cost > 0).map((t) => ({ teamId: t.teamId, roi: t.sales / t.cost }));
  const roiW = pick(roi, 'roi');
  add('best_roi', '🎯', 'Sharpest Investor', 'Best sales return on positioning spend', roiW, roiW ? +roiW[0].roi.toFixed(2) : null);

  const loyal = pick(res.teams, 'loyalty', (t) => t.loyalty > 0);
  add('loyalty', '💎', 'Loyalty Champion', 'Largest customer-loyalty bonus', loyal, loyal?.[0].loyalty);

  const solo = new Map();
  for (const p of res.products) if (p.competitors === 1) solo.set(p.teamId, (solo.get(p.teamId) || 0) + 1);
  const soloW = pick([...solo].map(([teamId, n]) => ({ teamId, n })), 'n');
  add('blue_ocean', '🌊', 'Blue Ocean', 'Most products with a cell all to themselves', soloW, soloW?.[0].n);

  const topP = [...res.products].sort((a, b) => b.sales - a.sales)[0];
  if (topP && topP.sales > 0) add('hit_product', '🚀', 'Hit Product', 'Owns the best-selling product', [{ teamId: topP.teamId }], topP.sales);

  return awards;
}

module.exports = { GameService, GameError, TEAM_COLORS };
