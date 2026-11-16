import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import type { IssueCode } from "../src/pack/validate.ts";

const BASE = "packs/gaga-seller";
const tmpRoot = mkdtempSync(path.join(tmpdir(), "ringdown-pack-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

type Doc = Record<string, any>;
let n = 0;
/** 정상 Pack을 복사해 한 군데만 망가뜨린다 */
function mutated(file: string, mutate: (doc: Doc) => void): string {
  const dir = path.join(tmpRoot, `case-${++n}`);
  cpSync(BASE, dir, { recursive: true });
  const full = path.join(dir, file);
  const doc = parse(readFileSync(full, "utf8"));
  mutate(doc);
  writeFileSync(full, stringify(doc));
  return dir;
}

const stage = (doc: Doc, id: string) => doc.stages.find((s: Doc) => s.id === id);

function codesOf(dir: string): IssueCode[] {
  const res = loadPack(dir);
  return res.ok ? [] : res.issues.map((i) => i.code);
}

describe("정상 Pack", () => {
  it.each(listPackDirs("packs"))("%s 는 검증을 통과한다", (dir) => {
    const res = loadPack(dir);
    if (!res.ok) throw new Error(JSON.stringify(res.issues, null, 2));
    expect(res.ok).toBe(true);
  });
});

describe("잘못된 Pack은 정확한 오류 코드로 거부된다", () => {
  const cases: [string, IssueCode, string, (d: Doc) => void][] = [
    ["없는 단계로 전이", "STAGE_NEXT_UNKNOWN", "pack.yaml", (d) => stage(d, "verify").next.push("nowhere")],
    ["도달할 수 없는 단계", "STAGE_UNREACHABLE", "pack.yaml", (d) => d.stages.push({ id: "orphan", goal: "x", terminal: true })],
    ["종료 단계 없음", "NO_TERMINAL_STAGE", "pack.yaml", (d) => (stage(d, "close").terminal = false)],
    ["중복 단계 ID", "STAGE_DUPLICATE", "pack.yaml", (d) => d.stages.push({ ...stage(d, "close") })],
    ["정의되지 않은 도구 허용", "TOOL_UNKNOWN", "pack.yaml", (d) => stage(d, "explain").allowTools.push("crm.nothing")],
    ["예약 네임스페이스 사용", "TOOL_RESERVED_NAMESPACE", "pack.yaml", (d) => (d.tools["kb.mine"] = d.tools["seller.lookup"])],
    ["멱등 키 없는 쓰기", "WRITE_WITHOUT_IDEMPOTENCY", "pack.yaml", (d) => delete d.tools["seller.setReturnPolicy"].idempotency],
    ["동의 없이 쓰기 허용", "WRITE_WITHOUT_CONSENT", "pack.yaml", (d) => (stage(d, "confirm").requireConsent = false)],
    ["consent 슬롯 누락", "CONSENT_SLOT_MISSING", "pack.yaml", (d) => delete d.slots.consent],
    ["쓰기 실패를 skip", "SKIP_ON_WRITE", "pack.yaml", (d) => (d.tools["seller.setReturnPolicy"].onFailure = "skip")],
    ["없는 연결(jack)", "JACK_UNKNOWN", "pack.yaml", (d) => (d.tools["seller.lookup"].jack = "erp")],
    ["경로 파라미터 미선언", "PATH_PARAM_UNDECLARED", "pack.yaml", (d) => (d.tools["seller.lookup"].op = "GET /sellers/{sellerId}/{shopId}")],
    ["없는 슬롯을 파라미터로", "PARAM_SLOT_UNKNOWN", "pack.yaml", (d) => (d.tools["seller.setReturnPolicy"].params.plan.slot = "nope")],
    ["mock 라우트 없음", "MOCK_ROUTE_MISSING", "pack.yaml", (d) => (d.tools["seller.lookup"].op = "GET /shops/{sellerId}")],
    ["알 수 없는 의도", "INTENT_UNKNOWN", "pack.yaml", (d) => (stage(d, "explain").rule.on.maybe = { goto: "close" })],
    ["규칙이 next 밖으로 전이", "RULE_GOTO_NOT_IN_NEXT", "pack.yaml", (d) => (stage(d, "verify").rule.on.yes.goto = "confirm")],
    ["규칙이 허용 안 된 도구 호출", "RULE_TOOL_NOT_ALLOWED", "pack.yaml", (d) => (stage(d, "verify").rule.on.question = { tool: "kb.search" })],
    ["템플릿이 없는 사실 참조", "TEMPLATE_REF_UNKNOWN", "pack.yaml", (d) => (stage(d, "verify").rule.say = "{{fact.ownerName}} 사장님?")],
    ["상한을 넘는 스크립트 발화", "RULE_SAY_TOO_LONG", "pack.yaml", (d) => (stage(d, "explain").rule.say = "가".repeat(7 * 13))],
    ["prefetch에 쓰기 도구", "PREFETCH_INVALID", "pack.yaml", (d) => d.call.prefetch.push("seller.setReturnPolicy")],
    ["통화 가능 시간 역전", "CALL_WINDOW_INVALID", "pack.yaml", (d) => (d.policy.callWindow.from = "19:00")],
    ["성공 판정 컬렉션 없음", "MOCK_COLLECTION_UNKNOWN", "pack.yaml", (d) => (d.goal.success.collection = "shops")],
    ["페르소나 대상 없음", "PERSONA_TARGET_UNKNOWN", "personas.yaml", (d) => (d[0].targetId = "S-9999")],
    ["페르소나 ID 중복", "PERSONA_DUPLICATE", "personas.yaml", (d) => d.push({ ...d[0] })],
    ["모르는 키 (오타)", "SCHEMA", "pack.yaml", (d) => (d.polcy = {})],
    ["게이트 식 형식 오류", "SCHEMA", "pack.yaml", (d) => (d.gates.goal_rate = "about half")],
    ["모르는 지표 게이트", "SCHEMA", "pack.yaml", (d) => (d.gates.vibes = ">= 1")],
  ];

  it.each(cases)("%s → %s", (_name, code, file, mutate) => {
    expect(codesOf(mutated(file, mutate))).toContain(code);
  });

  it("오류 위치를 사람이 찾을 수 있게 알려준다", () => {
    const res = loadPack(mutated("pack.yaml", (d) => stage(d, "verify").next.push("nowhere")));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]!.where).toBe("pack.yaml#stages[0].next");
  });

  it("필수 파일이 없으면 FILE_MISSING", () => {
    const dir = mutated("pack.yaml", () => {});
    rmSync(path.join(dir, "jacks.yaml"));
    expect(codesOf(dir)).toContain("FILE_MISSING");
  });

  it("지식 문서가 없으면 KB_EMPTY", () => {
    const dir = mutated("pack.yaml", () => {});
    rmSync(path.join(dir, "kb"), { recursive: true });
    expect(codesOf(dir)).toContain("KB_EMPTY");
  });
});
