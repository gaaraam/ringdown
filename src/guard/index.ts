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
