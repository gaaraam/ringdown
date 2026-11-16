import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULTS, parseCliOverrides, parseSpec, resolveModels } from "../src/config/models.ts";
import { createLlmClient, registerProvider } from "../src/llm/types.ts";

const config = (yaml: string) => {
  const p = path.join(mkdtempSync(path.join(tmpdir(), "ringdown-cfg-")), "ringdown.config.yaml");
  writeFileSync(p, yaml);
  return p;
};

describe("모델 spec 파싱", () => {
  it("모델 이름 안의 / 와 : 를 보존한다", () => {
    expect(parseSpec("ollama/hf.co/org/model:Q4_K_M")).toEqual({
      provider: "ollama",
      model: "hf.co/org/model:Q4_K_M",
      baseUrl: undefined,
    });
  });
  it("@ 뒤를 baseUrl로 본다", () => {
    expect(parseSpec("openai-compat/qwen@http://localhost:8080/v1").baseUrl).toBe("http://localhost:8080/v1");
  });
  it.each(["qwen3", "unknown/x", "ollama/"])("잘못된 spec '%s'는 거부", (s) => {
    expect(() => parseSpec(s)).toThrow();
  });
  it("CLI 인자 role=spec", () => {
    expect(parseCliOverrides(["agent=ollama/a", "persona=ollama/b"])).toEqual({ agent: "ollama/a", persona: "ollama/b" });
    expect(() => parseCliOverrides(["boss=ollama/a"])).toThrow();
  });
});

describe("모델 우선순위: 기본값 < 설정 파일 < 환경변수 < CLI", () => {
  const file = config(`models:\n  agent: { provider: ollama, model: from-file, options: { temperature: 0.1 } }\n`);

  it("아무것도 없으면 기본값", () => {
    const m = resolveModels({ env: {} });
    expect(m.agent.model).toBe(DEFAULTS.agent.model);
    expect(m.agent.source).toBe("default");
  });
  it("설정 파일이 기본값을 이긴다", () => {
    expect(resolveModels({ configPath: file, env: {} }).agent).toMatchObject({ model: "from-file", source: "config" });
  });
  it("환경변수가 설정 파일을 이기고, 생성 옵션은 이어받는다", () => {
    const m = resolveModels({ configPath: file, env: { RINGDOWN_MODEL_AGENT: "ollama/from-env" } });
    expect(m.agent).toMatchObject({ model: "from-env", source: "env", options: { temperature: 0.1 } });
  });
  it("CLI가 모두를 이긴다", () => {
    const m = resolveModels({ configPath: file, env: { RINGDOWN_MODEL_AGENT: "ollama/from-env" }, cli: { agent: "ollama/from-cli" } });
    expect(m.agent).toMatchObject({ model: "from-cli", source: "cli" });
  });
  it("공급자를 바꾸면 이전 공급자의 baseUrl을 끌고 가지 않는다", () => {
    expect(() => resolveModels({ env: {}, cli: { agent: "openai-compat/x" } })).toThrow(/baseUrl/);
  });
  it("역할마다 따로 바뀐다", () => {
    const m = resolveModels({ env: {}, cli: { persona: "ollama/p" } });
    expect(m.agent.source).toBe("default");
    expect(m.persona.model).toBe("p");
  });
});

describe("LLM 공급자 등록", () => {
  it("등록 안 된 공급자는 이유와 함께 실패", () => {
    const m = resolveModels({ env: {}, cli: { agent: "openai-compat/x@http://localhost:1/v1" } });
    expect(() => createLlmClient(m.agent)).toThrow(/등록되지 않았습니다/);
  });
  it("공급자를 등록하면 엔진 코드 변경 없이 쓸 수 있다", async () => {
    registerProvider("none", (spec) => ({
      label: spec.model,
      chat: async () => ({ text: "ok", model: spec.model, latencyMs: 1 }),
    }));
    const m = resolveModels({ env: {} });
    expect((await createLlmClient(m.judge).chat({ system: "", messages: [] })).text).toBe("ok");
  });
});
