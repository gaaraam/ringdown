/**
 * Pack 스키마: 조직 하나를 붙이는 데 필요한 모든 설정.
 * 구조 검증(zod)만 여기서 하고, 파일 간 참조 검증은 validate.ts에서 한다.
 */
import { z } from "zod";

export const Id = z.string().regex(/^[a-z][a-z0-9-]*$/, "소문자로 시작하는 kebab-case여야 합니다");
/** 도구 이름: `<namespace>.<name>` (예: crm.lookup) */
export const ToolName = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/, "`namespace.name` 형식이어야 합니다");
/** 업무 API 오퍼레이션: `METHOD /path/{param}` */
export const OpSpec = z
  .string()
  .regex(/^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9_\-/{}]*$/, "`METHOD /path/{param}` 형식이어야 합니다");

/** 엔진이 제공하는 도구. Pack 도구는 이 네임스페이스를 쓸 수 없다. */
export const RESERVED_NAMESPACES = ["kb", "call"] as const;
export const BUILTIN_TOOLS = ["kb.search", "call.scheduleCallback", "call.handoff"] as const;

/** 엔진이 기본으로 아는 고객 의도. Pack은 `intents`로 키워드를 추가하거나 새 의도를 정의한다. */
export const BUILTIN_INTENTS = [
  "yes",
  "no",
  "question",
  "busy",
  "opt_out",
  "request_human",
  "unknown",
] as const;

export const OUTCOMES = [
  "success",
  "callback_scheduled",
  "pending_confirmation",
  "declined",
  "opted_out",
  "handoff",
  "failed",
] as const;
export const Outcome = z.enum(OUTCOMES);
export type Outcome = z.infer<typeof Outcome>;

export const METRICS = [
  "goal_rate",
  "acceptable_rate",
  "barge_in_rate",
  "long_call_rate",
  "turn_latency_p95",
  "dead_air_incidents",
  "degraded_survival",
  "policy_violations",
  "brain_fallbacks",
] as const;

const GateExpr = z
  .string()
  .regex(/^(>=|<=|==|>|<)\s*-?\d+(\.\d+)?$/, "`>= 0.5` 같은 비교식이어야 합니다");

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM 형식이어야 합니다");

const Param = z.strictObject({
  type: z.enum(["string", "number", "boolean"]),
  enum: z.array(z.string()).optional(),
  /** 값의 출처. target: 통화 대상 ID, slot: 대화에서 채운 슬롯, model: Brain이 채움 */
  source: z.enum(["target", "slot", "model"]),
  slot: z.string().optional(),
  description: z.string().optional(),
});

const FailureKind = z.enum(["timeout", "5xx", "unavailable"]);

export const Tool = z.strictObject({
  jack: Id,
  op: OpSpec,
  kind: z.enum(["read", "write"]),
  description: z.string().min(1),
  params: z.record(z.string(), Param).default({}),
  timeoutMs: z.number().int().min(100).max(30_000),
  retry: z
    .strictObject({ max: z.number().int().min(0).max(5), on: z.array(FailureKind).min(1) })
    .default({ max: 0, on: ["timeout"] }),
  idempotency: z.strictObject({ header: z.string().min(1) }).optional(),
  /** 재시도까지 실패했을 때 통화에서 할 일 */
  onFailure: z.enum(["defer_callback", "confirm_later", "handoff", "skip"]),
  /** 결과에서 사실(fact)로 남길 필드. 숫자 근거 검사의 재료가 된다 */
  facts: z.array(z.string()).default([]),
});
export type Tool = z.infer<typeof Tool>;

const RuleAction = z.strictObject({
  goto: Id.optional(),
  tool: ToolName.optional(),
  set: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  say: z.string().optional(),
  end: Outcome.optional(),
});

export const Stage = z.strictObject({
  id: Id,
  /** 이 단계에서 Brain이 이뤄야 할 것 (LLM 프롬프트에 들어간다) */
  goal: z.string().min(1),
  allowTools: z.array(ToolName).default([]),
  /** true면 이 단계의 쓰기 도구는 `consent` 슬롯이 true일 때만 실행된다 */
  requireConsent: z.boolean().default(false),
  next: z.array(Id).default([]),
  terminal: z.boolean().default(false),
  /** RuleBrain(오프라인 기준선)과 LLM 실패 시 대체 응답에 쓰는 스크립트 */
  rule: z
    .strictObject({
      say: z.string().min(1),
      on: z.record(z.string(), RuleAction).default({}),
    })
    .optional(),
});
export type Stage = z.infer<typeof Stage>;

const Slot = z.strictObject({
  type: z.enum(["string", "number", "boolean"]),
  enum: z.array(z.string()).optional(),
  /** enum 값을 말로 읽을 때 쓰는 이름. 예) paid-3000 → "반품 배송비 3천 원" */
  labels: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
});

export const Pack = z.strictObject({
  id: Id,
  version: z.number().int().positive(),
  name: z.string().min(1),
  locale: z.string().default("ko-KR"),
  call: z.strictObject({
    direction: z.enum(["outbound", "inbound"]).default("outbound"),
    /** 통화 대상이 업무 시스템의 어떤 레코드인지 */
    target: z.strictObject({ collection: z.string(), idParam: z.string() }),
    /** 인사 전에 실행할 조회 도구. 실패하면 도구의 onFailure를 따른다 */
    prefetch: z.array(ToolName).default([]),
  }),
  goal: z.strictObject({
    description: z.string().min(1),
    /** 성공은 업무 시스템 상태로 판정한다 (Brain의 주장으로 판정하지 않는다) */
    success: z.strictObject({
      collection: z.string(),
      field: z.string(),
      op: z.enum(["exists", "equals"]),
      value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
    acceptableOutcomes: z.array(Outcome).default([]),
  }),
  policy: z.strictObject({
    callWindow: z.strictObject({
      days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).min(1),
      from: Hhmm,
      to: Hhmm,
      tz: z.string().default("Asia/Seoul"),
    }),
    /** 고정 고지 문구. LLM이 생성하지 않는다 */
    disclosure: z.string().min(1),
    maxTurnSpeechSec: z.number().positive().default(12),
    maxCallSec: z.number().positive().default(180),
    silenceMaxSec: z.number().positive().default(3),
    turnLatencyBudgetMs: z.number().int().positive().default(800),
    fillerPhrases: z.array(z.string().min(1)).min(1).default(["확인해 볼게요, 잠시만요."]),
    handoffTarget: z.string().min(1),
    forbidden: z.array(z.string()).default([]),
  }),
  intents: z.record(z.string(), z.array(z.string().min(1))).default({}),
  slots: z.record(z.string(), Slot).default({}),
  stages: z.array(Stage).min(1),
  tools: z.record(ToolName, Tool).default({}),
  gates: z.partialRecord(z.enum(METRICS), GateExpr).default({}),
});
export type Pack = z.infer<typeof Pack>;

export const JackConfig = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("mock") }),
  z.strictObject({
    type: z.literal("http-json"),
    baseUrl: z.string().min(1),
    /** 비밀값은 환경변수 이름만 적는다 */
    auth: z
      .strictObject({ type: z.literal("bearer"), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/) })
      .optional(),
  }),
]);
export const Jacks = z.record(Id, JackConfig);
export type Jacks = z.infer<typeof Jacks>;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const Mock = z.strictObject({
  collections: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
  routes: z.array(
    z.strictObject({
      op: OpSpec,
      action: z.enum(["read", "patch", "create"]),
      collection: z.string(),
      /** 경로 파라미터 중 레코드 키로 쓸 것 (read/patch) */
      key: z.string().optional(),
      /** patch 대상 필드. 없으면 body 전체를 병합 */
      field: z.string().optional(),
    }),
  ),
  /** 조직별로 장애 프로파일의 일부 값을 덮어쓸 때 */
  scalars: z.record(z.string(), Scalar).optional(),
});
export type Mock = z.infer<typeof Mock>;

export const Persona = z.strictObject({
  id: Id,
  targetId: z.string().min(1),
  description: z.string().min(1),
  /** 0~1. 낮을수록 긴 발화에 빨리 끼어든다 */
  patience: z.number().min(0).max(1),
  /** 0~1. 높을수록 제안을 받아들인다 */
  cooperativeness: z.number().min(0).max(1),
  intent: z.enum(["accept", "accept_if_short", "ask_then_accept", "decline", "opt_out", "request_human", "busy"]),
  knowledge: z.enum(["low", "mid", "high"]).default("mid"),
  quirks: z.array(z.enum(["interrupts", "topic_switch", "silence", "asks_question", "mishears"])).default([]),
  /** 초당 음절 수 */
  speechRate: z.number().positive().default(7),
});
export const Personas = z.array(Persona);
export type Persona = z.infer<typeof Persona>;
