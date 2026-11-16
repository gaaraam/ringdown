#!/usr/bin/env -S npx tsx
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { runCall } from "./runtime/call.ts";
import { parseArgs } from "node:util";
import { modelLabel, parseCliOverrides, resolveModels, ROLES } from "./config/models.ts";
import { listPackDirs, loadPack } from "./pack/load.ts";

const HELP = `ringdown <command> [options]

commands:
  validate [pack-dir...]   Pack 검증 (기본: packs/ 아래 전체)
  call --pack <dir> --persona <id> --faults <profile> --seed <n>
                           결정론적 단일 통화와 JSONL trace
  models                   역할별로 실제 사용될 모델과 그 출처 표시

options:
  --model <role>=<spec>    모델 교체 (여러 번 가능)  예) --model agent=ollama/qwen3:14b
  --config <path>          설정 파일 (기본: ringdown.config.yaml)
  --json                   기계가 읽을 출력
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pack: { type: "string" },
    persona: { type: "string" },
    faults: { type: "string", default: "clean" },
    seed: { type: "string", default: "1" },
    model: { type: "string", multiple: true, default: [] },
    config: { type: "string", default: "ringdown.config.yaml" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, ...args] = positionals;

function cmdValidate(): number {
  const dirs = args.length > 0 ? args : listPackDirs("packs");
  if (dirs.length === 0) {
    console.error("검증할 Pack이 없습니다 (packs/<org>/pack.yaml)");
    return 1;
  }
  let failed = 0;
  const report: unknown[] = [];
  for (const dir of dirs) {
    const res = loadPack(dir);
    const name = path.basename(dir);
    if (res.ok) {
      const p = res.value.pack;
      report.push({ pack: name, ok: true });
      if (!values.json) {
        console.log(
          `✓ ${name}@${p.version}  단계 ${p.stages.length} · 도구 ${Object.keys(p.tools).length} · ` +
            `지식 ${res.value.kb.length} · 페르소나 ${res.value.personas.length}`,
        );
      }
    } else {
      failed++;
      report.push({ pack: name, ok: false, issues: res.issues });
      if (!values.json) {
        console.log(`✗ ${name}  오류 ${res.issues.length}건`);
        for (const i of res.issues) console.log(`    [${i.code}] ${i.where}: ${i.message}`);
      }
    }
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  return failed > 0 ? 1 : 0;
}

function cmdModels(): number {
  const models = resolveModels({ configPath: values.config, cli: parseCliOverrides(values.model ?? []) });
  if (values.json) {
    console.log(JSON.stringify(models, null, 2));
    return 0;
  }
  for (const role of ROLES) {
    const m = models[role];
    console.log(`${role.padEnd(8)} ${modelLabel(m).padEnd(32)} ${(m.baseUrl ?? "-").padEnd(28)} (${m.source})`);
  }
  return 0;
}

async function cmdCall(): Promise<number> {
  if (!values.pack || !values.persona) throw new Error("--pack과 --persona가 필요합니다");
  const loaded = loadPack(values.pack);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  const persona = loaded.value.personas.find((p) => p.id === values.persona);
  if (!persona) throw new Error(`없는 페르소나: ${values.persona}`);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed)) throw new Error("seed는 안전한 정수여야 합니다");
  const result = await runCall(loaded.value, persona, values.faults!, seed);
  const runId = `${loaded.value.pack.id}-${result.callId}`;
  const dir = path.join("runs", runId, "calls");
  mkdirSync(dir, { recursive: true });
  const trace = path.join(dir, `${result.callId}.jsonl`);
  writeFileSync(trace, result.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  if (values.json) console.log(JSON.stringify({ callId: result.callId, outcome: result.outcome, metrics: result.metrics, trace }));
  else {
    console.log("시뮬레이션 기준 · Brain: rule");
    for (const turn of result.transcript) {
      const heard = turn.role === "agent" ? turn.heard : turn.text;
      console.log(`[${(turn.startedAt / 1000).toFixed(3)}s] ${turn.role === "agent" ? "상담" : "고객"}: ${heard}${turn.role === "agent" && turn.interrupted ? " [끼어들기]" : ""}`);
    }
    console.log(`결과: ${result.outcome} · trace: ${trace}`);
  }
  return 0;
}

async function main(): Promise<number> {
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case "call":
      return cmdCall();
    case "validate":
      return cmdValidate();
    case "models":
      return cmdModels();
    default:
      console.error(`알 수 없는 명령 '${cmd}'\n\n${HELP}`);
      return 1;
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`오류: ${(e as Error).message}`);
  process.exitCode = 1;
}
