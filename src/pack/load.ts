/**
 * Pack 디렉터리를 읽어 구조 검증 → 참조 검증까지 마친 LoadedPack을 돌려준다.
 *
 * packs/<org>/
 *   pack.yaml      필수
 *   jacks.yaml     필수 (업무 시스템 연결)
 *   mock.yaml      mock 연결을 쓰면 필수
 *   personas.yaml  선택 (soundcheck용)
 *   kb/*.md        필수 (1개 이상)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { Jacks, Mock, Pack, Personas } from "./schema.ts";
import { validatePack, type Issue, type PackParts } from "./validate.ts";

export interface KbDoc {
  file: string;
  text: string;
}

export interface LoadedPack extends Omit<PackParts, "kbFiles"> {
  dir: string;
  kb: KbDoc[];
}

export type LoadResult = { ok: true; value: LoadedPack } | { ok: false; issues: Issue[] };

function readYaml<S extends z.ZodType>(
  dir: string,
  file: string,
  schema: S,
  issues: Issue[],
  required: boolean,
): z.infer<S> | undefined {
  const full = path.join(dir, file);
  if (!existsSync(full)) {
    if (required) issues.push({ code: "FILE_MISSING", where: file, message: `${file}이 없습니다` });
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(full, "utf8"));
  } catch (e) {
    issues.push({ code: "SCHEMA", where: file, message: `YAML 파싱 실패: ${(e as Error).message}` });
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const p = issue.path.map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("");
      issues.push({ code: "SCHEMA", where: `${file}#${p.replace(/^\./, "")}`, message: issue.message });
    }
    return undefined;
  }
  return parsed.data;
}

export function loadPack(dir: string): LoadResult {
  const issues: Issue[] = [];
  const pack = readYaml(dir, "pack.yaml", Pack, issues, true);
  const jacks = readYaml(dir, "jacks.yaml", Jacks, issues, true);
  const mock = readYaml(dir, "mock.yaml", Mock, issues, false);
  const personas = readYaml(dir, "personas.yaml", Personas, issues, false) ?? [];

  const kbDir = path.join(dir, "kb");
  const kb: KbDoc[] = existsSync(kbDir)
    ? readdirSync(kbDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({ file: `kb/${f}`, text: readFileSync(path.join(kbDir, f), "utf8") }))
    : [];

  // 구조가 깨졌으면 참조 검증은 의미가 없다
  if (issues.length > 0 || !pack || !jacks) return { ok: false, issues };

  const refIssues = validatePack({ pack, jacks, mock, personas, kbFiles: kb.map((d) => d.file) });
  if (refIssues.length > 0) return { ok: false, issues: refIssues };

  return { ok: true, value: { dir, pack, jacks, mock, personas, kb } };
}

/** packs/ 아래의 모든 Pack 디렉터리 */
export function listPackDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "pack.yaml")))
    .map((d) => path.join(root, d.name))
    .sort();
}
