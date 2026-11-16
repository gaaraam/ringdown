import { modelLabel, type ResolvedModel } from "../config/models.ts";
import type { ChatRequest, ChatResponse, LlmClient } from "./types.ts";
import { parseOutput, requestJson } from "./http.ts";

/** 완성된 JSON을 한 번에 받는다. 비스트리밍이라 첫 토큰 지연은 보고하지 않는다. */
export class OllamaClient implements LlmClient {
  readonly label: string;
  constructor(private spec: ResolvedModel) { this.label = modelLabel(spec); }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const start = performance.now();
    const data = await requestJson(this.spec, "/api/chat", {
      model: this.spec.model, stream: false, think: false, keep_alive: "5m",
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(req.jsonSchema ? { format: req.jsonSchema } : {}),
      options: { ...this.spec.options, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
    }, req.signal);
    return { ...parseOutput(data?.message?.content, !!req.jsonSchema), model: this.label,
      latencyMs: performance.now() - start,
      ...(typeof data.prompt_eval_count === "number" && typeof data.eval_count === "number" ? {
        usage: { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count },
      } : {}),
    };
  }
}
