/**
 * 경계 검사: 엔진 코드(src/)에 조직 ID나 조직 전용 이름이 나오면 실패한다.
 * "새 조직 = packs/ 디렉터리 하나"를 CI가 지키게 하는 장치다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKS = path.join(ROOT, "packs");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// 금지어: 각 Pack의 id, jack 이름, 도구 네임스페이스, 컬렉션 이름
const banned = new Set<string>();
for (const org of readdirSync(PACKS)) {
  const packFile = path.join(PACKS, org, "pack.yaml");
  try {
    const pack = parseYaml(readFileSync(packFile, "utf8"));
    banned.add(pack.id);
    banned.add(pack.call.target.collection);
    for (const [name, tool] of Object.entries<{ jack: string }>(pack.tools ?? {})) {
      banned.add(name.split(".")[0]!);
      banned.add(tool.jack);
    }
  } catch {
    // pack.yaml이 없거나 깨진 디렉터리는 validate가 잡는다
  }
}

const violations: string[] = [];
for (const file of walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const word of banned) {
      if (new RegExp(`(^|[^A-Za-z0-9-])${word.replace(/[-]/g, "\\-")}([^A-Za-z0-9-]|$)`).test(line)) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  '${word}'`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error(`✗ 엔진 코드에 조직 전용 이름이 있습니다 (${violations.length}건). packs/로 옮기세요.`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`✓ 경계 검사 통과 (금지어 ${banned.size}개: ${[...banned].sort().join(", ")})`);
