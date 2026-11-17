import "../llm/providers.ts";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadPack } from "../pack/load.ts";
import { resolveModels, parseCliOverrides } from "../config/models.ts";
import { FAULT_IDS } from "../jacks/faults.ts";
import { runMatrix } from "./runner.ts";
import { baseline, Baseline, compare } from "./report.ts";
import { writeRun } from "./io.ts";

export async function soundcheck(args: string[]): Promise<number> {
  const {values} = parseArgs({args, options:{ pack:{type:"string",multiple:true}, faults:{type:"string",default:"all"}, seeds:{type:"string",default:"3"}, out:{type:"string",default:"runs"}, baseline:{type:"boolean"}, "update-baseline":{type:"boolean"}, brain:{type:"string",default:"rule"}, config:{type:"string",default:"ringdown.config.yaml"}, model:{type:"string",multiple:true} }});
  if (!values.pack?.length || new Set(values.pack).size !== values.pack.length) throw Error("중복 없는 --pack이 필요합니다");
  if (values.brain !== "rule" && values.brain !== "llm") throw Error("--brain은 rule 또는 llm입니다");
  if (values.brain === "llm" && (values.baseline || values["update-baseline"])) throw Error("rule 기준선 비교·갱신은 rule 모드에서만 가능합니다");
  const count=Number(values.seeds);
  if (!Number.isSafeInteger(count) || count < 1) throw Error("--seeds는 양의 정수여야 합니다");
  const seeds=Array.from({length:count},(_,i)=>i+1);
  const models=resolveModels({configPath:values.config,cli:parseCliOverrides(values.model??[])});
  const gitSha=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
  mkdirSync(values.out!,{recursive:true}); let passed=true;
  for (const dir of values.pack) {
    const loaded=loadPack(dir); if (!loaded.ok) throw Error(JSON.stringify(loaded.issues));
    const runId=`${new Date().toISOString().replace(/[:.]/g,"-")}-${loaded.value.pack.id}-${randomUUID().slice(0,8)}`;
    const result=await runMatrix(loaded.value,{faults:values.faults === "all" ? FAULT_IDS : values.faults!.split(","),seeds,models,gitSha,runId,brain:values.brain});
    const file=path.join("baselines",`${loaded.value.pack.id}.json`); let comparison="";
    if (values.baseline) {
      const old=Baseline.parse(JSON.parse(readFileSync(file,"utf8")));
      if (old.pack !== result.report.pack || JSON.stringify(old.matrix)!==JSON.stringify(result.report.matrix) || JSON.stringify(old.seeds)!==JSON.stringify(seeds)) throw Error("기준선 Pack 버전·매트릭스·시드가 다릅니다");
      comparison="\n## 기준선 비교\n\n"+Object.entries(result.report.metrics).map(([key,value])=>`- ${key}: ${compare(old.metrics[key as keyof typeof old.metrics],value,["goal_rate","acceptable_rate","degraded_survival"].includes(key))}`).join("\n")+"\n";
    }
    writeRun(path.join(values.out!,runId),result,comparison);
    if(values["update-baseline"]) { mkdirSync("baselines",{recursive:true}); writeFileSync(file,JSON.stringify(baseline(result.report),null,2)+"\n"); }
    console.log(`${result.report.pack}: ${result.report.pass ? "통과" : "실패"} · ${result.report.matrix.calls}통화 · ${path.join(values.out!,runId,"report.md")}`);
    passed &&= result.report.pass;
  }
  return passed ? 0 : 1;
}
