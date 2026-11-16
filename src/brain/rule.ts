import type { Brain, Plan, ToolResult, TurnContext } from "../core/types.ts";
import { BUILTIN_INTENTS } from "../pack/schema.ts";
import type { Chunk } from "../knowledge/bm25.ts";

export const KEYWORDS: Record<string, string[]> = {
  opt_out: ["전화하지", "그만 연락", "수신 거부", "연락하지"],
  // "사람"만으로는 잡지 않는다. "사람들이 반품을…" 같은 평범한 문장이 이관으로 끝나기 때문이다.
  request_human: ["사람 상담원", "사람이랑", "사람 바꿔", "사람 연결", "상담원 연결", "상담원 바꿔", "담당자 연결", "매니저"],
  busy: ["바빠", "바쁩니다", "나중에", "운전", "회의"],
  no: ["아니", "싫", "필요 없", "안 할", "괜찮습니다"],
  yes: ["네", "예", "맞아", "좋아", "동의", "진행해"],
  question: ["왜", "어떻게", "궁금", "질문", "?"],
};
/**
 * 한 글자 키워드("네", "예")는 부분 문자열로 맞추면 "이야기예요"가 긍정이 된다.
 * 한 글자짜리는 어절 전체가 그 글자의 반복(+요)일 때만 맞는 것으로 본다. 예) 네, 네네, 예요
 */
function hasKeyword(text: string, word: string): boolean {
  if ([...word].length > 1 || !/\p{L}/u.test(word)) return text.includes(word);
  const tokens = text.split(/[\s.,!?~…]+/).filter(Boolean);
  const pattern = new RegExp(`^(?:${word})+요?$`, "u");
  return tokens.some((t) => pattern.test(t));
}

export function classify(text: string, intents: Record<string, string[]> = {}): string {
  const matches = (key: string) => [...(KEYWORDS[key] ?? []), ...(intents[key] ?? [])].some((word) => hasKeyword(text, word));
  const custom = Object.keys(intents).filter((key) => !(BUILTIN_INTENTS as readonly string[]).includes(key));
  return ["opt_out", "request_human", ...custom, "busy", "no", "yes", "question"].find(matches) ?? "unknown";
}
export function render(text: string, ctx: TurnContext): string {
  return text.replace(/\{\{\s*(fact|slot)\.(\w+)\s*\}\}/g, (_, kind: string, key: string) => {
    if (kind === "fact") return String([...ctx.facts].reverse().find((f) => f.key === key)?.value ?? "확인되지 않은 정보");
    const value = ctx.slots[key]?.value;
    return ctx.pack.pack.slots[key]?.labels?.[String(value)] ?? String(value ?? "선택한 항목");
  });
}
export class RuleBrain implements Brain {
  readonly id = "rule";
  private unknowns = 0;
  private lastTurn = -1;
  private proposed: Plan = {};
  async plan(ctx: TurnContext): Promise<Plan> {
    const user = [...ctx.transcript].reverse().find((t) => t.role === "user");
    const intent = classify(user?.text ?? "", ctx.pack.pack.intents);
    if (user?.seq !== this.lastTurn) {
      this.unknowns = intent === "unknown" ? this.unknowns + 1 : 0;
      this.lastTurn = user?.seq ?? -1;
    }
    if (ctx.rejection) return this.proposed = { say: "확인이 필요합니다. 다시 말씀해 주시겠어요?", intent };
    if (intent === "unknown") return this.proposed = this.unknowns >= 2
      ? { say: "상담원에게 연결해 드릴게요.", end: "handoff", intent }
      : { say: "다시 짧게 말씀해 주시겠어요?", intent };
    const action = ctx.stage.rule?.on[intent];
    if (!action) return this.proposed = { say: "원하시는 내용을 다시 말씀해 주시겠어요?", intent };
    return this.proposed = {
      intent, setSlots: action.set, transition: action.goto, end: action.end,
      say: action.say,
      tools: action.tool ? [{ tool: action.tool, args: action.tool === "kb.search" ? { query: user?.text ?? "" } : {} }] : [],
    };
  }
  async compose(ctx: TurnContext, results: ToolResult[]): Promise<string> {
    const knowledge = results.find((r) => r.call.tool === "kb.search" && r.status === "ok");
    if (knowledge?.status === "ok") {
      const chunks = knowledge.data as Chunk[];
      // 인용 ID는 trace의 결과에 보존하고 음성에는 본문만 읽는다.
      // 자료에 답이 없으면 후속 연락을 약속하지 않는다 (등록되지 않는 약속은 지킬 수 없다)
      return chunks[0]?.text ?? "그 내용은 제가 가진 자료로는 정확히 안내드리기 어려워요.";
    }
    return render(this.proposed.say ?? ctx.stage.rule?.say ?? "감사합니다.", ctx);
  }
}
