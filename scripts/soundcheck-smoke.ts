import { performance } from "node:perf_hooks";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { resolveModels } from "../src/config/models.ts";
import { FAULT_IDS } from "../src/jacks/faults.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
const start=performance.now();
for(const dir of listPackDirs("packs")) {
  const loaded=loadPack(dir); if(!loaded.ok) throw Error(JSON.stringify(loaded.issues));
  const {report}=await runMatrix(loaded.value,{faults:FAULT_IDS,seeds:[1],models:resolveModels({env:{}}),gitSha:"smoke",runId:"smoke"});
  // smoke는 시드 1개(약 150통화)라 비율 지표의 95% 구간 폭이 ±0.08에 이른다. 비율 게이트를 여기서 걸면
  // 코드가 아니라 표본 운으로 CI가 흔들린다. 표본 크기와 무관한 무관용 게이트(== 0)만 검사하고,
  // 비율 게이트는 전체 soundcheck(--seeds 3 이상)에서 판정한다.
  const hard=report.gates.filter(g=>g.op==="=="&&g.threshold===0);
  if(hard.some(g=>!g.pass)) throw Error(`${report.pack}: 무관용 게이트 실패 ${JSON.stringify(hard.filter(g=>!g.pass))}`);
  console.log(`${report.pack}: ${report.matrix.calls}통화 통과`);
}
const elapsed=performance.now()-start;
console.log(`Soundcheck smoke ${elapsed.toFixed(0)}ms`);
if(elapsed>10000) throw Error("Soundcheck smoke 10초 초과");
