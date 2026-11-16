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
npm run ci                       # 타입 검사 + 테스트 + 경계 검사 + Pack 검증
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
