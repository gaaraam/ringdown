import type { Brain, Fact, Plan, Scalar, SlotValue, ToolCall, ToolResult, Turn, TurnContext } from "../core/types.ts";
import type { LoadedPack } from "../pack/load.ts";
import type { Outcome, Persona } from "../pack/schema.ts";
import { RuleBrain, render } from "../brain/rule.ts";
import { checkPlan, groundedCorpus, postGuard, preGuard, SAFE_PHRASE } from "../guard/index.ts";
import { Knowledge } from "../knowledge/bm25.ts";
import { MockBusinessSystem, MockJack } from "../jacks/mock.ts";
import { getFaultProfile } from "../jacks/faults.ts";
import { JackRuntime } from "../jacks/runtime.ts";
import { Rng, hash } from "../sim/rng.ts";
import { ScriptedPersona } from "../sim/persona.ts";
import { SimTransport } from "../transport/sim.ts";

export interface TraceEvent {
  type: "turn.start" | "brain.plan" | "guard.reject" | "tool.call" | "tool.result" | "speech.start" | "speech.interrupted" | "call.end";
  at: number;
  latency: { brain: number; tool: number; tts: number };
  [key: string]: unknown;
}
export interface PendingOp { kind: "callback" | "confirmation" | "handoff"; tool?: string; target?: string }
export interface CallResult {
  callId: string; outcome: Outcome; transcript: Turn[]; events: TraceEvent[];
  pending: PendingOp[]; system: MockBusinessSystem; slots: Record<string, SlotValue>;
  metrics: { deadAir: number; controlRejections: number; outputGuardHits: number; longCall: boolean; policyViolations: number };
}

/** 한 호출은 독립된 업무 상태·난수 스트림을 갖는다. 실시간 대기나 외부 API는 없다. */
export async function runCall(loaded: LoadedPack, persona: Persona, faults: string, seed: number,
  options: { brain?: Brain; transport?: SimTransport } = {},
): Promise<CallResult> {
  if (!loaded.mock) throw new Error("통화 시뮬레이션에는 mock 설정이 필요합니다");
  if (Object.values(loaded.jacks).some((j) => j.type !== "mock")) throw new Error("M2는 mock 연결만 지원합니다");
  const pack = loaded.pack;
  const rng = new Rng(`${seed}:${persona.id}:${faults}`);
  const callId = `call-${hash(`${pack.id}:${seed}:${persona.id}:${faults}`).toString(16)}`;
  const system = new MockBusinessSystem(loaded.mock);
  const profile = getFaultProfile(faults);
  const runtimes = new Map(Object.keys(loaded.jacks).map((id) => [id,
    new JackRuntime(new MockJack(id, system, profile, rng.fork(`jack:${id}`)), rng.fork(`retry:${id}`))]));
  const brain = options.brain ?? new RuleBrain();
  const knowledge = new Knowledge(loaded.kb);
  const transcript: Turn[] = [];
  const events: TraceEvent[] = [];
  const facts: Fact[] = [];
  const slots: Record<string, SlotValue> = {};
  const pending: PendingOp[] = [];
  const metrics = { deadAir: 0, controlRejections: 0, outputGuardHits: 0, longCall: false, policyViolations: 0 };
  let stage = pack.stages[0]!;
  let now = 0;
  let until = Infinity;
  let connected = false;
  let speechEnd = 0;
  let userEnd: number | undefined;
  let interruptedAt: string | undefined;
  let seq = 0;
  let outcome: Outcome | undefined;
  let latency = { brain: 0, tool: 0, tts: 0 };
  let transport: SimTransport;
  const ctx = (): TurnContext => ({ pack: loaded, stage, slots, facts, transcript, interruptedAt });
  const emit = (type: TraceEvent["type"], data: Record<string, unknown> = {}, at = now) => {
    events.push({ type, at, latency: { ...latency }, ...data });
  };
  const say = async (text: string, fixed = false, filler = false) => {
    const guarded = fixed ? { text, hits: [] } : postGuard(text, groundedCorpus(ctx()), pack.policy.forbidden, pack.policy.maxTurnSpeechSec);
    if (!fixed) {
      const audit = postGuard(guarded.text, groundedCorpus(ctx()), pack.policy.forbidden, pack.policy.maxTurnSpeechSec);
      metrics.policyViolations += audit.hits.filter((hit) => hit !== "speech_length").length;
    }
    for (const reason of guarded.hits) { metrics.outputGuardHits++; emit("guard.reject", { layer: "output", reason }); }
    const at = Math.max(now, speechEnd);
    if (at >= until) return;
    if (userEnd !== undefined) {
      if (at - userEnd > pack.policy.silenceMaxSec * 1000) metrics.deadAir++;
      userEnd = undefined;
    }
    emit("speech.start", { text: guarded.text, filler, fixed }, at);
    const spoken = await transport.speak(guarded.text, at).done;
    transcript.push({ role: "agent", seq: transcript.length, text: guarded.text, ...spoken, startedAt: at });
    speechEnd = spoken.endedAt;
    if (spoken.interrupted) {
      interruptedAt = spoken.heard;
      emit("speech.interrupted", { intended: guarded.text, heard: spoken.heard }, spoken.endedAt);
    }
    if (!filler) now = speechEnd;
  };
  // 도구 대기와 발화는 겹칠 수 있다. 첫 멘트는 예산 시각, 이후 멘트는 침묵 상한 전에 송출한다.
  const advance = async (to: number) => {
    to = Math.min(to, until);
    if (connected) {
      const gap = Math.min(pack.policy.turnLatencyBudgetMs, pack.policy.silenceMaxSec * 1000);
      let next = Math.max(now, userEnd !== undefined ? userEnd + gap : speechEnd + gap);
      while (next < to && next < until) {
        now = next;
        await say(rng.pick(pack.policy.fillerPhrases), false, true);
        next = speechEnd + gap;
      }
    }
    now = to;
  };
  const builtin = (call: ToolCall): ToolResult => {
    emit("tool.call", { call, builtin: true });
    let data: unknown = {};
    if (call.tool === "kb.search") {
      const chunks = knowledge.search(String(call.args.query ?? ""));
      for (const chunk of chunks) facts.push({ key: chunk.chunkId, value: chunk.text, source: { kind: "kb", chunkId: chunk.chunkId } });
      data = chunks;
    } else if (call.tool === "call.scheduleCallback") pending.push({ kind: "callback" });
    else if (call.tool === "call.handoff") pending.push({ kind: "handoff", target: pack.policy.handoffTarget });
    const result: ToolResult = { call, status: "ok", data };
    emit("tool.result", { result, citations: call.tool === "kb.search" ? (data as { chunkId: string }[]).map((c) => c.chunkId) : [] });
    return result;
  };
  const failure = (toolName: string, strategy: string): string | undefined => {
    if (strategy === "defer_callback") {
      builtin({ tool: "call.scheduleCallback", args: {} }); outcome = "callback_scheduled";
      return "확인 후 다시 연락드릴게요.";
    }
    if (strategy === "confirm_later") {
      pending.push({ kind: "confirmation", tool: toolName }); outcome = "pending_confirmation";
      return "처리 결과는 문자로 안내드릴게요.";
    }
    if (strategy === "handoff") {
      builtin({ tool: "call.handoff", args: {} }); outcome = "handoff";
      return "상담원에게 연결해 드릴게요.";
    }
    return undefined;
  };
  const execute = async (call: ToolCall): Promise<ToolResult> => {
    const tool = pack.tools[call.tool];
    if (!tool) return builtin(call);
    const args: Record<string, Scalar> = {};
    for (const [key, param] of Object.entries(tool.params)) {
      const value = param.source === "target" ? persona.targetId : param.source === "slot" ? slots[param.slot!]?.value : call.args[key];
      if (value === undefined || typeof value !== param.type || (param.enum && !param.enum.includes(String(value)))) {
        return { call, status: "failed", kind: "4xx", handledAs: tool.onFailure };
      }
      args[key] = value;
    }
    const callSeq = ++seq;
    emit("tool.call", { call: { tool: call.tool, args }, callSeq, consent: slots.consent?.value === true });
    const result = await runtimes.get(tool.jack)!.call(call.tool, tool, { op: tool.op, pathParams: args, body: args }, {
      callId, seq: callSeq, now, until,
      advance: async (to) => { latency.tool += to - now; await advance(to); },
      onAttempt: (attempt) => emit("tool.result", { callSeq, attempt }, attempt.endedAt),
    });
    emit("tool.result", { callSeq, result: result.result, elapsedMs: result.elapsedMs, attempts: result.attempts.length });
    if (result.result.status === "error") return { call, status: "failed", kind: result.result.kind, handledAs: tool.onFailure };
    const data = result.result.data;
    if (data && typeof data === "object") for (const key of tool.facts) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        facts.push({ key, value, source: { kind: "tool", tool: call.tool, callSeq } });
      }
    }
    return { call, status: "ok", data };
  };

  // 사전 조회는 연결 전에 끝낸다. 실패 안내도 고정 고지 뒤에만 말한다.
  let prefetchFailure: ToolResult | undefined;
  for (const tool of pack.call.prefetch) {
    const result = await execute({ tool, args: {} });
    if (result.status === "failed" && result.handledAs !== "skip") { prefetchFailure = result; break; }
  }
  const connectedAt = now;
  until = now + pack.policy.maxCallSec * 1000;
  transport = options.transport ?? new SimTransport(new ScriptedPersona(persona, rng.fork("persona")), until);
  connected = true;
  await say(pack.policy.disclosure, true);
  if (prefetchFailure?.status === "failed") {
    const text = failure(prefetchFailure.call.tool, prefetchFailure.handledAs);
    if (text) await say(text);
  } else await say(render(stage.rule?.say ?? "통화 가능하실까요?", ctx()));

  while (!outcome && now < until) {
    const previous = [...transcript].reverse().find((t) => t.role === "agent");
    const user = transport.next(stage, loaded, now, previous?.role === "agent" && previous.interrupted);
    now = Math.min(user.endedAt, until);
    if (now >= until) break;
    transcript.push({ role: "user", seq: transcript.length, ...user });
    userEnd = now;
    latency = { brain: 0, tool: 0, tts: 0 };
    emit("turn.start", { stage: stage.id, user: user.text, interruptedAt });
    const guarded = preGuard(user.text, ctx());
    if (guarded) {
      outcome = guarded;
      emit("guard.reject", { layer: "input", reason: guarded });
      if (guarded === "handoff") builtin({ tool: "call.handoff", args: {} });
      await say(guarded === "opted_out" ? "연락드리지 않겠습니다. 감사합니다." : "상담원에게 연결해 드릴게요.");
      break;
    }
    let plan: Plan = {};
    let rejection: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const delay = Math.round(rng.between(20, 60));
      latency.brain += delay;
      await advance(now + delay);
      if (now >= until) break;
      plan = await brain.plan({ ...ctx(), rejection });
      emit("brain.plan", { plan, attempt });
      rejection = checkPlan(plan, ctx());
      if (!rejection) break;
      metrics.controlRejections++;
      emit("guard.reject", { layer: "control", reason: rejection });
    }
    interruptedAt = undefined;
    if (now >= until) break;
    if (rejection) { await say(SAFE_PHRASE); continue; }
    for (const [key, value] of Object.entries(plan.setSlots ?? {})) slots[key] = { value, turn: transcript.length - 1 };
    const results: ToolResult[] = [];
    let failureText: string | undefined;
    for (const call of plan.tools ?? []) {
      if (now >= until) break;
      const result = await execute(call);
      results.push(result);
      if (result.status === "failed") failureText = failure(call.tool, result.handledAs);
      if (outcome) break;
    }
    if (now >= until) break;
    if (!outcome && plan.transition) stage = pack.stages.find((s) => s.id === plan.transition)!;
    const text = failureText ?? (results.length === 0 && plan.say !== undefined ? render(plan.say, ctx()) : await brain.compose(ctx(), results));
    latency.tts = 80;
    await advance(now + latency.tts);
    await say(text);
    if (!outcome) outcome = plan.end ?? (stage.terminal ? "failed" : undefined);
    if (outcome === "callback_scheduled" && !pending.some((p) => p.kind === "callback")) builtin({ tool: "call.scheduleCallback", args: {} });
    if (outcome === "handoff" && !pending.some((p) => p.kind === "handoff")) builtin({ tool: "call.handoff", args: {} });
  }
  metrics.longCall = now >= until;
  now = Math.min(now, until);
  const goal = pack.goal.success;
  const value = system.get(goal.collection, persona.targetId)?.[goal.field];
  const success = goal.op === "exists" ? value !== undefined && value !== null : value === goal.value;
  // Brain의 성공 주장은 업무 상태가 뒷받침하지 않으면 실패다.
  outcome = success ? "success" : outcome === "success" ? "failed" : outcome ?? "failed";
  // 차단 횟수와 실제 송출·실행 위반을 분리한다. 상수 0을 지표로 보고하지 않는다.
  metrics.policyViolations += system.doubleWrites().length;
  const optedOutAt = events.find((e) => e.type === "guard.reject" && e.reason === "opted_out")?.at;
  for (const event of events.filter((e) => e.type === "tool.call" && !e.builtin)) {
    const call = event.call as ToolCall;
    if (pack.tools[call.tool]?.kind === "write" && event.consent !== true) metrics.policyViolations++;
    if (optedOutAt !== undefined && event.at >= optedOutAt) metrics.policyViolations++;
  }
  transport.hangup(outcome, now);
  emit("call.end", { outcome, metrics, pending, brain: brain.id, durationMs: now - connectedAt });
  events.sort((a, b) => a.at - b.at);
  return { callId, outcome, transcript, events, pending, system, slots, metrics };
}
