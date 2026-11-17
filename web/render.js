import { esc, ms, turnTrace } from './trace.js';
export const labels = { goal_rate: '목표 성공률', acceptable_rate: '허용 종료율', degraded_survival: '장애 생존율', barge_in_rate: '끼어들기율', long_call_rate: '시간 상한 도달률', dead_air_incidents: 'Dead-air', policy_violations: '정책 위반', control_rejections: '실행 거부', output_guard_hits: '발화 가드', turn_latency_p95: '턴 지연 p95', brain_fallbacks: 'Brain 대체' };
export const statusLabel = status => ({ running: '실행 중', waiting: '입력 대기', complete: '통화 완료', error: '통화 중단' })[status] ?? status;
export const outcomeLabel = status => ({ success: '목표 달성', failed: '미달성', declined: '거절', handoff: '상담원 이관', opted_out: '수신 거부', callback_scheduled: '콜백 예약', pending_confirmation: '확인 대기' })[status] ?? status;
const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
const section = (title, content) => `<section class="card rail-section"><h2>${esc(title)}</h2>${content}</section>`;

export function messages(call, pack) {
  if (!call.state?.transcript.length) return '<div class="empty"><p>연결 중이에요.</p></div>';
  return call.state.transcript.map((turn, i) => `<article class="msg ${turn.role === 'user' ? 'user' : 'agent'}"><div class="meta"><span class="av">${turn.role === 'user' ? '나' : 'r'}</span><strong>${turn.role === 'user' ? '고객' : '에이전트'}</strong><span>${(turn.startedAt / 1000).toFixed(1)}s</span>${turn.interrupted ? '<span class="badge">끼어들기</span>' : ''}</div><div class="bubble">${esc(turn.role === 'agent' ? turn.heard : turn.text)}</div>${turn.role === 'agent' ? turnTrace(turn, i, call, pack) : ''}</article>`).join('') + (call.status === 'complete' ? `<div class="meta">통화를 마쳤어요 — ${esc(outcomeLabel(call.state.outcome))}</div>` : '');
}
export function statePanel(call, pack) {
  if (!pack) return section('통화 상태', '<p>불러오는 중이에요.</p>');
  const s = call?.state;
  const visited = new Set(s?.transitions.flatMap(t => [t.from, t.to]) ?? []);
  return section('통화 상태', kv('상태', call ? statusLabel(call.status) : '준비') + kv('Brain', 'RuleBrain') + kv('시뮬레이션 시각', s ? `${(s.at / 1000).toFixed(1)} s` : '—') + (s?.outcome ? kv('결과', outcomeLabel(s.outcome)) : '')) +
    section('단계 그래프', `<ol class="stage-graph">${pack.stages.map(stage => `<li class="stage-node ${stage.id === s?.stage ? 'active' : ''}"><strong>${stage.id === s?.stage ? '◉' : visited.has(stage.id) ? '✓' : '○'} ${esc(stage.id)}</strong><small>${stage.next.length ? `→ ${stage.next.map(esc).join(', ')}` : '종료 단계'}</small></li>`).join('')}</ol>`) +
    section('실행 지표', kv('Dead-air', s?.metrics.deadAir ?? 0) + kv('가드 수정', s?.metrics.outputGuardHits ?? 0) + kv('실행 거부', s?.metrics.controlRejections ?? 0) + kv('정책 위반', s?.metrics.policyViolations ?? 0)) +
    section('슬롯', s && Object.keys(s.slots).length ? Object.entries(s.slots).map(([k, v]) => kv(k, `${v.value} (turn ${v.turn})`)).join('') : '<p>없음</p>') +
    section('사실과 출처', s?.facts.length ? s.facts.map(f => `<div class="fact"><b>${esc(f.key)}</b>: ${esc(f.value)}<small>${esc(f.source.kind)} / ${esc(f.source.tool ?? f.source.chunkId ?? 'target')}</small></div>`).join('') : '<p>없음</p>') +
    section('Jack / 차단기', s ? Object.entries(s.jacks).map(([id, j]) => `<div class="fact"><b>${esc(id)}</b>${kv('회로', j.state)}${kv('연속 실패', j.failures)}${j.openUntil ? kv('다음 탐침 시각', ms(j.openUntil)) : ''}${j.probeDue ? '<small>다음 호출이 탐침이에요.</small>' : ''}</div>`).join('') : '<p>없음</p>') +
    section('후속 작업', s?.pending.length ? s.pending.map(p => `<p>${esc(p.kind)} ${esc(p.tool ?? p.target ?? '')}</p>`).join('') : '<p>없음</p>');
}
const value = (metric, name) => metric.value === null ? '관측 없음' : metric.ci95 ? `${(metric.value * 100).toFixed(1)}%` : name === 'turn_latency_p95' ? ms(metric.value) : metric.value;
const interval = metric => metric.ci95 ? `Wilson 95% CI ${(metric.ci95[0] * 100).toFixed(1)}–${(metric.ci95[1] * 100).toFixed(1)}%` : '—';
export function reportPanel(report) {
  return section('실험 조건', kv('Pack', report.pack) + kv('Brain', report.brain) + kv('페르소나', report.matrix.personas) + kv('통화', report.matrix.calls) + kv('시드', report.seeds.join(', ')));
}
export function reportView(report) {
  const personas = [...new Set(report.calls.map(c => c.persona))];
  return `<div class="card report-head"><div><h2>결과</h2><p>${esc(report.pack)} / ${report.matrix.calls}통화 / RuleBrain</p></div><span class="badge ${report.pass ? '' : 'fail'}">${report.pass ? '게이트 통과' : '게이트 미달'}</span></div>
    <div class="metric-grid">${['goal_rate', 'degraded_survival', 'turn_latency_p95', 'policy_violations'].map(name => `<div class="card metric"><span>${labels[name]}</span><strong>${value(report.metrics[name], name)}</strong><small>${interval(report.metrics[name])}</small><small>n = ${report.metrics[name].n}</small></div>`).join('')}</div>
    <section class="card report-section"><h2>게이트</h2><div class="gates">${report.gates.map(g => `<span class="badge ${g.pass ? '' : 'fail'}">${esc(labels[g.metric] ?? g.metric)} ${esc(g.op)} ${g.threshold} (실제 ${g.value?.toFixed(3) ?? '관측 없음'})</span>`).join('')}</div></section>
    <section class="card report-section"><h2>페르소나 × 장애</h2><p>목표 성공률. 칸을 누르면 해당 통화를 열어요.</p><div class="table-wrap"><table><thead><tr><th scope="col">페르소나</th>${report.matrix.faults.map(f => `<th scope="col">${esc(f)}</th>`).join('')}</tr></thead><tbody>${personas.map(p => `<tr><th scope="row">${esc(p)}</th>${report.matrix.faults.map(f => {
      const calls = report.calls.filter(c => c.persona === p && c.fault === f);
      const percent = Math.round(100 * calls.filter(c => c.outcome === 'success').length / calls.length);
      return `<td><button class="heat ${percent === 100 ? 'high' : percent ? 'mid' : ''}" data-cell-persona="${esc(p)}" data-cell-fault="${esc(f)}" aria-label="${esc(p)}, ${esc(f)}, 성공 ${percent}%, ${calls.length}통화 열기">${percent}%</button></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div></section>
    <section class="card report-section"><h2>전체 지표</h2><div class="table-wrap"><table><thead><tr><th>지표</th><th>값</th><th>신뢰구간</th><th>n</th></tr></thead><tbody>${Object.entries(report.metrics).map(([name, metric]) => `<tr><th scope="row">${esc(labels[name] ?? name)}</th><td>${value(metric, name)}</td><td>${interval(metric)}</td><td>${metric.n}</td></tr>`).join('')}</tbody></table></div></section>`;
}
