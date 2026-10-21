import {
  $, $$, esc, fmt, signed, pct, qs, store, api, loadConfig, cfg, syncClock, remaining, clock, toast,
  renderMap, mapLegend, lineChart, race, phaseLabel, teamMap, standings, segmentOf, demandOf,
} from './common.js';

const gameId = (qs('g') || '').toUpperCase();
const auth = store.get(`pg:admin:${gameId}`);
if (!gameId || !auth?.token) location.replace(`/?g=${gameId}`);

await loadConfig();
const C = cfg();
let state = null;
let tab = 'board';

const socket = io({ auth: { token: auth.token }, transports: ['websocket', 'polling'] });
socket.on('connect', () => $('#conn').classList.add('on'));
socket.on('disconnect', () => $('#conn').classList.remove('on'));
socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') {
    store.del(`pg:admin:${gameId}`);
    alert('Facilitator session expired. Please log in again.');
    location.replace(`/?g=${gameId}`);
  }
});
socket.on('gone', () => { alert('This game no longer exists.'); location.replace('/'); });
socket.on('state', (s) => {
  syncClock(s.game.serverNow);
  state = s;
  render();
});

const act = (action, extra = {}) => new Promise((resolve) => {
  socket.timeout(10000).emit('admin', { action, ...extra }, (err, res) => {
    if (err || !res?.ok) toast(res?.error || 'No response from server.', 'err');
    resolve(res);
  });
});

// static bits
$('#screen-link').href = `/screen.html?g=${gameId}`;
$('#export-csv').href = `/api/games/${gameId}/export.csv?token=${encodeURIComponent(auth.token)}`;
$('#export-json').href = `/api/games/${gameId}/export.json?token=${encodeURIComponent(auth.token)}`;
$('#code').textContent = gameId;
$('#join-url').value = `${location.origin}/?g=${gameId}`;
for (let i = 1; i <= C.maxRounds; i++) $('#set-rounds').add(new Option(String(i), String(i)));

function render() {
  const g = state.game;
  const [label, cls] = phaseLabel(g);
  $('#game-name').firstChild.textContent = g.name;
  document.title = `Control · ${g.name}`;
  $('#phase').textContent = label;
  $('#phase').className = `pill ${cls}`;
  $('#round').textContent = `${g.round}/${g.totalRounds}`;
  const submitted = state.teams.filter((t) => t.submitted).length;
  $('#subs').textContent = g.status === 'open' ? `${submitted}/${state.teams.length}` : '–';

  // controls
  const start = $('#btn-start');
  const close = $('#btn-close');
  start.classList.toggle('hidden', g.status === 'open' || g.status === 'finished');
  close.classList.toggle('hidden', g.status !== 'open');
  start.textContent = `▶ Start round ${g.round + 1}`;
  start.disabled = !state.teams.length;
  $$('[data-extend]').forEach((b) => { b.disabled = g.status !== 'open'; });
  $('#btn-stop-timer').disabled = g.status !== 'open' || !g.deadline;
  $('#btn-end').disabled = g.status === 'finished';
  const msg = {
    lobby: state.teams.length ? `${state.teams.length} team(s) in the lobby. Start when everyone has joined.` : 'Waiting for teams to join…',
    open: `Round ${g.round} is live. ${submitted} of ${state.teams.length} teams submitted.${g.autoClose ? ' The round closes automatically once all have submitted.' : ''}`,
    results: `Round ${g.round} resolved. Discuss results, then start round ${g.round + 1}.`,
    finished: 'Game over. Final leaderboard is on the big screen. Export the results below.',
  }[g.status];
  $('#control-msg').textContent = msg;

  // settings (don't clobber while focused)
  if (document.activeElement?.id !== 'set-minutes') {
    const mins = String(Math.round(g.roundSeconds / 60));
    if (![...$('#set-minutes').options].some((o) => o.value === mins)) $('#set-minutes').add(new Option(mins, mins));
    $('#set-minutes').value = mins;
  }
  if (document.activeElement?.id !== 'set-rounds') $('#set-rounds').value = String(g.totalRounds);
  $('#set-auto').checked = g.autoClose;

  renderTeams();
  renderTab();
}

function renderTeams() {
  const g = state.game;
  const detail = new Map(state.detail.map((d) => [d.id, d]));
  $('#teams-body').innerHTML = state.teams.map((t) => {
    const d = detail.get(t.id);
    const sub = d?.decision?.submitted;
    const draft = d?.decision?.draft;
    const planCells = sub
      ? sub.plan.map((p) => {
        const cur = d.products.find((x) => x.seq === p.seq);
        const from = cur ? cur.cell : 'START';
        return `<span class="mono" title="${from} → ${p.cell}">#${p.seq} ${from === p.cell ? p.cell : `${from}→<b>${p.cell}</b>`}</span>`;
      }).join(' · ')
      : g.status === 'open'
        ? `<span class="dim">${draft ? `drafting… (${draft.plan.length} products${draft.by ? `, last edit ${esc(draft.by)}` : ''})` : 'no decision yet'}</span>`
        : `<span class="dim">${d?.products.map((p) => `#${p.seq} ${p.cell}`).join(' · ') || 'no products'}</span>`;
    const status = g.status === 'open'
      ? (t.submitted ? '<span class="tag hold">submitted</span>' : '<span class="tag moved">deciding</span>')
      : '';
    return `<tr>
      <td><span class="rank" style="background:${t.color};color:#0b1220">${t.number}</span></td>
      <td><b>${esc(t.name)}</b><div class="muted" style="font-size:12px">${t.online ? '<span class="good">● online</span>' : '<span class="dim">○ offline</span>'}${sub?.by ? ` · by ${esc(sub.by)}` : ''}</div></td>
      <td>${status}</td>
      <td class="n">${fmt(t.accumulated)}</td>
      <td class="n">${t.productCount}</td>
      <td style="font-size:13px;max-width:520px">${planCells}</td>
      <td class="n">${sub ? fmt(sub.cost) : ''}</td>
      <td style="white-space:nowrap">
        <button class="small ghost" data-rename="${t.id}" title="Rename">✎</button>
        <button class="small ghost" data-pin="${t.id}" title="Reset PIN (logs the team out)">🔑</button>
        ${g.round <= 1 && g.status !== 'results' && g.status !== 'finished' ? `<button class="small ghost" data-remove="${t.id}" title="Remove team">✕</button>` : ''}
      </td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No teams yet – share the game code.</td></tr>';

  $$('[data-rename]').forEach((b) => b.onclick = async () => {
    const t = state.teams.find((x) => x.id === Number(b.dataset.rename));
    const name = prompt('New team name', t.name);
    if (name) act('rename', { teamId: t.id, name });
  });
  $$('[data-pin]').forEach((b) => b.onclick = async () => {
    const t = state.teams.find((x) => x.id === Number(b.dataset.pin));
    const pin = prompt(`New PIN for ${t.name} (4–8 digits). The team will need to rejoin with it.`);
    if (pin) { const r = await act('resetPin', { teamId: t.id, pin }); if (r?.ok) toast(`PIN reset for ${t.name}`, 'ok'); }
  });
  $$('[data-remove]').forEach((b) => b.onclick = async () => {
    const t = state.teams.find((x) => x.id === Number(b.dataset.remove));
    if (confirm(`Remove ${t.name} from the game?`)) act('remove', { teamId: t.id });
  });
}

function renderTab() {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  const body = $('#tab-body');
  const h = state.history;
  if (tab === 'board') {
    if (!h.length) { body.innerHTML = '<div class="empty">The leaderboard appears after round 1.</div>'; return; }
    const st = standings(state);
    if (!body.querySelector('#race')) {
      body.innerHTML = `<div class="grid cols-2"><div><h3>Accumulated profit</h3><div id="race"></div></div><div><h3>Accumulated profit by round</h3><div id="acc-chart"></div></div></div>`;
    }
    race($('#race'), st.map((r) => ({ id: r.id, name: r.name, color: r.color, value: r.accumulated })));
    lineChart($('#acc-chart'), state.teams.map((t) => ({ name: t.name, color: t.color, values: h.map((x) => x.results.find((y) => y.teamId === t.id)?.accumulated ?? null) })), h.map((x) => `R${x.round}`), { zero: false });
  } else if (tab === 'map') {
    const tm = teamMap(state);
    const chips = {};
    for (const d of state.detail) {
      const t = tm.get(d.id);
      const source = state.game.status === 'open' && d.decision?.submitted ? d.decision.submitted.plan : d.products.map((p) => ({ seq: p.seq, cell: p.cell }));
      for (const p of source) (chips[p.cell] = chips[p.cell] || []).push({ label: `${t.number}`, color: t.color });
    }
    body.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
      <div><div class="muted" style="margin-bottom:8px">${state.game.status === 'open' ? 'Showing submitted plans for this round (teams that have not submitted are shown at their current positions).' : 'Current positions of every product.'} Chip number = team number.</div><div id="admin-map"></div>${mapLegend('demand')}</div>
      <div><h3>Teams</h3>${state.teams.map((t) => `<div class="team-name" style="margin:4px 12px 4px 0"><span class="chip" style="background:${t.color};display:inline-grid">${t.number}</span>${esc(t.name)}</div>`).join('')}</div></div>`;
    renderMap($('#admin-map'), {
      mode: 'demand',
      chips,
      counts: h.length ? h[h.length - 1].cellCounts : {},
      tooltip: (cell) => {
        const seg = segmentOf(cell);
        const list = (chips[cell] || []).map((c) => tm.get(state.teams.find((t) => String(t.number) === c.label)?.id)?.name).filter(Boolean);
        return `<div class="t">${cell}${seg ? ' · ' + esc(seg.name) : ''}</div><div class="kv">Demand <b>${fmt(demandOf(cell))}</b></div><div class="kv">Products <b>${list.length}</b></div>${list.length ? `<div class="muted" style="font-size:12px">${list.map(esc).join(', ')}</div>` : ''}`;
      },
    });
  } else if (tab === 'matrix') {
    if (!h.length) { body.innerHTML = '<div class="empty">No rounds resolved yet.</div>'; return; }
    const tm = teamMap(state);
    body.innerHTML = h.slice().reverse().map((hr) => `
      <h3 style="margin-top:12px">Round ${hr.round} · market sales ${fmt(hr.market.totalSales)} · ${hr.market.totalProducts} products</h3>
      <div class="table-scroll"><table><thead><tr><th>Team</th><th class="n">Sales</th><th class="n">Share</th><th class="n">Best</th><th class="n">Loyalty</th><th class="n">Cost</th><th class="n">Net</th><th class="n">Round rank</th><th class="n">Accumulated</th><th class="n">Overall</th><th class="n">Products</th><th>Submitted</th></tr></thead>
      <tbody>${hr.results.slice().sort((a, b) => a.overallRank - b.overallRank).map((r) => {
        const t = tm.get(r.teamId) || {};
        return `<tr><td><span class="team-name"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span></td><td class="n">${fmt(r.sales)}</td><td class="n">${pct(r.share)}</td><td class="n">${fmt(r.best)}</td><td class="n">${fmt(r.loyalty)}</td><td class="n">${fmt(r.cost)}</td><td class="n ${r.net >= 0 ? 'good' : 'bad'}">${signed(r.net)}</td><td class="n">#${r.roundRank}</td><td class="n"><b>${fmt(r.accumulated)}</b></td><td class="n">#${r.overallRank}</td><td class="n">${r.productCount}</td><td>${r.submitted ? 'yes' : '<span class="warn">carried over</span>'}</td></tr>`;
      }).join('')}</tbody></table></div>`).join('');
  } else if (tab === 'log') {
    const tm = teamMap(state);
    const who = (a) => (a.startsWith('team:') ? tm.get(Number(a.slice(5)))?.name || a : a);
    body.innerHTML = `<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>${state.audit.map((a) => {
      let d = '';
      try { const x = JSON.parse(a.detail || 'null'); d = x ? Object.entries(x).filter(([k]) => k !== 'plan').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : ''; } catch { d = ''; }
      return `<tr><td class="mono">${new Date(a.at).toLocaleTimeString()}</td><td>${esc(who(a.actor))}</td><td>${esc(a.action)}</td><td class="muted" style="font-size:13px">${esc(d)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }
}

// ---------- controls ----------
$('#btn-start').onclick = async () => {
  const r = await act('start');
  if (r?.ok) toast('Round started', 'ok');
};
$('#btn-close').onclick = async () => {
  const notSubmitted = state.teams.filter((t) => !t.submitted).map((t) => t.name);
  if (notSubmitted.length && !confirm(`${notSubmitted.join(', ')} ${notSubmitted.length === 1 ? 'has' : 'have'} not submitted. Their products will stay where they are. Close the round now?`)) return;
  act('close');
};
$$('[data-extend]').forEach((b) => b.onclick = () => act('extend', { seconds: Number(b.dataset.extend) }));
$('#btn-stop-timer').onclick = () => act('stopTimer');
$('#btn-end').onclick = () => {
  if (confirm('End the game now? If a round is running it will be resolved first, and that becomes the final round.')) act('end');
};
$('#btn-delete').onclick = async () => {
  if (prompt(`This permanently deletes the game and all data. Type the game code (${gameId}) to confirm.`)?.toUpperCase() !== gameId) return;
  try {
    await api('DELETE', `/api/games/${gameId}`, null, auth.token);
    store.del(`pg:admin:${gameId}`);
    location.replace('/');
  } catch (err) { toast(err.message, 'err'); }
};
$('#set-minutes').onchange = (e) => act('settings', { settings: { roundSeconds: Number(e.target.value) * 60 } }).then((r) => r?.ok && toast('Timer updated – applies from the next round', 'ok'));
$('#set-rounds').onchange = (e) => act('settings', { settings: { totalRounds: Number(e.target.value) } });
$('#set-auto').onchange = (e) => act('settings', { settings: { autoClose: e.target.checked } });
$('#copy-url').onclick = () => { navigator.clipboard?.writeText($('#join-url').value).then(() => toast('Link copied', 'ok')); };
$$('#tabs button').forEach((b) => b.onclick = () => { tab = b.dataset.t; $('#tab-body').innerHTML = ''; renderTab(); });

setInterval(() => {
  if (!state) return;
  const g = state.game;
  const el = $('#timer');
  if (g.status !== 'open') { el.textContent = g.status === 'finished' ? 'FINAL' : '--:--'; el.className = 'timer'; return; }
  const ms = remaining(g.deadline);
  el.textContent = ms == null ? '∞' : clock(ms);
  el.className = `timer ${ms != null && ms < 30000 ? 'urgent' : ms != null && ms < 90000 ? 'soon' : ''}`;
}, 250);
