import type { ResolvedModel } from "../config/models.ts";

export class LlmError extends Error {
  constructor(readonly kind: "timeout" | "http" | "invalid_json", message: string) { super(message); this.name = `LlmError(${kind})`; }
}
/** 본문 수신까지 하나의 데드라인을 적용한다. */
export async function requestJson(spec: ResolvedModel, route: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const timeout = AbortSignal.timeout(spec.timeoutMs);
  try {
    const response = await fetch(`${spec.baseUrl?.replace(/\/$/, "")}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!response.ok) throw new LlmError("http", `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    try { return JSON.parse(await response.text()); }
    catch (e) { if (timeout.aborted || signal?.aborted) throw e; throw new LlmError("invalid_json", "공급자 응답 JSON 파싱 실패"); }
  } catch (e) {
    if (timeout.aborted || signal?.aborted) throw new LlmError("timeout", "LLM 요청 제한 시간 초과 또는 취소");
    if (e instanceof LlmError) throw e;
    throw new LlmError("http", String(e));
  }
}
export function parseOutput(text: unknown, structured: boolean): { text: string; json?: unknown } {
  if (typeof text !== "string") throw new LlmError("invalid_json", "응답 content가 문자열이 아닙니다");
  if (!structured) return { text };
  try { return { text, json: JSON.parse(text) }; }
  catch { throw new LlmError("invalid_json", "모델 출력 JSON 파싱 실패"); }
}
