import type { CallResult } from "../runtime/call.ts";
import type { Outcome } from "../pack/schema.ts";

export interface Metric { value: number | null; ci95: [number, number] | null; n: number }
/** Wilson 점수 구간, z=1.959963984540054. 관측 없음은 0%가 아니라 null이다. */
export function rate(k: number, n: number): Metric {
  if (!n) return { value: null, ci95: null, n };
  const z = 1.959963984540054, p = k / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { value: p, ci95: [k === 0 ? 0 : Math.max(0, center - half), k === n ? 1 : Math.min(1, center + half)], n };
}
/** 최근접 순위 p95: 정렬한 표본의 ceil(0.95*n)번째, 단위 ms. */
export function p95(values: number[]): Metric {
  return { value: values.length ? [...values].sort((a,b) => a-b)[Math.ceil(.95 * values.length)-1]! : null, ci95: null, n: values.length };
}
export function acceptable(call: Pick<CallResult, "outcome">, outcomes: Outcome[]): boolean {
  return call.outcome === "success" || outcomes.includes(call.outcome);
}
/** 재시도 후 성공도 장애 통화다. 사전 조회를 포함한 업무 도구의 실제 non-ok 시도만 센다. */
export function degraded(call: Pick<CallResult, "events">): boolean {
  return call.events.some(e => e.type === "tool.result" && e.attempt && (e.attempt as { result: { status: string } }).result.status !== "ok");
}
/**
 * 대상 통화는 모든 입력 페르소나×장애×시드(거절·이관·down 포함). 성공은 업무 상태 판정이다.
 * 끼어들기: 고정 고지만 제외한 에이전트 발화 중 interrupted 비율. 대기 멘트는 포함한다.
 * 통화 제한 도달은 longCall. 지연은 고객 발화 종료부터 다음 발화 시작까지(대기 멘트 포함).
 * 응답 없는 마지막 고객 턴은 지연 표본에서 제외하며 n으로 공개한다.
 * deadAir는 런타임 침묵 상한 초과 횟수, 정책 위반은 차단 후 실제 실행·송출 감사 횟수다.
 * brain_fallbacks는 brain.fallback 이벤트 수로 M4 연결점을 둔다(rule은 0).
 * 비율 외 합계와 p95에는 Wilson을 적용하지 않는다(ci95=null).
 */
export function metrics(calls: Pick<CallResult, "outcome" | "events" | "transcript" | "metrics">[], outcomes: Outcome[]) {
  const agents = calls.flatMap(c => c.transcript.filter(t => t.role === "agent" && !c.events.some(e => e.type === "speech.start" && e.fixed && e.at === t.startedAt)));
  const latencies = calls.flatMap(c => c.transcript.flatMap(t => {
    if (t.role !== "user") return [];
    const next = c.transcript.find(a => a.role === "agent" && a.startedAt >= t.endedAt);
    return next ? [next.startedAt - t.endedAt] : [];
  }));
  const faults = calls.filter(degraded);
  const count = (value: number): Metric => ({ value, ci95: null, n: calls.length });
  return {
    goal_rate: rate(calls.filter(c => c.outcome === "success").length, calls.length),
    acceptable_rate: rate(calls.filter(c => acceptable(c, outcomes)).length, calls.length),
    barge_in_rate: rate(agents.filter(t => t.role === "agent" && t.interrupted).length, agents.length),
    long_call_rate: rate(calls.filter(c => c.metrics.longCall).length, calls.length),
    turn_latency_p95: p95(latencies),
    dead_air_incidents: count(calls.reduce((n,c) => n+c.metrics.deadAir,0)),
    degraded_survival: rate(faults.filter(c => acceptable(c,outcomes)).length, faults.length),
    policy_violations: count(calls.reduce((n,c) => n+c.metrics.policyViolations,0)),
    brain_fallbacks: count(calls.reduce((n,c) => n+c.events.filter(e => e.type === "brain.fallback").length,0)),
  };
}
