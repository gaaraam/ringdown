# Soundcheck 실행과 해석

```sh
npm ci
npm run soundcheck -- --pack packs/gaga-seller --pack packs/gaga-ads --faults all --seeds 3
npm run soundcheck -- --pack packs/gaga-seller --seeds 3 --baseline
npm run soundcheck -- --pack packs/gaga-seller --seeds 3 --update-baseline
npm run ringdown -- pin runs/<runId> <callId>
npm run ci
```

`--seeds N`은 시드 1부터 N까지다. `--faults clean,flaky`처럼 부분집합도 가능하다. `--out` 기본값은 `runs`. `--brain rule`만 허용하며 LLM은 호출하지 않는다. 모델 설정은 `resolveModels`로 읽어 역할·출처·label·used:false를 남긴다.

여러 Pack은 각각 `runs/<runId>/report.json`, `report.md`, `calls/<callId>.jsonl`을 생성한다. trace 경로는 보고서 디렉터리 기준이다. 하나라도 게이트에 실패하면 프로세스 종료 코드 1이다. 게이트는 점 추정값으로 판정하고 CI는 불확실성 표시 및 기준선 비교에 쓴다. 집계 게이트 실패와 통화 단위 failures는 다르다. 예를 들어 허용된 콜백만 있어도 성공률 게이트는 실패할 수 있다.

`report.json`은 `src/soundcheck/report.ts`의 엄격한 zod v1 계약이다. DESIGN 예시의 `seed` 대신 요청된 `seeds`, `transcript` 대신 `trace`를 사용한다. 실패 외 통화도 pin할 수 있도록 `calls` 목록을 추가했다. Pack별 보고서 구조를 유지하므로 다중 Pack을 하나의 성공률로 섞지 않는다.

기준선은 metrics와 CI 외에 비교 조건(Pack 버전, brain, 매트릭스, 시드)을 보관한다. 조건이 다르면 비교를 거부한다. 두 95% 구간이 끝점에서 닿아도 `변화 없음(구간 겹침)`이다. 합계/p95는 구간이 없어서 판정 불가다. 이는 유의성 검정 대신 사용하는 보수적 규칙이며 비중첩 자체가 현실 고객의 인과적 개선을 입증하지 않는다. 같은 버전의 Pack 내용 변경까지 탐지하는 콘텐츠 해시는 아직 없다.

지표의 정확한 정의와 한계는 생성된 report.md의 정의 절 및 `src/soundcheck/metrics.ts`에 함께 기록한다. 성공률 분모는 수락 의도의 고객만이 아니라 전체 입력 통화다. 통화별 mock 상태와 브레이커가 새로 생성된다. 실제 장애는 non-ok 업무 도구 시도로 판단하여 정상 완료된 slow 통화는 장애 생존율 분모에서 제외한다. 분모 0은 null이다. 고정 고지를 끼어들기율에서 제외하고 filler는 발화와 지연 응답에 포함한다.

정책 위반은 가드가 막은 제안과 실제로 실행·송출한 위반을 구별한다. 현재 감사는 무동의/이중 쓰기, 수신 거부 이후 도구 실행, 출력 근거/금지어 범위이며 모든 운영 정책의 증명은 아니다. `Brain.takeFallbacks()`는 사유를 소비하는 M4 연결점이고 런타임이 `brain.fallback` trace로 기록한다.

시뮬레이션 기준: scripted는 단계·선택지를 미리 알고, filler는 구조적으로 침묵을 예방하며, rule의 fallback은 0이다. 성공 외의 허용 종료가 많아 acceptable_rate와 degraded_survival은 쉽게 100%가 된다. 지연은 가상 시계이고 실제 LLM/ASR/TTS/API 성능을 뜻하지 않는다. 반복 페르소나와 턴의 상관을 보정한 통계나 실제 고객 표본 추정은 범위 밖이다.
