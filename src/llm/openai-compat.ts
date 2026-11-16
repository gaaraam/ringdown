import { modelLabel, type ResolvedModel } from "../config/models.ts";
import type { ChatRequest, ChatResponse, LlmClient } from "./types.ts";
import { parseOutput, requestJson } from "./http.ts";

export class OpenAICompatClient implements LlmClient {
  readonly label: string;
  constructor(private spec: ResolvedModel) { this.label = modelLabel(spec); }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const start = performance.now();
    const data = await requestJson(this.spec, "/chat/completions", {
      ...this.spec.options, model: this.spec.model, stream: false,
      messages: [{ role: "system", content: req.system }, ...req.messages],
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: false, schema: req.jsonSchema } } } : {}),
    }, req.signal);
    return { ...parseOutput(data.choices?.[0]?.message?.content, !!req.jsonSchema), model: this.label,
      latencyMs: performance.now() - start,
      ...(data.usage ? { usage: { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } } : {}),
    };
  }
}
