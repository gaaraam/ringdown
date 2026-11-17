# Ringdown

조직마다 다른 지식·정책·업무 시스템에 AI 콜 에이전트를 **설정 묶음 하나로** 연결하고,
업무 시스템이 느리거나 죽어도 통화가 이어지는지 **시뮬레이션으로 잽니다**.

- 새 조직 = `packs/<org>/` 디렉터리 하나. 엔진 코드에 조직 이름이 나오면 CI가 막습니다.
- LLM은 말할 내용을 제안만 하고, 실행 여부·시점·실패 처리는 결정론 런타임이 정합니다.
- 모델은 로컬 LLM(Ollama 등)이고 설정 파일·환경변수·CLI로 언제든 바꿉니다.

> 개발 중입니다. 진행 상황은 [docs/PROGRESS.md](docs/PROGRESS.md), 설계는 [docs/DESIGN.md](docs/DESIGN.md).

## 빠른 시작

```bash
npm ci
npm run validate                 # packs/ 아래 Pack 검증
npm run ringdown -- models       # 역할별 모델과 그 출처
npm run ci                       # 타입 검사 + lint + 테스트 + 경계 검사 + Pack 검증 + smoke
```

## Pack 구조

```
packs/gaga-seller/          가가마켓 반품 배송비 정책 안내 (가상 조직)
  pack.yaml                 목표 · 정책 · 단계 그래프 · 도구 · 합격선
  jacks.yaml                업무 시스템 연결 (mock 또는 http-json)
  mock.yaml                 선언형 mock 업무 시스템
  personas.yaml             soundcheck 통화 상대
  kb/*.md                   조직 지식
```

가가마켓·가가애즈는 가상 조직이며 실재하는 회사·서비스와 관련이 없습니다.


## 단일 통화 시뮬레이션 (M2)

```bash
npm run ringdown -- call --pack packs/gaga-seller --persona cooperative-owner --faults lost-ack --seed 7
npm run ringdown -- call --pack packs/gaga-ads --persona grateful-owner --faults slow --seed 7 --json
```

장애 프로파일은 `clean`, `slow`, `flaky`, `down`, `lost-ack`이다. 출력은 시뮬레이션 시각의 대화·끼어들기로 들린 부분·최종 결과이며, `runs/<runId>/calls/<callId>.jsonl`에 이벤트와 지연 분해를 저장한다. 동일 Pack·페르소나·장애·시드는 같은 경로를 덮어쓴다. `runs/`는 Git에서 제외된다.

M2는 RuleBrain과 mock만 사용하며 실제 대기, LLM 호출, 전화 발신, SMS 발송은 하지 않는다. 콜백·확인 작업·이관은 trace의 pending 목록에 등록된다. 성공은 Brain의 선언이 아닌 mock 업무 상태로 판정한다. scripted 페르소나는 현재 단계와 규칙을 아는 테스트 장치이므로 결과를 실제 고객의 대화 품질로 해석하면 안 된다.


## Playground

```bash
npm run play                   # http://localhost:4310 (127.0.0.1에만 바인딩)
PORT=4311 npm run play          # 포트 변경
```

Playground에서 Pack·페르소나·장애·시드를 고르고 자동 통화를 돌리거나, **직접 대화해요** 모드로 고객의 말을 입력해요. 입력을 기다리는 실제 시간은 시뮬레이션 시계에 포함하지 않아요. 오른쪽에는 단계 그래프, 슬롯·출처가 있는 사실, Jack 차단기와 실행 지표가 나타나요.

Calls에서는 말풍선 아래 trace를 펼쳐 의도, 제안, 실행된 전이, 도구 시도·지연·멱등 키, 대기 멘트와 침묵을 확인해요. 거부·수정 사유는 접혀 있어도 표시해요. Soundcheck에서는 작은 기본 매트릭스(clean/slow × 시드 7)를 실행하고, 게이트·Wilson 95% CI·목표 성공률 히트맵을 봐요. 칸을 누르면 같은 조건의 통화를 결정론적으로 재생해요. 여러 시드가 있으면 통화를 선택해요.

![Playground 라이트 화면](docs/screenshots/light-playground.png)

RuleBrain과 mock만 사용해요. LLM·실제 전화·외부 업무 API는 호출하지 않아요. 기록은 서버 메모리에 최근 100개까지 보관하고, 동시에 진행하는 통화는 8개로 제한해요. 화면을 닫아도 사람 입력 대기는 유지되며 Calls에서 이어서 입력하거나 통화를 닫을 수 있어요. 서버를 재시작하면 기록은 사라져요. 사람 모드의 페르소나는 업무 조회 대상만 선택하며, 응답과 끼어들기를 자동 생성하지 않아요.

API는 같은 로컬 주소에서 JSON으로 요청해요. `GET /api/packs`, `GET /api/packs/:id`, `GET /api/calls`, `POST /api/calls`, `GET /api/calls/:id`, `GET /api/calls/:id/events`(SSE), `POST /api/calls/:id/say`, `DELETE /api/calls/:id`, `POST /api/soundcheck`를 제공해요. 통화 생성 본문은 `{pack, persona, fault, seed, mode}`이고, 고객 입력은 `{text}`, 매트릭스는 `{pack, faults, seeds}`예요. SSE는 재연결해도 복구할 수 있는 전체 snapshot을 보내요. 매트릭스는 최대 5개 장애·3개 시드를 받아요.

```bash
npm run visual                 # 설치된 headless Chrome으로 6장 캡처 + 화면 흐름 검사
# 필요하면 CHROME_BIN=/path/to/chrome npm run visual
```

기본 Chrome 경로는 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`이에요. 별도 브라우저 다운로드·서버 준비·프런트엔드 빌드는 필요하지 않아요. 임시 포트의 서버와 독립된 브라우저를 자동으로 닫아요. 시드 7, 1440×1000, 로컬 시스템 글꼴로 `docs/screenshots/{light,dark}-{playground,calls,soundcheck}.png`를 만들어요. 시스템 글꼴과 Chrome 버전이 같은 환경에서는 재실행 결과가 같아요. 테마는 시스템 설정을 따르거나 화면 하단에서 직접 바꿀 수 있어요.
