# Soundcheck gaga-seller@1: 통과

main-rule-gaga-seller · git 8b752af2c0880c0108a6b66860e32b6ad2e59b3f

| 지표 | 값 | 95% CI | n |
|---|---:|---|---:|
| goal_rate | 0.5500 | 0.4249 ~ 0.6691 | 60 |
| acceptable_rate | 1.0000 | 0.9398 ~ 1.0000 | 60 |
| barge_in_rate | 0.0452 | 0.0248 ~ 0.0813 | 221 |
| long_call_rate | 0.0000 | 0.0000 ~ 0.0602 | 60 |
| turn_latency_p95 | 284.0000 | — | 160 |
| dead_air_incidents | 0.0000 | — | 60 |
| degraded_survival | 1.0000 | 0.7009 ~ 1.0000 | 9 |
| policy_violations | 0.0000 | — | 60 |
| brain_fallbacks | 0.0000 | — | 60 |

## Brain 진단

- 턴 지연 p50/p95: 41.0000 / 59.0000 ms (n=156)
- 제어 거부: 0회 · 출력 가드: 0회


## 게이트

| 지표 | 기준 | 값 | 판정 |
|---|---|---:|---|
| goal_rate | >= 0.45 | 0.5500 | 통과 |
| acceptable_rate | >= 0.9 | 1.0000 | 통과 |
| policy_violations | == 0 | 0.0000 | 통과 |
| barge_in_rate | <= 0.2 | 0.0452 | 통과 |
| long_call_rate | <= 0.1 | 0.0000 | 통과 |
| dead_air_incidents | == 0 | 0.0000 | 통과 |

## 장애별

| 장애 | 성공률 | 허용률 | 장애 생존율 | 지연 p95(ms) |
|---|---:|---:|---:|---:|
| clean | 0.6333 | 1.0000 | 관측 없음 | 256.0000 |
| flaky | 0.4667 | 1.0000 | 1.0000 | 328.0000 |

## 주요 실패 이유

통화 단위 실패 없음(집계 게이트 실패와 별개).

## 정의와 한계

시뮬레이션 기준 · scripted 페르소나 · 실제 음성·업무 API 호출 없음. LLM 모드는 실제 추론 시간을 가상 시계에 반영한다.
- 대상 통화: 전체 페르소나 × 장애 × 시드. 거절·바쁨·down도 제외하지 않는다.
- goal_rate: 업무 상태 성공 / 대상 통화. acceptable_rate: 성공 또는 Pack 허용 종료 / 대상 통화.
- barge_in_rate: 고정 고지를 제외한 에이전트 턴의 끼어들기 비율(대기 멘트 포함).
- long_call_rate: maxCallSec에 도달한 통화 비율. 하드 제한이라 초과 대신 도달을 센다.
- turn_latency_p95: 고객 발화 종료 → 다음 에이전트 발화 시작(ms), 대기 멘트 포함, 최근접 순위 ceil(0.95*n). 응답 없는 마지막 턴 제외.
- dead_air_incidents: 런타임이 관측한 고객 턴 뒤 침묵 상한(policy.silenceMaxSec, 기본 3초) 초과 횟수.
- degraded_survival: 사전 조회·재시도를 포함해 실제 non-ok 업무 도구 시도가 있었던 통화 중 허용 종료 비율.
- policy_violations: 가드 차단 이후 실제 실행·송출 감사(무동의 쓰기, 이중 쓰기, 수신 거부 후 도구, 출력 근거·금지어). 차단 횟수와 다르다.
- brain_fallbacks: brain.fallback 이벤트 수(rule은 0). 비율은 Wilson 95% CI, 분모 0은 null. 합계·p95는 CI 없음.
- 브레이커·mock 상태는 통화별로 독립. 같은 페르소나 반복은 현실 고객 독립 표본이 아니며 CI는 시뮬레이션의 기술 통계다.
- scripted는 단계·선택지를 알고 응답한다. 지연은 가상 시계이고 filler가 침묵을 예방한다. 정책 통과는 제한된 규칙/가드의 결과이며 실제 대화 품질 증거가 아니다.
- knowledge는 현재 scripted 행동을 바꾸지 않으며 발화 관련도에 따른 끼어들기 모델도 미구현이다.

Brain: rule · 게이트는 CI 하한이 아닌 점추정 기준.

모델 설정: agent=ollama/exaone3.5:7.8b (config, used=false), persona=ollama/gemma3:12b (default, used=false), judge=none/none (default, used=false)
