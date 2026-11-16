# M4 로컬 모델 비교 — 2026-11-16

## 실험 조건

Apple M1 Max, 통합 메모리 32 GiB, macOS 27.0, Node.js 20.20.2, Ollama 0.40.16(`http://localhost:11434`)에서 실행했다. 실제 로컬 추론과 mock 업무 시스템·scripted 페르소나의 결합이며 실제 전화·고객·업무 API 실험이 아니다.

- 비교: rule / `ollama/exaone3.5:7.8b` / `ollama/qwen3:8b`.
- 공통 매트릭스: 두 Pack × 각 30명 × `clean,flaky` × seed 1. Brain별 120통화, 총 360통화. 입력 거절·이관도 분모에 포함한다.
- 설정: [config.yaml](m4/config.yaml)의 `temperature:0`, `seed:1`, `num_ctx:8192`, 요청 timeout 30초. 생성 상한 512토큰, 비스트리밍, `think:false`, `keep_alive:"5m"`. 모델은 `resolveModels`의 CLI 재정의로 선택했다. GPU 수치 연산과 서빙 상태 때문에 모델 출력·실측 지연의 비트 단위 재현은 보장하지 않는다.
- 모델은 GPU 경합을 피하려고 EXAONE → Qwen 순차 실행했다. 콜드/웜 캐시가 섞이며 캐시 적중률·첫 토큰 지연은 이 실험에서 측정하지 않았다. 다운로드·설치 및 단일 통화 예비 실행 시간은 표의 wall time에서 제외했다. gemma 다운로드 및 짧은 로컬 검증 작업은 일부 추론과 겹쳤다. 전용 벤치마크 환경이 아니므로 작은 지연 차이는 우열 근거로 삼지 않는다.
- 비교 모델은 모두 Q4_K_M이다. EXAONE ID는 `c7c4e3d1ca22`, Qwen ID는 `500a1f067a9f`, 미사용 gemma ID는 `b92b218582c5`이다. 모델 다이제스트·양자화: [API tags](m4/model-tags.json), [ollama list](m4/ollama-list.txt). API 실응답 [EXAONE](m4/api-exaone.json), [Qwen](m4/api-qwen.json)에 스키마 JSON 출력과 사용 토큰이 남아 있다. Qwen 응답에는 thinking 본문이 없는지 확인했다.
- 최종 비교의 구현 SHA는 각 report.json의 `gitSha`에 기록했다. 실행 중 비정상 `null` 공급자 응답 분류 및 Markdown 진단 표시를 보완했으므로 EXAONE과 Qwen의 SHA가 다를 수 있다. 정상 응답·프롬프트·매트릭스는 같다. 측정 뒤 숫자·불리언 enum 슬롯 타입 보존도 보완했으며, 실제 두 Pack의 생성 스키마는 보완 전후 byte-identical함을 확인했다. API 연결 확인 요청만 생성 상한 64토큰이며 본 비교는 512토큰이다. 최종 프롬프트 이전 EXAONE 예비 측정은 [pilot-exaone/requests.jsonl](m4/pilot-exaone/requests.jsonl)에 분리했다. 예비 단일 통화에서 질문하며 `end:pending_confirmation`을 함께 출력한 것을 보고, 종료 시에만 end를 넣으라는 공통 지시를 보강했다. 최종 비교에는 예비 측정을 섞지 않았다.

재현 명령(출력 디렉터리는 새 경로 사용):

```bash
npm ci
npx tsx scripts/m4-comparison.ts rule runs/m4-rule
npx tsx scripts/m4-comparison.ts ollama/exaone3.5:7.8b runs/m4-exaone
npx tsx scripts/m4-comparison.ts ollama/qwen3:8b runs/m4-qwen
npx tsx scripts/m4-scripted-sensitivity.ts
```

## 지표 읽는 법

성공은 모델의 `end:success` 주장이 아니라 최종 mock 업무 상태로 판정한다. goal_rate의 구간은 Wilson 95% CI다. 같은 페르소나를 장애별로 반복했으므로 독립 실고객 표본의 추론 구간이 아니라 기술 통계이며, 구간이 겹치는 차이를 개선이라고 단정하지 않는다. 게이트는 CI 하한이 아닌 점추정으로 판정한다.

Brain 지연은 모델 plan·compose·스키마/정책 재요청·대체 실행의 턴별 합계다. rule의 값은 기존 20~60ms 가상 지연이며 실제 CPU 수행 시간과 비교한 배율로 해석하지 않는다. p50/p95는 최근접 순위이고 CI는 만들지 않았다. 입력 가드가 바로 끝낸 턴은 Brain 지연 표본에서 제외한다.

`turn_latency_p95`는 사용자 발화 종료부터 **filler를 포함한 첫 발화 시작**까지다. 짧아 보여도 답변 내용이 준비됐다는 뜻은 아니다. filler는 가상 시각에 삽입되며 실제 오디오의 실시간 송출 검증이 아니다. `dead_air=0`도 이 제한 안에서만 의미가 있다. 출력 가드의 `speech_length`는 품질/길이 차단이며 숫자 근거·금지어 차단과 구별해야 한다. `policy_violations`는 차단 뒤 실행·송출 감사이고, 막은 시도 수와 다르다.

## 결과


### gaga-ads@2

| Brain | goal_rate (95% CI) | barge_in | turn p95 ms | Brain p50 / p95 ms | 대체 | 정책 위반 | dead air | 출력 / 제어 차단 | wall 초 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rule | 50.0% (37.7–62.3) | 5.29% | 336 | 37 / 59 | 0 | 0 | 0 | 0 / 0 | 0.0 |
| exaone | 0.0% (0.0–6.0) | 1.71% | 800 | 8082 / 9820 | 0 | 0 | 0 | 20 / 0 | 420.0 |
| qwen | 0.0% (0.0–6.0) | 4.46% | 800 | 3557 / 4594 | 0 | 0 | 0 | 0 / 0 | 236.3 |

### gaga-seller@1

| Brain | goal_rate (95% CI) | barge_in | turn p95 ms | Brain p50 / p95 ms | 대체 | 정책 위반 | dead air | 출력 / 제어 차단 | wall 초 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| rule | 48.3% (36.2–60.7) | 5.26% | 287 | 38 / 59 | 0 | 0 | 0 | 0 / 0 | 0.0 |
| exaone | 0.0% (0.0–6.0) | 5.75% | 800 | 8310 / 10306 | 0 | 0 | 0 | 43 / 0 | 455.5 |
| qwen | 0.0% (0.0–6.0) | 5.61% | 800 | 2952 / 3909 | 0 | 0 | 0 | 0 / 0 | 170.0 |

원본 보고서:

- [rule · gaga-ads@2](m4/rule/gaga-ads/report.json)
- [rule · gaga-seller@1](m4/rule/gaga-seller/report.json)
- [exaone · gaga-ads@2](m4/exaone/gaga-ads/report.json)
- [exaone · gaga-seller@1](m4/exaone/gaga-seller/report.json)
- [qwen · gaga-ads@2](m4/qwen/gaga-ads/report.json)
- [qwen · gaga-seller@1](m4/qwen/gaga-seller/report.json)

원본 report의 `trace`는 같은 디렉터리 아래 보존한 JSONL을 가리킨다. [요청별 EXAONE 지연/토큰](m4/exaone/requests.jsonl), [Qwen 지연/토큰](m4/qwen/requests.jsonl), [추가 집계](m4/analysis.json), [비교 차트](m4/comparison.html)도 함께 남겼다. 표에서 rule wall time의 0.0은 소수 한 자리 반올림이며 실제 값은 timing.json에 있다.

### 해석과 기본값 결정

- **업무 성공은 두 LLM 모두 rule보다 나빴다.** rule은 30/60, 29/60 성공했고, 두 LLM은 각 Pack에서 0/60이었다. 성공률 CI도 겹치지 않는다. 두 LLM 모두 goal_rate 게이트에서 실패했고 rule은 두 Pack 게이트를 통과했다. 평가 샘플·모델 옵션·프롬프트에 한정한 결과이며 일반적인 모델 순위가 아니다.
- **Qwen은 EXAONE보다 짧고 빨랐지만 업무 진행은 개선하지 못했다.** Brain p95는 가가애즈 9.82 → 4.59초, 가가마켓 10.31 → 3.91초였다. Qwen 출력 가드 0회, EXAONE은 길이 62회·숫자 1회였다. rule의 지연은 가상 난수여서 실제 추론과의 속도 배율 비교는 하지 않는다.
- **핵심 실패는 스키마 밖의 의미 오류였다.** EXAONE은 95/120통화, Qwen은 90/120통화에서 실제 pending 작업 없이 `pending_confirmation`으로 끝났다. Qwen이 주장한 성공 5건은 최종 업무 상태 검사에서 `failed`로 정정됐다. 현재 런타임은 성공 주장과 실행 동의를 검증하지만, 확인 작업 없는 `pending_confirmation` 종료 자체는 거부하지 않는다. 이 종료 권한의 의미 검사가 후속 과제다.
- **대체·위반 0의 범위가 좁다.** EXAONE 214회, Qwen 123회 실제 추론 요청에 공급자 오류가 없고 JSON 검증도 통과해 fallback은 0이었다. 두 LLM의 업무 쓰기 실행은 0건, 제어 거부도 0건이었다. 따라서 이 매트릭스의 정책 위반 0은 “모든 위험한 모델 제안을 제어 가드가 차단했다”는 증거가 아니다. 실제 차단 증거는 숫자 오류 1건이며, 무동의 쓰기 거부는 별도 가짜 클라이언트 테스트가 담당한다.
- **끼어들기 분모도 봐야 한다.** 가가애즈의 filler 제외 본문 끼어들기는 rule 12/219(5.48%), EXAONE 6/119(5.04%), Qwen 12/131(9.16%)다. EXAONE 전체 끼어들기율 1.71%는 filler 231회가 분모에 포함된 효과가 크다. 가가마켓 본문 기준은 rule 12/224(5.36%), EXAONE 20/120(16.67%), Qwen 12/120(10.00%)다. 단순 전체 비율로 대화 품질 개선을 선언하지 않는다.
- **기본값은 승격하지 않는다.** CLI 기본 Brain `rule`을 유지한다. `DEFAULTS`와 예제 설정의 모델 이름·온도도 기존 값을 유지하며, 기존 EXAONE 값은 품질 승인이나 배포 권고가 아니다. 비교 조건은 temperature 0, 기존 기본값은 0.3으로 그 기본 온도에서의 성능은 측정하지 않았다. 예제 주석만 미사용 persona와 비교 한계를 설명하도록 갱신했다.

최종 실험 wall time은 EXAONE 875.5초(약 14분 35초), Qwen 406.3초(약 6분 46초)다. 40분 한도에 도달하지 않아 **모든 모델에 동일한 전체 매트릭스**를 사용했다. 예비 47회 요청(166.4초)은 최종 결과에 포함하지 않았다.


## 실제 실패 발화와 런타임 차단

### 질문하면서 종료한 EXAONE

[가가애즈 grateful-owner / clean trace](m4/exaone/gaga-ads/calls/call-bc66f568.jsonl):

> 고객: 네, 진행해 주세요.
>
> 모델이 송출한 말: 한입베이커리님, 현재 광고 잔액이 18,000원으로 3일 후에 광고가 멈출 예정입니다. 1만 원 아래로 내려가면 자동으로 충전을 원하시나요?

계획은 `transition:pitch`와 `end:pending_confirmation`을 동시에 포함했다. `call.end.pending`는 빈 배열이고 쓰기 도구도 실행되지 않았다. 질문 뒤 답을 받기 전에 통화가 끝났다. 종료 필드 생략 지시를 보강했어도 EXAONE은 같은 오류를 반복했다. `brain_fallbacks=0`은 JSON 형식이 맞았다는 뜻이지 의미가 올바르다는 뜻이 아니다.

### 숫자 오류를 막은 출력 가드

[가가마켓 / call-7b04212f trace](m4/exaone/gaga-seller/calls/call-7b04212f.jsonl)의 도구 결과는 `monthlyReturnShippingCost:38000`이었다.

> 송출 전 모델 초안: 현재 월 반품 배송비 총액이 약 38만 원으로, 이는 5천 원 옵션이 가장 적합할 수 있습니다.
>
> 실제 송출의 마지막 문장: 무료 배송, 3천 원 배송비, 또는 5천 원 배송비 중 어떤 옵션으로 설정하시겠습니까?

`brain.compose`에는 잘못된 금액이 남지만 `guard.reject(layer:output, reason:numeric_grounding)` 뒤 `speech.start`에는 해당 문장이 없다. 가드가 없었다면 10배로 부풀린 금액이 송출됐을 사례다. 같은 턴의 `speech_length`도 별도로 계수됐다. 다만 앞 문장의 “판매자님께서 부담” 같은 의미 주장까지 검증한 것은 아니다.

### 고객 의도를 잘못 읽은 Qwen과 성공 판정

[가가애즈 / call-12e56923 trace](m4/qwen/gaga-ads/calls/call-12e56923.jsonl):

> 고객: 오늘 날씨 이야기예요.
>
> 모델이 송출한 말: 잔액이 1만 원 아래로 내려가면 등록된 결제수단으로 5만 원씩 충전돼요. 이대로 설정할까요?

고객의 선택이 아닌데 `intent:amount_50k`, `setSlots.chargeAmount:"50000"`로 분류하고 `end:success`를 제안했다. 쓰기 도구는 없었다. 런타임은 mock 상태가 바뀌지 않았으므로 결과를 `failed`로 정정했다. 성공 지표 오염은 막았지만 잘못된 질문이나 종료를 교정한 것은 아니다.

무동의 쓰기 차단은 가짜 클라이언트 테스트에서 현재 단계에 허용된 쓰기 도구를 내도록 한 뒤 `checkPlan`이 `write_without_consent`를 반환하는 것으로 검증했다. 이 테스트를 실측 매트릭스의 실제 사고 방지 건수로 합산하지 않는다. 입력 수신 거부·이관은 모델 호출 전에 처리된다.

## scripted 페르소나의 표현 민감도

초기 가정인 “scripted가 키워드 답변만 이해하므로 자연스러운 LLM 발화를 불리하게 평가한다”는 현재 구현과 정확히 일치하지 않는다. `ScriptedPersona.reply(stage, pack, interrupted)`에는 에이전트 발화 문자열 입력 자체가 없다. 현재 단계, Pack 선택지 키워드, 고정 고객 의도, 끼어들기 여부로 응답을 생성한다. 키워드 분류는 RuleBrain·동의 가드가 **고객 발화**를 해석할 때 사용한다.

[표현 민감도 대조 실험](m4/scripted-sensitivity.json)은 120통화에서 송출 텍스트의 모든 문자·숫자를 `가`로 바꾸고 발화 길이·난수 소비를 보존했다. **고객 발화/시각이 바뀐 통화 0/120, 종료 결과가 바뀐 통화 0/120**이었다. 따라서 같은 길이에서 표현 의미 때문에 생기는 불이익은 이 대조군에서 0이다. 자연스러운 문장이 길어져 끼어들기·통화 제한이 늘어나는 효과는 가능하지만, 이를 언어 이해 품질로 분리할 수 없다. LLM의 부정확한 질문에도 단계만 맞으면 고객이 적절한 선택을 답할 수 있어 반대로 점수를 부풀릴 수도 있다.

## 검증과 범위

`npm run ci`: 719개 테스트 통과, 실제 서버 테스트 1개 선택적 건너뛰기. 타입 검사, 가짜 공급자 기반 단위 테스트, 조직 경계 검사, 두 Pack 검증, 두 Pack × 30명 × 5장애의 300통화 smoke. 실제 서버 테스트는 `RINGDOWN_LIVE=1`일 때만 실행한다. OpenAI 호환 공급자는 fake HTTP로 요청·응답 계약을 검증했고 실제 호환 서버는 검증하지 않았다. 비스트리밍 JSON 출력이므로 첫 토큰 지연/스트리밍 취소는 구현 범위 밖이다.

LLM 페르소나는 이번 단계의 선택 범위에서 제외했다. 동의·실행 권한·숫자·금지어·발화 길이 가드는 약화하지 않았으며 persona RNG는 계속 `(seed, persona)`만 사용한다. 기존 보고서 v1에 선택적 diagnostics를 추가해 구 보고서를 계속 읽는다. `acceptable_rate`는 `failed` 외 거의 모든 종료를 허용해 포화되므로 대화 품질의 증거로 쓰지 않는다.
