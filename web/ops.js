import { esc, turnTrace } from './trace.js';

const $ = selector => document.querySelector(selector);
const number = value => Number(value).toLocaleString('ko-KR');
const percent = value => value === null ? '관측 없음' : `${(value * 100).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`;
const date = value => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const duration = value => `${number(Math.round(value / 1000))}초`;
const empty = text => `<p class="ops-empty">${text}</p>`;
const field = (label, html) => `<label class="field">${label}${html}</label>`;
const options = (values, selected = '') => Object.entries(values).map(([key, label]) => `<option value="${esc(key)}" ${key === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
const card = (title, content) => `<section class="card report-section"><h2>${title}</h2>${content}</section>`;
const kv = (key, value) => `<div class="kv"><span>${key}</span><b>${esc(value)}</b></div>`;
const faultLabels = { clean: '정상', slow: '응답 지연', flaky: '간헐적 오류', down: '연결 불가', 'lost-ack': '처리 응답 유실' };
const errorLabels = { timeout: '응답 시간 초과', '5xx': '서버 오류', '4xx': '요청 거부', unavailable: '연결 불가', unknown_outcome: '처리 결과 불명' };
const campaignStatus = { running: '실행 중', complete: '완료', interrupted: '중단', error: '실행 오류' };
const followStatus = { open: '열림', resolved: '처리 완료' };

export function createOps({ api, action, notice }) {
  let catalogue, campaigns = [], current = '', revision = 0, timer, selectedItem;
  let historyFilter = {};
  const campaignName = id => { const c = campaigns.find(c => c.id === id); return c ? `${c.name} · ${date(c.startedAt)}` : '캠페인 없음'; };
  const campaignOptions = selected => options({ '': '전체 캠페인', ...Object.fromEntries(campaigns.map(c => [c.id, `${c.name} · ${date(c.startedAt)} · ${faultLabels[c.fault]}`])) }, selected);
  const rail = content => { $('#state').innerHTML = content; $('#rail').setAttribute('aria-label', '운영 상세'); };
  const summaryRail = (title, body) => rail(`<section class="card rail-section"><h2>${title}</h2>${body}</section>`);
  const badge = (label, accent = false) => `<span class="badge ${accent ? 'accent' : ''}">${esc(label)}</span>`;
  const callLink = call => `<a class="ops-link" href="#history/${encodeURIComponent(call.id)}">${esc(call.customer.name)}</a><small class="block">${esc(call.customer.targetId)}</small>`;
  const queryString = fields => new URLSearchParams(Object.entries(fields).filter(([, value]) => value)).toString();
  function bindFilter(selector, fn) {
    $(selector).addEventListener('submit', action(event => fn(Object.fromEntries(new FormData(event.target)))));
  }
  function campaignRows(rows) {
    return rows.length ? `<div class="table-wrap"><table><thead><tr><th>캠페인</th><th>진행</th><th>상태</th></tr></thead><tbody>${rows.map(c => `<tr><td><a class="ops-link" href="#overview?campaign=${esc(c.id)}">${esc(c.name)}</a><small class="block">${esc(date(c.startedAt))}</small></td><td>${number(c.completed)} / ${number(c.total)}</td><td>${badge(campaignStatus[c.status], c.status === 'running')}</td></tr>`).join('')}</tbody></table></div>` : empty('등록된 캠페인이 없습니다.');
  }
  async function overview(params, rev) {
    const campaign = params.get('campaign') ?? '';
    const [stats, inbox] = await Promise.all([api(`/api/ops/overview?${queryString({ campaign })}`), api(`/api/ops/inbox?${queryString({ campaign, status: 'open' })}`)]);
    if (rev !== revision) return;
    $('#view-overview').innerHTML = `<form id="overview-filter" class="card config">${field('캠페인', `<select name="campaign">${campaignOptions(campaign)}</select>`)}<button class="btn">조회</button><span class="badge">시뮬레이션</span></form>
      <div class="metric-grid">${[['총 통화', number(stats.total)], ['목표 달성률', percent(stats.goalRate)], ['수신 거부율', percent(stats.optOutRate)], ['상담원 연결률', percent(stats.handoffRate)]].map(([label, value]) => `<div class="card metric"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
      ${card('통화 결과', stats.total ? `<div class="outcome-bars">${Object.entries(stats.outcomes).map(([kind, count]) => `<div class="outcome-row"><span>${esc(catalogue.outcomes[kind])}</span><progress max="${stats.total}" value="${count}" aria-label="${esc(catalogue.outcomes[kind])}"></progress><b>${number(count)}건</b><small>${percent(count / stats.total)}</small></div>`).join('')}</div>` : empty('통화 기록이 없습니다.'))}
      ${card('업무 API 오류', `<div class="table-wrap"><table><caption>최종 업무 요청 ${number(stats.api.requests)}건 기준</caption><thead><tr><th>오류 유형</th><th>오류 수</th><th>오류율</th></tr></thead><tbody>${Object.entries(stats.api.errors).map(([kind, count]) => `<tr><th>${errorLabels[kind]}</th><td>${number(count)}</td><td>${percent(stats.api.errorRates[kind])}</td></tr>`).join('')}</tbody></table></div>`)}
      ${card('캠페인', campaignRows(campaigns.filter(c => !campaign || c.id === campaign)))}`;
    summaryRail('열린 후속 처리', `<strong class="ops-total">${number(stats.openFollowUps)}<small>건</small></strong>${Object.entries(catalogue.kinds).map(([kind, label]) => kv(label, `${number(inbox.filter(i => i.kind === kind).length)}건`)).join('')}<a class="btn primary ops-block" href="#inbox?${queryString({ campaign, status: 'open' })}">후속 처리함 열기</a>`);
    bindFilter('#overview-filter', values => show('overview', new URLSearchParams(values)));
  }
  async function inboxView(params, rev) {
    const filter = { kind: params.get('kind') ?? '', status: params.get('status') ?? 'open', campaign: params.get('campaign') ?? '' };
    const items = await api(`/api/ops/inbox?${queryString(filter)}`);
    if (rev !== revision) return;
    $('#view-inbox').innerHTML = `<form id="inbox-filter" class="card config">${field('종류', `<select name="kind">${options({ '': '전체 종류', ...catalogue.kinds }, filter.kind)}</select>`)}${field('상태', `<select name="status">${options({ '': '전체 상태', ...followStatus }, filter.status)}</select>`)}${field('캠페인', `<select name="campaign">${campaignOptions(filter.campaign)}</select>`)}<button class="btn">조회</button></form>
      <section class="card report-section"><div class="ops-section-title"><h2>후속 처리</h2><span class="badge">${number(items.length)}건</span></div><div class="inbox-list">${items.length ? items.map(item => `<button class="inbox-item ${item.id === selectedItem ? 'selected' : ''}" data-item="${esc(item.id)}"><span class="ops-row"><strong>${esc(item.customer.name)}</strong>${badge(catalogue.kinds[item.kind], item.kind === 'confirmation')}</span><span class="ops-reason">${esc(item.reason)}</span><span class="ops-row"><small>${esc(item.customer.targetId)} · ${esc(date(item.createdAt))}</small><span>${item.kind === 'confirmation' ? badge(item.landed ? '반영됨' : '반영 안 됨') : ''} ${badge(followStatus[item.status])}</span></span></button>`).join('') : empty('조건에 맞는 후속 처리가 없습니다.')}</div></section>`;
    function select(id) {
      const item = items.find(i => i.id === id); selectedItem = item?.id;
      document.querySelectorAll('[data-item]').forEach(el => { el.classList.toggle('selected', el.dataset.item === id); el.setAttribute('aria-pressed', String(el.dataset.item === id)); });
      if (!item) { summaryRail('처리 상세', empty('선택된 후속 처리가 없습니다.')); return; }
      summaryRail('처리 상세', `<div class="ops-customer"><strong>${esc(item.customer.name)}</strong><small class="block">${esc(item.customer.targetId)}</small></div>${kv('종류', catalogue.kinds[item.kind])}${item.kind === 'confirmation' ? kv('업무 반영 상태', item.landed ? '반영됨' : '반영 안 됨') : ''}<p class="ops-reason">${esc(item.reason)}</p><a class="ops-link ops-block" href="#history/${esc(item.callId)}">통화 기록 열기</a><form id="resolve-form" class="ops-form">${field('상태', `<select name="status">${options(followStatus, item.status)}</select>`)}${field('담당자', `<input name="assignee" maxlength="100" value="${esc(item.assignee)}">`)}${field('처리 메모', `<textarea name="note" rows="5" maxlength="2000">${esc(item.note)}</textarea>`)}<button class="btn primary">저장</button><p id="resolve-feedback" role="status"></p></form>`);
      bindFilter('#resolve-form', async values => {
        const button = $('#resolve-form button'); button.disabled = true;
        try { await api(`/api/ops/inbox/${encodeURIComponent(item.id)}`, values, 'PATCH'); if (rev === revision) await show('inbox', new URLSearchParams(filter)); }
        finally { button.disabled = false; }
      });
    }
    $('#view-inbox .inbox-list').addEventListener('click', event => { const button = event.target.closest('[data-item]'); if (button) select(button.dataset.item); });
    select(items.some(i => i.id === selectedItem) ? selectedItem : items[0]?.id);
    bindFilter('#inbox-filter', values => show('inbox', new URLSearchParams(values)));
  }
  async function history(params, rev, id) {
    if (id) {
      const call = await api(`/api/ops/calls/${encodeURIComponent(id)}`);
      if (rev !== revision) return;
      $('#view-history').innerHTML = `<a class="ops-link" href="#history">통화 목록</a><section class="card report-section"><div class="ops-section-title"><h2>${esc(call.customer.name)}</h2>${badge(catalogue.outcomes[call.outcome], call.outcome === 'success')}</div><p class="ops-summary">${esc(call.summary)}</p></section>
        ${card('대화 기록', `<div class="ops-transcript">${call.state.transcript.map(turn => `<article class="msg ${turn.role === 'user' ? 'user' : 'agent'}"><div class="meta"><strong>${turn.role === 'user' ? '고객' : '상담'} </strong><span>${duration(turn.startedAt - (call.state.transcript[0]?.startedAt ?? 0))}</span></div><div class="bubble">${esc(turn.role === 'agent' ? turn.heard : turn.text)}</div></article>`).join('') || empty('대화 기록이 없습니다.')}</div>`)}
        <details class="card report-section developer-details"><summary>개발자 상세</summary>${call.state.transcript.map((turn, i) => turn.role === 'agent' ? turnTrace(turn, i, call, { silenceMaxSec: call.silenceMaxSec }) : '').join('')}</details>`;
      summaryRail('통화 정보', kv('고객 번호', call.customer.targetId) + kv('결과', catalogue.outcomes[call.outcome]) + kv('시작', date(call.startedAt)) + kv('통화 시간', duration(call.durationMs)) + `<p class="ops-reason">${esc(campaignName(call.campaignId))}</p><a class="ops-link ops-block" href="#inbox?campaign=${esc(call.campaignId)}&status=">캠페인 후속 처리</a>`);
      return;
    }
    if ([...params.keys()].length) historyFilter = Object.fromEntries(params);
    const calls = await api(`/api/ops/calls?${queryString(historyFilter)}`);
    if (rev !== revision) return;
    $('#view-history').innerHTML = `<form id="history-filter" class="card config">${field('고객 이름 또는 번호', `<input name="q" maxlength="200" value="${esc(historyFilter.q ?? '')}" placeholder="고객 검색">`)}${field('결과', `<select name="outcome">${options({ '': '전체 결과', ...catalogue.outcomes }, historyFilter.outcome)}</select>`)}${field('캠페인', `<select name="campaign">${campaignOptions(historyFilter.campaign)}</select>`)}${field('통화 날짜', `<input type="date" name="date" value="${esc(historyFilter.date ?? '')}">`)}<button class="btn">검색</button><button class="btn" type="button" id="clear-history">초기화</button></form>
      ${card(`통화 기록 <span class="badge">${number(calls.length)}건</span>`, calls.length ? `<div class="table-wrap"><table><thead><tr><th>고객</th><th>결과</th><th>시작 시각</th><th>통화 시간</th></tr></thead><tbody>${calls.map(c => `<tr><td>${callLink(c)}</td><td>${badge(catalogue.outcomes[c.outcome])}</td><td>${esc(date(c.startedAt))}</td><td>${duration(c.durationMs)}</td></tr>`).join('')}</tbody></table></div>` : empty('조건에 맞는 통화 기록이 없습니다.'))}`;
    summaryRail('조회 결과', kv('통화', `${number(calls.length)}건`) + kv('통화 시간 합계', duration(calls.reduce((sum, c) => sum + c.durationMs, 0))));
    bindFilter('#history-filter', values => { historyFilter = values; return show('history'); });
    $('#clear-history').addEventListener('click', action(() => { historyFilter = {}; return show('history'); }));
  }
  async function campaignsView(rev) {
    if (rev !== revision) return;
    const running = campaigns.find(c => c.status === 'running');
    $('#view-campaigns').innerHTML = `<form id="campaign-form" class="card report-section ops-form"><div class="ops-section-title"><h2>새 캠페인</h2><span class="badge">시뮬레이션</span></div><div class="ops-form-grid">${field('Pack', `<select id="campaign-pack" name="pack">${options(Object.fromEntries(catalogue.packs.map(p => [p.id, p.name])))}</select>`)}${field('장애 프로필', `<select name="fault">${options(faultLabels)}</select>`)}${field('시드', '<input name="seed" type="number" value="7" min="-2147483648" max="2147483647" required>')}</div><fieldset><legend>통화 대상</legend><label class="ops-select-all"><input id="all-personas" type="checkbox" checked>전체 선택</label><div id="campaign-personas" class="persona-checks"></div></fieldset><div class="ops-row"><span id="target-count" class="ops-reason"></span><button class="btn primary" id="run-campaign" ${running ? 'disabled' : ''}>캠페인 실행</button></div></form><div id="campaign-progress" role="status"></div><div id="campaign-list">${card('캠페인 기록', campaignRows(campaigns))}</div>`;
    function renderTargets() {
      const pack = catalogue.packs.find(p => p.id === $('#campaign-pack').value);
      $('#campaign-personas').innerHTML = pack.personas.map(p => `<label><input type="checkbox" name="personas" value="${esc(p.id)}" checked><span>${esc(p.customer.name)}<small class="block">${esc(p.customer.targetId)}</small></span></label>`).join('');
      $('#all-personas').checked = true; targetCount();
    }
    function targetCount() {
      const all = [...document.querySelectorAll('#campaign-personas input')], count = all.filter(el => el.checked).length;
      $('#target-count').textContent = `선택한 대상 ${number(count)}명`;
      $('#all-personas').checked = count === all.length; $('#all-personas').indeterminate = count > 0 && count < all.length;
    }
    $('#campaign-pack').addEventListener('change', renderTargets);
    $('#all-personas').addEventListener('change', () => { document.querySelectorAll('#campaign-personas input').forEach(el => { el.checked = $('#all-personas').checked; }); targetCount(); });
    $('#campaign-personas').addEventListener('change', targetCount); renderTargets();
    $('#campaign-form').addEventListener('submit', action(async event => {
      const fields = new FormData(event.target), personas = fields.getAll('personas');
      if (!personas.length) throw new Error('통화 대상을 선택해 주세요.');
      $('#run-campaign').disabled = true;
      try {
        const campaign = await api('/api/ops/campaigns', { pack: fields.get('pack'), fault: fields.get('fault'), seed: Number(fields.get('seed')), personas });
        await refreshProgress(campaign.id, rev);
      } catch (error) { if (rev === revision) $('#run-campaign').disabled = false; throw error; }
    }));
    summaryRail('실행 조건', kv('통화 방식', '시뮬레이션') + kv('응답 방식', '규칙 기반') + kv('업무 연결', '모의 시스템'));
    if (running) await refreshProgress(running.id, rev);
    else if (campaigns[0]) progressView(campaigns[0]);
  }
  function progressView(c) {
    $('#campaign-progress').innerHTML = `<section class="card report-section"><div class="ops-section-title"><h2>${esc(c.name)}</h2>${badge(campaignStatus[c.status], c.status === 'running')}</div><progress max="${c.total}" value="${c.completed}" aria-label="캠페인 진행"></progress><div class="ops-row"><span>${number(c.completed)} / ${number(c.total)}통화</span><a class="ops-link" href="#overview?campaign=${esc(c.id)}">운영 현황</a></div></section>`;
  }
  async function refreshProgress(id, rev) {
    if (rev !== revision || current !== 'campaigns') return;
    const c = await api(`/api/ops/campaigns/${id}`);
    if (rev !== revision) return;
    progressView(c);
    if (c.status === 'running') timer = setTimeout(() => { void refreshProgress(id, rev).catch(notice); }, 150);
    else {
      campaigns = await api('/api/ops/campaigns');
      if (rev !== revision) return;
      $('#run-campaign').disabled = false;
      $('#campaign-list').innerHTML = card('캠페인 기록', campaignRows(campaigns));
    }
  }
  async function show(view, params = new URLSearchParams(), id) {
    clearTimeout(timer); current = view; const rev = ++revision;
    if (!['overview', 'inbox', 'history', 'campaigns'].includes(view)) return;
    if (!catalogue) catalogue = await api('/api/ops/catalogue');
    const list = await api('/api/ops/campaigns');
    if (rev !== revision) return;
    campaigns = list;
    if (view === 'overview') await overview(params, rev);
    if (view === 'inbox') await inboxView(params, rev);
    if (view === 'history') await history(params, rev, id);
    if (view === 'campaigns') await campaignsView(rev);
  }
  return { show };
}
