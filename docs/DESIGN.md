# Ringdown 설계 문서 (v0.1 초안)

> 조직마다 다른 지식·정책·업무 시스템에 AI 콜 에이전트를 **설정 묶음 하나로** 연결하고,
> 업무 시스템이 느리거나 죽어도 통화가 이어지는지 **시뮬레이션으로 재는** 엔진.

## 0. 이 문서가 답하려는 질문

| 질문 | 답하는 절 |
|---|---|
| 새 조직을 붙일 때 무엇을 바꾸고, 무엇은 절대 안 바꾸나 | 3. 공통 / 설정 / 코드의 경계 |
| LLM이 틀려도 사고가 나지 않게 하는 장치는 어디에 있나 | 4. 런타임, 6. 가드레일 |
| 업무 API가 느리거나 실패하면 통화는 어떻게 되나 | 5. Jack 런타임 |
| "좋아졌다"를 무엇으로, 얼마나 믿을 수 있게 재나 | 7. Soundcheck |
| 음성은 어디에 붙나 | 8. Transport |

## 1. 문제 정의

**상황.** 아웃바운드 업무 전화(판매자 안내, 광고 충전 권유 등)를 AI가 대신 건다. 엔진은 하나지만 붙이는 조직마다 다음이 전부 다르다.

- 참조 지식(정책 문서, FAQ)
- 응대·발신 정책(통화 가능 시간, 고지 문구, 거절 처리, 상담원 이관 조건)
- 연동할 업무 시스템(조회·변경 API, 응답 속도, 장애 양상)

**실패의 대부분은 모델 밖에서 난다.** 모델이 똑똑해도 다음 경우 통화는 망가진다.

- 업무 API가 3초 걸려서 침묵이 흐른다 → 고객이 끊는다
- 쓰기 요청이 성공했는데 응답이 유실돼 재시도 → 두 번 처리된다
- 정책 문서에 없는 숫자를 모델이 말한다 → 잘못된 안내
- 말이 길어서 고객이 끼어든다 → 같은 말을 반복한다

**목표.**
1. 새 조직 = `packs/<org>/` 디렉터리 하나. **엔진 코드 변경 0줄**을 측정 가능한 지표로 둔다.
2. 업무 시스템 장애 유형별로 통화가 어떻게 끝나는지 정의하고 재현 가능하게 잰다.
3. LLM은 "무엇을 말할지" 제안만 하고, "무엇을 해도 되는지"는 결정론적 런타임이 정한다.

**비목표.**
- ASR/TTS 모델을 만들지 않는다. 음성은 교체 가능한 Transport 뒤에 둔다(8절).
- 실제 전화망(SIP/PSTN) 연동은 하지 않는다.
- 범용 대화 프레임워크가 아니다. "목적이 있는 아웃바운드 통화" 하나에 맞춘다.

## 2. 전체 구조

```
                   ┌──────────── packs/<org>/ (설정) ────────────┐
                   │ pack.yaml  kb/*.md  personas.yaml  gates   │
                   └───────────────┬────────────────────────────┘
                                   │ 로드 + 스키마 검증 (zod)
┌──────────┐  utterance   ┌────────▼─────────────────────────────┐  ToolCall  ┌──────────┐
│Transport │─────────────▶│            Call Runtime              │───────────▶│   Jack   │──▶ 업무 시스템
│ text sim │◀─────────────│  turn loop · stage graph · facts     │◀───────────│ runtime  │   (mock / 실제)
│ (voice)  │  speech+cut  │  ┌────────┐ ┌────────┐ ┌──────────┐  │  Result    │timeout   │
└──────────┘              │  │ Brain  │ │Guard-  │ │Knowledge │  │            │retry     │
                          │  │(제안)  │ │rails   │ │(BM25)    │  │            │breaker   │
                          │  └────────┘ └────────┘ └──────────┘  │            │idempotent│
                          └────────┬─────────────────────────────┘            └──────────┘
                                   │ trace events (JSONL)
                          ┌────────▼────────┐
                          │   Soundcheck    │ personas × scenarios × fault profiles
                          │ metrics · gates │ → report.json (exit code) + transcripts
                          └─────────────────┘
```

핵심 원칙: **LLM proposes, runtime disposes.**
Brain은 `Plan`(말할 내용, 호출할 도구, 단계 전이)을 돌려줄 뿐이고, 실행 여부·시점·실패 처리는 런타임이 정한다.

## 3. 공통 / 설정 / 코드의 경계

여러 조직에 같은 연동을 반복할 때 늘 나오는 질문, "무엇을 공통으로 뽑고 무엇을 개별로 남기나"에 대한 이 프로젝트의 답이다.

| 층 | 무엇 | 바뀌는 시점 | 예 |
|---|---|---|---|
| **엔진(공통 코드)** | 턴 루프, 단계 그래프 실행기, 가드레일 프레임워크, Jack 런타임, 평가 하네스 | 제품 개선 시 | 타임아웃 처리, 끼어들기 처리 |
| **Jack 타입(공통 코드, 추가형)** | 업무 시스템 **프로토콜** 어댑터 | 새 프로토콜을 처음 만날 때 1회 | `http-json`, `mock` (추후 `soap`, `sql`) |
| **Pack(조직별 설정)** | 목표, 단계, 정책, 도구 바인딩, 지식, 페르소나, 합격선 | 조직 추가·정책 변경 시 | `packs/gaga-seller/pack.yaml` |

규칙:
- 조직 이름으로 분기하는 코드(`if org === ...`)는 금지. CI에서 `packs/` 밖에 조직 ID 문자열이 나오면 실패시킨다.
- Pack으로 표현이 안 되는 요구가 나오면 Pack을 억지로 늘리지 않고 **엔진 기능 + 설정 키**로 승격한다. 승격 이력은 `docs/decisions/`에 남긴다.
- 온보딩 비용 지표: `새 조직 추가 PR에서 packs/ 밖 변경 파일 수` (목표 0).

### 3.1 Pack 스키마 (요약)

```yaml
id: gaga-seller
version: 3
locale: ko-KR
goal:
  description: 반품 배송비 정책이 비어 있는 판매자에게 설정을 안내하고, 동의하면 대신 설정한다
  success: { tool: seller.setReturnPolicy, status: ok }      # 성공은 업무 시스템 상태로 판정
  acceptableOutcomes: [callback_scheduled, declined, opted_out]
policy:
  callWindow: { days: [mon-fri], from: "09:00", to: "18:00", tz: Asia/Seoul }
  disclosure: "안녕하세요, 가가마켓 AI 상담원입니다. 통화는 품질 관리를 위해 기록됩니다."  # 고정 문구, LLM 생성 금지
  maxTurnSpeechSec: 12            # 한 번에 말하는 길이 상한
  maxCallSec: 180
  optOutPhrases: ["전화하지 마", "그만 연락"]       # + Brain 의도 분류
  handoff: { when: [user_requests_human, repeated_failure, complaint], target: queue:seller-care }
  forbidden: ["무조건", "보장"]                    # 출력 금지 표현
stages:                                            # 단계 그래프: 각 단계에서 허용되는 도구와 전이
  - id: verify
    allowTools: [seller.lookup]
    next: [explain]
  - id: explain
    allowTools: [kb.search]
    next: [confirm, close]
  - id: confirm
    allowTools: [seller.setReturnPolicy]
    requireConsent: true                           # 쓰기 도구는 명시적 동의 슬롯이 채워져야 실행
    next: [close]
  - id: close
tools:
  seller.lookup:
    jack: gaga-api                                  # jacks.yaml의 연결 정의
    op: GET /sellers/{sellerId}
    kind: read
    timeoutMs: 1500
    retry: { max: 2, on: [timeout, 5xx] }
    onFailure: defer_callback                      # 실패 시 통화 처리 전략 (5절)
  seller.setReturnPolicy:
    jack: gaga-api
    op: PUT /sellers/{sellerId}/return-policy
    kind: write
    idempotency: header:Idempotency-Key            # 쓰기는 멱등 키 필수 (스키마 검증에서 강제)
    timeoutMs: 2500
    retry: { max: 1, on: [timeout] }
    onFailure: confirm_later
gates:                                             # 이 조직의 합격선 (7절)
  goal_rate: ">= 0.55"
  policy_violations: "== 0"
  barge_in_rate: "<= 0.20"
  long_call_rate: "<= 0.10"
  dead_air_incidents: "== 0"
```

`kb/*.md`는 조직 지식, `personas.yaml`은 통화 상대 정의, `jacks.yaml`은 연결 정보(base URL, 인증 방식 — 비밀값은 환경변수 참조만)다.

## 4. Call Runtime

### 4.1 상태

```ts
interface CallState {
  callId: string; pack: PackRef; stage: StageId;
  slots: Record<string, Slot>;          // 동의 여부 등. 출처(발화 turn id) 포함
  facts: Fact[];                        // 도구 결과·KB에서 온 값. 출처 필수 → 숫자 근거 검사에 사용
  clock: SimClock;                      // 시뮬레이션 시각 (실통화에서는 실시각)
  transcript: Turn[];                   // 에이전트 발화는 "의도한 문장"과 "실제로 들린 부분"을 따로 기록
  pending: PendingOp[];                 // 진행 중 도구 호출, 예약된 콜백
}
```

### 4.2 턴 루프

```
고객 발화 종료 이벤트
 1. pre-guard      : 거절/이관 요청/욕설 감지 → 해당 종료 절차로 즉시 전환 (Brain 우회)
 2. brain.plan     : Plan { say?, tools?, transition?, end? }
 3. policy check   : 단계에 허용된 도구인가 / 쓰기면 동의 슬롯이 있는가 / 전이가 그래프에 있는가
                     위반이면 Plan 거부 → 사유를 붙여 brain에 1회 재요청 → 그래도 실패면 안전 문구
 4. tool exec      : Jack 런타임 (5절). 턴 지연 예산을 넘기면 대기 멘트를 먼저 내보낸다
 5. brain.compose  : 도구 결과를 받아 최종 발화 (도구가 없으면 2단계 say 사용)
 6. post-guard     : 숫자 근거 / 금지 표현 / 길이 상한 / 단계 이탈 검사 (6절)
 7. speak          : Transport로 송출. 끼어들기가 오면 들린 부분까지만 transcript에 기록
```

끼어들기가 일어나면 다음 턴의 Brain 입력에 `interrupted_at: "...들린 부분까지"`가 들어간다. 같은 말을 처음부터 반복하지 않게 하기 위해서다.

### 4.3 Brain 인터페이스

```ts
interface Brain {
  plan(ctx: TurnContext): Promise<Plan>;
  compose(ctx: TurnContext, results: ToolResult[]): Promise<Utterance>;
}
```

| 구현 | 용도 | 비고 |
|---|---|---|
| `RuleBrain` | 오프라인 기준선, CI | 키워드 의도 분류 + 단계별 템플릿. 모델 없이 돌아간다 |
| `LlmBrain` | 실제 품질 측정 | **로컬 LLM**(Ollama). 외부 API·비용 없음 |

RuleBrain 점수는 **런타임의 견고성**(장애·정책 처리)을 재는 것이지 대화 품질이 아니다. 보고서에 Brain 종류와 모델 이름을 항상 같이 찍는다.

### 4.4 로컬 LLM

- **서빙:** Ollama(`localhost:11434`). 모델은 설정값이라 바꿔 끼울 수 있다. 개발 장비(Apple Silicon, 메모리 32GB)에서는 7~14B급 4비트 양자화 모델이 현실적이다. 한국어가 되는 모델 몇 개를 같은 매트릭스로 돌려 비교표를 만들고 기본값을 고른다.
- **도구 호출은 네이티브 tool calling에 기대지 않는다.** 작은 모델은 도구 호출 형식을 자주 깨뜨린다. 대신 Ollama의 JSON 스키마 강제 출력(`format`)으로 `Plan`을 받는다. 스키마에는 **지금 단계에서 허용된 도구 이름만 enum으로** 넣는다. 모델이 허용되지 않은 도구를 고르는 일이 구조적으로 불가능해진다.
- **약한 모델일수록 런타임 설계가 일을 한다.** 출력이 스키마를 못 지키면 1회 재요청, 그래도 실패면 RuleBrain 템플릿으로 떨어진다(`brain_fallbacks` 지표로 센다). 이 지표가 "모델 품질"과 "런타임이 막아 준 사고"를 분리해서 보여준다.
- **지연이 실측이다.** 로컬 추론 시간이 그대로 턴 지연에 들어간다. 모델 크기별로 품질·지연 트레이드오프 표가 나오고, 상황에 맞는 모델을 고르는 근거가 된다.
- **프롬프트 캐시:** 고정 부분(정책·단계 설명)을 앞에, 턴마다 바뀌는 부분을 뒤에 둬서 Ollama의 KV 캐시 재사용을 노린다. 첫 토큰 지연이 줄어드는지 잰다.
- **클라이언트 경계:** `LlmClient` 인터페이스 하나 뒤에 둔다. 나중에 다른 서빙(llama.cpp, vLLM)이나 상용 API로 바꿔도 Brain 코드는 그대로다.

## 5. Jack 런타임 (업무 시스템 연동)

### 5.1 계약

```ts
interface Jack {
  call(op: OpSpec, args: unknown, opts: { deadline: number; idempotencyKey?: string }): Promise<JackResult>;
}
type JackResult =
  | { status: "ok"; data: unknown; latencyMs: number }
  | { status: "error"; kind: "timeout" | "5xx" | "4xx" | "unavailable" | "unknown_outcome"; latencyMs: number };
```

`unknown_outcome`은 쓰기 요청을 보냈는데 응답을 못 받은 경우다. 성공했는지 모르므로 **같은 멱등 키로 재조회/재시도**만 허용한다.

### 5.2 실패 처리 계층

| 계층 | 장치 | 기본값 |
|---|---|---|
| 호출 | 타임아웃, 재시도(지수 백오프 + 지터), 멱등 키 | Pack에서 도구별 설정 |
| 연결 | 서킷 브레이커 (연속 실패 N회 → 열림, 반열림 탐침) | 5회 / 30초 |
| 턴 | 지연 예산. 800ms 넘으면 대기 멘트, 하드 데드라인 넘으면 `onFailure` 전략 | 800ms / 도구 timeout |
| 통화 | `onFailure` 전략 | 아래 표 |

| `onFailure` | 통화에서 일어나는 일 | 결과 분류 |
|---|---|---|
| `defer_callback` | "확인 후 다시 연락드릴게요" + 콜백 예약 | `callback_scheduled` |
| `confirm_later` | 쓰기 결과를 모르면 "처리 결과는 문자로 안내드릴게요" + 비동기 확인 작업 등록 | `pending_confirmation` |
| `handoff` | 상담원 큐로 이관 | `handoff` |
| `skip` | 해당 정보 없이 대화 계속 (조회성 부가 정보만 허용) | 영향 없음 |

어떤 경우에도 **침묵이 3초를 넘지 않게** 하는 것이 런타임의 책임이다(`dead_air_incidents` 지표).

### 5.3 장애 주입

Mock 업무 시스템(`mock` jack)은 프로파일별로 장애를 낸다. 같은 시드면 같은 장애가 같은 시점에 난다.

| 프로파일 | 내용 |
|---|---|
| `clean` | 지연 50~200ms, 실패 없음 |
| `slow` | 지연 p50 900ms / p95 2.8s |
| `flaky` | 20% 5xx, 5% timeout |
| `down` | 특정 jack 전체 불가 |
| `lost-ack` | 쓰기는 반영되지만 응답 유실 → 멱등성 검증용. 이중 처리되면 `double_write` 위반 |

## 6. 가드레일

| 시점 | 검사 | 위반 시 |
|---|---|---|
| 발신 전 | 통화 가능 시간, 수신 거부 목록, 일일 시도 횟수 | 발신하지 않음 |
| 통화 시작 | 고지 문구는 Pack의 고정 문구로만 송출 | — (LLM 경로 없음) |
| 고객 발화 | 거절·이관 요청 감지 | 즉시 정중 종료 / 이관 |
| Plan | 단계 밖 도구, 동의 없는 쓰기, 그래프 밖 전이 | Plan 거부 후 재요청 |
| 에이전트 발화 | **숫자 근거**: 발화 속 숫자·금액·날짜가 `facts` 또는 인용 KB 청크에 있어야 함 | 해당 문장 제거 → 재작성 1회 → 안전 문구 |
| 에이전트 발화 | 금지 표현, 길이 상한(`maxTurnSpeechSec`) | 재작성 / 자르기 |

모델 출력 가드레일(발화 검사)과 실행 통제(도구·전이 검사)를 **구분해서** 기록한다. 지표도 따로 센다.

## 7. Soundcheck (평가)

### 7.1 실행 단위

```
매트릭스 = packs × personas(30) × fault profiles(5) × seeds
```

`npm run soundcheck -- --pack gaga-seller --brain rule --faults all --seeds 3`

### 7.2 페르소나

`personas.yaml`에 성향을 파라미터로 둔다.

```yaml
- id: busy-owner
  patience: 0.3          # 낮을수록 긴 발화에 빨리 끼어든다
  intent: decline_if_long
  knowledge: low
  quirks: [interrupts, topic_switch]
```

- `scripted`: 파라미터 기반 결정론 시뮬레이터. CI용.
- `llm`: 로컬 LLM이 연기하는 페르소나. 대화 품질 측정용. 시간이 오래 걸려서 수동 실행. **에이전트와 다른 모델 계열**을 쓴다.

### 7.3 시간 모델

실제 음성 없이 통화 시간을 잰다.

- 발화 길이 = 글자 수 ÷ 발화 속도(한국어 기본 초당 7음절, 페르소나별 조정)
- 턴 지연 = Brain 지연(LlmBrain은 실측, RuleBrain은 분포 샘플) + 도구 지연(장애 주입) + TTS 첫 음성 지연(상수)
- 끼어들기 = 페르소나가 `patience`와 발화 관련도로 끼어들 시점(글자 위치)을 정한다. **말이 길고 관련 없을수록 끼어들기가 늘어나도록** 만들어서, 끼어들기율이 실제 운영 지표처럼 "발화 품질"에 반응하게 한다.

### 7.4 지표 정의

| 지표 | 정의 | 방향 |
|---|---|---|
| `goal_rate` | 업무 시스템 상태로 판정한 성공 통화 ÷ 대상 통화 | ↑ |
| `acceptable_rate` | 성공 + Pack이 허용한 종료(콜백 예약, 정중한 거절 수용, 수신 거부 존중) | ↑ |
| `barge_in_rate` | 끼어들기 발생 에이전트 턴 ÷ 전체 에이전트 턴 | ↓ |
| `long_call_rate` | `maxCallSec` 초과 통화 비율 | ↓ |
| `turn_latency_p95` | 고객 발화 종료 → 에이전트 첫 음성 | ↓ |
| `dead_air_incidents` | 에이전트 쪽 침묵 3초 초과 횟수 | 0 |
| `degraded_survival` | 장애가 난 통화 중 허용 가능한 결과로 끝난 비율 | ↑ |
| `policy_violations` | 동의 없는 쓰기, 이중 쓰기, 거절 무시, 근거 없는 숫자 등 | 0 |

비율 지표는 Wilson 95% 구간을 같이 낸다. 구간이 겹치는 개선은 "개선"으로 보고하지 않는다.

### 7.5 출력 계약 (`report.json`, schema v1)

```json
{
  "schemaVersion": 1,
  "runId": "2026-11-16T09-00-00Z-ab12",
  "gitSha": "…", "pack": "gaga-seller@3", "brain": "rule", "seed": [1,2,3],
  "matrix": { "personas": 30, "faults": ["clean","slow","flaky","down","lost-ack"], "calls": 450 },
  "metrics": { "goal_rate": { "value": 0.61, "ci95": [0.56, 0.65], "n": 450 } },
  "gates": [ { "metric": "goal_rate", "op": ">=", "threshold": 0.55, "pass": true } ],
  "pass": true,
  "failures": [ { "callId": "…", "reason": "dead_air", "transcript": "runs/…/calls/….jsonl" } ]
}
```

- 게이트 실패 시 종료 코드 1. 이 계약 덕분에 Agent Office 같은 외부 오케스트레이터의 검증 단계에 그대로 끼울 수 있다.
- 기준선(`baselines/<pack>.json`)과 비교해 회귀를 표시한다.

### 7.6 실패 통화 → 회귀 시나리오

실패 통화의 trace를 `scenarios/regressions/`에 고정 시나리오로 승격하는 명령을 둔다(`ringdown pin <callId>`). 현업과 통화 기록을 같이 보며 고친 문제가 다시 나오지 않게 하는 장치다.

## 8. Transport (음성 확장 지점)

```ts
interface Transport {
  onUserUtterance(cb: (u: { text: string; endedAt: number; confidence?: number }) => void): void;
  speak(text: string): SpeechHandle;   // SpeechHandle은 interrupted 이벤트와 heardText를 제공
  hangup(reason: string): void;
}
```

- `SimTransport`: 페르소나 시뮬레이터와 붙는다(1차 구현).
- `ConsoleTransport`: 터미널에서 사람이 직접 통화 상대가 된다(데모용).
- `VoiceTransport`(후순위): WebSocket 오디오 스트림 + 외부 ASR/TTS. ASR confidence가 낮으면 되묻기 정책을 Pack에서 켠다.

## 9. 관측

- 모든 턴을 trace 이벤트(JSONL)로 남긴다: `turn.start`, `brain.plan`, `guard.reject`, `tool.call`, `tool.result`, `speech.start`, `speech.interrupted`, `call.end`.
- 각 이벤트에 시뮬레이션 시각과 지연 분해(brain / tool / tts)를 넣어서, p95가 나빠지면 어느 구간 탓인지 바로 보이게 한다.
- `ringdown replay <callId>`: 저장된 trace로 통화를 다시 보여준다.

## 10. 저장소 구조

```
ringdown/
  src/
    runtime/      턴 루프, 단계 그래프, 상태
    brain/        rule, llm (LlmClient: ollama)
    guard/        pre/plan/output 가드
    knowledge/    BM25 인덱스, 청크 인용
    jacks/        jack 런타임(timeout/retry/breaker/idempotency), http-json, mock
    transport/    sim, console
    soundcheck/   매트릭스 실행, 페르소나, 지표, 보고서
    pack/         스키마(zod), 로더, 검증
    cli.ts
  packs/
    gaga-seller/   판매자 반품 정책 안내 (쓰기 도구 있음)
    gaga-ads/      광고 잔액 소진 전 자동충전 권유 (거절·수신거부가 많은 영업 콜)
  mocks/          가상 업무 시스템(판매자 API, 광고 API) + 장애 주입
  baselines/  scenarios/  docs/decisions/
```

가상 조직(가가마켓·가가애즈)은 실재 회사와 무관한 이름으로 둔다.

## 11. 단계별 계획

| 단계 | 산출물 | 완료 기준 |
|---|---|---|
| M1 계약 | Pack 스키마, Jack/Brain/Transport 인터페이스, mock 업무 시스템 | `ringdown validate packs/*` 통과, 잘못된 Pack 10종이 정확한 오류로 거부됨 |
| M2 런타임 | 턴 루프, 가드레일, Jack 런타임, RuleBrain, SimTransport | 2개 Pack × 5개 장애 프로파일 통화가 끝까지 돈다. `lost-ack`에서 이중 쓰기 0 |
| M3 Soundcheck | 페르소나 30종, 지표, report.json, 게이트, 기준선 | `npm run soundcheck` 한 번에 보고서. CI에서 게이트 실패 시 빨간불 |
| M4 LlmBrain | 로컬 LLM Brain(JSON 스키마 출력), LLM 페르소나 | 같은 매트릭스를 rule/모델 2~3종으로 돌려 품질·지연 비교표 생성 |
| M5 온보딩 증명 | 세 번째 Pack 추가 | `packs/` 밖 변경 파일 0 (CI가 확인) |
| M6 음성 | VoiceTransport | 후순위 |

## 12. 위험과 한계

- **시뮬레이션은 실제 통화가 아니다.** 페르소나 분포가 실제 고객과 다르면 지표도 다르다. 보고서에 "시뮬레이션 기준"을 항상 표기하고, 실통화 trace가 생기면 그것으로 페르소나를 보정한다.
- **LLM 페르소나가 LLM 에이전트에 유리하게 반응할 수 있다.** 같은 모델끼리 대화시키지 않고, scripted 페르소나 결과와 항상 같이 본다.
- **RuleBrain 기준선이 너무 약하면 LlmBrain 개선폭이 부풀려진다.** 기준선을 일부러 약하게 만들지 않는다.
- **로컬 모델은 상용 모델보다 약하다.** 목표는 최고 점수가 아니라, 약한 모델로도 정책 위반 0·침묵 0을 지키는 런타임을 보여주는 것이다.

## 13. 열린 결정

1. ~~LLM 공급원~~ → 로컬 LLM(Ollama)으로 결정
2. ~~가상 조직~~ → 가가마켓·가가애즈로 결정
3. 음성(M6) 착수 시점
