// Shared client helpers: API, storage, formatting, the perceptual map,
// charts, leaderboard race, confetti, sounds and the server clock.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'));
export const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
export const pct = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d) + '%');
export const qs = (k) => new URLSearchParams(location.search).get(k);

export async function api(method, url, body, token) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function clientId() {
  let id = null;
  try { id = sessionStorage.getItem('pg:client'); } catch { /* ignore */ }
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    try { sessionStorage.setItem('pg:client', id); } catch { /* ignore */ }
  }
  return id;
}

// ---------- server clock ----------
let clockOffset = 0;
export function syncClock(serverNow) {
  if (typeof serverNow === 'number') clockOffset = serverNow - Date.now();
}
export const serverTime = () => Date.now() + clockOffset;
export function remaining(deadline) {
  if (!deadline) return null;
  return Math.max(0, deadline - serverTime());
}
export function clock(ms) {
  if (ms == null) return '--:--';
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- toasts ----------
export function toast(msg, kind = '') {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3800);
  setTimeout(() => t.remove(), 4300);
}

// ---------- sound ----------
let audio = null;
let muted = store.get('pg:muted') ?? false;
export const sound = {
  get muted() { return muted; },
  toggle() { muted = !muted; store.set('pg:muted', muted); return muted; },
  tone(freq = 660, dur = 0.12, type = 'sine', vol = 0.08, delay = 0) {
    if (muted) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.frequency.value = freq;
      const t0 = audio.currentTime + delay;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    } catch { /* audio blocked */ }
  },
  tick() { this.tone(880, 0.06, 'square', 0.03); },
  click() { this.tone(520, 0.05, 'triangle', 0.05); },
  ok() { this.tone(660, 0.1); this.tone(990, 0.16, 'sine', 0.08, 0.1); },
  start() { [440, 554, 659].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.07, i * 0.12)); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.08, i * 0.14)); },
};

// ---------- count-up ----------
export function countUp(el, to, { from = 0, ms = 1400, prefix = '', signedFmt = false } = {}) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    const v = from + (to - from) * e;
    el.textContent = prefix + (signedFmt ? signed(v) : fmt(v));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- confetti ----------
export function confetti(ms = 5000) {
  let c = $('#confetti');
  if (!c) {
    c = document.createElement('canvas');
    c.id = 'confetti';
    document.body.appendChild(c);
  }
  const ctx = c.getContext('2d');
  const W = (c.width = innerWidth);
  const H = (c.height = innerHeight);
  const colors = ['#38bdf8', '#818cf8', '#22c55e', '#fbbf24', '#f97316', '#ec4899', '#ffffff'];
  const parts = Array.from({ length: 220 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.6,
    vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
    r: 4 + Math.random() * 6, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.a += p.va; p.vy += 0.03;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    }
    if (t - t0 < ms) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// ---------- game config & map ----------
let CONFIG = null;
export async function loadConfig() {
  if (!CONFIG) CONFIG = await api('GET', '/api/config');
  return CONFIG;
}
export const cfg = () => CONFIG;

export function demandOf(cell) {
  const row = cell[0];
  const col = Number(cell.slice(1));
  return CONFIG.demand[row][col - 1];
}
export function dist(a, b) {
  const r = (c) => CONFIG.rows.indexOf(c[0]);
  const k = (c) => Number(c.slice(1));
  return Math.abs(r(a) - r(b)) + Math.abs(k(a) - k(b));
}
export const moveCost = (a, b) => dist(a, b) * CONFIG.moveCost;
export const segmentOf = (cell) => CONFIG.segments.find((s) => s.cell === cell);

// Demand → colour, following the brief: green = attractive, yellow = moderate, red = low.
export function demandColor(d) {
  if (d === 0) return '#1b2537';
  if (d >= 1000) return '#15803d';
  if (d >= 800) return '#16a34a';
  if (d >= 600) return '#4d7c0f';
  if (d >= 400) return '#a16207';
  if (d >= 300) return '#b45309';
  if (d >= 200) return '#9a3412';
  if (d >= 150) return '#7f1d1d';
  return '#5b1a1a';
}
export function heatColor(n, max) {
  if (!n) return 'rgba(34,197,94,0.12)';
  const k = Math.min(1, n / Math.max(3, max));
  const hue = 120 - 120 * k;
  return `hsla(${hue}, 80%, 45%, ${0.35 + 0.5 * k})`;
}

/**
 * Render the perceptual map.
 * opts: { mode: 'demand'|'heat', counts, chips: {cell: [{label,color,ghost,sel}]}, origin, target,
 *         onClick(cell), tooltip(cell) -> html, segLabels }
 */
export function renderMap(root, opts = {}) {
  const { rows, cols } = CONFIG;
  const counts = opts.counts || {};
  const maxCount = Math.max(0, ...Object.values(counts));
  let html = '<div class="map">';
  rows.forEach((r) => {
    html += `<div class="axis">${r}</div>`;
    for (let c = 1; c <= cols; c++) {
      const cell = r + c;
      const d = demandOf(cell);
      const isStart = cell === CONFIG.start;
      const seg = segmentOf(cell);
      const bg = opts.mode === 'heat' ? heatColor(counts[cell] || 0, maxCount) : demandColor(d);
      const cls = ['cell'];
      if (isStart) cls.push('start');
      if (seg) cls.push('seg');
      if (opts.origin === cell) cls.push('selected-origin');
      if (opts.target === cell) cls.push('target');
      const chips = (opts.chips?.[cell] || [])
        .map((ch) => `<span class="chip ${ch.ghost ? 'ghost' : ''} ${ch.sel ? 'sel' : ''}" style="${ch.ghost ? `color:${ch.color}` : `background:${ch.color}`}">${esc(ch.label)}</span>`)
        .join('');
      const cnt = counts[cell] ? `<span class="cnt">${counts[cell]}</span>` : '';
      const center = isStart ? 'START' : opts.mode === 'heat' ? (counts[cell] || '') : fmt(d);
      html += `<div class="${cls.join(' ')}" data-cell="${cell}" style="background:${bg}">
        <span class="id">${cell}</span>${opts.mode === 'heat' ? '' : cnt}
        <span class="d">${center}</span>
        ${seg && opts.segLabels !== false ? `<span class="seg-label">${esc(seg.name.split(' ')[0])}</span>` : ''}
        ${chips ? `<span class="chips">${chips}</span>` : ''}
      </div>`;
    }
  });
  html += '<div></div>';
  for (let c = 1; c <= cols; c++) html += `<div class="axis">${c}</div>`;
  html += '</div>';
  root.innerHTML = `<div class="map-outer"><div class="axis-y axis-title">Style / look →</div>${html}
    <div class="row" style="justify-content:space-between;margin-top:4px;padding-left:32px">
      <span class="axis-title">Low quality</span><span class="axis-title">Quality →</span><span class="axis-title">High quality</span>
    </div></div>`;

  const tip = getTooltip();
  $$('.cell', root).forEach((el) => {
    const cell = el.dataset.cell;
    if (opts.onClick) el.addEventListener('click', () => opts.onClick(cell));
    if (opts.tooltip) {
      el.addEventListener('mousemove', (e) => {
        tip.innerHTML = opts.tooltip(cell);
        tip.classList.remove('hidden');
        const x = Math.min(e.clientX + 16, innerWidth - tip.offsetWidth - 10);
        const y = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 10);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
      });
      el.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    }
  });
}

function getTooltip() {
  let t = $('.tooltip');
  if (!t) {
    t = document.createElement('div');
    t.className = 'tooltip hidden';
    document.body.appendChild(t);
  }
  return t;
}

export function mapLegend(mode) {
  if (mode === 'heat') {
    return `<div class="map-legend"><span><i class="sw" style="background:${heatColor(0, 1)}"></i>No competitors</span>
      <span><i class="sw" style="background:${heatColor(1, 4)}"></i>Few</span>
      <span><i class="sw" style="background:${heatColor(4, 4)}"></i>Crowded</span>
      <span class="dim">Numbers = products positioned in the cell last round (all teams, anonymous)</span></div>`;
  }
  return `<div class="map-legend">
    <span><i class="sw" style="background:${demandColor(1000)}"></i>High demand</span>
    <span><i class="sw" style="background:${demandColor(400)}"></i>Moderate</span>
    <span><i class="sw" style="background:${demandColor(100)}"></i>Low</span>
    <span><i class="sw" style="border:2px dashed #fff"></i>Segment centre</span>
    <span class="dim">Badge = competing products last round</span></div>`;
}

// ---------- heat grid (small) ----------
export function heatGrid(counts) {
  const { rows, cols } = CONFIG;
  const max = Math.max(0, ...Object.values(counts || {}));
  let h = '<div class="heat">';
  for (const r of rows) {
    h += `<div class="ax">${r}</div>`;
    for (let c = 1; c <= cols; c++) {
      const n = counts?.[r + c] || 0;
      h += `<div title="${r + c}: ${n} product(s)" style="background:${heatColor(n, max)}">${n || ''}</div>`;
    }
  }
  h += '<div></div>';
  for (let c = 1; c <= cols; c++) h += `<div class="ax">${c}</div>`;
  return h + '</div>';
}

// ---------- line chart ----------
/** series: [{name, color, values:[...], me}] ; labels: x labels */
export function lineChart(root, series, labels, { height = 240, zero = true } = {}) {
  const W = Math.max(320, root.clientWidth || 600);
  const H = height;
  const pad = { l: 58, r: 16, t: 14, b: 26 };
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { root.innerHTML = '<div class="empty">No data yet – results appear after round 1.</div>'; return; }
  let min = Math.min(...all, zero ? 0 : Infinity);
  let max = Math.max(...all, zero ? 0 : -Infinity);
  if (min === max) { max += 1; min -= 1; }
  const span = max - min;
  max += span * 0.06;
  if (min < 0) min -= span * 0.06;
  const n = Math.max(labels.length, 2);
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (n - 1);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const ticks = 5;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px">`;
  for (let i = 0; i <= ticks; i++) {
    const v = min + ((max - min) * i) / ticks;
    svg += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  if (min < 0) svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" stroke="#64748b" stroke-dasharray="4 4"/>`;
  labels.forEach((l, i) => { svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`; });
  const ordered = [...series].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
  for (const s of ordered) {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    svg += `<path class="series ${s.me ? 'me' : ''}" d="${d}" stroke="${s.color}" opacity="${s.dim ? 0.35 : 1}"/>`;
    for (const p of pts) svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${s.me ? 4.5 : 3}" fill="${s.color}"><title>${esc(s.name)}</title></circle>`;
  }
  svg += '</svg>';
  const legend = `<div class="chart-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
  root.innerHTML = svg + legend;
}

// ---------- leaderboard race ----------
/** rows: [{id, name, color, value, label}] sorted any order. Keeps DOM to animate between updates. */
export function race(root, rows, { rowH = 50 } = {}) {
  root.classList.add('race');
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...sorted.map((r) => Math.abs(r.value)));
  root.style.height = sorted.length * rowH + 'px';
  const seen = new Set();
  sorted.forEach((r, i) => {
    let el = root.querySelector(`[data-id="${r.id}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'race-row';
      el.dataset.id = r.id;
      el.innerHTML = `<div class="rank"></div><div class="nm"></div><div><div class="bar"><span></span></div></div>`;
      el.style.transform = `translateY(${sorted.length * rowH}px)`;
      root.appendChild(el);
      void el.offsetWidth;
    }
    seen.add(String(r.id));
    const rk = el.querySelector('.rank');
    rk.textContent = i + 1;
    rk.className = `rank ${i < 3 ? 'r' + (i + 1) : ''}`;
    el.querySelector('.nm').innerHTML = `<span class="team-name"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</span>`;
    const bar = el.querySelector('.bar');
    bar.style.background = r.color;
    bar.classList.toggle('neg', r.value < 0 || Math.abs(r.value) / max < 0.18);
    bar.style.width = `${Math.max(1, (Math.abs(r.value) / max) * 92)}%`;
    bar.querySelector('span').textContent = r.label ?? fmt(r.value);
    el.style.transform = `translateY(${i * rowH}px)`;
  });
  for (const el of [...root.children]) if (!seen.has(el.dataset.id)) el.remove();
}

// ---------- ticker ----------
export function setTicker(items) {
  let t = $('.ticker');
  if (!t) {
    t = document.createElement('div');
    t.className = 'ticker';
    t.innerHTML = '<div class="label">MARKET WIRE</div><div class="grow" style="overflow:hidden"><div class="track"></div></div>';
    document.body.appendChild(t);
  }
  const track = $('.track', t);
  const html = items.map((s) => `<span>${esc(s)}</span>`).join('');
  if (track.dataset.html !== html) {
    track.dataset.html = html;
    track.innerHTML = html;
    track.style.animationDuration = `${Math.max(25, items.join(' ').length / 7)}s`;
  }
}

export function phaseLabel(game) {
  if (game.status === 'lobby') return ['Lobby', ''];
  if (game.status === 'open') return [`Round ${game.round} live`, 'live'];
  if (game.status === 'results') return [`Round ${game.round} results`, 'results'];
  return ['Game over', 'done'];
}

export function teamMap(state) {
  return new Map(state.teams.map((t) => [t.id, t]));
}

export function standings(state) {
  const last = state.history[state.history.length - 1];
  const prev = state.history[state.history.length - 2];
  const tm = teamMap(state);
  if (!last) return state.teams.map((t) => ({ ...t, accumulated: t.accumulated, overallRank: 1, delta: 0 }));
  return last.results
    .map((r) => {
      const p = prev?.results.find((x) => x.teamId === r.teamId);
      const t = tm.get(r.teamId) || { name: '?', color: '#888' };
      return { ...r, id: r.teamId, name: t.name, color: t.color, number: t.number, delta: p ? p.overallRank - r.overallRank : 0 };
    })
    .sort((a, b) => a.overallRank - b.overallRank || b.accumulated - a.accumulated);
}

export function rulesHtml() {
  return `<div class="rules">
  <p><b>Goal:</b> finish with the highest <b>accumulated profit</b> after all rounds. Accumulated profit = 5,000 starting points + every round's (sales − positioning costs).</p>
  <h4>Where to compete</h4>
  <p>Consumers judge products on <b>quality</b> (left → right) and <b>style/look</b> (bottom → top). Each cell shows the demand (sales points) available there.
  Four segments sit at the green hot-spots: <b>Status Seekers (A10)</b>, <b>Fashion Conscious (D3)</b>, <b>Budget Conscious (H3)</b> and <b>Quality Focused (I8)</b>.</p>
  <h4>Costs</h4>
  <ul><li>Every product starts in <b>START (J1)</b>. Moving costs <b>200 points per cell</b>, horizontally or vertically (never diagonally). Example: START → H3 = 4 moves = 800.</li>
  <li>Repositioning an existing product costs the same 200 per cell, even if you lower quality or style.</li>
  <li>Products you don't move cost nothing. You can spend up to your current accumulated profit (5,000 in round 1).</li>
  <li>Up to <b>20 products</b> per team. Products can't be withdrawn – reposition weak ones instead.</li></ul>
  <h4>Sales</h4>
  <ul><li>A cell's demand is <b>split equally</b> between every product in it, including your own. Alone in a 1,000 cell = 1,000; with 4 others = 200 each.</li>
  <li><b>Loyalty bonus:</b> a product that stays put earns an extra 10% of its previous sales, compounding each round (≈ +95% by round 8). Moving a product resets its loyalty.</li>
  <li>Products left in START earn nothing.</li></ul>
  <h4>Each round</h4>
  <ol><li>Click a product (or <b>+ Launch new product</b>), then click a target cell on the map.</li>
  <li>Watch the cost and projected sales, keep within budget.</li>
  <li>Press <b>Submit decision</b> before the timer ends. You can edit and resubmit until the round closes. Teams that don't submit keep last round's positions.</li></ol>
  <p class="muted">Other teams never see your decisions. After each round everyone sees team totals, the anonymous competition map (how many products sit in each cell) and the top 10 products.</p>
  </div>`;
}
