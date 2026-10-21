'use strict';
// End-to-end: real HTTP + Socket.IO server, 10 team "laptops", a facilitator
// and a projector screen, playing all 8 rounds. Checks scoring persistence,
// privacy between teams, budget enforcement and leaderboard output.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');
const E = require('../server/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'posgame-'));

async function api(base, method, url, body, token) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function client(base, auth) {
  return new Promise((resolve, reject) => {
    const s = connect(base, { auth, transports: ['websocket'], forceNew: true });
    s.latest = null;
    s.states = [];
    s.on('state', (st) => { s.latest = st; s.states.push(st); });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const emit = (s, ev, msg) => new Promise((resolve) => s.emit(ev, msg, resolve));
const waitFor = async (pred, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for condition');
};

test('10 teams play 8 rounds over sockets with private decisions', async (t) => {
  const srv = createServer({ dbFile: path.join(tmp, 'g.db'), quiet: true });
  const port = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(() => srv.close());

  const created = await api(base, 'POST', '/api/games', { name: 'Test Cup', totalRounds: 8, maxTeams: 10, roundSeconds: 0, autoClose: false, adminPassword: 'secret' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const { gameId, adminToken } = created.data;

  // bad admin login
  assert.equal((await api(base, 'POST', `/api/games/${gameId}/admin-login`, { password: 'nope' })).status, 401);

  const admin = await client(base, { token: adminToken });
  const screen = await client(base, { role: 'screen', gameId });

  const teams = [];
  for (let i = 1; i <= 10; i++) {
    const r = await api(base, 'POST', `/api/games/${gameId}/join`, { teamName: `Team ${i}`, pin: '1234' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    teams.push({ ...r.data, name: `Team ${i}` });
  }
  // 11th team rejected, duplicate name with wrong PIN rejected, correct PIN rejoins
  assert.equal((await api(base, 'POST', `/api/games/${gameId}/join`, { teamName: 'Team 11', pin: '1234' })).status, 403);
  assert.equal((await api(base, 'POST', `/api/games/${gameId}/join`, { teamName: 'team 3', pin: '9999' })).status, 401);
  const rejoin = await api(base, 'POST', `/api/games/${gameId}/join`, { teamName: 'TEAM 3', pin: '1234' });
  assert.equal(rejoin.data.rejoined, true);

  for (const tm of teams) tm.sock = await client(base, { token: tm.token });
  // a team token cannot perform admin actions
  // (no 'admin' handler is registered on team sockets, so the ack never fires)
  const sneaky = await Promise.race([emit(teams[0].sock, 'admin', { action: 'start' }), new Promise((r) => setTimeout(() => r('ignored'), 300))]);
  assert.equal(sneaky, 'ignored');
  assert.equal(admin.latest.game.status, 'lobby');
  // forged tokens are refused
  await assert.rejects(client(base, { token: teams[0].token.replace(/.$/, 'x') }));

  assert.equal((await emit(admin, 'admin', { action: 'start' })).ok, true);
  await waitFor(() => teams.every((tm) => tm.sock.latest?.game.status === 'open'));

  // Over-budget submission is rejected (A10 = 3600, two of them = 7200 > 5000)
  const over = await emit(teams[0].sock, 'plan:save', { plan: [{ seq: 1, cell: 'A10' }, { seq: 2, cell: 'A10' }], submit: true });
  assert.equal(over.ok, false);
  assert.match(over.error, /budget/);
  // Invalid cell rejected
  assert.equal((await emit(teams[0].sock, 'plan:save', { plan: [{ seq: 1, cell: 'Z9' }], submit: true })).ok, false);

  // Deterministic strategies so we can reproduce the expected outcome with the engine.
  const targets = ['A10', 'H3', 'D3', 'I8', 'H3', 'A9', 'B10', 'H2', 'I7', 'G3'];
  const extra = ['I8', 'D2', 'H4', 'J8', 'D3', 'H3', 'I9', 'I8', 'C3', 'A10'];
  const shadow = teams.map(() => ({ acc: E.STARTING_BUDGET, products: [] }));

  for (let round = 1; round <= 8; round++) {
    if (round > 1) {
      assert.equal((await emit(admin, 'admin', { action: 'start' })).ok, true);
      await waitFor(() => teams.every((tm) => tm.sock.latest?.game.status === 'open' && tm.sock.latest.game.round === round));
    }
    for (let i = 0; i < teams.length; i++) {
      const me = teams[i].sock.latest.me;
      let plan = me.products.map((p) => ({ seq: p.seq, cell: p.cell }));
      if (round === 1) plan = [{ seq: 1, cell: targets[i] }];
      if (round === 2 && i % 2 === 0) plan.push({ seq: plan.length + 1, cell: extra[i] });
      if (round === 4 && i === 3) plan[0].cell = 'I9';
      if (i === 9 && round === 3) continue; // team 10 forgets to submit -> carry over
      const cost = E.planCost(me.products.map((p) => ({ id: p.seq, cell: p.cell })), plan.map((p) => ({ id: p.seq, cell: p.cell }))).total;
      if (cost > me.budget) plan = me.products.map((p) => ({ seq: p.seq, cell: p.cell }));
      const r = await emit(teams[i].sock, 'plan:save', { plan, submit: true, by: `player${i}` });
      assert.equal(r.ok, true, r.error);
    }

    // Privacy: while the round is open, no team state contains another team's products/decisions
    await waitFor(() => screen.latest?.teams.filter((x) => x.submitted).length >= 9);
    for (let i = 0; i < teams.length; i++) {
      const st = teams[i].sock.latest;
      assert.equal(st.me.id, teams[i].teamId);
      assert.equal(st.detail, undefined);
      const json = JSON.stringify(st);
      for (let j = 0; j < teams.length; j++) {
        if (j === i) continue;
        assert.ok(!json.includes(`"player${j}"`), 'leaked another team decision');
      }
      assert.ok(!('products' in st.teams[0]), 'public team list must not include products');
      for (const h of st.history) for (const top of h.top10) assert.ok(!('cell' in top), 'top10 must not reveal cells');
    }
    assert.equal(screen.latest.me, undefined);
    // admin sees all decisions
    assert.equal(admin.latest.detail.filter((d) => d.decision?.submitted).length >= 9, true);

    // Shadow-compute with the pure engine using the same plans the server stored
    const adminDetail = admin.latest.detail;
    const input = adminDetail.map((d, i) => {
      const plan = d.decision?.submitted ? d.decision.submitted.plan : d.products.map((p) => ({ seq: p.seq, cell: p.cell }));
      return {
        teamId: d.id,
        accumulated: shadow[i].acc,
        products: plan.map((pl) => {
          const prev = shadow[i].products[pl.seq - 1];
          return { id: `${d.id}:${pl.seq}`, prevCell: prev ? prev.cell : null, cell: pl.cell, prevSales: prev ? prev.sales : 0, prevBonus: prev ? prev.bonus : 0 };
        }),
      };
    });
    const expected = E.resolveRound(input);
    expected.teams.forEach((tr, i) => {
      shadow[i].acc = tr.accumulated;
    });
    for (const pr of expected.products) {
      const i = adminDetail.findIndex((d) => d.id === pr.teamId);
      const seq = Number(String(pr.productId).split(':')[1]);
      shadow[i].products[seq - 1] = { cell: pr.cell, sales: pr.sales, bonus: pr.cumBonus };
    }

    assert.equal((await emit(admin, 'admin', { action: 'close' })).ok, true);
    const want = round === 8 ? 'finished' : 'results';
    await waitFor(() => screen.latest?.game.status === want && screen.latest.history.length === round);
    const got = screen.latest.history[round - 1].results;
    for (const tr of expected.teams) {
      const g = got.find((x) => x.teamId === tr.teamId);
      assert.equal(g.accumulated, tr.accumulated, `round ${round} team ${tr.teamId} accumulated`);
      assert.equal(g.sales, tr.sales);
    }
    if (round === 3) assert.equal(got.find((x) => x.teamId === teams[9].teamId).submitted, false);
  }

  // Decisions after game end are refused
  const late = await emit(teams[0].sock, 'plan:save', { plan: [], submit: true });
  assert.equal(late.ok, false);

  // Final leaderboard is ranked and exported
  const final = screen.latest.history[7].results.sort((a, b) => a.overallRank - b.overallRank);
  assert.equal(final[0].overallRank, 1);
  const csv = await api(base, 'GET', `/api/games/${gameId}/export.csv`, null, adminToken);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /team_result,8,/);
  assert.equal((await api(base, 'GET', `/api/games/${gameId}/export.csv`, null, teams[0].token)).status, 401);

  console.log('  final leaderboard:', final.map((r) => `${r.overallRank}. team${r.teamId} ${r.accumulated}`).join(' | '));
  for (const tm of teams) tm.sock.close();
  admin.close();
  screen.close();
});

test('state survives a server restart mid-round', async (t) => {
  const file = path.join(tmp, 'restart.db');
  let srv = createServer({ dbFile: file, quiet: true });
  let port = await srv.listen(0, '127.0.0.1');
  let base = `http://127.0.0.1:${port}`;
  const { gameId, adminToken } = (await api(base, 'POST', '/api/games', { name: 'R', totalRounds: 2, roundSeconds: 0, adminPassword: 'pass1' })).data;
  const tm = (await api(base, 'POST', `/api/games/${gameId}/join`, { teamName: 'Alpha', pin: '4321' })).data;
  let admin = await client(base, { token: adminToken });
  await emit(admin, 'admin', { action: 'start' });
  let s = await client(base, { token: tm.token });
  await waitFor(() => s.latest?.game.status === 'open');
  assert.equal((await emit(s, 'plan:save', { plan: [{ seq: 1, cell: 'H3' }], submit: true })).ok, true);
  s.close();
  admin.close();
  await srv.close();

  srv = createServer({ dbFile: file, quiet: true });
  port = await srv.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
  t.after(() => srv.close());
  s = await client(base, { token: tm.token }); // old token still valid after restart
  await waitFor(() => s.latest?.me);
  assert.equal(s.latest.me.decision.submitted.plan[0].cell, 'H3');
  admin = await client(base, { token: adminToken });
  await waitFor(() => admin.latest);
  await emit(admin, 'admin', { action: 'close' });
  await waitFor(() => s.latest?.game.status === 'results');
  assert.equal(s.latest.me.budget, 5000 - 800 + 1000);
  s.close();
  admin.close();
});

test('round timer closes the round automatically', async (t) => {
  const srv = createServer({ dbFile: path.join(tmp, 'timer.db'), quiet: true });
  const port = await srv.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(() => srv.close());
  const { gameId, adminToken } = (await api(base, 'POST', '/api/games', { name: 'T', totalRounds: 1, roundSeconds: 60, adminPassword: 'pass1' })).data;
  await api(base, 'POST', `/api/games/${gameId}/join`, { teamName: 'Solo', pin: '1111' });
  const admin = await client(base, { token: adminToken });
  await emit(admin, 'admin', { action: 'start' });
  await emit(admin, 'admin', { action: 'extend', seconds: -3600 }); // clamps to now + 5s
  await waitFor(() => admin.latest?.game.status === 'finished', 9000);
  admin.close();
});
