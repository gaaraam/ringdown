import { describe, expect, it } from "vitest";
import { JackRuntime } from "../src/jacks/runtime.ts";
import { Rng } from "../src/sim/rng.ts";
import { Tool, OUTCOMES } from "../src/pack/schema.ts";
import type { Jack, JackRequest, JackResult, Brain, TurnContext } from "../src/core/types.ts";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { runCall } from "../src/runtime/call.ts";
import { FAULT_PROFILES } from "../src/jacks/faults.ts";
import { numbers, postGuard, checkPlan } from "../src/guard/index.ts";
import { Knowledge } from "../src/knowledge/bm25.ts";
import { classify, RuleBrain, render } from "../src/brain/rule.ts";
import { ScriptedPersona } from "../src/sim/persona.ts";
import { SimTransport } from "../src/transport/sim.ts";

const packs = listPackDirs("packs").map((dir) => { const res = loadPack(dir); if (!res.ok) throw Error(dir); return res.value; });
const spec = (kind: "read" | "write" = "read", max = 2) => Tool.parse({ jack: "test", op: "GET /records", kind, description: "테스트", timeoutMs: 1000, retry: { max, on: ["timeout", "5xx"] }, onFailure: "handoff" });
const req = { op: "GET /records", pathParams: {} };
const options = { callId: "test", seq: 1, now: 0 };
function fake(results: JackResult[]) {
  const requests: JackRequest[] = [];
  const jack: Jack = { id: "test", call: async (req) => { requests.push(req); return results[Math.min(requests.length - 1, results.length - 1)]!; } };
  return { requests, runtime: new JackRuntime(jack, new Rng(7)) };
}

describe("Jack 런타임", () => {
  it.each(["read", "write"] as const)("%s 무응답 데드라인", async (kind) => {
    const f = fake([{ status: "ok", data: {}, latencyMs: Infinity }]);
    const result = await f.runtime.call("test.run", spec(kind, 0), req, options);
    expect(result.result).toEqual({ status: "error", kind: kind === "write" ? "unknown_outcome" : "timeout", latencyMs: 1000 });
    expect(result.elapsedMs).toBe(1000);
  });
  it("데드라인과 같은 응답은 성공, 초과 응답만 timeout", async () => {
    for (const ms of [1000, 1001]) {
      const f = fake([{ status: "ok", data: {}, latencyMs: ms }]);
      expect((await f.runtime.call("test.run", spec("read", 0), req, options)).result.status).toBe(ms === 1000 ? "ok" : "error");
    }
  });
  it("재시도는 동일 멱등 키, 지수 백오프는 가상 시각에만 반영", async () => {
    const f = fake([{ status: "error", kind: "5xx", latencyMs: 100 }]);
    const ticks: number[] = [];
    const result = await f.runtime.call("test.run", spec("write"), req, { ...options, advance: async (to) => { ticks.push(to); } });
    expect(new Set(f.requests.map((r) => r.idempotencyKey))).toEqual(new Set(["test:test.run:1"]));
    expect(result.attempts).toHaveLength(3);
    expect(f.requests[1]!.now - 100).toBeGreaterThanOrEqual(50);
    expect(f.requests[1]!.now - 100).toBeLessThanOrEqual(150);
    expect(f.requests[2]!.now - f.requests[1]!.now - 100).toBeGreaterThanOrEqual(100);
    expect(result.elapsedMs).toBe(ticks.at(-1));
  });
  it("연속 실패 다섯 번 뒤 열림, 30초 뒤 탐침 성공 시 닫힘", async () => {
    const f = fake([...Array.from({ length: 5 }, (): JackResult => ({ status: "error", kind: "5xx", latencyMs: 10 })), { status: "ok", data: {}, latencyMs: 10 }]);
    for (let i = 0; i < 5; i++) await f.runtime.call("test.run", spec("read", 0), req, { ...options, now: i * 10 });
    expect((await f.runtime.call("test.run", spec(), req, { ...options, now: 30049 })).attempts).toHaveLength(0);
    expect((await f.runtime.call("test.run", spec(), req, { ...options, now: 30050 })).result.status).toBe("ok");
    expect((await f.runtime.call("test.run", spec(), req, { ...options, now: 30060 })).result.status).toBe("ok");
  });
  it("실패한 반열림 탐침은 다시 30초간 차단", async () => {
    const f = fake([{ status: "error", kind: "5xx", latencyMs: 0 }]);
    for (let i = 0; i < 5; i++) await f.runtime.call("test.run", spec("read", 0), req, options);
    await f.runtime.call("test.run", spec(), req, { ...options, now: 30000 });
    expect((await f.runtime.call("test.run", spec(), req, { ...options, now: 59999 })).attempts).toHaveLength(0);
  });
  it("통화 제한 뒤에는 재시도 요청을 보내지 않는다", async () => {
    const f = fake([{ status: "ok", data: {}, latencyMs: Infinity }]);
    const result = await f.runtime.call("test.run", spec("write"), req, { ...options, until: 700 });
    expect(result.elapsedMs).toBe(700);
    expect(f.requests).toHaveLength(1);
  });
});

describe("숫자와 출력 가드", () => {
  it("쉼표와 한국어 금액을 값으로 정규화", () => {
    expect(numbers("18,000원 3천 원 1만 원 5만 원 1만 2천 원")).toEqual(["18000", "3000", "10000", "50000", "12000"]);
    expect(postGuard("금액은 18,000원입니다. 비용은 3천 원입니다. 5만 원입니다.", ["18000 3000 50000"], [], 30).hits).toEqual([]);
  });
  it("근거 없는 숫자 문장만 제거하며 금지어도 차단", () => {
    const result = postGuard("안녕하세요. 비용은 9만 원입니다. 무조건 됩니다.", [], ["무조건"], 12);
    expect(result.text).toBe("안녕하세요.");
    expect(result.hits).toEqual(["numeric_grounding", "forbidden"]);
  });
  it("모든 문장 제거 시 안전 문구, 길이 초과는 문장 경계", () => {
    expect(postGuard("99원입니다.", [], [], 12).text).toBe("확인 후 안내드릴게요.");
    expect(postGuard("네. " + "가".repeat(100) + ".", [], [], 2).text).toBe("네.");
  });
});

it("한 글자 키워드는 어절 단위로만 맞고, '사람'만으로는 이관하지 않는다", () => {
  for (const [text, intent] of [
    ["오늘 날씨 이야기예요.", "unknown"],
    ["예약 문의예요", "unknown"],
    ["네, 진행해 주세요.", "yes"],
    ["네네 맞아요", "yes"],
    ["예요", "yes"],
    ["사람들이 반품을 많이 해서요", "unknown"],
    ["사람 상담원 연결해 주세요.", "request_human"],
    ["AI 상담원이세요?", "question"],
  ]) expect(classify(text!), text).toBe(intent);
});

it("BM25는 질문과 가까운 청크를 ID와 함께 반환", () => {
  const kb = new Knowledge([{ file: "kb/test.md", text: "## 환불\n환불 정책과 환불 신청 방법입니다.\n## 결제\n자동 결제 금액을 변경합니다." }]);
  expect(kb.search("환불 신청")[0]?.chunkId).toBe("kb/test.md#환불");
  expect(kb.search("없는단어")).toEqual([]);
});

it("의도 우선순위와 Pack 추가 키워드", () => {
  const intents = { choice: ["선택"], yes: ["승인"] };
  for (const [text, intent] of [["네 전화하지 마 사람 선택", "opt_out"], ["사람 상담원 선택 바빠", "request_human"], ["선택 바빠 아니 네?", "choice"], ["바빠 아니 네?", "busy"], ["아니 네?", "no"], ["네?", "yes"], ["왜?", "question"], ["승인", "yes"], ["음", "unknown"]]) expect(classify(text!, intents)).toBe(intent);
});

function context(): TurnContext {
  return { pack: packs[0]!, stage: packs[0]!.pack.stages[0]!, facts: [], slots: {}, transcript: [] };
}
it("알 수 없는 의도 연속 두 번은 이관, 재요청은 중복 계수하지 않음", async () => {
  const brain = new RuleBrain(); const ctx = context();
  ctx.transcript.push({ role: "user", seq: 0, text: "음", startedAt: 0, endedAt: 0 });
  expect((await brain.plan(ctx)).end).toBeUndefined();
  expect((await brain.plan({ ...ctx, rejection: "test" })).end).toBeUndefined();
  ctx.transcript.push({ role: "user", seq: 1, text: "음", startedAt: 1, endedAt: 1 });
  expect((await brain.plan(ctx)).end).toBe("handoff");
});
it("슬롯 레이블과 사실을 렌더링", () => {
  const ctx = context(); const [key, slot] = Object.entries(ctx.pack.pack.slots).find(([, s]) => s.labels)!;
  const value = Object.keys(slot.labels!)[0]!;
  ctx.slots[key] = { value, turn: 0 }; ctx.facts.push({ key: "cost", value: 18000, source: { kind: "target" } });
  expect(render(`{{slot.${key}}} {{fact.cost}}`, ctx)).toBe(`${slot.labels![value]} 18000`);
});
it("끼어들기는 들린 접두사와 가상 종료 시각을 기록", async () => {
  const p = { ...packs[0]!.personas[0]!, patience: 0, quirks: ["interrupts" as const] };
  const transport = new SimTransport(new ScriptedPersona(p, new Rng(1)));
  const text = "설명을 이어갑니다. ".repeat(30);
  const result = await transport.speak(text, 100).done;
  expect(result.interrupted).toBe(true);
  expect(text.startsWith(result.heard)).toBe(true);
  expect(result.heard.length).toBeLessThan(text.length);
  expect(result.endedAt).toBe(4100);
});

describe("두 Pack × 30 페르소나 × 5 장애 × 2 시드", () => {
  for (const pack of packs) for (const persona of pack.personas) for (const fault of Object.keys(FAULT_PROFILES)) for (const seed of [1, 7]) {
    it(`${pack.pack.id}/${persona.id}/${fault}/${seed}`, async () => {
      const result = await runCall(pack, persona, fault, seed);
      expect(OUTCOMES).toContain(result.outcome);
      expect(result.system.doubleWrites()).toEqual([]);
      expect(result.metrics.deadAir).toBe(0);
      expect(result.metrics.policyViolations).toBe(0);
      expect(result.transcript[0]?.text).toBe(pack.pack.policy.disclosure);
      const calls = result.events.filter((e) => e.type === "tool.call" && !e.builtin);
      for (const event of calls) {
        const call = event.call as { tool: string };
        if (pack.pack.tools[call.tool]?.kind === "write") expect(event.consent).toBe(true);
      }
      const optOut = result.events.find((e) => e.type === "guard.reject" && e.reason === "opted_out");
      if (optOut) {
        expect(result.outcome).toBe("opted_out");
        expect(calls.filter((e) => e.at >= optOut.at)).toEqual([]);
      }
      const users = result.transcript.filter((t) => t.role === "user");
      for (const user of users) {
        const next = result.transcript.find((t) => t.role === "agent" && t.startedAt >= user.endedAt);
        if (next) expect(next.startedAt - user.endedAt).toBeLessThanOrEqual(pack.pack.policy.silenceMaxSec * 1000);
      }
    });
  }
});
it("같은 시드는 발화와 trace 전체가 동일", async () => {
  const a = await runCall(packs[0]!, packs[0]!.personas[0]!, "slow", 8);
  const b = await runCall(packs[0]!, packs[0]!.personas[0]!, "slow", 8);
  expect(a.transcript).toEqual(b.transcript); expect(a.events).toEqual(b.events);
});
it("허용 밖 계획은 한 번 재요청하고 안전 문구로 대체", async () => {
  const seen: TurnContext[] = [];
  const brain: Brain = { id: "test", plan: async (ctx) => { seen.push(structuredClone(ctx)); return { tools: [{ tool: "bad.write", args: {} }] }; }, compose: async () => { throw Error("거부된 계획의 compose 호출 금지"); } };
  const pack = structuredClone(packs[0]!); pack.pack.policy.maxCallSec = 30;
  const result = await runCall(pack, { ...pack.personas[0]!, intent: "accept" }, "clean", 1, { brain });
  expect(seen[1]?.rejection).toBe("tool_not_allowed");
  expect(result.metrics.controlRejections).toBeGreaterThan(0);
  expect(result.system.writes).toEqual([]);
  expect(result.metrics.longCall).toBe(true);
});
it("동의 위조와 그래프 밖 전이는 실행 전에 거부", () => {
  const ctx = context();
  expect(checkPlan({ setSlots: { consent: true } }, ctx)).toBe("consent_not_explicit");
  expect(checkPlan({ transition: "missing" }, ctx)).toBe("transition_not_allowed");
});

it("종료 권한: 질문하면서 종료·런타임 전용 종료·효과 없는 콜백 종료를 거부한다", () => {
  const loaded = packs.find((p) => p.pack.id === "gaga-ads")!;
  const stage = (id: string) => loaded.pack.stages.find((s) => s.id === id)!;
  const at = (id: string): TurnContext => ({ pack: loaded, stage: stage(id), facts: [], slots: {}, transcript: [] });
  // M4 실측에서 EXAONE이 낸 계획: 다음 단계로 가며 질문하고, 동시에 확인 대기로 종료
  expect(checkPlan({ transition: "pitch", end: "pending_confirmation" }, at("verify"))).toBe("end_reserved_for_runtime");
  // 두뇌가 수신 거부로 끝내면 협조적인 고객을 다시 부를 수 없게 된다 (M4 파일럿에서 실제로 발생)
  expect(checkPlan({ transition: "pitch", end: "opted_out" }, at("verify"))).toBe("end_reserved_for_runtime");
  // 쓰기 없이 성공으로 끝내면 고객에게 거짓 완료 안내가 나간다 (M4 파일럿에서 세 모델 모두 발생)
  expect(checkPlan({ transition: "close", end: "success" }, at("confirm"))).toBe("end_without_effect");
  expect(checkPlan({ transition: "pitch", end: "declined" }, at("verify"))).toBe("end_without_terminal_stage");
  expect(checkPlan({ end: "success" }, at("confirm"))).toBe("end_without_terminal_stage");
  expect(checkPlan({ transition: "close", end: "callback_scheduled" }, at("pitch"))).toBe("end_without_effect");
  expect(checkPlan({ transition: "close", end: "callback_scheduled", tools: [{ tool: "call.scheduleCallback", args: {} }] }, at("pitch"))).toBeUndefined();
  expect(checkPlan({ transition: "close", end: "declined" }, at("pitch"))).toBeUndefined();
  expect(checkPlan({ end: "handoff" }, at("pitch"))).toBeUndefined();
});

it("소수점은 문장 경계로 잘리지 않는다", () => {
  expect(postGuard("약 1.5일입니다. 감사합니다.", ["1.5"], [], 12)).toEqual({ text: "약 1.5일입니다. 감사합니다.", hits: [] });
  expect(postGuard("약 1.9일입니다.", ["1.5"], [], 12).hits).toContain("numeric_grounding");
});
it("명시적 긍정 동의와 슬롯 설정 뒤에만 쓰기를 제안한다", async () => {
  const ctx = context();
  ctx.stage = ctx.pack.pack.stages.find((s) => s.requireConsent)!;
  const tool = ctx.stage.allowTools[0]!;
  expect(checkPlan({ tools: [{ tool, args: {} }] }, ctx)).toBe("write_without_consent");
  ctx.transcript = [{ role: "user", seq: 1, text: "네, 동의합니다.", startedAt: 0, endedAt: 1 }];
  const plan = await new RuleBrain().plan(ctx);
  expect(plan.setSlots?.consent).toBe(true);
  expect(plan.tools?.[0]?.tool).toBe(tool);
  expect(checkPlan(plan, ctx)).toBeUndefined();
});
it.each(["defer_callback", "confirm_later", "handoff", "skip"] as const)("조회 실패 전략 %s", async (strategy) => {
  const pack = structuredClone(packs[0]!);
  const tool = pack.pack.tools[pack.pack.call.prefetch[0]!]!;
  tool.onFailure = strategy;
  const result = await runCall(pack, { ...pack.personas[0]!, intent: "decline" }, "down", 1);
  const expected = { defer_callback: "callback_scheduled", confirm_later: "pending_confirmation", handoff: "handoff", skip: "declined" };
  expect(result.outcome).toBe(expected[strategy]);
  if (strategy === "defer_callback") {
    expect(result.pending).toEqual([{ kind: "callback" }]);
    expect(result.events.some((e) => e.type === "tool.call" && (e.call as ToolCallLike).tool === "call.scheduleCallback")).toBe(true);
  }
  if (strategy === "confirm_later") expect(result.pending[0]?.kind).toBe("confirmation");
  if (strategy === "handoff") expect(result.pending[0]?.target).toBe(pack.pack.policy.handoffTarget);
});
type ToolCallLike = { tool: string };
it("응답 유실은 확인 작업을 등록하되 성공은 반영된 업무 상태로 판정", async () => {
  const pack = structuredClone(packs[0]!);
  const persona = { ...pack.personas[0]!, cooperativeness: 1, patience: 1 };
  const fault = FAULT_PROFILES["lost-ack"]!;
  const saved = fault.lostAck;
  fault.lostAck = 1;
  try {
    const result = await runCall(pack, persona, "lost-ack", 1);
    expect(result.outcome).toBe("success");
    expect(result.pending.some((p) => p.kind === "confirmation")).toBe(true);
    expect(result.transcript.some((t) => t.text.includes("문자로"))).toBe(true);
    expect(result.system.writes).toHaveLength(1);
    const attempts = result.events.filter((e) => e.attempt).map((e) => e.attempt as { idempotencyKey?: string });
    const writes = attempts.filter((a) => a.idempotencyKey);
    expect(writes).toHaveLength(2);
    expect(writes[0]!.idempotencyKey).toBe(writes[1]!.idempotencyKey);
  } finally { fault.lostAck = saved; }
});
it("성공이라는 Brain 주장만으로 목표를 달성하지 않는다", async () => {
  const brain: Brain = { id: "test", plan: async () => ({ say: "감사합니다.", transition: "close", end: "success" }), compose: async () => "감사합니다." };
  const result = await runCall(packs[0]!, packs[0]!.personas[0]!, "clean", 1, { brain });
  expect(result.outcome).toBe("failed");
  expect(result.system.writes).toEqual([]);
});
it("긴 쓰기 무응답 동안 첫 예산 시각부터 반복 대기 멘트, 발화 겹침 없음", async () => {
  const pack = structuredClone(packs[0]!);
  const write = Object.values(pack.pack.tools).find((t) => t.kind === "write")!;
  write.timeoutMs = 15000;
  const fault = FAULT_PROFILES["lost-ack"]!; const saved = fault.lostAck; fault.lostAck = 1;
  try {
    const result = await runCall(pack, { ...pack.personas[0]!, cooperativeness: 1, patience: 1 }, "lost-ack", 2);
    const filler = result.events.filter((e) => e.type === "speech.start" && e.filler);
    expect(filler.length).toBeGreaterThan(3);
    const user = result.transcript.filter((t) => t.role === "user").at(-1)!;
    expect(filler[0]!.at - user.endedAt).toBe(pack.pack.policy.turnLatencyBudgetMs);
    const speeches = result.transcript.filter((t) => t.role === "agent");
    for (let i = 1; i < speeches.length; i++) expect(speeches[i]!.startedAt).toBeGreaterThanOrEqual(speeches[i - 1]!.endedAt);
    expect(result.metrics.deadAir).toBe(0);
  } finally { fault.lostAck = saved; }
});
it("사전 가드가 수신 거부와 사람 요청을 Brain 없이 처리", async () => {
  const brain: Brain = { id: "test", plan: async () => { throw Error("호출 금지"); }, compose: async () => { throw Error("호출 금지"); } };
  for (const intent of ["opt_out", "request_human"] as const) {
    const result = await runCall(packs[0]!, { ...packs[0]!.personas[0]!, intent }, "clean", 1, { brain });
    expect(result.outcome).toBe(intent === "opt_out" ? "opted_out" : "handoff");
    expect(result.system.writes).toEqual([]);
  }
});
it("끼어들기 접두사는 다음 Brain 턴에 전달", async () => {
  const pack = structuredClone(packs[0]!);
  pack.pack.stages[0]!.rule!.say = "길게 설명하는 문장입니다. ".repeat(20);
  pack.pack.policy.maxTurnSpeechSec = 60;
  const seen: TurnContext[] = [];
  const brain: Brain = { id: "test", plan: async (ctx) => { seen.push(structuredClone(ctx)); return { say: "감사합니다.", transition: "close", end: "declined" }; }, compose: async () => "감사합니다." };
  const result = await runCall(pack, { ...pack.personas[0]!, patience: 0, quirks: ["interrupts"] }, "clean", 1, { brain });
  const cut = result.transcript.filter((t) => t.role === "agent" && t.interrupted).at(-1)!;
  expect(cut.role === "agent" && seen[0]?.interruptedAt).toBe(cut.role === "agent" ? cut.heard : undefined);
  expect(result.events.some((e) => e.type === "speech.interrupted")).toBe(true);
});
it("출력 차단은 실행 거부와 별도 계수하고 숫자 환각을 송출하지 않는다", async () => {
  const brain: Brain = { id: "test", plan: async () => ({ say: "99999999원입니다. 무조건 됩니다.", transition: "close", end: "declined" }), compose: async () => "호출되지 않습니다." };
  const result = await runCall(packs[0]!, packs[0]!.personas[0]!, "clean", 1, { brain });
  expect(result.metrics.controlRejections).toBe(0);
  expect(result.metrics.outputGuardHits).toBe(2);
  expect(result.transcript.some((t) => t.text.includes("99999999"))).toBe(false);
  expect(result.events.filter((e) => e.type === "guard.reject").every((e) => e.layer === "output")).toBe(true);
});
it("정책 재요청은 한 번만 하고 수정된 계획을 실행", async () => {
  let count = 0;
  const brain: Brain = { id: "test", plan: async (ctx) => {
    count++;
    if (!ctx.rejection) return { transition: "missing" };
    return { say: "감사합니다.", transition: "close", end: "declined" };
  }, compose: async () => "감사합니다." };
  const result = await runCall(packs[0]!, packs[0]!.personas[0]!, "clean", 1, { brain });
  expect(count).toBe(2);
  expect(result.metrics.controlRejections).toBe(1);
  expect(result.outcome).toBe("declined");
});
it("짧은 통화 한도는 발화와 마지막 이벤트도 정확히 자른다", async () => {
  const pack = structuredClone(packs[0]!); pack.pack.policy.maxCallSec = 1;
  const result = await runCall(pack, pack.personas[0]!, "clean", 1);
  const first = result.transcript[0]!;
  expect(first.endedAt - first.startedAt).toBe(1000);
  expect(result.events.at(-1)?.at).toBe(first.endedAt);
  expect(result.metrics.longCall).toBe(true);
});
