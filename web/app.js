import { esc } from './trace.js';
import { messages, statePanel, reportView, reportPanel, statusLabel, outcomeLabel } from './render.js';
const $ = selector => document.querySelector(selector);
const S = { view: 'playground', packs: [], pack: null, persona: '', call: null, callPack: null, stream: null, report: null, reportPack: null };
const titles = { playground: 'Playground', calls: 'Calls', soundcheck: 'Soundcheck' };
function notice(error) { $('#notice').textContent = error.message ?? String(error); $('#notice').hidden = false; }
async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `요청 실패 (${response.status})`);
  return data;
}
function action(fn) { return event => { event?.preventDefault(); $('#notice').hidden = true; Promise.resolve().then(() => fn(event)).catch(notice); }; }
function busy(button, active, label) { button.disabled = active; if (label) button.textContent = label; }
function nav(view) {
  S.view = view;
  const title = titles[view];
  document.title = `Ringdown — ${title}`;
  $('#page-title').textContent = title;
  for (const name of Object.keys(titles)) $(`#view-${name}`).hidden = view !== name;
  $('#conversation').hidden = view === 'soundcheck';
  document.querySelectorAll('[data-view]').forEach(el => { el.classList.toggle('on', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
  renderState();
}
function renderState() {
  $('#state').innerHTML = S.view === 'soundcheck' && S.report ? reportPanel(S.report) : statePanel(S.call, S.callPack ?? S.pack);
}
function renderSidebar() {
  $('#packs').innerHTML = S.packs.map(p => `<button class="side-item ${p.id === S.pack?.id ? 'on' : ''}" data-pack="${esc(p.id)}"><span>#</span><span>${esc(p.id)}</span></button>`).join('');
  $('#personas').innerHTML = S.pack.personas.map(p => `<button class="side-item ${p.id === S.persona ? 'on' : ''}" data-persona="${esc(p.id)}" title="${esc(p.intent)}"><span class="persona-dot"></span><span>${esc(p.id)}</span></button>`).join('');
  $('#pack-count').textContent = S.packs.length;
  $('#persona-count').textContent = S.pack.personas.length;
  $('#persona').innerHTML = S.pack.personas.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('');
  $('#persona').value = S.persona;
}
async function selectPack(id) {
  S.pack = await api(`/api/packs/${encodeURIComponent(id)}`);
  S.persona = S.pack.personas[0]?.id ?? '';
  $('#pack').value = S.pack.id;
  $('#fault').innerHTML = S.pack.faults.map(f => `<option>${esc(f)}</option>`).join('');
  $('#matrix-faults').innerHTML = S.pack.faults.map(f => `<label><input type="checkbox" value="${esc(f)}" ${['clean', 'slow'].includes(f) ? 'checked' : ''}>${esc(f)}</label>`).join('');
  renderSidebar(); renderState();
}
function renderCall() {
  const call = S.call;
  if (!call) return;
  const el = $('#messages');
  const bottom = el.scrollHeight - el.clientHeight - el.scrollTop < 100;
  const expanded = new Set([...el.querySelectorAll('details[open]')].map(d => d.dataset.trace));
  el.innerHTML = messages(call, S.callPack);
  el.querySelectorAll('details').forEach(d => { d.open = expanded.has(d.dataset.trace); });
  if (bottom) el.scrollTop = el.scrollHeight;
  $('#conversation-title').textContent = `${call.persona}와의 대화`;
  $('#conversation-subtitle').textContent = `${call.pack} / ${call.fault} / seed ${call.seed} / ${call.mode === 'human' ? '직접 입력' : '페르소나 자동'}`;
  $('#call-status').textContent = statusLabel(call.status);
  const ready = call.mode === 'human' && call.status === 'waiting';
  $('#say').disabled = !ready;
  $('#send').disabled = !ready;
  $('#say').placeholder = ready ? '고객의 말을 입력하세요' : call.status === 'complete' ? '통화가 끝났어요' : '진행 중이에요';
  $('#stop').hidden = !['running', 'waiting'].includes(call.status);
  $('#composer-help').textContent = call.error ?? (ready ? 'Enter로 보내요. 입력을 기다리는 동안 시뮬레이션 시계는 멈춰 있어요.' : '');
  renderState();
}
async function openCall(id) {
  S.stream?.close();
  S.stream = null;
  S.call = await api(`/api/calls/${id}`);
  S.callPack = S.pack?.id === S.call.pack ? S.pack : await api(`/api/packs/${encodeURIComponent(S.call.pack)}`);
  $('#messages').innerHTML = '';
  renderCall();
  if (['complete', 'error'].includes(S.call.status)) return;
  const stream = new EventSource(`/api/calls/${id}/events`);
  S.stream = stream;
  stream.addEventListener('snapshot', event => {
    if (S.stream !== stream) return;
    const data = JSON.parse(event.data);
    if (data.revision < S.call.revision) return;
    const wasWaiting = S.call.status === 'waiting';
    S.call = data; renderCall();
    if (!wasWaiting && data.status === 'waiting' && S.view !== 'soundcheck') $('#say').focus();
    if (['complete', 'error'].includes(data.status)) { stream.close(); void refreshCalls().catch(notice); }
  });
  stream.onerror = () => {
    if (S.stream === stream && !['complete', 'error'].includes(S.call.status)) $('#composer-help').textContent = '연결이 끊겨 다시 연결하고 있어요.';
  };
}
async function refreshCalls() {
  const calls = await api('/api/calls');
  $('#call-history').innerHTML = '<option value="">통화 선택</option>' + calls.map(c => `<option value="${esc(c.id)}">${esc(c.pack)} / ${esc(c.persona)} / ${esc(c.fault)} / seed ${c.seed} — ${statusLabel(c.status)}</option>`).join('');
  if (S.call) $('#call-history').value = S.call.id;
}
async function startCall(input) {
  const call = await api('/api/calls', input);
  await openCall(call.id);
  await refreshCalls();
}
$('#call-form').addEventListener('submit', action(async () => {
  busy($('#start'), true, '시작 중…');
  try {
    await startCall({ pack: S.pack.id, persona: S.persona, fault: $('#fault').value, seed: Number($('#seed').value), mode: $('#mode').value });
  } finally { busy($('#start'), false, '통화 시작'); }
}));
$('#composer').addEventListener('submit', action(async () => {
  if (!S.call || S.call.status !== 'waiting') return;
  busy($('#send'), true);
  try { await api(`/api/calls/${S.call.id}/say`, { text: $('#say').value }); $('#say').value = ''; }
  catch (error) { renderCall(); throw error; }
}));
$('#stop').addEventListener('click', action(async () => { await api(`/api/calls/${S.call.id}`, undefined, 'DELETE'); }));
$('#pack').addEventListener('change', action(() => selectPack($('#pack').value)));
$('#packs').addEventListener('click', action(event => { const button = event.target.closest('[data-pack]'); if (button) return selectPack(button.dataset.pack); }));
$('#persona').addEventListener('change', () => { S.persona = $('#persona').value; renderSidebar(); });
$('#personas').addEventListener('click', event => { const button = event.target.closest('[data-persona]'); if (button) { S.persona = button.dataset.persona; renderSidebar(); } });
$('.nav').addEventListener('click', action(async event => { const button = event.target.closest('[data-view]'); if (button) { nav(button.dataset.view); if (S.view === 'calls') await refreshCalls(); } }));
$('#call-history').addEventListener('change', action(() => $('#call-history').value && openCall($('#call-history').value)));
$('#refresh-calls').addEventListener('click', action(refreshCalls));
$('#matrix-form').addEventListener('submit', action(async () => {
  const parts = $('#matrix-seeds').value.split(',').map(s => s.trim());
  if (parts.some(s => !/^-?\d+$/.test(s))) throw new Error('시드를 정수로 입력해 주세요. 쉼표로 나눌 수 있어요.');
  const input = { pack: S.pack.id, faults: [...document.querySelectorAll('#matrix-faults input:checked')].map(el => el.value), seeds: parts.map(Number) };
  busy($('#run-matrix'), true, '실행 중…');
  try {
    const report = await api('/api/soundcheck', input);
    S.report = report; S.reportPack = input.pack;
    $('#report').innerHTML = reportView(report); renderState();
  } finally { busy($('#run-matrix'), false, '매트릭스 실행'); }
}));
async function replay(row) {
  $('#cell-dialog').close(); nav('calls');
  await startCall({ pack: S.reportPack, persona: row.persona, fault: row.fault, seed: row.seed, mode: 'auto' });
}
$('#report').addEventListener('click', action(async event => {
  const cell = event.target.closest('[data-cell-persona]');
  if (!cell) return;
  const rows = S.report.calls.filter(c => c.persona === cell.dataset.cellPersona && c.fault === cell.dataset.cellFault);
  if (rows.length === 1) { await replay(rows[0]); return; }
  $('#cell-calls').innerHTML = rows.map(row => `<button class="btn" data-call-id="${esc(row.callId)}">seed ${row.seed} — ${esc(outcomeLabel(row.outcome))}</button>`).join('');
  $('#cell-dialog').showModal();
}));
$('#cell-calls').addEventListener('click', action(event => { const button = event.target.closest('[data-call-id]'); if (button) return replay(S.report.calls.find(c => c.callId === button.dataset.callId)); }));
$('#close-dialog').addEventListener('click', () => $('#cell-dialog').close());
$('#theme').addEventListener('change', () => {
  document.documentElement.dataset.theme = $('#theme').value;
  try { localStorage.setItem('ringdown:theme', $('#theme').value); } catch { /* Optional persistence. */ }
});
try { $('#theme').value = localStorage.getItem('ringdown:theme') ?? ''; document.documentElement.dataset.theme = $('#theme').value; } catch { /* System theme remains available. */ }
window.addEventListener('pagehide', () => S.stream?.close());
async function init() {
  S.packs = await api('/api/packs');
  $('#pack').innerHTML = S.packs.map(p => `<option value="${esc(p.id)}">${esc(p.id)}</option>`).join('');
  if (!S.packs.length) throw new Error('실행 가능한 mock Pack이 없어요. packs/ 설정을 확인해 주세요.');
  await selectPack(S.packs[0].id);
  renderState();
}
void init().catch(notice);
