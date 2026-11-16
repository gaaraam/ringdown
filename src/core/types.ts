/**
 * 엔진의 핵심 계약. 구현(src/brain, src/jacks, src/transport)은 이 타입에만 의존한다.
 */
import type { LoadedPack } from "../pack/load.ts";
import type { Outcome, Stage } from "../pack/schema.ts";

export type Scalar = string | number | boolean;

// ── 상태 ──────────────────────────────────────────────────────

/** 도구 결과나 KB에서 온 값. 출처가 없는 값은 발화에 쓸 수 없다 */
export interface Fact {
  key: string;
  value: Scalar;
  source: { kind: "tool"; tool: string; callSeq: number } | { kind: "kb"; chunkId: string } | { kind: "target" };
}

export interface SlotValue {
  value: Scalar;
  /** 이 값을 채운 고객 발화의 턴 번호 */
  turn: number;
}

export interface AgentTurn {
  role: "agent";
  seq: number;
  /** 의도한 문장 */
  text: string;
  /** 끼어들기로 잘렸다면 실제로 들린 부분 */
  heard: string;
  interrupted: boolean;
  startedAt: number;
  endedAt: number;
}

export interface UserTurn {
  role: "user";
  seq: number;
  text: string;
  startedAt: number;
  endedAt: number;
  /** ASR 신뢰도 (음성일 때만) */
  confidence?: number;
}

export type Turn = AgentTurn | UserTurn;

// ── Brain ─────────────────────────────────────────────────────

export interface ToolCall {
  tool: string;
  args: Record<string, Scalar>;
}

export interface Plan {
  /** 도구 결과 없이 바로 할 말 (도구가 있으면 compose 결과로 대체될 수 있다) */
  say?: string;
  tools?: ToolCall[];
  transition?: string;
  setSlots?: Record<string, Scalar>;
  end?: Outcome;
  /** Brain이 분류한 고객 의도 (trace·지표용) */
  intent?: string;
}

export interface TurnContext {
  pack: LoadedPack;
  stage: Stage;
  slots: Record<string, SlotValue>;
  facts: Fact[];
  transcript: Turn[];
  /** 직전 에이전트 발화가 끊겼다면 들린 부분까지 */
  interruptedAt?: string;
  /** 직전 Plan이 정책 검사에서 거부됐다면 그 사유 (1회 재요청용) */
  rejection?: string;
}

export type ToolResult =
  | { call: ToolCall; status: "ok"; data: unknown }
  | { call: ToolCall; status: "failed"; kind: JackErrorKind; handledAs: string };

export interface Brain {
  readonly id: string;
  plan(ctx: TurnContext): Promise<Plan>;
  compose(ctx: TurnContext, results: ToolResult[]): Promise<string>;
}

// ── Jack (업무 시스템 연동) ───────────────────────────────────

export type JackErrorKind = "timeout" | "5xx" | "4xx" | "unavailable" | "unknown_outcome";

export interface JackRequest {
  op: string;
  pathParams: Record<string, Scalar>;
  body?: Record<string, Scalar>;
  idempotencyKey?: string;
  /** 시뮬레이션 시각 (ms). mock이 장애를 시각 기준으로 재현하는 데 쓴다 */
  now: number;
}

export type JackResult =
  | { status: "ok"; data: unknown; latencyMs: number }
  | { status: "error"; kind: JackErrorKind; latencyMs: number; httpStatus?: number };

export interface Jack {
  readonly id: string;
  call(req: JackRequest): Promise<JackResult>;
}

// ── Transport ────────────────────────────────────────────────

export interface SpeechHandle {
  /** 송출이 끝나거나 끊겼을 때 resolve */
  done: Promise<{ interrupted: boolean; heard: string; endedAt: number }>;
}

export interface Transport {
  onUserUtterance(cb: (u: Omit<UserTurn, "role" | "seq">) => void): void;
  speak(text: string, at: number): SpeechHandle;
  hangup(reason: string, at: number): void;
}
