import type { Plan, TurnContext } from "../core/types.ts";
import { classify } from "../brain/rule.ts";

export const SAFE_PHRASE = "확인 후 안내드릴게요.";
export const syllables = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
export const durationMs = (text: string, rate = 7): number => Math.ceil(syllables(text) / rate * 1000);

export function preGuard(text: string, ctx: TurnContext): "opted_out" | "handoff" | undefined {
  const intent = classify(text, ctx.pack.pack.intents);
  return intent === "opt_out" ? "opted_out" : intent === "request_human" ? "handoff" : undefined;
}
/** 동의 슬롯은 현재 확인 단계의 실제 긍정 발화가 있을 때만 새로 설정할 수 있다. */
export function checkPlan(plan: Plan, ctx: TurnContext): string | undefined {
  const pack = ctx.pack.pack;
  const user = [...ctx.transcript].reverse().find((t) => t.role === "user");
  for (const [key, value] of Object.entries(plan.setSlots ?? {})) {
    const slot = pack.slots[key];
    if (!slot || typeof value !== slot.type || (slot.enum && !slot.enum.includes(String(value)))) return "invalid_slot";
    if (key === "consent" && value === true && (!ctx.stage.requireConsent || classify(user?.text ?? "", pack.intents) !== "yes")) return "consent_not_explicit";
  }
  const consent = plan.setSlots?.consent ?? ctx.slots.consent?.value;
  for (const call of plan.tools ?? []) {
    if (!ctx.stage.allowTools.includes(call.tool)) return "tool_not_allowed";
    if (pack.tools[call.tool]?.kind === "write" && consent !== true) return "write_without_consent";
  }
  if (plan.transition && !ctx.stage.next.includes(plan.transition)) return "transition_not_allowed";
  return checkEnd(plan, ctx);
}

/**
 * 종료 권한 검사. Brain은 종료를 제안할 뿐이고, 그 종료가 실제 상태와 맞는지는 런타임이 정한다.
 * - pending_confirmation: 쓰기 결과를 모를 때 런타임만 선언한다.
 * - opted_out: 수신 거부는 고객 발화의 입력 정책으로만 정한다. 두뇌가 선언하면 협조적인 고객을 다시 부를 수 없게 된다.
 * - handoff: 어느 단계에서든 허용한다. 런타임이 이관 요청을 등록한다.
 * - 그 밖의 종료: 종료 단계로 전이하거나 이미 종료 단계여야 한다. 질문하면서 통화를 끝내는 것을 막는다.
 * - callback_scheduled: 같은 계획에서 콜백 등록 도구를 실제로 호출해야 한다.
 */
/** 수신 거부와 확인 대기는 런타임만 정한다. 두뇌가 수신 거부로 끝내면 협조적인 고객을 다시 못 부르게 된다. */
const RUNTIME_ENDS = new Set(["opted_out", "pending_confirmation"]);
const has = (plan: Plan, tool: string) => (plan.tools ?? []).some((t) => t.tool === tool);
function checkEnd(plan: Plan, ctx: TurnContext): string | undefined {
  if (!plan.end) return undefined;
  if (RUNTIME_ENDS.has(plan.end)) return "end_reserved_for_runtime";
  if (plan.end === "handoff") return undefined; // 런타임이 이관 등록을 보장한다
  const target = plan.transition ? ctx.pack.pack.stages.find((s) => s.id === plan.transition) : ctx.stage;
  if (!target?.terminal) return "end_without_terminal_stage";
  if (plan.end === "callback_scheduled" && !has(plan, "call.scheduleCallback")) return "end_without_effect";
  return undefined;
}

/** 숫자 표기를 값으로 정규화한다. 천·만·억 혼합 금액도 같은 값으로 비교한다. */
export function numbers(text: string): string[] {
  const matches = text.match(/(?:\d[\d,]*(?:\.\d+)?\s*[십백천만억]?)(?:\s*\d[\d,]*(?:\.\d+)?\s*[십백천만억])*/g) ?? [];
  const units: Record<string, number> = { 십: 10, 백: 100, 천: 1000, 만: 10000, 억: 100000000 };
  return matches.map((match) => {
    let total = 0;
    let section = 0;
    for (const part of match.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([십백천만억]?)/g)) {
      const value = Number(part[1]!.replaceAll(",", ""));
      const unit = units[part[2]!] ?? 1;
      if (unit >= 10000) { total += (section + value) * unit; section = 0; }
      else section += value * unit;
    }
    return String(total + section);
  });
}
export function groundedCorpus(ctx: TurnContext): string[] {
  const p = ctx.pack.pack;
  return [
    ...ctx.facts.map((f) => String(f.value)),
    ...Object.values(p.slots).flatMap((s) => Object.values(s.labels ?? {})),
    ...ctx.pack.kb.map((d) => d.text),
    ...p.stages.flatMap((s) => [s.rule?.say ?? "", ...Object.values(s.rule?.on ?? {}).map((a) => a.say ?? "")]),
    p.policy.disclosure, ...p.policy.fillerPhrases,
  ];
}
export function postGuard(text: string, corpus: string[], forbidden: string[], maxSec: number): { text: string; hits: string[] } {
  const grounded = new Set(corpus.flatMap(numbers));
  const hits: string[] = [];
  const sentences = text.split(/(?<=[!?])\s*|(?<=\.)(?!\d)\s*|\n+/).filter(Boolean);
  const accepted = sentences.map((s) => s.trim()).filter((s) => {
    if (forbidden.some((phrase) => s.includes(phrase))) { hits.push("forbidden"); return false; }
    if (numbers(s).some((n) => !grounded.has(n))) { hits.push("numeric_grounding"); return false; }
    return true;
  });
  let output = "";
  for (const sentence of accepted) {
    const next = [output, sentence].filter(Boolean).join(" ");
    if (durationMs(next) > maxSec * 1000) { hits.push("speech_length"); break; }
    output = next;
  }
  if (!output) output = durationMs(SAFE_PHRASE) <= maxSec * 1000 ? SAFE_PHRASE : "네.";
  return { text: output, hits };
}
