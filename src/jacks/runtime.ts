import type { Jack, JackRequest, JackResult } from "../core/types.ts";
import type { Tool } from "../pack/schema.ts";
import { Rng } from "../sim/rng.ts";

export interface Attempt {
  at: number;
  endedAt: number;
  result: JackResult;
  idempotencyKey?: string;
}
export interface RuntimeResult {
  result: JackResult;
  elapsedMs: number;
  attempts: Attempt[];
}

/** 연결마다 하나씩 유지한다. 시간 이동은 호출자가 제공하는 가상 시계로만 한다. */
export class JackRuntime {
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  constructor(readonly jack: Jack, private readonly rng: Rng) {}

  /** Read-only observation; does not advance the breaker or consume a probe. */
  snapshot(now: number) {
    return { state: this.probing ? "half-open" : now < this.openUntil ? "open" : "closed",
      failures: this.failures, openUntil: this.openUntil, probeDue: this.openUntil > 0 && now >= this.openUntil };
  }

  async call(toolName: string, tool: Tool, request: Omit<JackRequest, "now" | "idempotencyKey">,
    opts: { callId: string; seq: number; now: number; until?: number;
      advance?: (to: number) => Promise<void>; onAttempt?: (attempt: Attempt) => void },
  ): Promise<RuntimeResult> {
    let now = opts.now;
    const attempts: Attempt[] = [];
    let result: JackResult = { status: "error", kind: "unavailable", latencyMs: 0 };
    const idempotencyKey = tool.kind === "write" ? `${opts.callId}:${toolName}:${opts.seq}` : undefined;
    const until = opts.until ?? Infinity;
    const advance = async (to: number) => { now = Math.min(to, until); await opts.advance?.(now); };
    for (let i = 0; i <= tool.retry.max && now < until; i++) {
      if (now < this.openUntil || this.probing) break;
      const probe = this.openUntil > 0;
      if (probe) this.probing = true;
      const at = now;
      const deadline = Math.min(tool.timeoutMs, until - now);
      let raw: JackResult;
      try { raw = await this.jack.call({ ...request, now, idempotencyKey }); }
      catch { raw = { status: "error", kind: "unavailable", latencyMs: 0 }; }
      if (!Number.isFinite(raw.latencyMs) || raw.latencyMs > deadline) {
        result = { status: "error", kind: tool.kind === "write" ? "unknown_outcome" : "timeout", latencyMs: deadline };
      } else result = { ...raw, latencyMs: Math.max(0, raw.latencyMs) };
      await advance(now + result.latencyMs);
      const attempt = { at, endedAt: now, result, idempotencyKey };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      this.probing = false;
      if (result.status === "ok") { this.failures = 0; this.openUntil = 0; break; }
      this.failures++;
      if (probe || this.failures >= 5) { this.openUntil = now + 30_000; break; }
      // 쓰기 무응답도 timeout 재시도 설정을 사용하되 동일한 멱등 키만 보낸다.
      const kind = result.kind === "unknown_outcome" ? "timeout" : result.kind;
      if (i === tool.retry.max || !tool.retry.on.some((k) => k === kind)) break;
      await advance(now + Math.round(100 * 2 ** i * this.rng.between(0.5, 1.5)));
    }
    return { result, elapsedMs: now - opts.now, attempts };
  }
}
