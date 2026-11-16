/**
 * 장애 프로파일. mock 업무 시스템이 "서버가 무엇을 했고, 응답이 언제 도착하는지"를 정한다.
 * 타임아웃 판정은 하지 않는다 — 그건 호출하는 쪽(Jack 런타임)의 데드라인이 정한다.
 * 응답이 영영 오지 않는 경우는 latencyMs = Infinity로 표현한다.
 */
export interface FaultProfile {
  id: string;
  description: string;
  latency: { p50: number; p95: number };
  /** 서버가 처리하지 않고 5xx를 돌려줄 확률 */
  error5xx: number;
  /** 서버가 응답하지 않을 확률 (처리도 안 됨) */
  hang: number;
  /** 연결 자체가 안 됨 */
  unavailable: boolean;
  /** 쓰기가 반영된 뒤 응답만 유실될 확률 (멱등성 검증용) */
  lostAck: number;
}

export const FAULT_PROFILES: Record<string, FaultProfile> = {
  clean: {
    id: "clean",
    description: "지연 50~200ms, 실패 없음",
    latency: { p50: 90, p95: 200 },
    error5xx: 0,
    hang: 0,
    unavailable: false,
    lostAck: 0,
  },
  slow: {
    id: "slow",
    description: "지연 p50 900ms / p95 2.8s",
    latency: { p50: 900, p95: 2800 },
    error5xx: 0,
    hang: 0,
    unavailable: false,
    lostAck: 0,
  },
  flaky: {
    id: "flaky",
    description: "20% 5xx, 5% 무응답",
    latency: { p50: 150, p95: 600 },
    error5xx: 0.2,
    hang: 0.05,
    unavailable: false,
    lostAck: 0,
  },
  down: {
    id: "down",
    description: "업무 시스템 연결 불가",
    latency: { p50: 5, p95: 20 },
    error5xx: 0,
    hang: 0,
    unavailable: true,
    lostAck: 0,
  },
  "lost-ack": {
    id: "lost-ack",
    description: "쓰기는 반영되지만 응답 50% 유실",
    latency: { p50: 120, p95: 400 },
    error5xx: 0,
    hang: 0,
    unavailable: false,
    lostAck: 0.5,
  },
};

export const FAULT_IDS = Object.keys(FAULT_PROFILES);

export function getFaultProfile(id: string): FaultProfile {
  const p = FAULT_PROFILES[id];
  if (!p) throw new Error(`알 수 없는 장애 프로파일 '${id}' (가능: ${FAULT_IDS.join(", ")})`);
  return p;
}
