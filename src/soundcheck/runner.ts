import type { LoadedPack } from "../pack/load.ts";
import { runCall, type CallResult } from "../runtime/call.ts";
import { modelLabel, ROLES, type ResolvedModel, type Role } from "../config/models.ts";
import { acceptable, metrics } from "./metrics.ts";
import { Fault, gates, Report } from "./report.ts";

/** 파일·환경·시계를 읽지 않는 결정론적 코어. 업무 상태와 브레이커는 runCall마다 새로 만든다. */
export async function runMatrix(pack: LoadedPack, input: { faults: string[]; seeds: number[]; runId: string; gitSha: string; models: Record<Role, ResolvedModel> }) {
  if (!pack.personas.length || !input.seeds.length || !input.faults.length) throw Error("빈 매트릭스는 평가할 수 없습니다");
  if (new Set(input.seeds).size !== input.seeds.length || input.seeds.some(s => !Number.isSafeInteger(s))) throw Error("시드는 중복 없는 안전한 정수여야 합니다");
  if (new Set(input.faults).size !== input.faults.length) throw Error("장애 프로파일 중복");
  const rows: { result: CallResult; persona: typeof pack.personas[number]; fault: ReturnType<typeof Fault.parse>; seed: number }[] = [];
  for (const persona of pack.personas) for (const raw of input.faults) for (const seed of input.seeds) {
    const fault = Fault.parse(raw);
    const result = await runCall(pack, persona, fault, seed);
    rows.push({ result, persona, fault, seed });
  }
  const summary = (row: typeof rows[number]) => ({ callId: row.result.callId, persona: row.persona.id, fault: row.fault, seed: row.seed, outcome: row.result.outcome, trace: `calls/${row.result.callId}.jsonl` });
  if (new Set(rows.map(r => r.result.callId)).size !== rows.length) throw Error("통화 ID 충돌");
  const aggregate = (selected: typeof rows) => metrics(selected.map(r => r.result), pack.pack.goal.acceptableOutcomes);
  const values = aggregate(rows), checks = gates(pack.pack.gates, values);
  const report = Report.parse({
    schemaVersion: 1, runId: input.runId, gitSha: input.gitSha, pack: `${pack.pack.id}@${pack.pack.version}`, packDir: pack.dir,
    brain: "rule", models: Object.fromEntries(ROLES.map(role => [role, { ...input.models[role], label: modelLabel(input.models[role]), used: false }])),
    seeds: input.seeds, matrix: { personas: pack.personas.length, faults: input.faults, calls: rows.length },
    metadata: { circuitBreaker: "per-call", eligibility: "all-matrix-calls", disclosureInBargeIn: false, simulation: true },
    metrics: values, gates: checks, pass: checks.every(g => g.pass), calls: rows.map(summary),
    failures: rows.flatMap(r => {
      const reasons = [!acceptable(r.result, pack.pack.goal.acceptableOutcomes) ? `outcome:${r.result.outcome}` : "", r.result.metrics.longCall ? "long_call" : "", r.result.metrics.deadAir ? "dead_air" : "", r.result.metrics.policyViolations ? "policy_violation" : ""].filter(Boolean);
      return reasons.length ? [{ ...summary(r), reason: reasons.join(", ") }] : [];
    }),
    breakdowns: { fault: Object.fromEntries(input.faults.map(f => [f, aggregate(rows.filter(r => r.fault === f))])), intent: Object.fromEntries([...new Set(pack.personas.map(p => p.intent))].map(i => [i, aggregate(rows.filter(r => r.persona.intent === i))])) },
  });
  return { report, traces: Object.fromEntries(rows.map(r => [r.result.callId, r.result.events])) };
}
