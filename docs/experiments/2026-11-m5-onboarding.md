# M5: 가가클리닉 온보딩 기록

2026-11-17, `main`의 `8c899b5`에서 `feat/19-third-pack`을 만들었다. 이슈 [#19](https://github.com/gaaraam/ringdown/issues/19)의 세 번째 가상 조직 실험이다. RuleBrain·mock만 실행했고 Ollama/LLM, 외부 업무 API, 실제 전화·SMS는 실행하지 않았다.

새 조직의 런타임 설정은 `packs/gaga-clinic/`만으로 발견된다. `src/`, `web/`, `scripts/` 변경은 0줄이다. 단, “증거 파일까지 packs 밖 변경 0”은 달성하지 못했다. 요청된 문서·PNG 외에 현재 CLI/기존 테스트가 요구하는 `baselines/gaga-clinic.json` 사본이 필요했다([#24](https://github.com/gaaraam/ringdown/issues/24)). 팩 안의 같은 기준선과 바이트 동일성을 검사한다. 엔진 변경이 없다는 주장과 이 경로 제약을 구분한다.

## 소요 시간

KST 기준 도구 실행·작성 시간을 반올림한 벽시계 기록이다. 단계는 일부 겹치므로 인시나 실제 고객 온보딩 견적이 아니다.

| 단계 | 시간대 | 소요 |
|---|---|---:|
| 이슈, README/설계/진행, 기존 팩 전체·기준선·스키마 읽기, npm ci | 14:52~14:53 | 약 1분 |
| 7단계·4도구·30명·KB 작성, 첫 매트릭스 원인 확인과 수정 | 14:53~14:56 | 약 3분 |
| 동의/인증/의료 질문 테스트, CLI pin, 엔진 과제 등록, 첫 CI | 14:56~14:58 | 약 2분 |
| npm run play 캠페인·처리함·직접/자동 대화·두 테마 캡처 | 14:58~15:01 | 약 3분 |
| 플레이북·기록·최종 검토 | 15:01~15:05 | 약 4분 |

구현·문서·화면 검증까지 약 13분. PR 등록·푸시 후 재검증 소요는 PR 댓글에 별도로 기록한다.

## 표현한 업무 흐름

- 사전 조회는 가상 이름만 fact로 만든다. 예약 컬렉션 조회는 이름 확인과 추가 사실 확인 뒤에 한다.
- 추가 사실은 처음 접수한 경로다. 모든 합성 대상의 경로를 `방문 접수`로 고정하고, 질문에서는 정답을 먼저 읽지 않는다. 단순 “네”, 잘못된 경로·부정 예시·반복 미인식은 조회 없이 종료/이관한다. 키워드 기반이라 실제 인증은 아니다.
- 조회한 `appointmentLabel`을 읽고 유지·변경·취소를 고르게 한다. 변경은 오전/오후 두 시간 중 선택한 뒤 별도의 동의를 받는다. 취소도 원래 예약을 다시 읽은 뒤 동의를 받는다.
- 두 쓰기는 다른 op와 tool 이름을 쓰며 각각 `requireConsent`, 명시적 긍정에서만 설정되는 `consent`, `Idempotency-Key`, 2500ms timeout, timeout 1회 재시도, `confirm_later`를 둔다. 재시도끼리만 같은 논리 작업 키를 공유한다.
- 예약 유지는 쓰기 0회이고 `declined`로 끝난다. 목표 지표는 변경/취소 반영만 세며, “유지 안내 성공”을 억지로 쓰기로 만들지 않았다.
- 의료 관련 키워드는 모든 단계의 입력 가드에서 이관한다. 일반 질문도 이관하고, 승인된 “변경 방법”만 예약 KB를 읽는다. KB에는 진단·복약·치료 조언이 없으며 `forbidden`에 조언 표현을 등록했다. 문자열 규칙이 임의의 의료 질문을 모두 이해한다는 뜻은 아니다.
- mock은 가상 이름과 `DEMO-*` ID, 예약 시간, 접수 경로만 사용한다. 주민번호·연락처·생년월일·질병 정보는 없다. 날짜는 2026-11-19/20의 고정 시뮬레이션 일정이다.

## 쉬웠던 부분과 막힌 부분

팩 탐색, 도구 권한, 상태 전이, 동의, 재시도와 후속 작업은 기존 기능 그대로 사용할 수 있었다. 별도 UI 등록 없이 Playground와 캠페인 목록에 새 조직·30명이 나타났다. 두 쓰기를 같은 `resolution` 필드로 표현해 단일 상태 성공 조건 안에 넣을 수 있었다. `appointmentLabel`은 원래 예약 스냅샷이고 최신 변경 상태는 `appointmentTime`/`resolution`을 본다.

처음 soundcheck는 목표 성공 0/450이었다. 확인 단계에 “다른 작업으로 바꾸기”라는 custom intent를 넣자 scripted가 긍정보다 그 선택을 항상 먼저 골랐다. 추가 사실의 오답 가지도 정상 선택처럼 뽑혔다. 게이트를 낮추지 않고, 확인 단계는 yes/no 중심으로 좁히고 오답은 전역 이관으로 처리했다. 직접 입력 검사는 별도로 남겼다. 또한 의료 키워드 `약`은 `예약`에도 걸려 좁은 복약 표현으로 바꿨다. 현재 키워드 분류를 인증/의료 이해 성능으로 해석하지 않는다.

`RULE_SAY_TOO_LONG`을 피하려고 상한을 늘리지 않았다. 12초 발화, 180초 통화, 3초 침묵 상한을 사용한다. 테스트는 실제 이름·예약 시간·슬롯 레이블 치환과 고정 고지까지 12초 안인지 확인한다. 현재 매트릭스의 끼어들기 0은 짧은 문구와 scripted 모델의 결과이지 실제 환자의 반응 측정이 아니다.

## 엔진에 남긴 과제

| 이슈 | 구체적인 제약 | 이번 팩의 대안 |
|---|---|---|
| [#20](https://github.com/gaaraam/ringdown/issues/20) 본인확인 predicate/권한 | 발화에서 값을 추출해 개인별 fact와 비교하거나 인증 결과로 도구 권한을 묶을 수 없음. 부분 문자열의 부정문 처리도 불완전 | 이름 확인 + 고정 집단의 접수 경로. 두 번째 단순 긍정은 이관. 실제 인증으로 사용하지 않음 |
| [#21](https://github.com/gaaraam/ringdown/issues/21) API 기반 선택지 | fact는 scalar, slot enum/intent는 정적. 가용 시간 목록·만료·경합을 표현하지 못함 | 두 고정 시간과 도구 enum만 허용. 실제 빈자리 조회·선점 증거는 없음 |
| [#22](https://github.com/gaaraam/ringdown/issues/22) 무쓰기 성공 | 단일 최종 상태 predicate라 유지 성공과 애초부터 예약이 있던 통화를 구분할 수 없음 | 유지는 acceptable `declined`, 두 쓰기는 null → resolution 변화로 성공 |
| [#23](https://github.com/gaaraam/ringdown/issues/23) 통화 시간 집행 | `callWindow`는 schema/validate에만 등장하고 런타임은 벽시계를 받지 않음 | 평일 09~18시 선언, 14:58 KST에 캠페인 시작. 시간 밖 차단이 검증됐다고 주장하지 않음 |
| [#24](https://github.com/gaaraam/ringdown/issues/24) 팩 내부 산출물 발견 | CLI·기존 테스트가 루트 baselines/scenarios를 고정 경로로 사용 | CLI 산출물을 팩 안에도 보관. 루트 기준선은 동일성 검사, 팩 회귀는 로컬 테스트에서 재생 |
| [#25](https://github.com/gaaraam/ringdown/issues/25) scripted 분기 역할 | custom intent의 정상 선택·탈출·오답을 구별하지 않음 | 확인 단계 custom 탈출 규칙 제외, human-source 테스트로 거절·의료 질문 별도 검증 |

이슈마다 재현 근거와 기대 동작·검증 조건을 적었다. 이번 PR에서는 해당 엔진을 고치지 않았다.

## Soundcheck 결과와 게이트

```sh
npm run soundcheck -- --pack packs/gaga-clinic --brain rule --faults all --seeds 3 --update-baseline
npm run ringdown -- pin runs/2026-11-17T05-55-30-176Z-gaga-clinic-59f4c96c call-ecdc063b
npm run ringdown -- pin runs/2026-11-17T05-55-30-176Z-gaga-clinic-59f4c96c call-59bfe080
```

첫 통과 run: `2026-11-17T05-55-30-176Z-gaga-clinic-59f4c96c`. Pack은 작성 중이었으므로 report의 gitSha `8c899b5`는 기반 커밋이며 팩 내용의 커밋 해시가 아니다. PR 푸시 후 `--baseline` 비교와 CI로 최종 head를 검증한다. 기존 팩 기준선은 다시 생성하지 않았다.

30명 × clean/slow/flaky/down/lost-ack × 시드 1/2/3 = 450통화, 전체 게이트 통과. 두 CLI-pinned YAML은 `packs/gaga-clinic/scenarios/regressions/`로 옮겨 `clinic.test.ts`에서 재생한다. 별도 직접 입력 회귀는 두 시간 선택·변경/취소 거절·의료 질문·불명확한 본인 확인·수신 거부·KB·unknown slot·down을 검사한다.

| 지표 | 측정값 | 게이트와 여유 |
|---|---:|---|
| 목표 성공 | 129/450 = 28.67% (95% CI 24.68~33.01%) | ≥20%, 점추정 8.67%p 여유, 구간 하한도 기준 이상 |
| 허용 종료 | 450/450 = 100% | ≥95%, 5%p 여유 |
| 끼어들기 | 0/1,836턴 | ≤15%, 고정 고지 제외·filler 포함 |
| 통화 시간 상한 도달 | 0/450 | ≤5% |
| 턴 지연 p95 | 800ms, 관측 1,286 | 별도 게이트 없음, filler 포함 가상 시간 |
| 침묵 사고 / 정책 위반 | 각각 0 | 각각 ==0, 무관용 |
| 장애 생존 | 181/181 = 100% | 보고용, 허용 종료가 많아 포화 가능 |
| Brain fallback | 0 | RuleBrain 결과, LLM 품질 증거 아님 |

장애별 목표 성공은 clean 35/90, slow 33/90, flaky 26/90, down 0/90, lost-ack 35/90이다. lost-ack은 서버 반영 후 응답 유실이므로 성공과 확인 필요가 공존할 수 있다. 기준선에서 성공 100%를 기대하지 않고 유지·거절·이관·장애도 분모에 남겼다. 이번 매트릭스에 맞춘 회귀 임계값이며 실제 환자 성공률의 SLA가 아니다.

## 화면과 후속 처리 확인

`DATA_DIR=$(mktemp -d /tmp/ringdown-m5-final-XXXXXX) PORT=4319 npm run play`로 독립 저장소를 사용했다. 브라우저에서 클리닉 전체 30명, `lost-ack`, 시드 7 캠페인을 실행했다.

- 시작 `2026-11-17T05:58:19.308Z`, 캠페인 `39c1cea6-a079-492a-b639-051700b5f3ae`, 30/30 완료. 순차 시뮬레이션의 마지막 통화도 15:26 KST로 선언 시간 안이었다.
- 목표 달성 9, 거절 17(유지/확인 거절 포함), 이관 1, 수신 거부 1, 콜백 2. 업무 요청 57건 중 최종 결과 불명 2건.
- 후속 처리함 5건: 확인 필요 2, 콜백 2, 이관 1. 확인 필요를 열어 저장된 업무 반영 상태가 `반영됨`인 것을 확인했다. 결과 분류의 확인 필요 0건과 후속 작업 2건은 모순이 아니다. 실제 상태가 성공이어도 응답을 잃은 작업은 남는다.
- Playground 직접 입력: `네, 본인입니다.` → `방문 접수` → `시간 변경` → `오후` → `네, 동의합니다`. 예약 시간 변경 완료, 슬롯 `2026-11-20T14:00:00+09:00`, 정책 위반/출력 수정/실행 거부 0. 자동 모드도 같은 팩에서 종료까지 확인했다(시드 7은 추가 확인 거절로 종료).
- 라이트·다크는 **같은 캠페인 결과**를 캡처했다. 1440×1000 CSS viewport, 로컬 브라우저 PNG이며 픽셀 크기는 장치 배율을 따른다. 두 PNG 모두 직접 열어 조직 이름·결과 수치·후속 작업·대비·잘림을 확인했다. 검증용 브라우저 탭과 서버는 종료했다.

[라이트 PNG](../screenshots/light-clinic-campaign.png) · [다크 PNG](../screenshots/dark-clinic-campaign.png)

## 최종 검증

- `npm run ci`: 최초 1,062개 테스트, 타입 검사·lint·경계·세 팩 validate·각 150통화 smoke 통과. 팩 테스트도 기본 Vitest 발견 대상이며 엔진/스크립트 등록은 추가하지 않았다.
- `git diff main --stat -- src web scripts`: 출력 없음.
- `git diff main --exit-code -- packs/gaga-seller packs/gaga-ads baselines/gaga-seller.json baselines/gaga-ads.json`: 종료 코드 0.
- 팩 내부 테스트의 타입은 별도 `tsc --noEmit --target ES2022 --module NodeNext --allowImportingTsExtensions --strict --skipLibCheck packs/gaga-clinic/clinic.test.ts`로 확인했다. 기본 lint glob은 팩 테스트를 포함하지 않으므로 `npx eslint --stdin --stdin-filename tests/clinic-pack.test.ts < packs/gaga-clinic/clinic.test.ts`로 기존 테스트 규칙을 적용했다. 두 검사 모두 통과했다.
- 푸시 후 CI 결과와 최종 head는 PR 검증 댓글에 남긴다. Actions는 사용하지 않으며 병합하지 않는다.
