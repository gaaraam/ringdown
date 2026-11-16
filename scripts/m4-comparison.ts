/** 실제 모델 비교 재현용. 순차 실행으로 모델 간 GPU 경합을 피한다. */
import "../src/llm/providers.ts";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveModels } from "../src/config/models.ts";
import { loadPack, listPackDirs } from "../src/pack/load.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
import { writeRun } from "../src/soundcheck/io.ts";
import { registerProvider } from "../src/llm/types.ts";
import { OllamaClient } from "../src/llm/ollama.ts";

const [brainSpec, out] = process.argv.slice(2);
if (!brainSpec || !out) throw Error("사용법: tsx scripts/m4-comparison.ts rule|공급자/모델 출력디렉터리");
const brain = brainSpec === "rule" ? "rule" : "llm";
const models = resolveModels({ configPath: "docs/experiments/m4/config.yaml", env: {}, cli: brain === "llm" ? { agent: brainSpec } : {} });
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (existsSync(out)) throw Error(`새 출력 디렉터리가 필요합니다: ${out}`);
mkdirSync(out, { recursive: true });
let requests = 0;
registerProvider("ollama", spec => {
  const client = new OllamaClient(spec);
  return { label: client.label, async chat(req) {
    const start = performance.now();
    try {
      const response = await client.chat(req);
      appendFileSync(`${out}/requests.jsonl`, JSON.stringify({ model: client.label, latencyMs: response.latencyMs, usage: response.usage, ok: true }) + "\n");
      return response;
    } catch (e) {
      appendFileSync(`${out}/requests.jsonl`, JSON.stringify({ model: client.label, latencyMs: performance.now() - start, ok: false, error: String(e) }) + "\n");
      throw e;
    } finally { if (++requests % 10 === 0) console.log(`${brainSpec}: ${requests}개 추론 요청 완료`); }
  } };
});
for (const dir of listPackDirs("packs")) {
  const loaded = loadPack(dir); if (!loaded.ok) throw Error(JSON.stringify(loaded.issues));
  const startedAt = new Date().toISOString(), start = performance.now();
  const result = await runMatrix(loaded.value, { brain, models, faults: ["clean", "flaky"], seeds: [1], gitSha, runId: `${brainSpec}-${loaded.value.pack.id}-${startedAt}` });
  const wallMs = performance.now() - start;
  const destination = `${out}/${loaded.value.pack.id}`;
  writeRun(destination, result);
  writeFileSync(`${destination}/timing.json`, JSON.stringify({ startedAt, wallMs, requestsSoFar: requests }, null, 2) + "\n");
  console.log(`${brainSpec} ${loaded.value.pack.id}: ${result.report.matrix.calls}통화, ${Math.round(wallMs/1000)}초, goal=${result.report.metrics.goal_rate.value}`);
}
