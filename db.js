'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'lobby',   -- lobby | open | results | finished
  current_round  INTEGER NOT NULL DEFAULT 0,
  total_rounds   INTEGER NOT NULL,
  max_teams      INTEGER NOT NULL,
  round_seconds  INTEGER NOT NULL,               -- 0 = no timer
  auto_close     INTEGER NOT NULL DEFAULT 1,     -- close round when every team has submitted
  deadline       INTEGER,                        -- epoch ms, null when no timer running
  admin_hash     TEXT NOT NULL,
  token_version  INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  name           TEXT NOT NULL COLLATE NOCASE,
  color          TEXT NOT NULL,
  pin_hash       TEXT NOT NULL,
  token_version  INTEGER NOT NULL DEFAULT 1,
  accumulated    INTEGER NOT NULL DEFAULT 5000,
  created_at     INTEGER NOT NULL,
  UNIQUE (game_id, name),
  UNIQUE (game_id, number)
);

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  cell           TEXT NOT NULL,
  created_round  INTEGER NOT NULL,
  last_sales     INTEGER NOT NULL DEFAULT 0,
  cum_bonus      REAL NOT NULL DEFAULT 0,
  UNIQUE (team_id, seq)
);

CREATE TABLE IF NOT EXISTS decisions (
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  plan_json      TEXT,                           -- submitted plan (null = nothing submitted yet)
  cost           INTEGER,
  submitted_at   INTEGER,
  submitted_by   TEXT,
  draft_json     TEXT,                           -- shared working draft, synced across a team's laptops
  draft_cost     INTEGER,
  draft_at       INTEGER,
  draft_by       TEXT,
  draft_client   TEXT,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (game_id, team_id, round)
);

CREATE TABLE IF NOT EXISTS round_results (
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sales          INTEGER NOT NULL,
  cost           INTEGER NOT NULL,
  net            INTEGER NOT NULL,
  best           INTEGER NOT NULL,
  loyalty        INTEGER NOT NULL,
  share          REAL NOT NULL,
  accumulated    INTEGER NOT NULL,
  round_rank     INTEGER NOT NULL,
  overall_rank   INTEGER NOT NULL,
  product_count  INTEGER NOT NULL,
  submitted      INTEGER NOT NULL,
  PRIMARY KEY (game_id, round, team_id)
);

CREATE TABLE IF NOT EXISTS product_results (
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  from_cell      TEXT NOT NULL,
  cell           TEXT NOT NULL,
  is_new         INTEGER NOT NULL,
  moved          INTEGER NOT NULL,
  competitors    INTEGER NOT NULL,
  base           INTEGER NOT NULL,
  loyalty        INTEGER NOT NULL,
  cum_bonus      REAL NOT NULL,
  sales          INTEGER NOT NULL,
  cost           INTEGER NOT NULL,
  PRIMARY KEY (game_id, round, product_id)
);

CREATE TABLE IF NOT EXISTS round_market (
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round          INTEGER NOT NULL,
  cell_counts    TEXT NOT NULL,
  market_json    TEXT NOT NULL,
  news_json      TEXT NOT NULL,
  awards_json    TEXT NOT NULL,
  resolved_at    INTEGER NOT NULL,
  PRIMARY KEY (game_id, round)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        TEXT,
  at             INTEGER NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  detail         TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_game ON teams(game_id);
CREATE INDEX IF NOT EXISTS idx_products_team ON products(team_id, seq);
CREATE INDEX IF NOT EXISTS idx_products_game ON products(game_id);
CREATE INDEX IF NOT EXISTS idx_presults_team ON product_results(game_id, team_id, round);
CREATE INDEX IF NOT EXISTS idx_audit_game ON audit_log(game_id, at);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  let depth = 0;
  function tx(fn) {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }

  return {
    raw: db,
    tx,
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    close: () => db.close(),
  };
}

module.exports = { open };
