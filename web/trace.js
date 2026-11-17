export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const ms = value => `${Math.round(value ?? 0).toLocaleString('ko-KR')} ms`;
const data = value => `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`;

/** Group evidence by the speech it precedes, preserving every retry and rejected proposal. */
export function turnTrace(turn, index, call, pack) {
  const transcript = call.state.transcript;
  const previous = transcript.slice(0, index).findLast(t => t.role === 'agent');
  const start = previous?.startedAt ?? -Infinity;
  const events = call.events.filter(e => e.at > start && e.at <= turn.startedAt);
  const rejects = events.filter(e => e.type === 'guard.reject' && e.layer !== 'input');
  const user = transcript.slice(0, index).findLast(t => t.role === 'user');
  const before = transcript[index - 1];
  const silence = before ? Math.max(0, turn.startedAt - before.endedAt) : 0;
  const currentSpeech = events.findLast(e => e.type === 'speech.start');
  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'brain.plan') {
      const following = events.slice(i + 1);
      const next = following.findIndex(x => x.type === 'brain.plan');
      const rejected = following.slice(0, next < 0 ? undefined : next).find(x => x.type === 'guard.reject' && x.layer === 'control');
      const p = e.plan;
      rows.push(`<div class="trace-item ${rejected ? 'rejected-plan' : ''}"><b>${rejected ? '거부된 제안' : 'Brain 제안'} #${e.attempt + 1}</b><p>감지 의도: <code>${esc(p.intent ?? '없음')}</code></p>
        ${data({ say: p.say ?? null, tools: p.tools ?? [], transition: p.transition ?? null, end: p.end ?? null, setSlots: p.setSlots ?? {} })}
        ${rejected ? `<p>사유: <code>${esc(rejected.reason)}</code></p>` : ''}</div>`);
    } else if (e.type === 'guard.reject') {
      // Input policy (opt-out, handoff request) is the runtime working as intended, not a blocked proposal.
      rows.push(e.layer === 'input'
        ? `<div class="policy-note"><b>입력 정책 처리</b>${esc(e.layer)} / <code>${esc(e.reason)}</code></div>`
        : `<div class="rejection"><b>${e.layer === 'control' ? '실행 거부' : '발화 수정'}</b>${esc(e.layer)} / <code>${esc(e.reason)}</code></div>`);
    } else if (e.type === 'tool.call') {
      rows.push(`<div class="trace-item"><b>${esc(e.call.tool)}</b> ${e.builtin ? '내장 도구' : `호출 #${e.callSeq}`}${data(e.call.args)}</div>`);
    } else if (e.type === 'tool.result') {
      if (e.attempt) {
        const a = e.attempt;
        rows.push(`<div class="trace-item"><b>호출 #${e.callSeq} 시도 결과</b> ${esc(a.result.status === 'ok' ? 'ok' : a.result.kind)} / ${ms(a.endedAt - a.at)}<p>멱등 키: <code>${esc(a.idempotencyKey ?? '없음 (읽기)')}</code></p></div>`);
      } else {
        rows.push(`<div class="trace-item">${e.builtin ? '내장 도구' : '도구'} 결과: <b>${esc(e.result?.status)}</b>${e.result?.kind ? ` / ${esc(e.result.kind)}` : ''}${e.attempts !== undefined ? ` / 재시도 ${Math.max(0, e.attempts - 1)}회 / ${ms(e.elapsedMs)}` : ''}${data(e.result)}</div>`);
      }
    } else if (e.type === 'brain.fallback') {
      rows.push(`<div class="trace-item">대체 응답: ${esc(e.reason)}</div>`);
    } else if (e.type === 'speech.interrupted') {
      rows.push(`<div class="trace-item">이전 발화 끼어들기: ${esc(e.heard)}</div>`);
    }
  }
  for (const t of call.state.transitions.filter(t => t.at > start && t.at <= turn.startedAt)) {
    rows.push(`<div class="trace-item"><b>실행된 단계 전이</b> ${esc(t.from)} → ${esc(t.to)}</div>`);
  }
  rows.push(`<div class="trace-item">${currentSpeech?.fixed ? '고정 고지' : currentSpeech?.filler ? '대기 멘트 (filler)' : '응답'} / 직전 발화 뒤 침묵 ${ms(silence)}${silence > pack.silenceMaxSec * 1000 ? ' / 침묵 상한 초과' : ' / 침묵 상한 이내'}</div>`);
  if (currentSpeech) rows.push(`<div class="trace-item">지연 누적: Brain ${ms(currentSpeech.latency.brain)} / 도구 ${ms(currentSpeech.latency.tool)} / TTS ${ms(currentSpeech.latency.tts)}</div>`);
  if (turn.interrupted) rows.push(`<div class="trace-item">끼어들기로 잘린 원문${data(turn.text)}</div>`);
  const banner = rejects.length ? `<div class="rejection"><b>런타임 거부·수정 ${rejects.length}건</b>${rejects.map(e => `<code>${esc(e.reason)}</code>`).join(' / ')}</div>` : '';
  const intent = events.findLast(e => e.type === 'brain.plan')?.plan?.intent;
  return `${banner}<details class="steps" data-trace="${turn.seq}"><summary>${intent ? `의도 ${esc(intent)} / ` : ''}이벤트 ${events.length}개</summary><div class="trace-body">${user && !intent ? `<div class="trace-item">고객 입력: ${esc(user.text)}</div>` : ''}${rows.join('')}</div></details>`;
}
