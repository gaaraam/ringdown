/**
 * 파일 간 참조 검증. zod가 잡지 못하는 "설정끼리 맞물리는가"를 본다.
 * 오류마다 고정 코드를 붙여서, 테스트와 운영자가 같은 언어로 이야기하게 한다.
 */
import {
  BUILTIN_INTENTS,
  BUILTIN_TOOLS,
  RESERVED_NAMESPACES,
  type Jacks,
  type Mock,
  type Pack,
  type Persona,
} from "./schema.ts";

export type IssueCode =
  | "SCHEMA"
  | "FILE_MISSING"
  | "STAGE_DUPLICATE"
  | "STAGE_NEXT_UNKNOWN"
  | "STAGE_UNREACHABLE"
  | "NO_TERMINAL_STAGE"
  | "TERMINAL_HAS_NEXT"
  | "TOOL_UNKNOWN"
  | "TOOL_RESERVED_NAMESPACE"
  | "WRITE_WITHOUT_IDEMPOTENCY"
  | "WRITE_WITHOUT_CONSENT"
  | "CONSENT_SLOT_MISSING"
  | "JACK_UNKNOWN"
  | "PATH_PARAM_UNDECLARED"
  | "PARAM_SLOT_UNKNOWN"
  | "PARAM_TARGET_MISMATCH"
  | "SKIP_ON_WRITE"
  | "MOCK_REQUIRED"
  | "MOCK_ROUTE_MISSING"
  | "MOCK_COLLECTION_UNKNOWN"
  | "INTENT_UNKNOWN"
  | "RULE_GOTO_NOT_IN_NEXT"
  | "RULE_TOOL_NOT_ALLOWED"
  | "RULE_SLOT_UNKNOWN"
  | "TEMPLATE_REF_UNKNOWN"
  | "RULE_SAY_TOO_LONG"
  | "PREFETCH_INVALID"
  | "CALL_WINDOW_INVALID"
  | "KB_EMPTY"
  | "PERSONA_DUPLICATE"
  | "PERSONA_TARGET_UNKNOWN";

export interface Issue {
  code: IssueCode;
  /** 사람이 읽는 위치. 예: pack.yaml#stages[2].next */
  where: string;
  message: string;
}

export interface PackParts {
  pack: Pack;
  jacks: Jacks;
  mock?: Mock;
  personas: Persona[];
  kbFiles: string[];
}

const pathParams = (op: string): string[] =>
  [...op.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

const opPathPattern = (op: string): string => op.replace(/\{[^}]+\}/g, "{}");

export function validatePack(parts: PackParts): Issue[] {
  const { pack, jacks, mock, personas, kbFiles } = parts;
  const issues: Issue[] = [];
  const add = (code: IssueCode, where: string, message: string) => issues.push({ code, where, message });

  // ── 단계 그래프 ──────────────────────────────────────────────
  const stageIds = new Set<string>();
  pack.stages.forEach((s, i) => {
    if (stageIds.has(s.id)) add("STAGE_DUPLICATE", `pack.yaml#stages[${i}]`, `단계 ID '${s.id}'가 중복됩니다`);
    stageIds.add(s.id);
  });

  pack.stages.forEach((s, i) => {
    for (const n of s.next) {
      if (!stageIds.has(n)) add("STAGE_NEXT_UNKNOWN", `pack.yaml#stages[${i}].next`, `'${s.id}' → '${n}': 없는 단계입니다`);
    }
    if (s.terminal && s.next.length > 0) {
      add("TERMINAL_HAS_NEXT", `pack.yaml#stages[${i}]`, `종료 단계 '${s.id}'에 next가 있습니다`);
    }
  });

  if (!pack.stages.some((s) => s.terminal)) {
    add("NO_TERMINAL_STAGE", "pack.yaml#stages", "terminal: true인 종료 단계가 하나 이상 필요합니다");
  }

  // 첫 단계에서 도달 가능한지
  const byId = new Map(pack.stages.map((s) => [s.id, s]));
  const reached = new Set<string>();
  const queue = [pack.stages[0]!.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const n of byId.get(id)?.next ?? []) queue.push(n);
  }
  pack.stages.forEach((s, i) => {
    if (!reached.has(s.id)) add("STAGE_UNREACHABLE", `pack.yaml#stages[${i}]`, `'${s.id}'는 첫 단계에서 도달할 수 없습니다`);
  });

  // ── 도구 ────────────────────────────────────────────────────
  const toolNames = new Set<string>([...Object.keys(pack.tools), ...BUILTIN_TOOLS]);
  const consentDeclared = pack.slots["consent"]?.type === "boolean";

  for (const [name, tool] of Object.entries(pack.tools)) {
    const where = `pack.yaml#tools.${name}`;
    const ns = name.split(".")[0]!;
    if ((RESERVED_NAMESPACES as readonly string[]).includes(ns)) {
      add("TOOL_RESERVED_NAMESPACE", where, `'${ns}.' 네임스페이스는 엔진 예약어입니다`);
    }
    const jack = jacks[tool.jack];
    if (!jack) add("JACK_UNKNOWN", `${where}.jack`, `jacks.yaml에 '${tool.jack}' 연결이 없습니다`);

    if (tool.kind === "write" && !tool.idempotency) {
      add("WRITE_WITHOUT_IDEMPOTENCY", where, "쓰기 도구는 멱등 키(idempotency.header)가 필요합니다");
    }
    if (tool.kind === "write" && tool.onFailure === "skip") {
      add("SKIP_ON_WRITE", `${where}.onFailure`, "쓰기 도구의 실패를 skip으로 넘길 수 없습니다");
    }

    for (const p of pathParams(tool.op)) {
      if (!tool.params[p]) add("PATH_PARAM_UNDECLARED", `${where}.op`, `경로 파라미터 '{${p}}'가 params에 없습니다`);
    }
    for (const [pname, param] of Object.entries(tool.params)) {
      if (param.source === "slot" && !(param.slot && pack.slots[param.slot])) {
        add("PARAM_SLOT_UNKNOWN", `${where}.params.${pname}`, `slot '${param.slot ?? "(없음)"}'이 slots에 선언되지 않았습니다`);
      }
      if (param.source === "target" && pname !== pack.call.target.idParam) {
        add(
          "PARAM_TARGET_MISMATCH",
          `${where}.params.${pname}`,
          `source: target 파라미터 이름은 call.target.idParam('${pack.call.target.idParam}')과 같아야 합니다`,
        );
      }
    }

    if (jack?.type === "mock") {
      if (!mock) {
        add("MOCK_REQUIRED", `${where}.jack`, "mock 연결을 쓰려면 mock.yaml이 필요합니다");
      } else if (!mock.routes.some((r) => opPathPattern(r.op) === opPathPattern(tool.op))) {
        add("MOCK_ROUTE_MISSING", `${where}.op`, `mock.yaml에 '${tool.op}' 라우트가 없습니다`);
      }
    }
  }

  pack.stages.forEach((s, i) => {
    for (const t of s.allowTools) {
      if (!toolNames.has(t)) add("TOOL_UNKNOWN", `pack.yaml#stages[${i}].allowTools`, `'${t}' 도구가 정의되지 않았습니다`);
      const tool = pack.tools[t];
      if (tool?.kind === "write" && !s.requireConsent) {
        add("WRITE_WITHOUT_CONSENT", `pack.yaml#stages[${i}]`, `쓰기 도구 '${t}'를 허용하는 단계는 requireConsent: true여야 합니다`);
      }
    }
    if (s.requireConsent && !consentDeclared) {
      add("CONSENT_SLOT_MISSING", `pack.yaml#stages[${i}]`, "requireConsent를 쓰려면 slots.consent(boolean)를 선언해야 합니다");
    }
  });

  // ── RuleBrain 스크립트 ───────────────────────────────────────
  const intents = new Set<string>([...BUILTIN_INTENTS, ...Object.keys(pack.intents)]);
  pack.stages.forEach((s, i) => {
    if (!s.rule) return;
    for (const [intent, action] of Object.entries(s.rule.on)) {
      const where = `pack.yaml#stages[${i}].rule.on.${intent}`;
      if (!intents.has(intent)) add("INTENT_UNKNOWN", where, `알 수 없는 의도 '${intent}' (intents에 정의하세요)`);
      if (action.goto && !s.next.includes(action.goto)) {
        add("RULE_GOTO_NOT_IN_NEXT", where, `'${action.goto}'는 '${s.id}'의 next에 없습니다`);
      }
      if (action.tool && !s.allowTools.includes(action.tool)) {
        add("RULE_TOOL_NOT_ALLOWED", where, `'${action.tool}'는 '${s.id}'의 allowTools에 없습니다`);
      }
      for (const slot of Object.keys(action.set ?? {})) {
        if (!pack.slots[slot]) add("RULE_SLOT_UNKNOWN", where, `slot '${slot}'이 선언되지 않았습니다`);
      }
    }
  });

  // ── 템플릿 참조: {{slot.x}}, {{fact.y}} ─────────────────────
  const factKeys = new Set(Object.values(pack.tools).flatMap((t) => t.facts));
  const checkTemplate = (text: string, where: string) => {
    for (const m of text.matchAll(/\{\{\s*(\w+)\.(\w+)\s*\}\}/g)) {
      const [, kind, key] = m;
      const ok = kind === "slot" ? !!pack.slots[key!] : kind === "fact" ? factKeys.has(key!) : false;
      if (!ok) add("TEMPLATE_REF_UNKNOWN", where, `템플릿 참조 '${m[0]}'를 찾을 수 없습니다 (slot은 slots, fact는 tools.*.facts에 있어야 함)`);
    }
  };
  pack.stages.forEach((s, i) => {
    if (!s.rule) return;
    checkTemplate(s.rule.say, `pack.yaml#stages[${i}].rule.say`);
    for (const [intent, a] of Object.entries(s.rule.on)) {
      if (a.say) checkTemplate(a.say, `pack.yaml#stages[${i}].rule.on.${intent}.say`);
    }
  });

  // ── 스크립트 발화 길이: 상한을 넘으면 런타임이 문장을 잘라서 뒷부분(대개 질문)이 사라진다 ──
  // 초당 7음절 기준. 사실(fact)은 5음절, 슬롯은 가장 긴 레이블로 어림한다.
  const estimateSec = (text: string) => {
    const expanded = text.replace(/\{\{\s*(\w+)\.(\w+)\s*\}\}/g, (_m, kind: string, key: string) => {
      if (kind === "slot") {
        const labels = Object.values(pack.slots[key]?.labels ?? {});
        return labels.reduce((a, b) => (b.length > a.length ? b : a), "다섯음절값");
      }
      return "다섯음절값";
    });
    return (expanded.match(/[\p{L}\p{N}]/gu) ?? []).length / 7;
  };
  const checkLength = (text: string, where: string) => {
    const sec = estimateSec(text);
    if (sec > pack.policy.maxTurnSpeechSec) {
      add("RULE_SAY_TOO_LONG", where, `약 ${sec.toFixed(1)}초로 발화 상한 ${pack.policy.maxTurnSpeechSec}초를 넘습니다. 넘는 문장은 잘려서 송출되지 않습니다`);
    }
  };
  pack.stages.forEach((s, i) => {
    if (!s.rule) return;
    checkLength(s.rule.say, `pack.yaml#stages[${i}].rule.say`);
    for (const [intent, a] of Object.entries(s.rule.on)) {
      if (a.say) checkLength(a.say, `pack.yaml#stages[${i}].rule.on.${intent}.say`);
    }
  });

  pack.call.prefetch.forEach((t, i) => {
    const tool = pack.tools[t];
    if (!tool) add("PREFETCH_INVALID", `pack.yaml#call.prefetch[${i}]`, `'${t}' 도구가 정의되지 않았습니다`);
    else if (tool.kind !== "read") add("PREFETCH_INVALID", `pack.yaml#call.prefetch[${i}]`, `prefetch에는 조회(read) 도구만 쓸 수 있습니다`);
  });

  // ── 목표·대상과 mock 데이터 ──────────────────────────────────
  if (mock) {
    const cols = new Set(Object.keys(mock.collections));
    if (!cols.has(pack.call.target.collection)) {
      add("MOCK_COLLECTION_UNKNOWN", "pack.yaml#call.target.collection", `mock.yaml에 '${pack.call.target.collection}' 컬렉션이 없습니다`);
    }
    if (!cols.has(pack.goal.success.collection)) {
      add("MOCK_COLLECTION_UNKNOWN", "pack.yaml#goal.success.collection", `mock.yaml에 '${pack.goal.success.collection}' 컬렉션이 없습니다`);
    }
    mock.routes.forEach((r, i) => {
      if (!cols.has(r.collection)) add("MOCK_COLLECTION_UNKNOWN", `mock.yaml#routes[${i}]`, `'${r.collection}' 컬렉션이 없습니다`);
    });
  }

  // ── 정책 ────────────────────────────────────────────────────
  const { from, to } = pack.policy.callWindow;
  if (from >= to) add("CALL_WINDOW_INVALID", "pack.yaml#policy.callWindow", `시작(${from})이 끝(${to})보다 늦거나 같습니다`);

  // ── 지식·페르소나 ───────────────────────────────────────────
  if (kbFiles.length === 0) add("KB_EMPTY", "kb/", "kb/에 마크다운 문서가 하나 이상 필요합니다");

  const personaIds = new Set<string>();
  const targets = mock?.collections[pack.call.target.collection];
  personas.forEach((p, i) => {
    if (personaIds.has(p.id)) add("PERSONA_DUPLICATE", `personas.yaml[${i}]`, `페르소나 ID '${p.id}'가 중복됩니다`);
    personaIds.add(p.id);
    if (targets && !targets[p.targetId]) {
      add("PERSONA_TARGET_UNKNOWN", `personas.yaml[${i}].targetId`, `'${p.targetId}'가 mock.yaml의 ${pack.call.target.collection}에 없습니다`);
    }
  });

  return issues;
}
