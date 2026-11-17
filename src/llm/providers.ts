import type { ResolvedModel } from "../config/models.ts";
import { registerProvider } from "./types.ts";
import { OllamaClient } from "./ollama.ts";
import { OpenAICompatClient } from "./openai-compat.ts";
import { requestJson } from "./http.ts";

registerProvider("ollama", spec => new OllamaClient(spec));
registerProvider("openai-compat", spec => new OpenAICompatClient(spec));
export async function checkModel(spec: ResolvedModel) {
  if (spec.provider === "none") return { reachable: false, installed: false, detail: "사용 안 함" };
  try {
    const data = await requestJson<{ models?: { name: string }[]; data?: { id: string }[] }>(spec, spec.provider === "ollama" ? "/api/tags" : "/models");
    const names: string[] = spec.provider === "ollama" ? (data.models ?? []).map(m => m.name) : (data.data ?? []).map(m => m.id);
    return { reachable: true, installed: names.includes(spec.model) || (spec.provider === "ollama" && names.includes(`${spec.model}:latest`)) };
  } catch (e) { return { reachable: false, installed: false, detail: String(e) }; }
}
