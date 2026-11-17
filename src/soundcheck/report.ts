import { z } from "zod";
import { METRICS, Outcome, Persona } from "../pack/schema.ts";
import { ModelSpec, ROLES } from "../config/models.ts";
import type { Metric } from "./metrics.ts";

export const MetricSchema = z.strictObject({ value: z.number().nonnegative().nullable(), ci95: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).nullable(), n: z.number().int().nonnegative() });
export const MetricsSchema = z.record(z.enum(METRICS), MetricSchema);
export const Fault = z.enum(["clean", "slow", "flaky", "down", "lost-ack"]);
export const CallSummary = z.strictObject({ callId: z.string().regex(/^call-[a-zA-Z0-9-]+$/), persona: z.string(), fault: Fault, seed: z.number().int(), outcome: Outcome, trace: z.string() });
export const Report = z.strictObject({
  schemaVersion: z.literal(1), runId: z.string(), gitSha: z.string(), pack: z.string(), packDir: z.string(), brain: z.enum(["rule", "llm"]),
  diagnostics: z.strictObject({ brain_latency_p50: MetricSchema, brain_latency_p95: MetricSchema, control_rejections: z.number().nonnegative(), output_guard_hits: z.number().nonnegative() }).optional(),
  models: z.record(z.enum(ROLES), ModelSpec.extend({ role: z.enum(ROLES), source: z.enum(["default","config","env","cli"]), label: z.string(), used: z.boolean() })),
  seeds: z.array(z.number().int()).min(1),
  matrix: z.strictObject({ personas: z.number().int().positive(), faults: z.array(Fault).min(1), calls: z.number().int().positive() }),
  metadata: z.strictObject({ circuitBreaker: z.literal("per-call"), eligibility: z.literal("all-matrix-calls"), disclosureInBargeIn: z.literal(false), simulation: z.literal(true) }),
  metrics: MetricsSchema,
  gates: z.array(z.strictObject({ metric: z.enum(METRICS), op: z.enum([">=","<=","==",">","<"]), threshold: z.number(), value: z.number().nullable(), pass: z.boolean() })),
  pass: z.boolean(), calls: z.array(CallSummary), failures: z.array(CallSummary.extend({ reason: z.string() })),
  breakdowns: z.strictObject({ fault: z.partialRecord(Fault, MetricsSchema), intent: z.partialRecord(Persona.shape.intent, MetricsSchema) }),
});
export type Report = z.infer<typeof Report>;
export function gates(spec: Partial<Record<typeof METRICS[number], string>>, values: Record<string, Metric>): Report["gates"] {
  return Object.entries(spec).map(([metric, expr]) => {
    const [,op,raw] = /^(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(expr)!;
    const threshold = Number(raw), value = values[metric]!.value;
    const pass = value !== null && ({ ">=": value >= threshold, "<=": value <= threshold, "==": value === threshold, ">": value > threshold, "<": value < threshold }[op!] ?? false);
    return { metric: metric as typeof METRICS[number], op: op as Report["gates"][number]["op"], threshold, value, pass };
  });
}
export const Baseline = z.strictObject({ schemaVersion: z.literal(1), pack: z.string(), brain: z.literal("rule"), matrix: Report.shape.matrix, seeds: Report.shape.seeds, metrics: MetricsSchema });
export function baseline(report: Report) { return Baseline.parse({ schemaVersion: 1, pack: report.pack, brain: report.brain, matrix: report.matrix, seeds: report.seeds, metrics: report.metrics }); }
/** 구간 끝점이 닿는 경우도 겹침이다. 합계·p95는 CI가 없어 판정을 유보한다. */
export function compare(before: Metric, after: Metric, higher: boolean): string {
  if (!before.ci95 || !after.ci95) return "판정 불가(구간 없음)";
  if (before.ci95[1] >= after.ci95[0] && after.ci95[1] >= before.ci95[0]) return "변화 없음(구간 겹침)";
  return (after.ci95[0] > before.ci95[1]) === higher ? "개선" : "회귀";
}
