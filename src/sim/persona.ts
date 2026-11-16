import type { LoadedPack } from "../pack/load.ts";
import type { Persona, Stage } from "../pack/schema.ts";
import { Rng } from "./rng.ts";

/** 단계와 규칙을 아는 scripted 지름길이다. 실제 고객 이해도나 대화 품질을 평가하지 않는다. */
export class ScriptedPersona {
  private asked = false;
  private turns = 0;
  constructor(readonly spec: Persona, private readonly rng: Rng) {}
  reply(stage: Stage, pack: LoadedPack, interrupted = false): string {
    this.turns++;
    const p = this.spec;
    if (p.intent === "opt_out") return "다시는 전화하지 마세요.";
    if (p.intent === "request_human") return "사람 상담원 연결해 주세요.";
    if (p.intent === "busy" || (p.intent === "accept_if_short" && interrupted)) return "지금 바빠요. 나중에 연락 주세요.";
    if (p.intent === "decline") return "아니요. 필요 없어요.";
    if ((p.quirks.includes("mishears") || p.quirks.includes("topic_switch")) && this.turns === 2 && this.rng.chance(0.5)) return "오늘 날씨 이야기예요.";
    if (!this.asked && stage.allowTools.includes("kb.search") && (p.intent === "ask_then_accept" || p.quirks.includes("asks_question"))) {
      this.asked = true;
      return "어떻게 변경하나요? 궁금해요.";
    }
    const choices = Object.keys(stage.rule?.on ?? {}).filter((intent) => pack.pack.intents[intent]);
    if (choices.length) {
      if (!this.rng.chance(p.cooperativeness)) return "아니요. 안 할게요.";
      return `${pack.pack.intents[this.rng.pick(choices)]![0]}으로 해 주세요.`;
    }
    return "네, 진행해 주세요.";
  }
  responseDelay(): number { return this.spec.quirks.includes("silence") ? 2500 : 300; }
  interruption(textDuration: number): number | undefined {
    const tolerance = (4 + 10 * this.spec.patience) * 1000;
    if (textDuration <= tolerance) return undefined;
    return this.rng.chance(this.spec.quirks.includes("interrupts") ? 0.95 : 0.5) ? tolerance : undefined;
  }
}
