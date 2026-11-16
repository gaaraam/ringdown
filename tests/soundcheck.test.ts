import { it, expect } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { resolveModels } from "../src/config/models.ts";
import { rate, p95, metrics } from "../src/soundcheck/metrics.ts";
import { compare, gates, Report } from "../src/soundcheck/report.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
import { pin, readScenario, writeRun } from "../src/soundcheck/io.ts";
import { runCall, type CallResult } from "../src/runtime/call.ts";
const packs=listPackDirs("packs").map(dir=>{ const p=loadPack(dir); if(!p.ok) throw Error(JSON.stringify(p.issues)); return p.value; });
const input={faults:["clean","slow","flaky","down","lost-ack"],seeds:[1],models:resolveModels({env:{}}),gitSha:"test",runId:"first"};
function fixture(outcome: CallResult["outcome"], failed=false): Pick<CallResult, "outcome" | "events" | "transcript" | "metrics"> {
  return {outcome,transcript:[],events: failed ? [{type:"tool.result",at:0,latency:{brain:0,tool:0,tts:0},attempt:{result:{status:"error"}}}] : [],metrics:{longCall:false,deadAir:0,policyViolations:0,controlRejections:0,outputGuardHits:0}};
}
it("Wilson 알려진 값과 관측 없음",()=>{
  expect(rate(5,10).ci95![0]).toBeCloseTo(.23659309,7);
  expect(rate(5,10).ci95![1]).toBeCloseTo(.76340691,7);
  expect(rate(0,10).ci95![1]).toBeCloseTo(.2775328,7);
  expect(rate(10,10).ci95![0]).toBeCloseTo(.7224672,7);
  expect(rate(0,0)).toEqual({value:null,ci95:null,n:0});
});
it("p95 최근접 순위와 빈 표본",()=>{
  expect(p95(Array.from({length:20},(_,i)=>i+1))).toEqual({value:19,ci95:null,n:20});
  expect(p95([]).value).toBeNull();
});
it("실제 실패 시도만 장애 분모, 재시도 성공도 포함",()=>{
  const calls=[fixture("success",true),fixture("failed",true),fixture("declined"),fixture("success")];
  const m=metrics(calls,["declined"]);
  expect(m.goal_rate).toEqual(rate(2,4)); expect(m.acceptable_rate).toEqual(rate(3,4));
  expect(m.degraded_survival).toEqual(rate(1,2));
  expect(metrics([fixture("success")],[]).degraded_survival.n).toBe(0);
});
it("고지 제외·filler 포함 끼어들기, 지연과 감사 합계",()=>{
  const c=fixture("success");
  c.events.push({type:"speech.start",at:0,fixed:true,latency:{brain:0,tool:0,tts:0}},{type:"brain.fallback",at:300,latency:{brain:0,tool:0,tts:0}});
  c.transcript=[{role:"agent",seq:0,text:"고지",heard:"고",interrupted:true,startedAt:0,endedAt:100},{role:"user",seq:1,text:"네",startedAt:100,endedAt:200},{role:"agent",seq:2,text:"대기",heard:"대",interrupted:true,startedAt:500,endedAt:600},{role:"agent",seq:3,text:"결과",heard:"결과",interrupted:false,startedAt:900,endedAt:1000}];
  c.metrics.longCall=true;c.metrics.deadAir=2;c.metrics.policyViolations=3;
  const m=metrics([c],[]);
  expect(m.barge_in_rate).toEqual(rate(1,2));expect(m.turn_latency_p95.value).toBe(300);
  expect(m.long_call_rate.value).toBe(1);expect(m.dead_air_incidents.value).toBe(2);expect(m.policy_violations.value).toBe(3);expect(m.brain_fallbacks.value).toBe(1);
});
it("게이트 모든 연산과 관측 없음",()=>{
  for(const [expr,pass] of [[">= 0.5",true],["<= 0.5",true],["== 0.5",true],["> 0.5",false],["< 0.5",false]] as const) expect(gates({goal_rate:expr},{goal_rate:rate(1,2)})[0]?.pass).toBe(pass);
  expect(gates({goal_rate:">= 0"},{goal_rate:rate(0,0)})[0]?.pass).toBe(false);
});
it("기준선 겹침·접점·방향·CI 없음",()=>{
  expect(compare(rate(5,10),rate(6,10),true)).toBe("변화 없음(구간 겹침)");
  expect(compare(rate(0,100),rate(100,100),true)).toBe("개선");
  expect(compare(rate(0,100),rate(100,100),false)).toBe("회귀");
  expect(compare({value:.2,ci95:[.1,.3],n:10},{value:.4,ci95:[.3,.5],n:10},true)).toContain("구간 겹침");
  expect(compare(p95([1]),p95([2]),false)).toContain("판정 불가");
});
for(const pack of packs) it(`${pack.pack.id}: 30명·보고서 계약·결정론·독립 상태`,async()=>{
  expect(pack.personas).toHaveLength(30);
  const a=await runMatrix(pack,input), b=await runMatrix(pack,{...input,runId:"second"});
  expect(Report.safeParse(a.report).success).toBe(true);
  expect({...a.report,runId:"same"}).toEqual({...b.report,runId:"same"});expect(a.traces).toEqual(b.traces);
  expect(a.report.matrix.calls).toBe(150);
  expect(pack.mock!.collections[pack.pack.goal.success.collection]![pack.personas[0]!.targetId]![pack.pack.goal.success.field]).toBeNull();
});
it("pin 출력과 모든 고정 시나리오 재생",async()=>{
  const temp=mkdtempSync(path.join(tmpdir(),"ringdown-pin-"));
  try {
    const result=await runMatrix(packs[0]!,{...input,faults:["down"]});
    writeRun(path.join(temp,"run"),result);
    const file=pin(path.join(temp,"run"),result.report.calls[0]!.callId,path.join(temp,"pinned"));
    const s=readScenario(file); const c=await runCall(packs[0]!,packs[0]!.personas.find(p=>p.id===s.persona)!,s.fault,s.seed);
    expect(c.outcome).toBe(s.expected);
    expect(()=>pin(path.join(temp,"run"),"../../bad",temp)).toThrow();
  } finally {rmSync(temp,{recursive:true,force:true});}
  for(const file of readdirSync("scenarios/regressions").filter(f=>f.endsWith(".yaml"))) {
    const s=readScenario(path.join("scenarios/regressions",file));const p=loadPack(s.pack);if(!p.ok) throw Error(JSON.stringify(p.issues));
    const persona=p.value.personas.find(p=>p.id===s.persona);expect(persona).toBeDefined();
    expect((await runCall(p.value,persona!,s.fault,s.seed)).outcome).toBe(s.expected);
  }
});
it("CLI 실제 게이트 통과/실패 종료 코드",()=>{
  const temp=mkdtempSync(path.join(tmpdir(),"ringdown-cli-"));
  try {
    const ok=spawnSync(process.execPath,["--import","tsx","src/cli.ts","soundcheck","--pack",packs[0]!.dir,"--faults","clean","--seeds","1","--out",temp],{encoding:"utf8"});
    expect(ok.status,ok.stderr).toBe(0);
    const fail=spawnSync(process.execPath,["--import","tsx","src/cli.ts","soundcheck","--pack",packs[0]!.dir,"--faults","down","--seeds","1","--out",temp],{encoding:"utf8"});
    expect(fail.status,fail.stderr).toBe(1);
    const reports=readdirSync(temp).map(dir=>Report.parse(JSON.parse(readFileSync(path.join(temp,dir,"report.json"),"utf8"))));
    expect(reports.some(r=>!r.pass && r.gates.some(g=>g.metric==="goal_rate"&&!g.pass))).toBe(true);
  } finally {rmSync(temp,{recursive:true,force:true});}
});
it("Brain 대체 이벤트를 런타임에서 소비해 한 번씩 계수",async()=>{
  let pending:string[]=[];
  const brain={id:"fallback-test",takeFallbacks:()=>{const taken=pending;pending=[];return taken;},plan:async()=>{pending.push("스키마 오류");return {say:"감사합니다.",end:"declined" as const};},compose:async()=>"감사합니다."};
  const c=await runCall(packs[0]!,packs[0]!.personas[0]!,"clean",1,{brain});
  expect(metrics([c],[]).brain_fallbacks.value).toBe(1);
});
it("보고서 계약은 빠진 지표·알 수 없는 키·잘못된 표본 수를 거부",async()=>{
  const {report}=await runMatrix(packs[0]!,{...input,faults:["down"]});
  expect(Report.safeParse({...report,unexpected:true}).success).toBe(false);
  expect(Report.safeParse({...report,metrics:{goal_rate:rate(0,30)}}).success).toBe(false);
  expect(Report.safeParse({...report,matrix:{...report.matrix,calls:-1}}).success).toBe(false);
});
it("빈 매트릭스·중복 시드·장애 프로파일 거부",async()=>{
  for(const change of [{seeds:[]},{seeds:[1,1]},{faults:[]},{faults:["missing"]},{faults:["clean","clean"]}]) await expect(runMatrix(packs[0]!,{...input,...change})).rejects.toThrow();
});

it("공통 난수: 이름만 다른 같은 장애 프로파일이면 모든 페르소나의 발화가 같다", async () => {
  const { FAULT_PROFILES } = await import("../src/jacks/faults.ts");
  const loaded = loadPack("packs/gaga-seller");
  if (!loaded.ok) throw new Error("pack");
  // 동작은 clean과 같고 이름만 다르다. 고객 행동이 장애 이름에 따라 바뀌면 장애별 비교가 표본 차이를 재게 된다
  FAULT_PROFILES["clean-twin"] = { ...FAULT_PROFILES.clean!, id: "clean-twin" };
  try {
    const texts = async (fault: string) => {
      const out: string[][] = [];
      for (const persona of loaded.value.personas) for (const seed of [1, 2, 3]) {
        out.push((await runCall(loaded.value, persona, fault, seed)).transcript.filter((t) => t.role === "user").map((t) => t.text));
      }
      return out;
    };
    expect(await texts("clean-twin")).toEqual(await texts("clean"));
  } finally {
    delete FAULT_PROFILES["clean-twin"];
  }
});

it("장애가 심할수록 성공률이 높아지지 않는다 (clean ≥ flaky ≥ down)", async () => {
  const { loadPack } = await import("../src/pack/load.ts");
  const { runMatrix } = await import("../src/soundcheck/runner.ts");
  const { resolveModels } = await import("../src/config/models.ts");
  const loaded = loadPack("packs/gaga-seller");
  if (!loaded.ok) throw new Error("pack");
  const { report } = await runMatrix(loaded.value, { faults: ["clean", "flaky", "down"], seeds: [1, 2, 3], runId: "t", gitSha: "t", models: resolveModels({ env: {} }) });
  const g = (f: "clean" | "flaky" | "down") => report.breakdowns.fault[f]!.goal_rate.value!;
  expect(g("clean")).toBeGreaterThanOrEqual(g("flaky"));
  expect(g("flaky")).toBeGreaterThanOrEqual(g("down"));
});
