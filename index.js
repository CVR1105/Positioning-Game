'use strict';
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');

const E = require('./engine');
const { open } = require('./db');
const { makeTokens, makeRateLimiter } = require('./security');
const { GameService, GameError } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'positioning-game.db');
const FACILITATOR_KEY = process.env.FACILITATOR_KEY || '';

function createServer({ dbFile = DB_FILE, facilitatorKey = FACILITATOR_KEY, quiet = false } = {}) {
  const db = open(dbFile);
  let secret = db.get(`SELECT value FROM settings WHERE key = 'token_secret'`)?.value;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.run(`INSERT INTO settings (key, value) VALUES ('token_secret', ?)`, secret);
  }
  const tokens = makeTokens(secret);

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10000,
    pingTimeout: 8000,
    cors: { origin: false },
  });

  // ---------- broadcasting ----------
  // Coalesce bursts of changes into one push per game; every recipient gets
  // a view built for its role, so private data never leaves its room.
  const pending = new Map();
  function onChange(gameId, opts = {}) {
    if (opts.event) io.to(`g:${gameId}`).emit('event', opts.event);
    if (opts.kickTeam) {
      io.in(`t:${gameId}:${opts.kickTeam}`).emit('kicked', { reason: 'Your session was reset by the facilitator. Please rejoin.' });
      io.in(`t:${gameId}:${opts.kickTeam}`).disconnectSockets(true);
    }
    let p = pending.get(gameId);
    if (!p) {
      p = { all: false, teams: new Set() };
      pending.set(gameId, p);
      setTimeout(() => flush(gameId), 40);
    }
    if (opts.teamOnly) p.teams.add(opts.teamOnly);
    else p.all = true;
  }

  function flush(gameId) {
    const p = pending.get(gameId);
    pending.delete(gameId);
    if (!p || service.stopped) return;
    try {
      if (!service.getGame(gameId)) {
        io.to(`g:${gameId}`).emit('gone');
        return;
      }
      if (p.all) {
        io.to(`s:${gameId}`).emit('state', service.publicView(gameId));
        for (const t of service.teams(gameId)) {
          const room = `t:${gameId}:${t.id}`;
          if (io.sockets.adapter.rooms.get(room)?.size) io.to(room).emit('state', service.teamView(gameId, t.id));
        }
      } else {
        for (const teamId of p.teams) {
          const room = `t:${gameId}:${teamId}`;
          if (io.sockets.adapter.rooms.get(room)?.size) io.to(room).emit('state', service.teamView(gameId, teamId));
        }
      }
      if (io.sockets.adapter.rooms.get(`a:${gameId}`)?.size) io.to(`a:${gameId}`).emit('state', service.adminView(gameId));
    } catch (err) {
      console.error('[broadcast]', err);
    }
  }

  const service = new GameService(db, tokens, { onChange });
  service.restoreTimers();

  // ---------- HTTP ----------
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '5m' }));

  const authLimiter = makeRateLimiter({ windowMs: 5 * 60 * 1000, max: 40 });
  const createLimiter = makeRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
  const ipOf = (req) => req.ip || req.socket.remoteAddress || 'unknown';

  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
      console.error('[http]', err);
      res.status(500).json({ error: 'Something went wrong on the server.' });
    }
  };

  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  const requireAdmin = (req) => {
    const auth = service.verifyAuth(bearer(req));
    if (!auth || auth.role !== 'admin' || auth.gameId !== String(req.params.id).toUpperCase()) {
      throw new GameError('Facilitator login required.', 401);
    }
    return auth;
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

  app.get('/api/config', (req, res) => res.json({
    rows: E.ROWS,
    cols: E.COLS,
    demand: E.DEMAND,
    start: E.START,
    moveCost: E.MOVE_COST,
    startingBudget: E.STARTING_BUDGET,
    loyaltyRate: E.LOYALTY_RATE,
    maxProducts: E.MAX_PRODUCTS,
    maxRounds: E.MAX_ROUNDS,
    maxTeams: E.MAX_TEAMS,
    segments: E.SEGMENTS,
    requiresFacilitatorKey: !!facilitatorKey,
  }));

  app.post('/api/games', wrap((req) => {
    if (!createLimiter(`create:${ipOf(req)}`)) throw new GameError('Too many games created from this device. Try later.', 429);
    if (facilitatorKey && req.body?.facilitatorKey !== facilitatorKey) throw new GameError('Invalid facilitator key.', 403);
    return service.createGame(req.body || {});
  }));

  app.get('/api/games/:id', wrap((req) => {
    const g = service.requireGame(req.params.id);
    const teams = service.teams(g.id).length;
    return { id: g.id, name: g.name, status: g.status, round: g.current_round, totalRounds: g.total_rounds, teams, maxTeams: g.max_teams };
  }));

  app.post('/api/games/:id/join', wrap((req) => {
    if (!authLimiter(`join:${ipOf(req)}`)) throw new GameError('Too many attempts. Wait a few minutes and try again.', 429);
    return service.joinTeam(req.params.id, req.body?.teamName, req.body?.pin);
  }));

  app.post('/api/games/:id/admin-login', wrap((req) => {
    if (!authLimiter(`admin:${ipOf(req)}`)) throw new GameError('Too many attempts. Wait a few minutes and try again.', 429);
    return service.adminLogin(req.params.id, req.body?.password);
  }));

  app.get('/api/games/:id/export.csv', wrap((req, res) => {
    const { gameId } = requireAdmin(req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="positioning-${gameId}.csv"`);
    res.send(service.exportCsv(gameId));
  }));

  app.get('/api/games/:id/export.json', wrap((req, res) => {
    const { gameId } = requireAdmin(req);
    res.setHeader('Content-Disposition', `attachment; filename="positioning-${gameId}.json"`);
    res.json(service.exportJson(gameId));
  }));

  app.delete('/api/games/:id', wrap((req) => {
    const { gameId } = requireAdmin(req);
    service.deleteGame(gameId);
    io.to(`g:${gameId}`).emit('gone');
    return { ok: true };
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- sockets ----------
  io.use((socket, next) => {
    const { token, gameId, role } = socket.handshake.auth || {};
    if (role === 'screen') {
      const g = service.getGame(gameId);
      if (!g) return next(new Error('Game not found'));
      socket.data = { role: 'screen', gameId: g.id };
      return next();
    }
    const auth = service.verifyAuth(token);
    if (!auth) return next(new Error('unauthorized'));
    socket.data = auth;
    next();
  });

  io.on('connection', (socket) => {
    const { role, gameId, teamId } = socket.data;
    socket.join(`g:${gameId}`);

    // simple per-socket flood guard
    let bucket = 0;
    const tick = setInterval(() => { bucket = 0; }, 1000);
    const flood = () => ++bucket > 15;

    const reply = (ack, fn) => {
      if (typeof ack !== 'function') ack = () => {};
      if (flood()) return ack({ ok: false, error: 'Slow down a little.' });
      try {
        ack({ ok: true, ...(fn() || {}) });
      } catch (err) {
        if (!(err instanceof GameError)) console.error('[socket]', err);
        ack({ ok: false, error: err instanceof GameError ? err.message : 'Server error.' });
      }
    };

    if (role === 'screen') {
      socket.join(`s:${gameId}`);
      socket.emit('state', service.publicView(gameId));
    } else if (role === 'team') {
      socket.join(`t:${gameId}:${teamId}`);
      service.setOnline(gameId, teamId, 1);
      socket.emit('state', service.teamView(gameId, teamId));
      onChange(gameId);

      socket.on('plan:save', (msg, ack) => reply(ack, () =>
        service.saveDecision(gameId, teamId, msg?.plan, { submit: !!msg?.submit, by: msg?.by, clientId: msg?.clientId })));
      socket.on('plan:withdraw', (msg, ack) => reply(ack, () => service.withdrawSubmission(gameId, teamId)));
    } else if (role === 'admin') {
      socket.join(`a:${gameId}`);
      socket.emit('state', service.adminView(gameId));

      socket.on('admin', (msg, ack) => reply(ack, () => {
        const a = msg?.action;
        switch (a) {
          case 'start': return service.startRound(gameId);
          case 'close': return service.closeRound(gameId, 'admin');
          case 'extend': return service.extendTimer(gameId, msg.seconds);
          case 'stopTimer': return service.stopTimer(gameId);
          case 'end': return service.endGame(gameId);
          case 'settings': return service.updateSettings(gameId, msg.settings || {});
          case 'resetPin': return service.resetTeamPin(gameId, msg.teamId, msg.pin);
          case 'rename': return service.renameTeam(gameId, msg.teamId, msg.name);
          case 'remove': return service.removeTeam(gameId, msg.teamId);
          default: throw new GameError('Unknown action.');
        }
      }));
    }

    socket.on('time', (ack) => typeof ack === 'function' && ack(Date.now()));

    socket.on('disconnect', () => {
      clearInterval(tick);
      if (role === 'team') {
        service.setOnline(gameId, teamId, -1);
        if (service.getGame(gameId)) onChange(gameId);
      }
    });
  });

  function listen(port = PORT, host = HOST) {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        const addr = server.address();
        if (!quiet) printBanner(addr.port);
        resolve(addr.port);
      });
    });
  }

  function close() {
    service.shutdown();
    return new Promise((resolve) => {
      io.close();
      server.close(() => {
        db.close();
        resolve();
      });
    });
  }

  return { app, server, io, service, db, listen, close };
}

function printBanner(port) {
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${port}`);
  }
  console.log('\n  Positioning Strategy Simulation is live');
  console.log('  ----------------------------------------');
  for (const u of urls) console.log(`  ${u}`);
  console.log('\n  Share a network address above with every team laptop on the same Wi-Fi/LAN.');
  if (FACILITATOR_KEY) console.log('  Creating games requires the FACILITATOR_KEY.');
  console.log(`  Data file: ${DB_FILE}\n`);
}

if (require.main === module) {
  const s = createServer();
  s.listen();
  const shutdown = () => {
    console.log('\nShutting down…');
    s.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
