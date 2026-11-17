/**
 * LLM 클라이언트 경계. Brain과 페르소나는 이 인터페이스만 안다.
 * 공급자 구현은 providers.ts에서 등록하고, 모델은 src/config/models.ts가 정한다.
 */
import type { ResolvedModel } from "../config/models.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** 고정 부분(정책·단계 설명). KV 캐시 재사용을 위해 턴마다 바뀌는 값을 넣지 않는다 */
  system: string;
  messages: ChatMessage[];
  /** 주면 이 JSON 스키마를 지키는 출력을 강제한다 */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  /** jsonSchema를 줬고 파싱에 성공했을 때 */
  json?: unknown;
  model: string;
  latencyMs: number;
  firstTokenMs?: number;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  readonly label: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type LlmFactory = (spec: ResolvedModel) => LlmClient;

const factories = new Map<string, LlmFactory>();

/** 공급자 등록. 새 공급자를 붙일 때 엔진 코드는 바뀌지 않는다 */
export function registerProvider(provider: string, factory: LlmFactory): void {
  factories.set(provider, factory);
}

export function createLlmClient(spec: ResolvedModel): LlmClient {
  const f = factories.get(spec.provider);
  if (!f) {
    throw new Error(
      `LLM 공급자 '${spec.provider}'가 등록되지 않았습니다 (role=${spec.role}). ` +
        `등록된 공급자: ${[...factories.keys()].join(", ") || "(없음)"}`,
    );
  }
  return f(spec);
}
