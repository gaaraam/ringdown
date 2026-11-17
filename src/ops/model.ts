import type { CallSnapshot, PendingOp, TraceEvent } from "../runtime/call.ts";
import type { Outcome } from "../pack/schema.ts";
import type { MockBusinessSystem } from "../jacks/mock.ts";
import type { Attempt } from "../jacks/runtime.ts";

export const outcomeLabels: Record<Outcome, string> = {
  success: "목표 달성", failed: "미달성", declined: "거절", handoff: "상담원 연결",
  opted_out: "수신 거부", callback_scheduled: "콜백 예약", pending_confirmation: "확인 필요",
};
export const kindLabels = { handoff: "상담원 연결", callback: "콜백", confirmation: "확인 필요" };
export interface Campaign {
  id: string; pack: string; name: string; personas: string[]; fault: string; seed: number;
  startedAt: string; status: "running" | "complete" | "interrupted" | "error";
}
export interface WriteEvidence {
  tool: string; callSeq: number; op: string; args: Record<string, unknown>; field?: string;
  idempotencyKey?: string;
}
export interface StoredCall {
  id: string; campaignId: string; persona: string; customer: { name: string; targetId: string };
  startedAt: string; durationMs: number; outcome: Outcome; summary: string; subject: string; selections: string[];
  state: CallSnapshot; events: TraceEvent[]; pending: PendingOp[];
  system: Pick<MockBusinessSystem, "collections" | "writes">;
  writeEvidence: WriteEvidence[]; silenceMaxSec: number;
}
export interface Resolution { status: "open" | "resolved"; assignee: string; note: string }
export interface FollowUp extends Resolution {
  id: string; callId: string; campaignId: string; customer: StoredCall["customer"];
  kind: PendingOp["kind"]; reason: string; createdAt: string; landed?: boolean;
}
export interface CallFilter { q?: string; outcome?: Outcome; campaign?: string; date?: string }
const finalResults = (call: StoredCall) => call.events.filter(e => e.type === "tool.result" && typeof e.callSeq === "number" && !e.attempt);

/** Check this exact write, not the overall goal or a successful response. */
export function writeLanded(call: StoredCall, evidence?: WriteEvidence): boolean {
  if (!evidence?.idempotencyKey) return false;
  return call.system.writes.some(write => {
    if (write.idempotencyKey !== evidence.idempotencyKey || write.op !== evidence.op) return false;
    const record = call.system.collections[write.collection]?.[write.recordKey];
    const value = evidence.field ? record?.[evidence.field] : record;
    return value !== null && typeof value === "object" && Object.entries(evidence.args).every(([key, v]) =>
      (value as Record<string, unknown>)[key] === v);
  });
}
export function followUps(call: StoredCall): FollowUp[] {
  const ops = call.pending.map(op => ({ ...op }));
  // A hard deadline can end the call before the runtime registers confirm_later.
  // Only final logical errors count; a recovered retry does not create extra work.
  const unknown = finalResults(call).filter(e => (e.result as { kind?: string })?.kind === "unknown_outcome")
    .map(e => call.writeEvidence.find(w => w.callSeq === e.callSeq)).filter(w => w !== undefined);
  for (const w of unknown) if (!ops.some(op => op.kind === "confirmation" && op.tool === w.tool)) ops.push({ kind: "confirmation", tool: w.tool });
  const used = new Set<number>();
  return ops.map((op, i) => {
    const evidence = [...call.writeEvidence].reverse().find(w => w.tool === op.tool && !used.has(w.callSeq));
    if (evidence) used.add(evidence.callSeq);
    const reason = op.kind === "confirmation" ? "업무 처리 결과를 확인하고 고객에게 안내해야 합니다."
      : op.kind === "handoff" ? "상담원 연결이 등록되어 후속 상담이 필요합니다."
      : "다시 연락하기로 하여 연락 일정을 확인해야 합니다.";
    return { id: `${call.id}:${i}`, callId: call.id, campaignId: call.campaignId, customer: call.customer,
      kind: op.kind, reason, createdAt: new Date(Date.parse(call.startedAt) + call.durationMs).toISOString(),
      status: "open", assignee: "", note: "", ...(op.kind === "confirmation" ? { landed: writeLanded(call, evidence) } : {}) };
  });
}
const resultSentences: Record<Outcome, string> = {
  success: "요청한 업무가 반영되어 목표를 달성했습니다.", failed: "통화를 마쳤으나 목표를 달성하지 못했습니다.",
  declined: "고객이 제안을 거절했습니다.", opted_out: "고객이 수신 거부를 요청했습니다.",
  handoff: "상담원 연결로 통화를 마쳤습니다.", callback_scheduled: "다시 연락하기로 하고 통화를 마쳤습니다.",
  pending_confirmation: "업무 처리 결과를 확정하지 못한 채 통화를 마쳤습니다.",
};
export function summarize(call: StoredCall): string {
  const fact = call.state.facts.find(f => /name$/i.test(f.key) && typeof f.value === "string");
  const customer = typeof fact?.value === "string" ? fact.value : call.customer.name;
  const user = [...call.state.transcript].reverse().find(t => t.role === "user");
  const quote = user ? ` 고객의 마지막 말: “${user.text}”` : " 고객 발화는 기록되지 않았습니다.";
  const kinds = [...new Set(followUps(call).map(item => kindLabels[item.kind]))];
  return `${customer} 고객과 ${call.subject} 건으로 통화했습니다.${call.selections.length ? ` 고객 선택: ${call.selections.join(", ")}.` : ""}${quote} ${resultSentences[call.outcome]} ${kinds.length ? `남은 처리: ${kinds.join(", ")}.` : "등록된 후속 처리는 없습니다."}`;
}
export function matches(call: StoredCall, filter: CallFilter): boolean {
  const q = filter.q?.trim().toLocaleLowerCase("ko-KR") ?? "";
  // Campaign dates are the Korean simulated business day, independent of server TZ.
  const date = new Date(Date.parse(call.startedAt) + 9 * 3600_000).toISOString().slice(0, 10);
  return (!q || `${call.customer.name} ${call.customer.targetId}`.toLocaleLowerCase("ko-KR").includes(q)) &&
    (!filter.outcome || call.outcome === filter.outcome) && (!filter.campaign || call.campaignId === filter.campaign) &&
    (!filter.date || date === filter.date);
}
export function statistics(calls: StoredCall[], inbox: FollowUp[]) {
  const outcomes = Object.fromEntries(Object.keys(outcomeLabels).map(k => [k, calls.filter(c => c.outcome === k).length]));
  const kinds = ["timeout", "5xx", "4xx", "unavailable", "unknown_outcome"] as const;
  const errors = Object.fromEntries(kinds.map(k => [k, 0]));
  let requests = 0;
  for (const call of calls) {
    // One terminal result per business tool invocation, including breaker rejections.
    // Attempt events and built-ins are excluded to avoid double counting retries.
    for (const event of finalResults(call)) {
      requests++;
      const result = event.result as { status: string; kind?: string };
      if (result.status === "error" && result.kind && result.kind in errors) errors[result.kind]!++;
    }
  }
  const rate = (n: number, d = calls.length) => d ? n / d : null;
  return { total: calls.length, outcomes, optOutRate: rate(outcomes.opted_out!), handoffRate: rate(outcomes.handoff!),
    goalRate: rate(outcomes.success!), openFollowUps: inbox.filter(i => i.status === "open").length,
    api: { requests, errors, errorRates: Object.fromEntries(kinds.map(k => [k, rate(errors[k]!, requests)])) } };
}
export function attemptKey(event: TraceEvent): string | undefined { return (event.attempt as Attempt | undefined)?.idempotencyKey; }
