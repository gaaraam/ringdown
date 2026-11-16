import { LlmBrain } from "../brain/llm.ts";
import { p95 } from "./metrics.ts";
import type { LoadedPack } from "../pack/load.ts";
import { runCall, type CallResult } from "../runtime/call.ts";
import { modelLabel, ROLES, type ResolvedModel, type Role } from "../config/models.ts";
import { acceptable, metrics } from "./metrics.ts";
import { Fault, gates, Report } from "./report.ts";

/** rule 모드는 결정론적이다. llm 모드는 실제 추론을 호출한다. 업무 상태와 브레이커는 runCall마다 새로 만든다. */
export async function runMatrix(pack: LoadedPack, input: { faults: string[]; seeds: number[]; runId: string; gitSha: string; models: Record<Role, ResolvedModel>; brain?: "rule" | "llm" }) {
  if (!pack.personas.length || !input.seeds.length || !input.faults.length) throw Error("빈 매트릭스는 평가할 수 없습니다");
  if (new Set(input.seeds).size !== input.seeds.length || input.seeds.some(s => !Number.isSafeInteger(s))) throw Error("시드는 중복 없는 안전한 정수여야 합니다");
  if (new Set(input.faults).size !== input.faults.length) throw Error("장애 프로파일 중복");
  const rows: { result: CallResult; persona: typeof pack.personas[number]; fault: ReturnType<typeof Fault.parse>; seed: number }[] = [];
  for (const persona of pack.personas) for (const raw of input.faults) for (const seed of input.seeds) {
    const fault = Fault.parse(raw);
    const result = await runCall(pack, persona, fault, seed, { brain: input.brain === "llm" ? new LlmBrain(input.models.agent) : undefined });
    rows.push({ result, persona, fault, seed });
  }
  const summary = (row: typeof rows[number]) => ({ callId: row.result.callId, persona: row.persona.id, fault: row.fault, seed: row.seed, outcome: row.result.outcome, trace: `calls/${row.result.callId}.jsonl` });
  if (new Set(rows.map(r => r.result.callId)).size !== rows.length) throw Error("통화 ID 충돌");
  const aggregate = (selected: typeof rows) => metrics(selected.map(r => r.result), pack.pack.goal.acceptableOutcomes);
  const values = aggregate(rows), checks = gates(pack.pack.gates, values);
  const report = Report.parse({
    schemaVersion: 1, runId: input.runId, gitSha: input.gitSha, pack: `${pack.pack.id}@${pack.pack.version}`, packDir: pack.dir,
    brain: input.brain ?? "rule", models: Object.fromEntries(ROLES.map(role => [role, { ...input.models[role], label: modelLabel(input.models[role]), used: role === "agent" && input.brain === "llm" && rows.some(r => r.result.events.some(e => e.type === "brain.plan")) }])),
    seeds: input.seeds, matrix: { personas: pack.personas.length, faults: input.faults, calls: rows.length },
    metadata: { circuitBreaker: "per-call", eligibility: "all-matrix-calls", disclosureInBargeIn: false, simulation: true },
    diagnostics: (() => {
      const samples = rows.flatMap(r => r.result.events.filter(e => e.type === "brain.latency").map(e => Number(e.ms)));
      const sorted = [...samples].sort((a,b) => a-b);
      return { brain_latency_p50: { value: sorted.length ? sorted[Math.ceil(sorted.length * .5)-1] : null, ci95: null, n: sorted.length },
        brain_latency_p95: p95(samples), control_rejections: rows.reduce((n,r) => n+r.result.metrics.controlRejections,0),
        output_guard_hits: rows.reduce((n,r) => n+r.result.metrics.outputGuardHits,0) };
    })(),
    metrics: values, gates: checks, pass: checks.every(g => g.pass), calls: rows.map(summary),
    failures: rows.flatMap(r => {
      const reasons = [!acceptable(r.result, pack.pack.goal.acceptableOutcomes) ? `outcome:${r.result.outcome}` : "", r.result.metrics.longCall ? "long_call" : "", r.result.metrics.deadAir ? "dead_air" : "", r.result.metrics.policyViolations ? "policy_violation" : ""].filter(Boolean);
      return reasons.length ? [{ ...summary(r), reason: reasons.join(", ") }] : [];
    }),
    breakdowns: { fault: Object.fromEntries(input.faults.map(f => [f, aggregate(rows.filter(r => r.fault === f))])), intent: Object.fromEntries([...new Set(pack.personas.map(p => p.intent))].map(i => [i, aggregate(rows.filter(r => r.persona.intent === i))])) },
  });
  return { report, traces: Object.fromEntries(rows.map(r => [r.result.callId, r.result.events])) };
}
