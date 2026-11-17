/**
 * 무인 야간 모델 비교. 의미 없는 실행을 끝까지 돌지 않도록 구간마다 중단 규칙을 둔다.
 *
 *   tsx scripts/m4-overnight.ts <출력 디렉터리> [--deadline HH:MM] [--plan pilot|full]
 *
 * 구간(segment) = 모델 하나 × Pack 하나. 통화마다 progress.jsonl에 한 줄을 남기므로
 * 중단돼도 그때까지의 결과는 남는다. 규칙과 근거는 docs/experiments/m4/overnight-plan.md.
 */
import "../src/llm/providers.ts";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveModels } from "../src/config/models.ts";
import { loadPack, listPackDirs, type LoadedPack } from "../src/pack/load.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
import { writeRun } from "../src/soundcheck/io.ts";
import { registerProvider } from "../src/llm/types.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import type { CallResult } from "../src/runtime/call.ts";

const args = process.argv.slice(2);
const out = args[0];
if (!out) throw Error("사용법: tsx scripts/m4-overnight.ts <출력 디렉터리> [--deadline HH:MM] [--plan pilot|full]");
const opt = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1]! : fallback; };
const plan = opt("--plan", "full");
const packFilter = opt("--packs", "");
const [dh, dm] = opt("--deadline", "07:30").split(":").map(Number);
const deadline = (() => { const d = new Date(); d.setHours(dh!, dm!, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); })();

// ── 중단 규칙 ──────────────────────────────────────────────
const RULES = {
  warmupCalls: 20,          // 이 수만큼 통화한 뒤부터 판정한다
  minRuleSuccessForZero: 4, // 같은 통화들에서 규칙 두뇌가 이만큼 성공했는데 LLM이 0건이면 모델이 동작하지 않는 것으로 본다
  maxLongCallRate: 0.5,     // 시간 상한 도달률이 이 이상이면 루프로 본다
  maxRejectionsPerTurn: 1,  // 턴당 런타임 거부가 이 이상이면 거부 반복으로 본다
  maxFallbackRate: 0.5,     // 턴의 절반 이상이 규칙 두뇌 대체면 LLM을 재는 게 아니다
  maxRequestErrorRate: 0.2, // 최근 50요청 중 오류율. 넘으면 인프라 문제로 전체 중단
  segmentBudgetMin: 150,    // 구간 하나가 이보다 오래 걸리면 중단
  reserveMinForSegment: 40, // 마감까지 이보다 적게 남으면 새 구간을 시작하지 않는다
};

class Abort extends Error { constructor(readonly scope: "segment" | "model" | "all", reason: string) { super(reason); } }

mkdirSync(out, { recursive: true });
const log = (msg: string) => { const line = `[${new Date().toLocaleTimeString("ko-KR", { hour12: false })}] ${msg}`; console.log(line); appendFileSync(`${out}/run.log`, line + "\n"); };
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

// 요청 단위 계측: 최근 50개 오류율로 인프라 장애를 감지한다
let segmentDir = out;
const recent: boolean[] = [];
let infraFailure: string | undefined;
registerProvider("ollama", spec => {
  const client = new OllamaClient(spec);
  return { label: client.label, async chat(req) {
    const start = performance.now();
    try {
      const response = await client.chat(req);
      appendFileSync(`${segmentDir}/requests.jsonl`, JSON.stringify({ latencyMs: Math.round(response.latencyMs), usage: response.usage, ok: true }) + "\n");
      recent.push(true); return response;
    } catch (e) {
      appendFileSync(`${segmentDir}/requests.jsonl`, JSON.stringify({ latencyMs: Math.round(performance.now() - start), ok: false, error: String(e) }) + "\n");
      recent.push(false); throw e;
    } finally {
      if (recent.length > 50) recent.shift();
      const errs = recent.filter(ok => !ok).length;
      // 공급자 안에서 던지면 LlmBrain이 대체 응답으로 삼키므로, 표시만 하고 통화 경계에서 중단한다
      if (recent.length >= 20 && errs / recent.length > RULES.maxRequestErrorRate) infraFailure = `LLM 요청 오류율 ${errs}/${recent.length}`;
    }
  } };
});

const packs: LoadedPack[] = listPackDirs("packs").map(dir => { const r = loadPack(dir); if (!r.ok) throw Error(JSON.stringify(r.issues)); return r.value; });
if (packFilter) packs.splice(0, packs.length, ...packs.filter(p => packFilter.split(",").includes(p.pack.id)));
const byId = (id: string) => packs.find(p => p.pack.id === id)!;
const subset = (p: LoadedPack, n: number): LoadedPack => ({ ...p, personas: p.personas.slice(0, n) });

interface Segment { model: string; pack: LoadedPack; faults: string[]; seeds: number[]; label: string }
const LLMS = opt("--models", "ollama/exaone3.5:7.8b,ollama/qwen3:8b,ollama/gemma3:12b").split(",");
const segments: Segment[] = plan === "pilot"
  ? [{ model: LLMS[0]!, pack: subset(byId("gaga-seller"), 6), faults: ["clean"], seeds: [1], label: "pilot" }]
  : [
      ...packs.map(pack => ({ model: "rule", pack, faults: ["clean", "flaky"], seeds: [1], label: "main" })),
      ...LLMS.flatMap(model => packs.map(pack => ({ model, pack, faults: ["clean", "flaky"], seeds: [1], label: "main" }))),
    ];

const deadModels = new Set<string>();
/** 한 번이라도 목표를 달성한 모델. 이후 0건은 그 Pack의 문제로 보고 구간만 중단한다. */
const provenModels = new Set<string>();
/** 규칙 두뇌의 통화별 결과. LLM 구간의 조기 판정 기준으로 쓴다. */
const ruleSuccess = new Map<string, boolean>();
const key = (pack: string, persona: string, fault: string) => `${pack}|${persona}|${fault}`;
const summary: Record<string, unknown>[] = [];
const writeSummary = () => writeFileSync(`${out}/summary.json`, JSON.stringify({ gitSha, plan, rules: RULES, deadline: new Date(deadline).toISOString(), segments: summary }, null, 2) + "\n");

function judge(rows: CallResult[], keys: string[], startedAt: number): Abort | undefined {
  if (infraFailure) return new Abort("all", infraFailure);
  const n = rows.length;
  const turns = rows.reduce((t, r) => t + r.transcript.filter(x => x.role === "user").length, 0) || 1;
  const fallbacks = rows.reduce((t, r) => t + r.events.filter(e => e.type === "brain.fallback").length, 0);
  if ((performance.now() - startedAt) / 60000 > RULES.segmentBudgetMin) return new Abort("segment", `구간 시간 예산 ${RULES.segmentBudgetMin}분 초과`);
  if (Date.now() > deadline) return new Abort("all", "마감 시각 도달");
  if (n < RULES.warmupCalls) return undefined;
  const success = rows.filter(r => r.outcome === "success").length;
  const longRate = rows.filter(r => r.metrics.longCall).length / n;
  const rejPerTurn = rows.reduce((t, r) => t + r.metrics.controlRejections, 0) / turns;
  const ruleHits = keys.filter(k => ruleSuccess.get(k)).length;
  if (success === 0 && ruleHits >= RULES.minRuleSuccessForZero) return new Abort("model", `처음 ${n}통화 목표 달성 0건 (같은 통화에서 규칙 두뇌 ${ruleHits}건)`);
  if (longRate >= RULES.maxLongCallRate) return new Abort("model", `시간 상한 도달률 ${(longRate * 100).toFixed(0)}%`);
  if (rejPerTurn >= RULES.maxRejectionsPerTurn) return new Abort("model", `턴당 런타임 거부 ${rejPerTurn.toFixed(2)}회`);
  if (fallbacks / turns >= RULES.maxFallbackRate) return new Abort("model", `규칙 두뇌 대체 ${(fallbacks / turns * 100).toFixed(0)}%`);
  return undefined;
}

log(`시작: plan=${plan}, 구간 ${segments.length}개, 마감 ${new Date(deadline).toLocaleString("ko-KR")}`);
for (const seg of segments) {
  const name = `${seg.label}-${seg.model.replace(/[/:]/g, "_")}-${seg.pack.pack.id}`;
  if (deadModels.has(seg.model)) { summary.push({ name, status: "skipped", reason: "같은 모델의 이전 구간에서 중단" }); writeSummary(); continue; }
  const minutesLeft = (deadline - Date.now()) / 60000;
  if (seg.model !== "rule" && minutesLeft < RULES.reserveMinForSegment) { summary.push({ name, status: "skipped", reason: `마감까지 ${Math.round(minutesLeft)}분` }); writeSummary(); continue; }
  segmentDir = `${out}/${name}`;
  if (existsSync(`${segmentDir}/report/report.json`)) { log(`${name}: 이미 완료, 건너뜀`); continue; }
  mkdirSync(segmentDir, { recursive: true });
  const brain = seg.model === "rule" ? "rule" : "llm";
  const models = resolveModels({ configPath: "docs/experiments/m4/config.yaml", env: {}, cli: brain === "llm" ? { agent: seg.model } : {} });
  const rows: CallResult[] = [];
  const keys: string[] = [];
  const startedAt = performance.now();
  log(`${name}: 시작 (${seg.pack.personas.length}명 × ${seg.faults.join(",")})`);
  try {
    const result = await runMatrix(seg.pack, { brain, models, faults: seg.faults, seeds: seg.seeds, gitSha, runId: name,
      onCall: ({ result: r, persona, fault, done, total }) => {
        rows.push(r); keys.push(key(seg.pack.pack.id, persona, fault));
        if (brain === "rule") ruleSuccess.set(key(seg.pack.pack.id, persona, fault), r.outcome === "success");
        appendFileSync(`${segmentDir}/progress.jsonl`, JSON.stringify({ done, total, persona, fault, outcome: r.outcome,
          userTurns: r.transcript.filter(x => x.role === "user").length, controlRejections: r.metrics.controlRejections,
          longCall: r.metrics.longCall, fallbacks: r.events.filter(e => e.type === "brain.fallback").length }) + "\n");
        if (done % 10 === 0) log(`${name}: ${done}/${total}, 성공 ${rows.filter(x => x.outcome === "success").length}`);
        if (brain === "llm") { const verdict = judge(rows, keys, startedAt); if (verdict) throw verdict; }
      } });
    writeRun(`${segmentDir}/report`, result);
    const m = result.report.metrics;
    if ((m.goal_rate.value ?? 0) > 0) provenModels.add(seg.model);
    summary.push({ name, status: "complete", calls: result.report.matrix.calls, goal: m.goal_rate.value, goalCi: m.goal_rate.ci95,
      acceptable: m.acceptable_rate.value, longCall: m.long_call_rate.value, minutes: Math.round((performance.now() - startedAt) / 60000) });
    log(`${name}: 완료, goal=${m.goal_rate.value}`);
    if (seg.label === "pilot") {
      const turns = rows.reduce((t, r) => t + r.transcript.filter(x => x.role === "user").length, 0) || 1;
      const rej = rows.reduce((t, r) => t + r.metrics.controlRejections, 0) / turns;
      const pass = (m.goal_rate.value ?? 0) > 0 && rej < RULES.maxRejectionsPerTurn && (m.long_call_rate.value ?? 1) < 0.3;
      summary[summary.length - 1]!.pilot = { pass, rejectionsPerTurn: Number(rej.toFixed(2)) };
      log(`파일럿 ${pass ? "통과" : "실패"}: 성공 ${m.goal_rate.value}, 턴당 거부 ${rej.toFixed(2)}, 시간 상한 ${m.long_call_rate.value}`);
    }
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    summary.push({ name, status: "aborted", scope: e.scope, reason: e.message, callsDone: rows.length,
      success: rows.filter(r => r.outcome === "success").length, minutes: Math.round((performance.now() - startedAt) / 60000) });
    log(`${name}: 중단(${e.scope}) ${e.message}`);
    if (e.scope === "model" && !provenModels.has(seg.model)) deadModels.add(seg.model);
    else if (e.scope === "model") log(`${name}: ${seg.model}은 다른 Pack에서 성공했으므로 이 구간만 중단`);
    if (e.scope === "all") { writeSummary(); break; }
  }
  writeSummary();
}
writeSummary();
log("끝");
