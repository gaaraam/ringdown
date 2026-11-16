import { performance } from "node:perf_hooks";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { resolveModels } from "../src/config/models.ts";
import { FAULT_IDS } from "../src/jacks/faults.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
const start=performance.now();
for(const dir of listPackDirs("packs")) {
  const loaded=loadPack(dir); if(!loaded.ok) throw Error(JSON.stringify(loaded.issues));
  const {report}=await runMatrix(loaded.value,{faults:FAULT_IDS,seeds:[1],models:resolveModels({env:{}}),gitSha:"smoke",runId:"smoke"});
  if(!report.pass) throw Error(`${report.pack}: 게이트 실패 ${JSON.stringify(report.gates.filter(g=>!g.pass))}`);
  console.log(`${report.pack}: ${report.matrix.calls}통화 통과`);
}
const elapsed=performance.now()-start;
console.log(`Soundcheck smoke ${elapsed.toFixed(0)}ms`);
if(elapsed>10000) throw Error("Soundcheck smoke 10초 초과");
