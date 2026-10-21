import {
  $, esc, fmt, signed, qs, loadConfig, syncClock, remaining, clock, sound, confetti,
  lineChart, race, heatGrid, setTicker, phaseLabel, teamMap, standings,
} from './common.js';

const gameId = (qs('g') || '').toUpperCase();
if (!gameId) location.replace('/');
await loadConfig();

let state = null;
let view = null;       // which stage layout is mounted
let lastTick = null;
let celebrated = false;

const socket = io({ auth: { role: 'screen', gameId }, transports: ['websocket', 'polling'] });
socket.on('connect', () => $('#conn').classList.add('on'));
socket.on('disconnect', () => $('#conn').classList.remove('on'));
socket.on('connect_error', (e) => { $('#conn').classList.remove('on'); if (e.message === 'Game not found') $('#stage').innerHTML = '<div class="empty">Game not found.</div>'; });
socket.on('gone', () => { $('#stage').innerHTML = '<div class="empty">This game was deleted.</div>'; });
socket.on('event', (ev) => {
  if (ev.type === 'round_started') sound.start();
  if (ev.type === 'round_results') { sound.fanfare(); view = null; }
});
socket.on('state', (s) => {
  syncClock(s.game.serverNow);
  state = s;
  render();
});

function render() {
  const g = state.game;
  const [label, cls] = phaseLabel(g);
  $('#title').textContent = g.name;
  $('#subtitle').textContent = `Game ${g.id} · ${state.teams.length} team${state.teams.length === 1 ? '' : 's'} · round ${g.round} of ${g.totalRounds}`;
  document.title = `${g.name} · Big screen`;
  $('#phase').textContent = label;
  $('#phase').className = `pill ${cls}`;
  const want = g.status;
  if (view !== want) { view = want; $('#stage').innerHTML = ''; }
  if (g.status === 'lobby') lobby();
  else if (g.status === 'open') live();
  else if (g.status === 'results') results();
  else finale();
  ticker();
}

function joinUrl() {
  return `${location.host}`;
}

function lobby() {
  const g = state.game;
  $('#stage').innerHTML = `
    <div class="grid cols-2" style="align-items:center">
      <div class="panel join-box">
        <div class="muted" style="font-size:20px">Open on your laptop</div>
        <div class="url" style="margin:8px 0 18px">${esc(joinUrl())}</div>
        <div class="muted" style="font-size:20px">and enter game code</div>
        <div class="code">${esc(g.id)}</div>
        <div class="muted" style="margin-top:10px">Pick a team name and a PIN – teammates join with the same name and PIN.</div>
      </div>
      <div>
        <h2 style="font-size:28px">Teams in the market <span class="muted">(${state.teams.length}/${g.maxTeams})</span></h2>
        <div class="sub-grid" style="grid-template-columns:repeat(2,1fr)">
          ${state.teams.map((t) => `<div class="sub-card done"><div class="badge" style="background:${t.color}">${t.number}</div><div class="nm">${esc(t.name)}</div><div class="st">${t.online ? 'ready' : 'joined'}</div></div>`).join('') || '<div class="empty" style="grid-column:1/-1">Waiting for the first team…</div>'}
        </div>
        <div class="panel" style="margin-top:18px">
          <h3>The market</h3>
          <div class="muted">Four segments: <b>Status Seekers (A10)</b> · <b>Fashion Conscious (D3)</b> · <b>Budget Conscious (H3)</b> · <b>Quality Focused (I8)</b>.
          Moving costs 200 per cell. Demand is split between everyone in a cell. Loyal (unmoved) products grow 10% a round. Highest accumulated profit after ${g.totalRounds} rounds wins.</div>
        </div>
      </div>
    </div>`;
}

function live() {
  const g = state.game;
  if (!$('#live-timer')) {
    $('#stage').innerHTML = `
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);align-items:start">
        <div class="panel" style="text-align:center">
          <div class="muted" style="font-size:22px;text-transform:uppercase;letter-spacing:.15em">Round ${g.round} of ${g.totalRounds}</div>
          <div class="screen-timer" id="live-timer">--:--</div>
          <div class="muted" style="font-size:20px;margin-top:6px" id="live-count"></div>
          <div class="budget-bar" style="height:14px;margin-top:16px"><div id="live-bar" style="width:0%"></div></div>
        </div>
        <div><h2 style="font-size:26px">Decisions</h2><div class="sub-grid" id="live-grid"></div></div>
      </div>
      <div class="grid cols-2" style="margin-top:20px" id="live-extra"></div>`;
  }
  const n = state.teams.filter((t) => t.submitted).length;
  $('#live-count').textContent = `${n} of ${state.teams.length} teams submitted`;
  $('#live-bar').style.width = `${state.teams.length ? (n / state.teams.length) * 100 : 0}%`;
  $('#live-grid').innerHTML = state.teams.map((t) => `<div class="sub-card ${t.submitted ? 'done' : ''}">
    <div class="badge" style="background:${t.color}">${t.submitted ? '✓' : t.number}</div>
    <div class="nm">${esc(t.name)}</div><div class="st">${t.submitted ? 'locked in' : t.online ? 'deciding…' : 'offline'}</div></div>`).join('');
  const h = state.history;
  const extra = $('#live-extra');
  if (h.length && !extra.dataset.done) {
    extra.dataset.done = '1';
    const last = h[h.length - 1];
    extra.innerHTML = `<div class="panel"><h3>Standings going into round ${g.round}</h3><div id="live-race"></div></div>
      <div class="panel"><h3>Where the competition was last round</h3>${heatGrid(last.cellCounts)}</div>`;
    race($('#live-race'), standings(state).map((r) => ({ id: r.id, name: r.name, color: r.color, value: r.accumulated })), { rowH: 46 });
  }
}

function results() {
  const h = state.history;
  const last = h[h.length - 1];
  const tm = teamMap(state);
  if (!$('#res-race')) {
    const best = [...last.results].sort((a, b) => b.net - a.net)[0];
    const bt = tm.get(best?.teamId) || {};
    $('#stage').innerHTML = `
      <div class="grid" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);align-items:start">
        <div class="panel"><h3>Accumulated profit after round ${last.round}</h3><div id="res-race"></div></div>
        <div class="grid" style="gap:16px">
          <div class="panel" style="text-align:center">
            <div class="muted" style="text-transform:uppercase;letter-spacing:.15em">Round ${last.round} winner</div>
            <div style="font-size:40px;font-weight:900;color:${bt.color}">${esc(bt.name || '')}</div>
            <div class="big-num ${(best?.net || 0) >= 0 ? 'good' : 'bad'}">${signed(best?.net || 0)}</div>
            <div class="muted">net profit this round</div>
          </div>
          <div class="panel"><h3>Awards</h3>${last.awards.map((a) => `<div class="award" style="display:flex"><span class="ic">${a.icon}</span><span><b>${esc(a.title)} · ${a.teamIds.map((id) => esc(tm.get(id)?.name)).join(', ')}</b><small>${esc(a.desc)}</small></span></div>`).join('') || '<div class="empty">–</div>'}</div>
        </div>
      </div>
      <div class="grid cols-3" style="margin-top:18px">
        <div class="panel"><h3>Accumulated profit by round</h3><div id="res-chart"></div></div>
        <div class="panel"><h3>Market</h3>
          <div class="kpis" style="grid-template-columns:1fr 1fr">
            <div class="kpi"><div class="k">Total sales</div><div class="v">${fmt(last.market.totalSales)}</div></div>
            <div class="kpi"><div class="k">Products</div><div class="v">${last.market.totalProducts}</div></div>
            <div class="kpi"><div class="k">Positioning spend</div><div class="v">${fmt(last.market.totalCost)}</div></div>
            <div class="kpi"><div class="k">Avg accumulated</div><div class="v">${fmt(last.market.avgAccumulated)}</div></div>
          </div>
          <h3 style="margin-top:14px">Top 5 products</h3>
          <table><tbody>${last.top10.slice(0, 5).map((t, i) => `<tr><td>${i + 1}</td><td><span class="team-name"><span class="dot" style="background:${tm.get(t.teamId)?.color}"></span>${esc(tm.get(t.teamId)?.name)}</span></td><td class="n">#${t.seq}</td><td class="n">${fmt(t.sales)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="panel"><h3>Competition map</h3>${heatGrid(last.cellCounts)}</div>
      </div>`;
    // Animate from the previous standings to the new ones.
    const prev = h[h.length - 2];
    const rows = (src) => src.results.map((r) => ({ id: r.teamId, name: tm.get(r.teamId)?.name, color: tm.get(r.teamId)?.color, value: r.accumulated }));
    race($('#res-race'), prev ? rows(prev) : state.teams.map((t) => ({ id: t.id, name: t.name, color: t.color, value: 5000 })));
    setTimeout(() => race($('#res-race'), rows(last)), 700);
    lineChart($('#res-chart'), state.teams.map((t) => ({ name: t.name, color: t.color, values: h.map((x) => x.results.find((y) => y.teamId === t.id)?.accumulated ?? null) })), h.map((x) => `R${x.round}`), { zero: false });
  }
}

function finale() {
  if ($('#final-podium')) return;
  const st = standings(state);
  const h = state.history;
  const tm = teamMap(state);
  // Game-long awards
  const sum = (id, k) => h.reduce((s, r) => s + (r.results.find((x) => x.teamId === id)?.[k] || 0), 0);
  const wins = (id) => h.filter((r) => r.results.find((x) => x.teamId === id)?.roundRank === 1).length;
  const best = (fn) => [...state.teams].sort((a, b) => fn(b) - fn(a))[0];
  const first = h[0];
  const climb = (t) => (first ? (first.results.find((x) => x.teamId === t.id)?.overallRank || 0) - (st.find((x) => x.id === t.id)?.overallRank || 0) : 0);
  const awards = [
    ['🥇', 'Most round wins', best(wins), (t) => `${wins(t.id)} round${wins(t.id) === 1 ? '' : 's'}`],
    ['💎', 'Loyalty champion', best((t) => sum(t.id, 'loyalty')), (t) => `${fmt(sum(t.id, 'loyalty'))} loyalty points`],
    ['📈', 'Biggest climber', best(climb), (t) => `${climb(t) > 0 ? '+' : ''}${climb(t)} places since round 1`],
    ['🛒', 'Sales machine', best((t) => sum(t.id, 'sales')), (t) => `${fmt(sum(t.id, 'sales'))} total sales`],
  ].filter((a) => a[2]);
  const podium = [st[1], st[0], st[2]].map((r, i) => r ? `<div class="step p${[2, 1, 3][i]}" style="width:240px;animation-delay:${[0.6, 1.4, 0][i]}s">
      <div class="nm" style="font-size:28px;color:${r.color}">${esc(r.name)}</div><div class="sc" style="font-size:20px">${fmt(r.accumulated)}</div><div class="block">${[2, 1, 3][i]}</div></div>` : '').join('');
  $('#stage').innerHTML = `
    <div style="text-align:center"><div class="pill done" style="font-size:16px;padding:8px 16px">Final standings</div>
      <h1 style="font-size:56px;margin-top:14px">🏆 ${esc(st[0]?.name || '')} wins the market!</h1></div>
    <div class="podium" id="final-podium">${podium}</div>
    <div class="grid cols-2" style="margin-top:20px">
      <div class="panel"><h3>Final leaderboard</h3><table><thead><tr><th></th><th>Team</th><th class="n">Accumulated profit</th><th class="n">Total sales</th><th class="n">Total spend</th><th class="n">Products</th></tr></thead><tbody>
        ${st.map((r) => `<tr><td><span class="rank ${r.overallRank <= 3 ? 'r' + r.overallRank : ''}">${r.overallRank}</span></td><td><span class="team-name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span></td><td class="n"><b>${fmt(r.accumulated)}</b></td><td class="n">${fmt(sum(r.id, 'sales'))}</td><td class="n">${fmt(sum(r.id, 'cost'))}</td><td class="n">${r.productCount}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="panel"><h3>Hall of fame</h3>${awards.map(([ic, title, t, desc]) => `<div class="award" style="display:flex"><span class="ic">${ic}</span><span><b>${title} · <span style="color:${t.color}">${esc(t.name)}</span></b><small>${desc(t)}</small></span></div>`).join('')}
      <h3 style="margin-top:16px">Accumulated profit journey</h3><div id="fin-chart"></div></div>
    </div>`;
  lineChart($('#fin-chart'), state.teams.map((t) => ({ name: tm.get(t.id).name, color: t.color, values: h.map((x) => x.results.find((y) => y.teamId === t.id)?.accumulated ?? null) })), h.map((x) => `R${x.round}`), { zero: false });
  if (!celebrated) { celebrated = true; sound.fanfare(); confetti(10000); }
}

function ticker() {
  const h = state.history;
  const items = h.length ? h[h.length - 1].news.map((n) => n.text) : [
    `Join at ${joinUrl()} with code ${state.game.id}`,
    'Status Seekers (A10) is the biggest prize – but the most expensive to reach and possibly the most crowded.',
    'Two products in one cell split its demand. Sometimes the best strategy is an empty cell.',
  ];
  setTicker(items);
}

setInterval(() => {
  if (!state || state.game.status !== 'open') return;
  const el = $('#live-timer');
  if (!el) return;
  const ms = remaining(state.game.deadline);
  el.textContent = ms == null ? 'OPEN' : clock(ms);
  el.className = `screen-timer ${ms != null && ms < 30000 ? 'urgent' : ms != null && ms < 90000 ? 'soon' : ''}`;
  const s = ms == null ? null : Math.ceil(ms / 1000);
  if (s != null && s <= 10 && s > 0 && s !== lastTick) { lastTick = s; sound.tick(); }
}, 250);

$('#mute').textContent = sound.muted ? '🔇' : '🔊';
$('#mute').onclick = () => { $('#mute').textContent = sound.toggle() ? '🔇' : '🔊'; };
$('#fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
