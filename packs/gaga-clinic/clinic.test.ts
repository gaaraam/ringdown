import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { loadPack } from "../../src/pack/load.ts";
import { runCall } from "../../src/runtime/call.ts";
import { readScenario } from "../../src/soundcheck/io.ts";
import { durationMs, postGuard } from "../../src/guard/index.ts";

const loaded = loadPack("packs/gaga-clinic");
if (!loaded.ok) throw Error(JSON.stringify(loaded.issues));
const pack = loaded.value;
const persona = pack.personas[0]!;
const verified = ["네, 본인입니다.", "방문 접수"];
async function conversation(replies: string[], fault = "clean") {
  const remaining = [...replies];
  return runCall(pack, persona, fault, 7, { customerSource: {
    spec: { speechRate: 7 },
    reply: () => { const text = remaining.shift(); if (text === undefined) throw Error("Unexpected extra prompt"); return text; },
    responseDelay: () => 300,
    interruption: () => undefined,
  } });
}
const tools = (c: Awaited<ReturnType<typeof conversation>>) => c.events.filter(e => e.type === "tool.call").map(e => (e.call as { tool: string }).tool);

describe("clinic pack safety and business paths", () => {
  it.each([["아니요"], ["네", "네"], ["네", "온라인"], ["네", "방문 접수 아니에요"], ["네", "음", "음"]])("no appointment disclosure or writes before both checks: %j", async (...replies) => {
    const c = await conversation(replies);
    expect(tools(c)).not.toContain("clinic.nextAppointment");
    expect(c.system.writes).toHaveLength(0);
    expect(c.transcript.filter(t => t.role === "agent").map(t => t.text).join(" ")).not.toContain("11월 19일");
  });
  it("keep leaves business state unchanged and does not claim goal success", async () => {
    const c = await conversation([...verified, "그대로"]);
    expect(c.outcome).toBe("declined");
    expect(c.system.writes).toHaveLength(0);
    expect(c.system.get("appointments", persona.targetId)?.resolution).toBeNull();
    expect(tools(c)).toEqual(["clinic.identity", "clinic.nextAppointment"]);
  });
  for (const [choice, time] of [["오전", "2026-11-20T10:00:00+09:00"], ["오후", "2026-11-20T14:00:00+09:00"]]) {
    it(`reschedules only the offered ${choice} slot after consent`, async () => {
      const c = await conversation([...verified, "시간 변경", choice!, "네, 동의합니다"]);
      expect(c.outcome).toBe("success");
      expect(c.system.get("appointments", persona.targetId)).toMatchObject({ resolution: "rescheduled", appointmentTime: time });
      expect(c.system.writes).toHaveLength(1);
      expect(c.system.writes[0]?.idempotencyKey).toBeTruthy();
      const query = c.events.findIndex(e => e.type === "tool.call" && (e.call as {tool:string}).tool === "clinic.nextAppointment");
      const check = c.events.findIndex(e => e.type === "turn.start" && e.stage === "verify-channel");
      expect(query).toBeGreaterThan(check);
      expect(c.metrics.outputGuardHits).toBe(0);
    });
  }
  it.each(["clean", "lost-ack"])("cancel has one applied write with %s", async fault => {
    const c = await conversation([...verified, "예약 취소", "네, 동의합니다"], fault);
    expect(c.outcome).toBe("success");
    expect(c.system.get("appointments", persona.targetId)?.resolution).toBe("cancelled");
    expect(c.system.writes).toHaveLength(1);
    expect(c.system.writes[0]?.idempotencyKey).toBeTruthy();
    expect(c.system.doubleWrites()).toHaveLength(0);
    if (fault === "lost-ack") expect(c.pending).toContainEqual({kind:"confirmation", tool:"clinic.cancel"});
  });
  it("lost reschedule acknowledgement reuses the key and leaves confirmation work", async () => {
    const changed = await conversation([...verified, "시간 변경", "오후", "네"], "lost-ack");
    expect(changed.system.writes).toHaveLength(1);
    const attempts = changed.events.filter(e => e.attempt && (e.attempt as {idempotencyKey?:string}).idempotencyKey);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map(e => (e.attempt as {idempotencyKey:string}).idempotencyKey)).size).toBe(1);
    expect(changed.pending).toContainEqual({kind:"confirmation", tool:"clinic.reschedule"});
  });
  it.each([["예약 취소", "아니요"], ["시간 변경", "오전", "아니요"], ["시간 변경", "저녁", "저녁"]])("decline or unoffered time cannot write: %j", async (...choices) => {
    const c = await conversation([...verified, ...choices]);
    expect(c.system.writes).toHaveLength(0);
    expect(c.outcome).not.toBe("success");
  });
  it("unavailable lookup registers callback without revealing appointment", async () => {
    const c = await conversation([], "down");
    expect(c.outcome).toBe("callback_scheduled");
    expect(c.pending).toContainEqual({kind:"callback"});
    expect(c.system.writes).toHaveLength(0);
  });
  it.each([
    ["약을 먹어도 되나요?"], [...verified, "아파요"],
    [...verified, "시간 변경", "검사 전 금식인가요?"],
    [...verified, "예약 취소", "열이 나는데 괜찮을까요?"],
  ])("medical question is handed off without a write: %j", async (...replies) => {
    const c = await conversation(replies);
    expect(c.outcome).toBe("handoff");
    expect(c.pending).toContainEqual({kind:"handoff", target:"queue:clinic-care"});
    expect(c.system.writes).toHaveLength(0);
    expect(c.metrics.policyViolations).toBe(0);
  });
  it("administrative KB answer returns to appointment choice", async () => {
    const c = await conversation([...verified, "어떻게 변경하나요?", "그대로"]);
    expect(tools(c)).toContain("kb.search");
    expect(c.system.writes).toHaveLength(0);
    expect(c.metrics.outputGuardHits).toBe(0);
  });
  it("opt-out at confirmation prevents the write", async () => {
    const c = await conversation([...verified, "예약 취소", "전화하지 마세요"]);
    expect(c.outcome).toBe("opted_out");
    expect(c.system.writes).toHaveLength(0);
  });
  it("forbidden advice is removed and every actual spoken turn fits the budget", async () => {
    for (const text of ["약을 중단하세요.", "이 약을 복용하세요.", "부작용 없습니다."]) {
      const guarded = postGuard(text, [], pack.pack.policy.forbidden, 12);
      expect(guarded.hits).toContain("forbidden");
      expect(guarded.text).not.toBe(text);
    }
    for (const replies of [[...verified, "시간 변경", "오전", "네"], [...verified, "예약 취소", "네"]]) {
      const c = await conversation(replies);
      for (const turn of c.transcript.filter(t => t.role === "agent")) expect(durationMs(turn.text)).toBeLessThanOrEqual(12000);
    }
  });
  it("CLI and pack-local baseline copies are identical", () => {
    expect(readFileSync("baselines/gaga-clinic.json", "utf8")).toBe(readFileSync("packs/gaga-clinic/baselines/gaga-clinic.json", "utf8"));
  });
  for (const file of readdirSync("packs/gaga-clinic/scenarios/regressions").filter(f => f.endsWith(".yaml"))) {
    it(`replays ${file}`, async () => {
      const s = readScenario(`packs/gaga-clinic/scenarios/regressions/${file}`);
      const p = pack.personas.find(p => p.id === s.persona)!;
      const c = await runCall(pack, p, s.fault, s.seed);
      expect(c.outcome).toBe(s.expected);
      expect(c.metrics.policyViolations).toBe(0);
      expect(c.system.doubleWrites()).toHaveLength(0);
    });
  }
});
