/**
 * 선언형 mock 업무 시스템. packs/<org>/mock.yaml을 해석할 뿐 조직별 코드는 없다.
 * 통화 한 건마다 새 인스턴스를 만들어 상태가 섞이지 않게 한다.
 */
import type { Jack, JackRequest, JackResult } from "../core/types.ts";
import type { Mock } from "../pack/schema.ts";
import type { Rng } from "../sim/rng.ts";
import type { FaultProfile } from "./faults.ts";

export interface AppliedWrite {
  op: string;
  collection: string;
  recordKey: string;
  idempotencyKey?: string;
  at: number;
}

type Rec = Record<string, unknown>;

export class MockBusinessSystem {
  readonly collections: Record<string, Record<string, Rec>>;
  readonly writes: AppliedWrite[] = [];
  private readonly idem = new Map<string, unknown>();
  private seq = 0;

  constructor(private readonly spec: Mock) {
    this.collections = structuredClone(spec.collections) as Record<string, Record<string, Rec>>;
  }

  /** 서버 측 처리. 장애와 무관한 "정상 서버"의 동작 */
  handle(req: JackRequest): { status: "ok"; data: unknown } | { status: "4xx"; httpStatus: number } {
    const route = this.spec.routes.find((r) => r.op === req.op);
    if (!route) return { status: "4xx", httpStatus: 404 };

    if (req.idempotencyKey && this.idem.has(req.idempotencyKey)) {
      return { status: "ok", data: this.idem.get(req.idempotencyKey) };
    }

    const col = (this.collections[route.collection] ??= {});
    let data: unknown;

    if (route.action === "create") {
      const id = `${route.collection}-${++this.seq}`;
      col[id] = { id, ...req.body, createdAt: req.now };
      data = col[id];
      this.writes.push({ op: req.op, collection: route.collection, recordKey: id, idempotencyKey: req.idempotencyKey, at: req.now });
    } else {
      const key = route.key ? String(req.pathParams[route.key] ?? "") : "";
      const rec = col[key];
      if (!rec) return { status: "4xx", httpStatus: 404 };
      if (route.action === "read") {
        data = structuredClone(rec);
      } else {
        if (route.field) rec[route.field] = { ...(req.body ?? {}) };
        else Object.assign(rec, req.body ?? {});
        data = structuredClone(rec);
        this.writes.push({ op: req.op, collection: route.collection, recordKey: key, idempotencyKey: req.idempotencyKey, at: req.now });
      }
    }

    if (req.idempotencyKey) this.idem.set(req.idempotencyKey, data);
    return { status: "ok", data };
  }

  /** 같은 레코드에 같은 쓰기가 두 번 이상 반영된 경우 (멱등성 위반) */
  doubleWrites(): AppliedWrite[][] {
    const groups = new Map<string, AppliedWrite[]>();
    for (const w of this.writes) {
      if (w.op.startsWith("POST")) continue; // create는 레코드 키가 매번 달라서 아래에서 따로 본다
      const k = `${w.op}|${w.recordKey}`;
      groups.set(k, [...(groups.get(k) ?? []), w]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  get(collection: string, key: string): Rec | undefined {
    return this.collections[collection]?.[key];
  }
}

const isWrite = (op: string) => !op.startsWith("GET ");

/** 장애 프로파일을 씌운 Jack */
export class MockJack implements Jack {
  constructor(
    readonly id: string,
    readonly system: MockBusinessSystem,
    private readonly fault: FaultProfile,
    private readonly rng: Rng,
  ) {}

  async call(req: JackRequest): Promise<JackResult> {
    const f = this.fault;
    const latencyMs = this.rng.latency(f.latency.p50, f.latency.p95);

    if (f.unavailable) return { status: "error", kind: "unavailable", latencyMs };
    if (this.rng.chance(f.hang)) return { status: "error", kind: "timeout", latencyMs: Infinity };
    if (this.rng.chance(f.error5xx)) return { status: "error", kind: "5xx", latencyMs, httpStatus: 503 };

    const res = this.system.handle(req);
    if (res.status === "4xx") return { status: "error", kind: "4xx", latencyMs, httpStatus: res.httpStatus };

    // 서버는 처리했지만 응답이 오지 않는다. 호출 쪽은 결과를 모르는 상태가 된다
    if (isWrite(req.op) && this.rng.chance(f.lostAck)) {
      return { status: "ok", data: res.data, latencyMs: Infinity };
    }
    return { status: "ok", data: res.data, latencyMs };
  }
}

