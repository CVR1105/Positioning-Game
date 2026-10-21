import { $, $$, api, store, qs, loadConfig } from './common.js';

const config = await loadConfig();
const code = (qs('g') || '').toUpperCase();
if (code) $$('input[name="code"]').forEach((i) => { i.value = code; });

const rounds = $('select[name="rounds"]');
for (let i = 1; i <= config.maxRounds; i++) rounds.add(new Option(String(i), String(i), i === config.maxRounds, i === config.maxRounds));
const teams = $('select[name="teams"]');
for (let i = 2; i <= config.maxTeams; i++) teams.add(new Option(String(i), String(i), i === config.maxTeams, i === config.maxTeams));
if (config.requiresFacilitatorKey) $('#fkey-field').classList.remove('hidden');

$$('#fac-tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#fac-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#create-form').classList.toggle('hidden', b.dataset.t !== 'create');
  $('#login-form').classList.toggle('hidden', b.dataset.t !== 'login');
}));

const lastPlayer = store.get('pg:player');
if (lastPlayer) $('#join-form [name="player"]').value = lastPlayer;

function busy(form, on) {
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = on;
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const gameId = f.code.value.trim().toUpperCase();
  $('#join-err').textContent = '';
  busy(f, true);
  try {
    const r = await api('POST', `/api/games/${gameId}/join`, { teamName: f.team.value, pin: f.pin.value });
    const player = f.player.value.trim();
    store.set('pg:player', player);
    store.set(`pg:team:${gameId}`, { token: r.token, teamId: r.teamId, player });
    location.href = `/team.html?g=${gameId}`;
  } catch (err) {
    $('#join-err').textContent = err.message;
  } finally {
    busy(f, false);
  }
});

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#create-err').textContent = '';
  busy(f, true);
  try {
    const r = await api('POST', '/api/games', {
      name: f.name.value,
      totalRounds: Number(f.rounds.value),
      maxTeams: Number(f.teams.value),
      roundSeconds: Number(f.minutes.value) * 60,
      autoClose: f.auto.checked,
      adminPassword: f.password.value,
      facilitatorKey: f.fkey.value,
    });
    store.set(`pg:admin:${r.gameId}`, { token: r.adminToken });
    location.href = `/admin.html?g=${r.gameId}`;
  } catch (err) {
    $('#create-err').textContent = err.message;
  } finally {
    busy(f, false);
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const gameId = f.code.value.trim().toUpperCase();
  $('#login-err').textContent = '';
  busy(f, true);
  try {
    const r = await api('POST', `/api/games/${gameId}/admin-login`, { password: f.password.value });
    store.set(`pg:admin:${gameId}`, { token: r.adminToken });
    location.href = `/admin.html?g=${gameId}`;
  } catch (err) {
    $('#login-err').textContent = err.message;
  } finally {
    busy(f, false);
  }
});

$('#screen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const gameId = e.target.code.value.trim().toUpperCase();
  $('#screen-err').textContent = '';
  try {
    await api('GET', `/api/games/${gameId}`);
    location.href = `/screen.html?g=${gameId}`;
  } catch (err) {
    $('#screen-err').textContent = err.message;
  }
});
