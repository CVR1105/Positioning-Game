import {
  $, $$, esc, fmt, signed, pct, qs, store, clientId, loadConfig, cfg, syncClock, remaining, clock,
  toast, sound, countUp, confetti, renderMap, mapLegend, heatGrid, lineChart, demandOf, moveCost, segmentOf,
  setTicker, phaseLabel, teamMap, standings, rulesHtml,
} from './common.js';

const gameId = (qs('g') || '').toUpperCase();
const auth = store.get(`pg:team:${gameId}`);
if (!gameId || !auth?.token) location.replace(`/?g=${gameId}`);

await loadConfig();
const C = cfg();
const me = { client: clientId(), player: auth.player || '' };

let state = null;
let plan = [];           // [{seq, cell|null}]
let planRound = null;
let selected = null;     // seq
let lastLocalEdit = 0;
let adoptedDraftAt = 0;
let mapMode = 'demand';
let tab = 'report';
let draftTimer = null;
let lastTickSecond = null;
const seenKey = `pg:seen:${gameId}:${auth.teamId}`;

// ---------- socket ----------
const socket = io({ auth: { token: auth.token }, transports: ['websocket', 'polling'] });
socket.on('connect', () => $('#conn').classList.add('on'));
socket.on('disconnect', () => $('#conn').classList.remove('on'));
socket.on('connect_error', (err) => {
  $('#conn').classList.remove('on');
  if (err.message === 'unauthorized') {
    store.del(`pg:team:${gameId}`);
    alert('Your team session is no longer valid. Please join again.');
    location.replace(`/?g=${gameId}`);
  }
});
socket.on('kicked', (m) => { store.del(`pg:team:${gameId}`); alert(m.reason); location.replace(`/?g=${gameId}`); });
socket.on('gone', () => { alert('This game was deleted by the facilitator.'); location.replace('/'); });
socket.on('event', (ev) => {
  if (ev.type === 'round_started') {
    sound.start();
    toast(`Round ${ev.round} is live – make your moves!`, 'ok');
  }
});
socket.on('state', (s) => {
  syncClock(s.game.serverNow);
  const prev = state;
  state = s;
  reconcilePlan(prev);
  render();
  maybeReveal();
});

const send = (ev, msg) => new Promise((resolve) => socket.timeout(8000).emit(ev, msg, (err, res) => resolve(err ? { ok: false, error: 'No response from server – check your connection.' } : res)));

// ---------- plan state ----------
const products = () => state?.me?.products || [];
const isOpen = () => state?.game.status === 'open';
const productBySeq = (seq) => products().find((p) => p.seq === seq);
const originOf = (row) => productBySeq(row.seq)?.cell ?? C.start;
const samePlan = (a, b) => a && b && a.length === b.length && a.every((x, i) => x.seq === b[i].seq && x.cell === b[i].cell);
const currentPlan = () => products().map((p) => ({ seq: p.seq, cell: p.cell }));

function reconcilePlan(prev) {
  const g = state.game;
  if (!isOpen()) {
    plan = currentPlan();
    planRound = null;
    selected = null;
    return;
  }
  const dec = state.me.decision;
  if (planRound !== g.round) {
    planRound = g.round;
    plan = (dec?.draft?.plan || dec?.submitted?.plan || currentPlan()).map((x) => ({ ...x }));
    adoptedDraftAt = dec?.draft?.at || 0;
    selected = plan[0]?.seq ?? null;
    return;
  }
  // Teammate edited the shared draft on another laptop: adopt it unless we're mid-edit.
  const d = dec?.draft;
  if (d && d.at > adoptedDraftAt && d.client !== me.client && Date.now() - lastLocalEdit > 1500) {
    adoptedDraftAt = d.at;
    const pendingNew = plan.filter((x) => !x.cell);
    if (!samePlan(plan.filter((x) => x.cell), d.plan)) {
      plan = d.plan.map((x) => ({ ...x }));
      for (const p of pendingNew) if (!plan.some((x) => x.seq === p.seq)) plan.push(p);
      toast(`${d.by || 'A teammate'} updated your team's plan`, 'warn');
    }
  }
  if (prev && !prev.me?.decision?.submitted && dec?.submitted && dec.submitted.by !== me.player) {
    toast(`${dec.submitted.by || 'A teammate'} submitted the team decision`, 'ok');
  }
}

function touchPlan() {
  lastLocalEdit = Date.now();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(syncDraft, 600);
  render();
}

async function syncDraft() {
  if (!isOpen()) return;
  const valid = plan.filter((x) => x.cell);
  const res = await send('plan:save', { plan: valid, submit: false, by: me.player, clientId: me.client });
  if (res?.ok) adoptedDraftAt = Math.max(adoptedDraftAt, res.at || 0);
}

// ---------- projections (public info only: last round's anonymous cell counts) ----------
function lastCounts() {
  const h = state.history;
  return h.length ? h[h.length - 1].cellCounts : {};
}

function projections() {
  const counts = lastCounts();
  const mineNow = {};
  for (const p of products()) mineNow[p.cell] = (mineNow[p.cell] || 0) + 1;
  const minePlanned = {};
  for (const r of plan) if (r.cell) minePlanned[r.cell] = (minePlanned[r.cell] || 0) + 1;
  const out = new Map();
  let sales = 0;
  let cost = 0;
  for (const r of plan) {
    const from = originOf(r);
    const c = r.cell ? moveCost(from, r.cell) : 0;
    cost += c;
    if (!r.cell || r.cell === C.start) { out.set(r.seq, { cost: c, est: 0 }); continue; }
    const rivals = Math.max(0, (counts[r.cell] || 0) - (mineNow[r.cell] || 0));
    const n = rivals + (minePlanned[r.cell] || 0);
    let est = Math.round(demandOf(r.cell) / Math.max(1, n));
    const p = productBySeq(r.seq);
    if (p && p.cell === r.cell && p.lastSales > 0) est += Math.ceil(C.loyaltyRate * p.lastSales + p.cumBonus - 1e-9);
    sales += est;
    out.set(r.seq, { cost: c, est, rivals, n });
  }
  return { per: out, sales, cost };
}

function projectFor(seq, cell) {
  const counts = lastCounts();
  let mineNow = 0;
  for (const p of products()) if (p.cell === cell) mineNow++;
  let minePlanned = 0;
  for (const r of plan) if (r.cell === cell && r.seq !== seq) minePlanned++;
  const rivals = Math.max(0, (counts[cell] || 0) - mineNow);
  let est = Math.round(demandOf(cell) / (rivals + minePlanned + 1));
  const p = productBySeq(seq);
  if (p && p.cell === cell && p.lastSales > 0) est += Math.ceil(C.loyaltyRate * p.lastSales + p.cumBonus - 1e-9);
  return { est, rivals, mine: minePlanned };
}

// ---------- rendering ----------
function render() {
  if (!state) return;
  const g = state.game;
  const m = state.me;
  const [label, cls] = phaseLabel(g);
  $('#game-name').firstChild.textContent = g.name;
  $('#team-label').innerHTML = `<span style="color:${m.color}">●</span> ${esc(m.name)}${me.player ? ` · ${esc(me.player)}` : ''} · Game ${esc(g.id)}`;
  document.title = `${m.name} · ${g.name}`;
  const ph = $('#phase');
  ph.textContent = label;
  ph.className = `pill ${cls}`;
  $('#round').textContent = g.round ? `${g.round}/${g.totalRounds}` : `0/${g.totalRounds}`;
  $('#budget').textContent = fmt(m.budget);
  const st = standings(state);
  const mine = st.find((r) => r.id === m.id);
  $('#rank').textContent = state.history.length && mine ? `#${mine.overallRank}` : '–';
  $('#final-btn').classList.toggle('hidden', g.status !== 'finished');

  renderStrip();
  renderMapPanel();
  renderDecision();
  renderTab();
  renderTicker();
}

function renderStrip() {
  const g = state.game;
  $('#team-strip').innerHTML = state.teams.map((t) => {
    const status = g.status === 'open' ? (t.submitted ? 'submitted ✓' : 'deciding…') : (t.online ? 'online' : 'offline');
    return `<span class="team-chip ${t.id === state.me.id ? 'me' : ''} ${g.status === 'open' && t.submitted ? 'submitted' : ''} ${t.online ? '' : 'offline'}">
      <span class="sw" style="background:${t.color}">${t.number}</span>${esc(t.name)} <span class="status">${status}</span></span>`;
  }).join('');
}

function renderMapPanel() {
  const color = state.me.color;
  const chips = {};
  const add = (cell, ch) => (chips[cell] = chips[cell] || []).push(ch);
  for (const r of plan) {
    const origin = originOf(r);
    const sel = r.seq === selected;
    if (r.cell) add(r.cell, { label: r.seq, color, sel });
    if (productBySeq(r.seq) && r.cell !== origin) add(origin, { label: r.seq, color, ghost: true });
  }
  const sel = plan.find((r) => r.seq === selected);
  const counts = lastCounts();
  renderMap($('#map'), {
    mode: mapMode,
    counts,
    chips,
    origin: sel && isOpen() ? originOf(sel) : null,
    target: sel && isOpen() ? sel.cell : null,
    onClick: onCellClick,
    tooltip: (cell) => {
      const seg = segmentOf(cell);
      const d = demandOf(cell);
      let h = `<div class="t">${cell}${seg ? ` · ${esc(seg.name)}` : ''}</div>`;
      if (cell === C.start) return h + '<div class="muted">START – products here earn nothing</div>';
      h += `<div class="kv">Demand <b>${fmt(d)}</b></div>`;
      h += `<div class="kv">Products here last round <b>${state.history.length ? counts[cell] || 0 : '?'}</b></div>`;
      if (sel && isOpen()) {
        const from = originOf(sel);
        const pr = projectFor(sel.seq, cell);
        h += `<div class="kv">Move #${sel.seq} here <b>${fmt(moveCost(from, cell))}</b></div>`;
        h += `<div class="kv">Projected sales <b>${fmt(pr.est)}</b></div>`;
      }
      if (seg) h += `<div class="muted" style="margin-top:4px;font-size:12px">${esc(seg.blurb)}</div>`;
      return h;
    },
  });
  $('#map-legend').innerHTML = mapLegend(mapMode);
  $('#map-hint').textContent = isOpen()
    ? (sel ? `Product #${sel.seq} selected – click a cell to position it` : 'Select a product, then click a cell')
    : 'Decisions open when the round starts';
}

function onCellClick(cell) {
  if (!isOpen()) return toast('The round is not open yet.', 'warn');
  const row = plan.find((r) => r.seq === selected);
  if (!row) return toast('Select a product in the list (or launch a new one) first.', 'warn');
  const isNew = !productBySeq(row.seq);
  if (isNew && cell === C.start) return toast('A new product must be positioned away from START.', 'err');
  row.cell = cell;
  sound.click();
  touchPlan();
}

function renderDecision() {
  const g = state.game;
  const m = state.me;
  const open = isOpen();
  const pj = projections();
  const budget = m.budget;
  const over = pj.cost > Math.max(0, budget);
  const incomplete = plan.some((r) => !r.cell);
  const dec = m.decision;
  const submittedSame = dec?.submitted && samePlan(dec.submitted.plan, plan.filter((r) => r.cell)) && !incomplete;

  $('#plan-cost').textContent = fmt(pj.cost);
  $('#plan-cost').className = `v ${over ? 'bad' : ''}`;
  $('#plan-left').textContent = `${fmt(Math.max(0, budget) - pj.cost)} left of ${fmt(budget)}`;
  $('#plan-sales').textContent = open ? fmt(pj.sales) : '–';
  const profit = pj.sales - pj.cost;
  $('#plan-profit').textContent = open ? signed(profit) : '–';
  $('#plan-profit').className = `v ${open ? (profit >= 0 ? 'good' : 'bad') : ''}`;
  const bar = $('#budget-bar');
  bar.classList.toggle('over', over);
  bar.firstElementChild.style.width = `${Math.min(100, budget > 0 ? (pj.cost / budget) * 100 : pj.cost ? 100 : 0)}%`;
  $('#prod-count').textContent = `${plan.length}/${C.maxProducts}`;
  $('#add-product').disabled = !open || plan.length >= C.maxProducts;
  $('#reset-plan').disabled = !open;
  $('#decision-hint').textContent = open ? `Round ${g.round} of ${g.totalRounds}` : '';

  renderBanner(submittedSame);

  // product rows
  const rows = plan.map((r) => {
    const p = productBySeq(r.seq);
    const origin = originOf(r);
    const pr = pj.per.get(r.seq) || { cost: 0, est: 0 };
    const moved = r.cell && r.cell !== origin;
    const tag = !p ? '<span class="tag new">new</span>' : moved ? '<span class="tag moved">move</span>' : '<span class="tag hold">hold</span>';
    const last = p?.history[p.history.length - 1];
    const sub = !r.cell
      ? '<span class="warn">Click a cell on the map to position it</span>'
      : `${segmentOf(r.cell) ? esc(segmentOf(r.cell).name) + ' · ' : ''}demand ${fmt(demandOf(r.cell))}${last ? ` · last round ${fmt(last.sales)}` : ''}${p && !moved && p.lastSales > 0 ? ' · loyalty ✓' : ''}`;
    return `<div class="prow ${r.seq === selected ? 'sel' : ''}" data-seq="${r.seq}">
      <div class="pn" style="background:${state.me.color}">${r.seq}</div>
      <div class="grow"><div class="move">${p ? esc(origin) : 'START'}<span class="arrow">→</span><b>${esc(r.cell || '?')}</b> ${tag}</div><div class="sub">${sub}</div></div>
      <div class="est" title="Projected sales">${open && r.cell ? '~' + fmt(pr.est) : ''}</div>
      <div class="cost ${pr.cost ? 'warn' : 'dim'}">${pr.cost ? '−' + fmt(pr.cost) : '0'}</div>
      <div>${open && !p ? `<button class="icon ghost small" data-del="${r.seq}" title="Remove this new product">✕</button>` : open && moved ? `<button class="icon ghost small" data-undo="${r.seq}" title="Keep in place">↺</button>` : ''}</div>
    </div>`;
  }).join('');
  $('#plist').innerHTML = rows || `<div class="empty">No products yet.${open ? ' Press <b>+ Launch new product</b>, then click a cell on the map.' : ''}</div>`;
  $$('#plist .prow').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    selected = Number(el.dataset.seq);
    render();
  }));
  $$('#plist [data-del]').forEach((el) => el.addEventListener('click', () => {
    const seq = Number(el.dataset.del);
    plan = plan.filter((r) => r.seq !== seq).map((r) => (r.seq > seq && !productBySeq(r.seq) ? { ...r, seq: r.seq - 1 } : r));
    if (selected === seq) selected = plan[plan.length - 1]?.seq ?? null;
    touchPlan();
  }));
  $$('#plist [data-undo]').forEach((el) => el.addEventListener('click', () => {
    const r = plan.find((x) => x.seq === Number(el.dataset.undo));
    r.cell = originOf(r);
    touchPlan();
  }));

  const btn = $('#submit');
  btn.disabled = !open || over || incomplete;
  btn.textContent = !open ? 'Submit decision' : submittedSame ? '✓ Submitted' : dec?.submitted ? 'Resubmit decision' : 'Submit decision';
  btn.className = submittedSame && open ? 'success big' : 'primary big';
  $('#submit-err').textContent = open && over ? `Over budget by ${fmt(pj.cost - Math.max(0, budget))}. Remove or shorten some moves.` : open && incomplete ? 'Every new product needs a cell.' : '';
}

function renderBanner(submittedSame) {
  const g = state.game;
  const dec = state.me.decision;
  if (submittedSame === undefined) {
    const incomplete = plan.some((r) => !r.cell);
    submittedSame = dec?.submitted && samePlan(dec.submitted.plan, plan.filter((r) => r.cell)) && !incomplete;
  }
  const b = $('#status-banner');
  const left = remaining(g.deadline);
  if (g.status === 'lobby') {
    b.className = 'banner info';
    b.innerHTML = `⏳ Waiting for the facilitator to start round 1. ${state.teams.length} team${state.teams.length === 1 ? '' : 's'} in the lobby. Read <b>How to play</b> below while you wait.`;
  } else if (g.status === 'results') {
    b.className = 'banner info';
    b.innerHTML = `📈 Round ${g.round} results are in. Study the market, then get ready – round ${g.round + 1} starts when the facilitator says go.`;
  } else if (g.status === 'finished') {
    b.className = 'banner ok';
    b.innerHTML = `🏁 Game over! <a href="#" id="see-final">See the final standings</a>.`;
    $('#see-final')?.addEventListener('click', (e) => { e.preventDefault(); showFinal(); });
  } else if (submittedSame) {
    b.className = 'banner ok';
    b.innerHTML = `✅ Submitted${dec.submitted.by ? ` by <b>${esc(dec.submitted.by)}</b>` : ''} at ${new Date(dec.submitted.at).toLocaleTimeString()}. You can still change it and resubmit until the round closes.`;
  } else if (dec?.submitted) {
    b.className = left != null && left < 60000 ? 'banner bad' : 'banner warn';
    b.innerHTML = '⚠️ You have changes that are <b>not submitted</b>. Only the submitted plan counts – resubmit to lock them in.';
  } else {
    b.className = left != null && left < 60000 ? 'banner bad' : 'banner warn';
    b.innerHTML = left != null && left < 60000
      ? '⏰ <b>Less than a minute left and nothing submitted!</b> If you don’t submit, your products stay where they are.'
      : '📝 Not submitted yet. Plan your moves and press <b>Submit decision</b>.';
  }

}

function renderTicker() {
  const items = [];
  const last = state.history[state.history.length - 1];
  if (last) items.push(...last.news.map((n) => n.text));
  if (!items.length) {
    items.push('Welcome to the market. Four segments are waiting: Status Seekers (A10), Fashion Conscious (D3), Budget Conscious (H3), Quality Focused (I8).');
    items.push('Every move costs 200 points per cell. Demand is split between all products in a cell.');
  }
  setTicker(items);
}

// ---------- tabs ----------
function renderTab() {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  const body = $('#tab-body');
  if (tab === 'rules') { if (body.dataset.t !== 'rules') body.innerHTML = rulesHtml(); body.dataset.t = 'rules'; return; }
  const key = `${tab}:${state.history.length}:${state.game.status}:${products().length}:${state.teams.length}`;
  if (body.dataset.key === key) return; // don't rebuild charts on every timer/draft update
  body.dataset.key = key;
  body.dataset.t = tab;
  if (tab === 'report') body.innerHTML = reportHtml();
  else body.innerHTML = marketHtml();
  if (tab === 'report') drawReportCharts();
  else drawMarketCharts();
}

function reportHtml() {
  const h = state.history;
  const m = state.me;
  if (!h.length) return '<div class="empty">Your round reports will appear here after round 1 is resolved.</div>';
  const last = h[h.length - 1];
  const r = last.results.find((x) => x.teamId === m.id);
  const prev = h[h.length - 2]?.results.find((x) => x.teamId === m.id);
  if (!r) return '<div class="empty">No results for your team yet.</div>';
  const n = last.results.length;
  const kpi = (k, v, s = '', cls = '') => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
  const rankMove = prev ? prev.overallRank - r.overallRank : 0;
  const myAwards = last.awards.filter((a) => a.teamIds.includes(m.id));
  const rows = products().map((p) => {
    const x = p.history.find((q) => q.round === last.round);
    if (!x) return '';
    return `<tr><td><span class="chip" style="background:${m.color};display:inline-grid">${p.seq}</span></td>
      <td class="mono">${x.from === x.cell ? x.cell : `${x.from} → ${x.cell}`}</td><td>${segmentOf(x.cell)?.name || ''}</td>
      <td class="n">${fmt(demandOf(x.cell))}</td><td class="n">${x.competitors}</td><td class="n">${fmt(x.base)}</td>
      <td class="n ${x.loyalty ? 'good' : 'dim'}">${x.loyalty ? '+' + fmt(x.loyalty) : '0'}</td><td class="n"><b>${fmt(x.sales)}</b></td>
      <td class="n ${x.cost ? 'warn' : 'dim'}">${x.cost ? '−' + fmt(x.cost) : '0'}</td></tr>`;
  }).join('');
  const hist = h.map((hr) => {
    const x = hr.results.find((q) => q.teamId === m.id);
    return x ? `<tr><td>Round ${hr.round}</td><td class="n">${fmt(x.sales)}</td><td class="n">${fmt(x.cost)}</td><td class="n ${x.net >= 0 ? 'good' : 'bad'}">${signed(x.net)}</td>
      <td class="n">${pct(x.share)}</td><td class="n">${x.productCount}</td><td class="n">#${x.roundRank}</td><td class="n"><b>${fmt(x.accumulated)}</b></td><td class="n">#${x.overallRank}</td>
      <td>${x.submitted ? '' : '<span class="tag moved">no submit</span>'}</td></tr>` : '';
  }).join('');
  return `
    <div class="grid cols-4" style="margin-bottom:16px">
      ${kpi(`Round ${last.round} sales`, fmt(r.sales), prev ? `${signed(r.sales - prev.sales)} vs last round` : '')}
      ${kpi('Positioning cost', fmt(r.cost), `${r.loyalty ? `loyalty bonus +${fmt(r.loyalty)}` : 'no loyalty bonus yet'}`)}
      ${kpi('Net profit', signed(r.net), `rank #${r.roundRank} of ${n} this round`, r.net >= 0 ? 'good' : 'bad')}
      ${kpi('Accumulated profit', fmt(r.accumulated), `#${r.overallRank} overall ${rankMove > 0 ? `<span class="good">▲${rankMove}</span>` : rankMove < 0 ? `<span class="bad">▼${-rankMove}</span>` : ''} · ${pct(r.share)} share`)}
    </div>
    ${myAwards.length ? `<div style="margin-bottom:14px">${myAwards.map(awardHtml).join('')}</div>` : ''}
    <div class="grid cols-2">
      <div><h3>Product performance · round ${last.round}</h3><div class="table-scroll"><table>
        <thead><tr><th>#</th><th>Position</th><th>Segment</th><th class="n">Demand</th><th class="n">In cell</th><th class="n">Base</th><th class="n">Loyalty</th><th class="n">Sales</th><th class="n">Cost</th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>
      <div><h3>Your trajectory</h3><div id="chart-me"></div></div>
    </div>
    <h3 style="margin-top:18px">Round history</h3>
    <div class="table-scroll"><table><thead><tr><th>Round</th><th class="n">Sales</th><th class="n">Cost</th><th class="n">Net</th><th class="n">Share</th><th class="n">Products</th><th class="n">Round rank</th><th class="n">Accumulated</th><th class="n">Overall</th><th></th></tr></thead>
    <tbody>${hist}</tbody></table></div>`;
}

function drawReportCharts() {
  const el = $('#chart-me');
  if (!el) return;
  const h = state.history;
  const m = state.me;
  const pick = (k) => h.map((hr) => hr.results.find((x) => x.teamId === m.id)?.[k] ?? null);
  lineChart(el, [
    { name: 'Sales', color: '#38bdf8', values: pick('sales') },
    { name: 'Net profit', color: '#22c55e', values: pick('net') },
    { name: 'Positioning cost', color: '#f59e0b', values: pick('cost') },
  ], h.map((x) => `R${x.round}`));
}

function awardHtml(a, who) {
  return `<span class="award"><span class="ic">${a.icon}</span><span><b>${esc(a.title)}${who ? ` · ${esc(who)}` : ''}</b><small>${esc(a.desc)}</small></span></span>`;
}

function marketHtml() {
  const h = state.history;
  if (!h.length) return '<div class="empty">Market intelligence unlocks after round 1: leaderboard, market totals, top 10 products and the competition map.</div>';
  const last = h[h.length - 1];
  const tm = teamMap(state);
  const st = standings(state);
  const lb = st.map((r) => `<tr class="${r.id === state.me.id ? 'me' : ''}">
      <td><span class="rank ${r.overallRank <= 3 ? 'r' + r.overallRank : ''}">${r.overallRank}</span></td>
      <td><span class="team-name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span></td>
      <td class="n">${fmt(r.sales)}</td><td class="n">${pct(r.share)}</td><td class="n">${fmt(r.best)}</td><td class="n">${fmt(r.cost)}</td>
      <td class="n ${r.net >= 0 ? 'good' : 'bad'}">${signed(r.net)}</td><td class="n">#${r.roundRank}</td><td class="n"><b>${fmt(r.accumulated)}</b></td>
      <td class="n">${r.productCount}</td><td class="n delta">${r.delta > 0 ? `<span class="good">▲${r.delta}</span>` : r.delta < 0 ? `<span class="bad">▼${-r.delta}</span>` : '–'}</td></tr>`).join('');
  const mk = last.market;
  const top = last.top10.map((t, i) => {
    const team = tm.get(t.teamId) || {};
    return `<tr class="${t.teamId === state.me.id ? 'me' : ''}"><td>${i + 1}</td><td><span class="team-name"><span class="dot" style="background:${team.color}"></span>${esc(team.name)}</span></td><td class="n">#${t.seq}</td><td class="n">${fmt(t.sales)}</td></tr>`;
  }).join('');
  const awards = last.awards.map((a) => awardHtml(a, a.teamIds.map((id) => tm.get(id)?.name).join(', '))).join('');
  return `
    <h3>Leaderboard after round ${last.round}</h3>
    <div class="table-scroll"><table><thead><tr><th></th><th>Team</th><th class="n">Sales</th><th class="n">Share</th><th class="n">Best product</th><th class="n">Cost</th><th class="n">Net</th><th class="n">Round rank</th><th class="n">Accumulated</th><th class="n">Products</th><th class="n">Move</th></tr></thead>
    <tbody>${lb}</tbody><tfoot><tr><td></td><td class="muted">Market total / average</td><td class="n">${fmt(mk.totalSales)}</td><td class="n">100%</td><td></td><td class="n">${fmt(mk.totalCost)}</td><td class="n">${signed(mk.totalNet)}</td><td></td><td class="n muted">avg ${fmt(mk.avgAccumulated)}</td><td class="n">${mk.totalProducts}</td><td></td></tr></tfoot></table></div>
    ${awards ? `<h3 style="margin-top:18px">Round ${last.round} awards</h3><div>${awards}</div>` : ''}
    <div class="grid cols-3" style="margin-top:18px">
      <div><h3>Accumulated profit</h3><div id="chart-acc"></div></div>
      <div><h3>Sales per round</h3><div id="chart-sales"></div></div>
      <div><h3>Profit per round</h3><div id="chart-profit"></div></div>
    </div>
    <div class="grid cols-2" style="margin-top:18px">
      <div><h3>Competition map <span class="hint">products per cell after round ${last.round} (anonymous)</span></h3>${heatGrid(last.cellCounts)}</div>
      <div><h3>Top 10 products <span class="hint">positions are confidential</span></h3><table><thead><tr><th></th><th>Team</th><th class="n">Product</th><th class="n">Sales</th></tr></thead><tbody>${top}</tbody></table></div>
    </div>`;
}

function drawMarketCharts() {
  const h = state.history;
  if (!h.length) return;
  const labels = h.map((x) => `R${x.round}`);
  const series = (k) => state.teams.map((t) => ({
    name: t.name, color: t.color, me: t.id === state.me.id, dim: t.id !== state.me.id,
    values: h.map((hr) => hr.results.find((x) => x.teamId === t.id)?.[k] ?? null),
  }));
  lineChart($('#chart-acc'), series('accumulated'), labels, { zero: false });
  lineChart($('#chart-sales'), series('sales'), labels);
  lineChart($('#chart-profit'), series('net'), labels);
}

// ---------- reveal & final ----------
function maybeReveal() {
  const h = state.history;
  if (!h.length || state.game.status === 'open') return;
  const seen = store.get(seenKey) || 0;
  const last = h[h.length - 1];
  if (last.round <= seen) return;
  store.set(seenKey, last.round);
  if (state.game.status === 'finished') showReveal(last, () => showFinal());
  else showReveal(last);
}

function showReveal(round, next) {
  const m = state.me;
  const r = round.results.find((x) => x.teamId === m.id);
  if (!r) return next?.();
  const prev = state.history.find((x) => x.round === round.round - 1)?.results.find((x) => x.teamId === m.id);
  const move = prev ? prev.overallRank - r.overallRank : 0;
  const myAwards = round.awards.filter((a) => a.teamIds.includes(m.id));
  const card = $('#overlay-card');
  card.innerHTML = `
    <div class="pill results" style="margin-bottom:10px">Round ${round.round} of ${state.game.totalRounds} · results</div>
    <h2>${r.net >= 0 ? 'Profitable round!' : 'Investment round'}</h2>
    <div class="muted">Net profit this round</div>
    <div class="big-num ${r.net >= 0 ? 'good' : 'bad'}" id="rv-net">0</div>
    <div class="grid cols-4" style="margin:18px 0">
      <div class="kpi"><div class="k">Sales</div><div class="v" id="rv-sales">0</div></div>
      <div class="kpi"><div class="k">Cost</div><div class="v">${fmt(r.cost)}</div></div>
      <div class="kpi"><div class="k">Accumulated</div><div class="v" id="rv-acc">0</div></div>
      <div class="kpi"><div class="k">Overall rank</div><div class="v">#${r.overallRank} ${move > 0 ? `<span class="good" style="font-size:14px">▲${move}</span>` : move < 0 ? `<span class="bad" style="font-size:14px">▼${-move}</span>` : ''}</div></div>
    </div>
    ${myAwards.length ? `<div style="margin-bottom:14px">${myAwards.map(awardHtml).join('')}</div>` : ''}
    <div class="muted" style="text-align:left;font-size:14px;margin-bottom:16px">${round.news.slice(0, 4).map((n) => `◆ ${esc(n.text)}`).join('<br>')}</div>
    <button class="primary big" id="rv-close">${next ? 'See final standings →' : 'Open full report'}</button>`;
  $('#overlay').classList.remove('hidden');
  sound.fanfare();
  countUp($('#rv-net'), r.net, { signedFmt: true });
  countUp($('#rv-sales'), r.sales);
  countUp($('#rv-acc'), r.accumulated, { from: prev?.accumulated ?? C.startingBudget });
  if (myAwards.length || r.roundRank === 1) confetti(2500);
  $('#rv-close').onclick = () => {
    $('#overlay').classList.add('hidden');
    if (next) next();
    else { tab = 'report'; render(); $('#tabs').scrollIntoView({ behavior: 'smooth' }); }
  };
}

function showFinal() {
  const st = standings(state);
  const mine = st.find((r) => r.id === state.me.id);
  const podium = [st[1], st[0], st[2]].map((r, i) => r ? `<div class="step p${[2, 1, 3][i]}" style="animation-delay:${[0.4, 0.9, 0][i]}s">
      <div class="nm" style="color:${r.color}">${esc(r.name)}</div><div class="sc">${fmt(r.accumulated)}</div><div class="block">${[2, 1, 3][i]}</div></div>` : '').join('');
  const rows = st.map((r) => `<tr class="${r.id === state.me.id ? 'me' : ''}"><td><span class="rank ${r.overallRank <= 3 ? 'r' + r.overallRank : ''}">${r.overallRank}</span></td>
    <td><span class="team-name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span></td><td class="n"><b>${fmt(r.accumulated)}</b></td></tr>`).join('');
  $('#overlay-card').innerHTML = `
    <div class="pill done">Final standings</div>
    <h2 style="margin-top:10px">${mine?.overallRank === 1 ? '🏆 You won the market!' : `You finished #${mine?.overallRank ?? '–'} of ${st.length}`}</h2>
    <div class="podium">${podium}</div>
    <table style="margin-top:10px"><tbody>${rows}</tbody></table>
    <button class="primary big" style="margin-top:18px" id="fin-close">Close</button>`;
  $('#overlay').classList.remove('hidden');
  sound.fanfare();
  confetti(mine?.overallRank === 1 ? 8000 : 4000);
  $('#fin-close').onclick = () => $('#overlay').classList.add('hidden');
}

// ---------- controls ----------
$('#add-product').addEventListener('click', () => {
  if (!isOpen() || plan.length >= C.maxProducts) return;
  const seq = plan.length + 1;
  plan.push({ seq, cell: null });
  selected = seq;
  sound.click();
  toast(`Product #${seq} added – now click a cell on the map.`);
  render();
});

$('#reset-plan').addEventListener('click', () => {
  plan = currentPlan();
  selected = plan[0]?.seq ?? null;
  touchPlan();
});

$('#submit').addEventListener('click', async () => {
  const btn = $('#submit');
  btn.disabled = true;
  clearTimeout(draftTimer);
  const res = await send('plan:save', { plan: plan.filter((r) => r.cell), submit: true, by: me.player, clientId: me.client });
  if (res?.ok) {
    adoptedDraftAt = Math.max(adoptedDraftAt, res.at || 0);
    sound.ok();
    toast('Decision submitted. You can still change it until the round closes.', 'ok');
  } else {
    $('#submit-err').textContent = res?.error || 'Could not submit.';
    toast(res?.error || 'Could not submit.', 'err');
    btn.disabled = false;
  }
});

$$('#map-mode button').forEach((b) => b.addEventListener('click', () => {
  mapMode = b.dataset.m;
  $$('#map-mode button').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));
$$('#tabs button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; renderTab(); }));
$('#mute').addEventListener('click', () => { $('#mute').textContent = sound.toggle() ? '🔇' : '🔊'; });
$('#mute').textContent = sound.muted ? '🔇' : '🔊';
$('#final-btn').addEventListener('click', showFinal);
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') $('#overlay').classList.add('hidden'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#overlay').classList.add('hidden'); selected = null; render(); }
});
addEventListener('resize', () => { const b = $('#tab-body'); b.dataset.key = ''; if (state) renderTab(); });

// ---------- timer loop ----------
setInterval(() => {
  if (!state) return;
  const g = state.game;
  const el = $('#timer');
  if (g.status !== 'open') { el.textContent = g.status === 'finished' ? 'FINAL' : '--:--'; el.className = 'timer'; return; }
  const ms = remaining(g.deadline);
  el.textContent = ms == null ? '∞' : clock(ms);
  el.className = `timer ${ms != null && ms < 30000 ? 'urgent' : ms != null && ms < 90000 ? 'soon' : ''}`;
  const s = ms == null ? null : Math.ceil(ms / 1000);
  if (s != null && s <= 10 && s > 0 && s !== lastTickSecond) {
    lastTickSecond = s;
    if (!state.me.decision?.submitted) sound.tick();
  }
  if (ms != null && ms < 60000) renderBanner();
}, 250);
