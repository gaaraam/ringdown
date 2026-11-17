import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmBrain, normalizePlan, planSchema, promptPrefix } from "../src/brain/llm.ts";
import { registerProvider, type ChatRequest } from "../src/llm/types.ts";
import { LlmError } from "../src/llm/http.ts";
import { OllamaClient } from "../src/llm/ollama.ts";
import { OpenAICompatClient } from "../src/llm/openai-compat.ts";
import { resolveModels } from "../src/config/models.ts";
import { loadPack, listPackDirs } from "../src/pack/load.ts";
import type { TurnContext } from "../src/core/types.ts";
import { checkPlan } from "../src/guard/index.ts";
import { runCall } from "../src/runtime/call.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
import { metrics } from "../src/soundcheck/metrics.ts";
import { Report } from "../src/soundcheck/report.ts";

const loaded = loadPack(listPackDirs("packs")[0]!);
if (!loaded.ok) throw Error("Pack 로딩 실패");
const pack = loaded.value;
const models = resolveModels({ env: {}, cli: { agent: "ollama/test-model" } });
function context(): TurnContext {
  return { pack, stage: pack.pack.stages[0]!, slots: {}, facts: [], transcript: [{ role: "user", seq: 0, text: "네, 진행해 주세요.", startedAt: 0, endedAt: 1 }] };
}
function fake(answer: (req: ChatRequest) => unknown | Promise<unknown>) {
  const requests: ChatRequest[] = [];
  registerProvider("ollama", () => ({ label: "ollama/test-model", async chat(req) {
    requests.push(req); const value = await answer(req);
    return { text: typeof value === "string" ? value : JSON.stringify(value), latencyMs: 999999, model: "ollama/test-model" };
  } }));
  return { requests, brain: new LlmBrain(models.agent) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("스키마는 continue를 기본값으로 두고 두뇌가 고를 수 없는 종료를 막는다", () => {
  const ctx = context();
  for (const stage of pack.pack.stages) {
    ctx.stage = stage;
    const schema = planSchema(ctx);
    expect(schema.safeParse({ intent: "yes", end: "continue" }).success).toBe(true);
    for (const reserved of ["pending_confirmation", "opted_out", "failed"]) expect(schema.safeParse({ intent: "yes", end: reserved }).success).toBe(false);
    expect(schema.safeParse({ intent: "yes", end: "handoff" }).success).toBe(stage.allowTools.includes("call.handoff"));
    const canClose = stage.terminal || stage.next.some(id => pack.pack.stages.find(s => s.id === id)?.terminal);
    expect(schema.safeParse({ intent: "no", end: "declined" }).success).toBe(Boolean(canClose));
  }
  ctx.stage = { ...pack.pack.stages[0]!, terminal: false, next: [] };
  expect(planSchema(ctx).safeParse({ intent: "no", end: "declined" }).success).toBe(false);
});

it("계획 정규화: continue는 지우고, 종료만 고르면 하나뿐인 종료 단계로 이동시킨다", () => {
  const ctx = context();
  const stage = pack.pack.stages.find(s => !s.terminal && s.next.filter(id => pack.pack.stages.find(x => x.id === id)?.terminal).length === 1)!;
  ctx.stage = stage;
  const close = stage.next.find(id => pack.pack.stages.find(x => x.id === id)?.terminal);
  expect(normalizePlan({ intent: "yes", say: "네", end: "continue" }, ctx)).toEqual({ intent: "yes", say: "네" });
  expect(normalizePlan({ intent: "no", end: "declined" }, ctx)).toMatchObject({ transition: close, end: "declined" });
  expect(normalizePlan({ intent: "no", transition: "x", end: "declined" }, ctx)).toMatchObject({ transition: "x", end: "declined" });
});

it("스키마는 현재 단계 도구·전이와 선언 슬롯 enum만 허용", () => {
  const ctx = context();
  for (const stage of pack.pack.stages) {
    ctx.stage = stage;
    const schema = planSchema(ctx);
    const json = z.toJSONSchema(schema) as unknown as { properties: { tools: { items: { properties: { tool: { enum: string[] } } } } } };
    if (stage.allowTools.length) expect(json.properties.tools.items.properties.tool.enum).toEqual(stage.allowTools);
    expect(schema.safeParse({ intent: "yes", tools: [{ tool: "unknown.write", args: {} }] }).success).toBe(false);
    expect(schema.safeParse({ intent: "yes", transition: "unknown" }).success).toBe(false);
    expect(schema.safeParse({ intent: "yes", setSlots: { unknown: true } }).success).toBe(false);
    const enumSlot = Object.entries(pack.pack.slots).find(([,s]) => s.enum);
    if (enumSlot) expect(schema.safeParse({ intent: "yes", setSlots: { [enumSlot[0]]: "unknown" } }).success).toBe(false);
  }
});
it("고정 프리픽스는 단계·슬롯·기록·거부 사유와 무관하게 바이트 동일", async () => {
  const ctx = context(), next = { ...ctx, stage: pack.pack.stages[1]!, slots: { consent: { value: true, turn: 5 } }, rejection: "write_without_consent", interruptedAt: "잠시" };
  expect(Buffer.from(promptPrefix(ctx))).toEqual(Buffer.from(promptPrefix(next)));
  const f = fake(() => ({ intent: "yes", say: "네." }));
  await f.brain.plan(ctx); await f.brain.plan(next);
  expect(f.requests[0]!.system).toBe(f.requests[1]!.system);
  expect(f.requests[0]!.messages).not.toEqual(f.requests[1]!.messages);
});
it.each(["invalid_json", "timeout"] as const)("%s 두 번 실패 → RuleBrain 대체 한 번", async kind => {
  const f = fake(() => { if (kind === "timeout") throw new LlmError(kind, "시간 초과"); return "{"; });
  const ctx = context();
  await f.brain.plan(ctx); await f.brain.compose(ctx, []);
  expect(f.requests).toHaveLength(2);
  expect(f.brain.takeFallbacks()).toHaveLength(1);
  expect(f.brain.takeFallbacks()).toEqual([]);
});
it("첫 JSON 실패 뒤 재요청 성공이면 대체하지 않는다", async () => {
  let n = 0; const f = fake(() => ++n === 1 ? "{" : { intent: "yes", say: "네." });
  expect((await f.brain.plan(context())).say).toBe("네.");
  expect(f.requests).toHaveLength(2); expect(f.brain.takeFallbacks()).toEqual([]);
});
it("LLM의 스키마 유효한 무동의 쓰기도 checkPlan이 차단", async () => {
  const ctx = context();
  ctx.stage = pack.pack.stages.find(s => s.allowTools.some(t => pack.pack.tools[t]?.kind === "write"))!;
  const tool = ctx.stage.allowTools.find(t => pack.pack.tools[t]?.kind === "write")!;
  const f = fake(() => ({ intent: "yes", tools: [{ tool, args: {} }] }));
  expect(checkPlan(await f.brain.plan(ctx), ctx)).toBe("write_without_consent");
});
it("실제 경과 시간은 sim 시각에 합산하고 공급자의 주장 지연은 쓰지 않는다", async () => {
  let wall = 0;
  vi.spyOn(performance, "now").mockImplementation(() => wall);
  const f = fake(() => { wall += 1800; return { intent: "no", say: "감사합니다.", transition: "close", end: "declined" }; });
  const result = await runCall(pack, pack.personas[0]!, "clean", 1, { brain: f.brain });
  expect(result.events.find(e => e.type === "brain.latency")?.ms).toBe(1800);
  const start = result.events.find(e => e.type === "turn.start")!;
  const plan = result.events.find(e => e.type === "brain.plan")!;
  expect(plan.at - start.at).toBe(1800);
  expect(result.events.some(e => e.type === "speech.start" && e.filler)).toBe(true);
});
it("런타임 대체 지표와 모델 used 기록, 구 v1 보고서도 수용", async () => {
  fake(() => "{");
  const result = await runMatrix({ ...pack, personas: [pack.personas[0]!] }, { brain: "llm", faults: ["clean"], seeds: [1], models, gitSha: "test", runId: "test" });
  expect(result.report.models.agent).toMatchObject({ label: "ollama/test-model", used: true });
  expect(result.report.models.persona.used).toBe(false);
  expect(result.report.metrics.brain_fallbacks.value).toBeGreaterThan(0);
  expect(result.report.metrics.brain_fallbacks.value).toBe(Object.values(result.traces).flat().filter(e => e.type === "brain.fallback").length);
  const { diagnostics: _diagnostics, ...old } = result.report;
  expect(Report.safeParse({ ...old, brain: "rule" }).success).toBe(true);
});
it("공급자 JSON schema·옵션·usage·비스트리밍 요청", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: { content: '{"say":"네"}' }, prompt_eval_count: 12, eval_count: 4 })));
  vi.stubGlobal("fetch", fetcher);
  const req = { system: "정책", messages: [{ role: "user" as const, content: "질문" }], jsonSchema: { type: "object" }, maxTokens: 20 };
  const result = await new OllamaClient(models.agent).chat(req);
  const body = JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1].body as string);
  expect(body).toMatchObject({ stream: false, think: false, keep_alive: "5m", format: req.jsonSchema, options: { num_predict: 20 } });
  expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 4 }); expect(result.firstTokenMs).toBeUndefined();
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"say":"네"}' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } })));
  const compatible = await new OpenAICompatClient({ ...models.agent, provider: "openai-compat", baseUrl: "http://local/v1" }).chat(req);
  expect(compatible.usage?.completionTokens).toBe(3);
  expect(JSON.parse((fetcher.mock.calls as unknown as [string, RequestInit][])[1]![1].body as string).response_format.json_schema.schema).toEqual(req.jsonSchema);
});
it("공급자 HTTP·잘못된 JSON·본문 제한 시간의 오류 종류", async () => {
  const client = new OllamaClient({ ...models.agent, timeoutMs: 10 });
  const req = { system: "", messages: [], jsonSchema: { type: "object" } };
  vi.stubGlobal("fetch", async () => new Response("실패", { status: 503 }));
  await expect(client.chat(req)).rejects.toMatchObject({ kind: "http" });
  vi.stubGlobal("fetch", async () => new Response("null"));
  await expect(client.chat(req)).rejects.toMatchObject({ kind: "invalid_json" });
  vi.stubGlobal("fetch", async () => new Response("{"));
  await expect(client.chat(req)).rejects.toMatchObject({ kind: "invalid_json" });
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => { init.signal!.addEventListener("abort", () => reject(Error("취소"))); }));
  await expect(client.chat(req)).rejects.toMatchObject({ kind: "timeout" });
});
it.skipIf(process.env.RINGDOWN_LIVE !== "1")("실제 Ollama 스키마 응답 (명시적 선택)", async () => {
  const spec = resolveModels().agent;
  const response = await new OllamaClient(spec).chat({ system: "JSON만 답하세요", messages: [{ role: "user", content: "say에 네를 넣으세요" }], jsonSchema: { type: "object", properties: { say: { type: "string" } }, required: ["say"] } });
  expect(response.json).toHaveProperty("say");
}, 60000);
it("compose 재시도도 턴 지연에 합산하고 실패 대체는 한 번", async () => {
  let wall = 0;
  vi.spyOn(performance, "now").mockImplementation(() => wall);
  const f = fake(req => {
    wall += 100;
    const suffix = JSON.parse(req.messages[0]!.content);
    if (typeof suffix.task === "string") return { intent: "no", transition: "close", end: "declined" };
    return "{";
  });
  const result = await runCall(pack, pack.personas[0]!, "clean", 1, { brain: f.brain });
  expect(result.events.find(e => e.type === "brain.latency")?.ms).toBe(300);
  expect(metrics([result], []).brain_fallbacks.value).toBe(1);
  expect(f.requests).toHaveLength(3);
});
it("스키마에 맞지 않는 JSON도 재시도 후 대체", async () => {
  const f = fake(() => ({ intent: "yes", setSlots: { invented: 1 } }));
  await f.brain.plan(context());
  expect(f.requests).toHaveLength(2);
  expect(f.brain.takeFallbacks()).toHaveLength(1);
});
it("입력 가드만 사용한 매트릭스는 LLM used=false", async () => {
  const f = fake(() => { throw Error("호출되면 안 됨"); });
  const result = await runMatrix({ ...pack, personas: [pack.personas.find(p => p.intent === "opt_out")!] }, { brain: "llm", faults: ["clean"], seeds: [1], models, gitSha: "test", runId: "test" });
  expect(result.report.models.agent.used).toBe(false);
  expect(f.requests).toHaveLength(0);
});
it("숫자·불리언 enum도 선언된 슬롯 타입을 유지", () => {
  const ctx = context();
  const changed = { ...ctx, pack: { ...ctx.pack, pack: { ...ctx.pack.pack, slots: {
    count: { type: "number" as const, enum: ["1", "2"] },
    enabled: { type: "boolean" as const, enum: ["true"] },
  } } } };
  const schema = planSchema(changed);
  expect(schema.safeParse({ intent: "yes", setSlots: { count: 1, enabled: true } }).success).toBe(true);
  expect(schema.safeParse({ intent: "yes", setSlots: { count: "1" } }).success).toBe(false);
  expect(schema.safeParse({ intent: "yes", setSlots: { count: 3 } }).success).toBe(false);
  expect(schema.safeParse({ intent: "yes", setSlots: { enabled: false } }).success).toBe(false);
});
