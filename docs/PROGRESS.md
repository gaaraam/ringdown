# 진행 상황

설계: [DESIGN.md](DESIGN.md) · 마지막 갱신: 2026-11-16

## 작업 방식

이슈 → 피처 브랜치(`feat/<이슈번호>-<요약>`) → PR(`Closes #N`) → CI 통과 → 스쿼시 머지.
단계는 GitHub 마일스톤(M1~M6)으로, 할 일은 이슈 체크리스트로 추적한다. 이 문서는 결정과 맥락을 남긴다.

## 단계

| 단계 | 상태 | 완료 기준 |
|---|---|---|
| M0 설계 | ✅ 완료 | DESIGN.md v0.1 합의 (가가마켓·가가애즈, 로컬 LLM, 음성은 후순위) |
| M1 계약 ([#1](https://github.com/gaaraam/ringdown/issues/1)) | ✅ 완료 | `ringdown validate packs/*` 통과, 잘못된 Pack 10종 이상이 정확한 오류 코드로 거부됨 |
| M2 런타임 ([#2](https://github.com/gaaraam/ringdown/issues/2)) | 🔜 다음 | 2개 Pack × 5개 장애 프로파일 통화 완주, `lost-ack`에서 이중 쓰기 0 |
| M3 Soundcheck | ⏳ | `npm run soundcheck` → report.json, 게이트 실패 시 종료 코드 1 |
| M4 LlmBrain | ⏳ | rule / 로컬 모델 2~3종 비교표 |
| M5 온보딩 증명 | ⏳ | 세 번째 Pack 추가 시 `packs/` 밖 변경 0 |
| M6 음성 | ⏳ 후순위 | — |

## M1 세부

- [x] 프로젝트 설정 (TypeScript, zod 4, vitest, tsx)
- [x] Pack 구조 스키마 (`src/pack/schema.ts`)
- [x] 파일 간 참조 검증 (`src/pack/validate.ts`)
- [x] Pack 로더 (`src/pack/load.ts`)
- [x] 모델 설정: 설정 파일 / 환경변수 / CLI 어디서든 교체 (`src/config/models.ts`)
- [x] 핵심 인터페이스: Brain, Jack, Transport, LlmClient (`src/core/types.ts`)
- [x] 선언형 mock 업무 시스템 + 장애 주입 (`src/jacks/mock.ts`)
- [x] Pack 2개: gaga-seller, gaga-ads
- [x] CLI: `ringdown validate`, `ringdown models`
- [x] CI 워크플로 (`npm run ci` = 타입 검사 + 테스트 + 경계 검사 + Pack 검증)
- [x] 잘못된 Pack 테스트 29종 (목표 10종). 전체 테스트 56개 통과
- [x] 경계 검사: `src/`에 조직 ID 문자열 금지 (`scripts/check-boundary.ts`)

## 기록

- **2026-11-16** 설계 v0.1 작성. LLM 공급원을 로컬(Ollama)로 결정. 모델은 교체 가능한 설정값으로.
- **2026-11-16** M1 시작. zod 3에 보안 권고(GHSA-mrhx-c7xc-m3w5)가 있어 zod 4로 시작.
- **2026-11-16** 결정: mock 업무 시스템을 코드가 아닌 `packs/<org>/mock.yaml` 선언으로 둔다. 조직별 코드가 생기면 "새 조직 = 설정만"이 깨지기 때문.
- **2026-11-16** 경계 검사가 첫 실행에서 엔진 주석의 조직 이름(`seller`)을 잡아냄. 의도대로 동작 확인.
- **2026-11-16** M1 완료. 모델 교체 우선순위: 기본값 < `ringdown.config.yaml` < `RINGDOWN_MODEL_<ROLE>` < `--model role=spec`. 공급자는 등록식이라 추가해도 엔진 코드는 바뀌지 않음.
- **2026-11-16** 작업 방식을 이슈 → 피처 브랜치 → PR → 머지로 정함. 커밋 작성자 메일은 개인 메일로.
- **2026-11-16** 결정: mock은 타임아웃을 판정하지 않고 "응답 도착 시각"만 낸다(무응답 = Infinity). 타임아웃·`unknown_outcome` 판정은 M2의 Jack 런타임이 데드라인으로 한다.

## 다음 (M2 런타임)

- [ ] Jack 런타임: 데드라인 · 재시도(백오프+지터) · 서킷 브레이커 · 멱등 키 · 쓰기 타임아웃 → `unknown_outcome`
- [ ] 턴 루프 + 단계 그래프 실행기 + 정책 검사(Plan 거부·재요청)
- [ ] 가드레일: 거절·이관 감지, 숫자 근거, 금지 표현, 길이 상한
- [ ] 지식 검색 (BM25, 청크 인용)
- [ ] RuleBrain (키워드 의도 + Pack 스크립트)
- [ ] SimTransport + scripted 페르소나 최소판
- [ ] trace 이벤트(JSONL) · `ringdown call` 단일 통화 실행
- [ ] 완료 기준: 2개 Pack × 5개 장애 프로파일 통화 완주, `lost-ack`에서 이중 쓰기 0
