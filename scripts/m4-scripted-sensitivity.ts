/** 페르소나가 발화 의미를 읽는지 보는 음성 길이 고정 대조 실험. */
import { writeFileSync } from "node:fs";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { runCall } from "../src/runtime/call.ts";
import { SimTransport } from "../src/transport/sim.ts";
import { ScriptedPersona } from "../src/sim/persona.ts";
import { Rng } from "../src/sim/rng.ts";
class ScrambledTransport extends SimTransport {
  override speak(text: string, at: number) {
    // 문장 의미만 제거하고 문자 수·발화 시간·끼어들기 난수 소비는 보존한다.
    return super.speak(text.replace(/[\p{L}\p{N}]/gu, "가"), at);
  }
}
const rows: unknown[] = [];
for (const dir of listPackDirs("packs")) {
  const loaded = loadPack(dir); if (!loaded.ok) throw Error(dir);
  let calls = 0, changedUserTurns = 0, changedOutcomes = 0;
  for (const persona of loaded.value.personas) for (const fault of ["clean", "flaky"]) {
    const normal = await runCall(loaded.value, persona, fault, 1);
    const connectedAt = normal.events.find(e => e.type === "speech.start" && e.fixed)!.at;
    const transport = new ScrambledTransport(new ScriptedPersona(persona, new Rng(`1:${persona.id}`).fork("persona")), connectedAt + loaded.value.pack.policy.maxCallSec * 1000);
    const scrambled = await runCall(loaded.value, persona, fault, 1, { transport });
    const users = (c: typeof normal) => c.transcript.filter(t => t.role === "user").map(t => ({ text: t.text, startedAt: t.startedAt, endedAt: t.endedAt }));
    changedUserTurns += Number(JSON.stringify(users(normal)) !== JSON.stringify(users(scrambled)));
    changedOutcomes += Number(normal.outcome !== scrambled.outcome);
    calls++;
  }
  rows.push({ pack: loaded.value.pack.id, calls, changedUserTurns, changedOutcomes });
}
writeFileSync("docs/experiments/m4/scripted-sensitivity.json", JSON.stringify({ intervention: "송출 발화의 모든 문자·숫자를 가로 치환, 발화 길이 고정", seed: 1, faults: ["clean", "flaky"], rows }, null, 2) + "\n");
console.log(rows);
