/**
 * 모델 설정. 코드 어디에도 모델 이름을 박지 않는다.
 *
 * 우선순위 (뒤가 이긴다):
 *   1. 기본값 (DEFAULTS)
 *   2. ringdown.config.yaml 의 models.<role>
 *   3. 환경변수 RINGDOWN_MODEL_<ROLE>  예) RINGDOWN_MODEL_AGENT=ollama/qwen3:14b
 *   4. CLI --model <role>=<spec>       예) --model persona=openai-compat/gemma@http://localhost:8080/v1
 *
 * spec 문자열: `<provider>/<model>[@<baseUrl>]`
 *   - model 안의 `/`, `:`는 그대로 둔다 (첫 `/`만 provider 구분자)
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ROLES = ["agent", "persona", "judge"] as const;
export type Role = (typeof ROLES)[number];

export const PROVIDERS = ["ollama", "openai-compat", "none"] as const;

export const ModelSpec = z.strictObject({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  /** 공급자에 그대로 넘기는 생성 옵션 (temperature, num_ctx 등) */
  options: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

const ConfigFile = z.strictObject({
  models: z.partialRecord(z.enum(ROLES), ModelSpec).default({}),
});

const DEFAULT_BASE_URL: Record<ModelSpec["provider"], string | undefined> = {
  ollama: "http://localhost:11434",
  "openai-compat": undefined,
  none: undefined,
};

/** M4 비교에서 업무 성공 개선이 없어 기존 모델 설정을 유지한다. CLI 기본 Brain은 rule이다. */
export const DEFAULTS: Record<Role, ModelSpec> = {
  agent: { provider: "ollama", model: "exaone3.5:7.8b", options: { temperature: 0.3 }, timeoutMs: 30_000 },
  persona: { provider: "ollama", model: "gemma3:12b", options: { temperature: 0.8 }, timeoutMs: 30_000 },
  judge: { provider: "none", model: "none", options: {}, timeoutMs: 30_000 },
};

export type Source = "default" | "config" | "env" | "cli";
export interface ResolvedModel extends ModelSpec {
  role: Role;
  source: Source;
}

export function parseSpec(spec: string): Pick<ModelSpec, "provider" | "model" | "baseUrl"> {
  const slash = spec.indexOf("/");
  if (slash <= 0) throw new Error(`모델 spec '${spec}': '<provider>/<model>[@baseUrl]' 형식이어야 합니다`);
  const provider = spec.slice(0, slash);
  let rest = spec.slice(slash + 1);
  let baseUrl: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    baseUrl = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  if (!(PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`모델 spec '${spec}': 알 수 없는 provider '${provider}' (가능: ${PROVIDERS.join(", ")})`);
  }
  if (!rest) throw new Error(`모델 spec '${spec}': 모델 이름이 비었습니다`);
  return { provider: provider as ModelSpec["provider"], model: rest, baseUrl };
}

/** `--model agent=ollama/qwen3:14b` 형태의 CLI 인자들을 role → spec으로 */
export function parseCliOverrides(values: string[]): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  for (const v of values) {
    const eq = v.indexOf("=");
    const role = v.slice(0, eq) as Role;
    if (eq <= 0 || !(ROLES as readonly string[]).includes(role)) {
      throw new Error(`--model '${v}': '<role>=<spec>' 형식이어야 합니다 (role: ${ROLES.join(", ")})`);
    }
    out[role] = v.slice(eq + 1);
  }
  return out;
}

export interface ResolveInput {
  configPath?: string;
  env?: Record<string, string | undefined>;
  cli?: Partial<Record<Role, string>>;
}

export function resolveModels(input: ResolveInput = {}): Record<Role, ResolvedModel> {
  const env = input.env ?? process.env;
  let fileModels: Partial<Record<Role, ModelSpec>> = {};
  if (input.configPath && existsSync(input.configPath)) {
    const parsed = ConfigFile.safeParse(parseYaml(readFileSync(input.configPath, "utf8")) ?? {});
    if (!parsed.success) throw new Error(`${input.configPath}: ${z.prettifyError(parsed.error)}`);
    fileModels = parsed.data.models;
  }

  const out = {} as Record<Role, ResolvedModel>;
  for (const role of ROLES) {
    let spec: ModelSpec = DEFAULTS[role];
    let source: Source = "default";
    const fromFile = fileModels[role];
    if (fromFile) {
      spec = fromFile;
      source = "config";
    }
    // env/cli는 provider·model·baseUrl만 바꾸고 options/timeout은 위에서 이어받는다
    const overrides: [Source, string | undefined][] = [
      ["env", env[`RINGDOWN_MODEL_${role.toUpperCase()}`]],
      ["cli", input.cli?.[role]],
    ];
    for (const [src, value] of overrides) {
      if (!value) continue;
      const p = parseSpec(value);
      const providerChanged = p.provider !== spec.provider;
      spec = {
        ...spec,
        provider: p.provider,
        model: p.model,
        baseUrl: p.baseUrl ?? (providerChanged ? undefined : spec.baseUrl),
      };
      source = src;
    }
    const baseUrl = spec.baseUrl ?? DEFAULT_BASE_URL[spec.provider];
    if (spec.provider === "openai-compat" && !baseUrl) {
      throw new Error(`models.${role}: openai-compat는 baseUrl이 필요합니다 (spec 끝에 @http://... )`);
    }
    out[role] = { ...spec, baseUrl, role, source };
  }
  return out;
}

/** 보고서·trace에 남기는 짧은 식별자 */
export const modelLabel = (m: Pick<ModelSpec, "provider" | "model">): string => `${m.provider}/${m.model}`;
