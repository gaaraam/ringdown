import { describe, expect, it } from "vitest";
import { FAULT_PROFILES, getFaultProfile } from "../src/jacks/faults.ts";
import { MockBusinessSystem, MockJack } from "../src/jacks/mock.ts";
import { loadPack } from "../src/pack/load.ts";
import { Rng } from "../src/sim/rng.ts";

const loaded = loadPack("packs/gaga-seller");
if (!loaded.ok) throw new Error("fixture pack invalid");
const mock = loaded.value.mock!;

const read = { op: "GET /sellers/{sellerId}", pathParams: { sellerId: "S-1001" }, now: 0 };
const write = (key?: string) => ({
  op: "PUT /sellers/{sellerId}/return-policy",
  pathParams: { sellerId: "S-1001" },
  body: { plan: "paid-3000" },
  idempotencyKey: key,
  now: 1000,
});

describe("선언형 mock 업무 시스템", () => {
  it("조회와 쓰기를 mock.yaml 라우트대로 처리한다", () => {
    const sys = new MockBusinessSystem(mock);
    expect(sys.handle(read)).toMatchObject({ status: "ok", data: { storeName: "달빛공방" } });
    sys.handle(write("k1"));
    expect(sys.get("sellers", "S-1001")?.returnPolicy).toEqual({ plan: "paid-3000" });
  });

  it("없는 레코드는 404", () => {
    const sys = new MockBusinessSystem(mock);
    expect(sys.handle({ ...read, pathParams: { sellerId: "S-0000" } })).toEqual({ status: "4xx", httpStatus: 404 });
  });

  it("통화마다 상태가 분리된다", () => {
    const a = new MockBusinessSystem(mock);
    a.handle(write("k1"));
    expect(new MockBusinessSystem(mock).get("sellers", "S-1001")?.returnPolicy).toBeNull();
  });

  it("같은 멱등 키의 재시도는 다시 반영되지 않는다", () => {
    const sys = new MockBusinessSystem(mock);
    sys.handle(write("k1"));
    sys.handle(write("k1"));
    expect(sys.writes).toHaveLength(1);
    expect(sys.doubleWrites()).toHaveLength(0);
  });

  it("멱등 키 없이 재시도하면 이중 쓰기로 잡힌다", () => {
    const sys = new MockBusinessSystem(mock);
    sys.handle(write());
    sys.handle(write());
    expect(sys.doubleWrites()).toHaveLength(1);
  });
});

describe("장애 주입", () => {
  const run = (profile: string, seed: number, req = read, times = 200) => {
    const jack = new MockJack("gaga-api", new MockBusinessSystem(mock), getFaultProfile(profile), new Rng(seed));
    return Promise.all(Array.from({ length: times }, () => jack.call(req)));
  };

  it("같은 시드면 같은 결과", async () => {
    expect(await run("flaky", 7)).toEqual(await run("flaky", 7));
  });

  it("clean은 실패가 없다", async () => {
    expect((await run("clean", 1)).every((r) => r.status === "ok" && Number.isFinite(r.latencyMs))).toBe(true);
  });

  it("flaky는 대략 설정한 비율로 실패한다", async () => {
    const res = await run("flaky", 3, read, 2000);
    const rate5xx = res.filter((r) => r.status === "error" && r.kind === "5xx").length / res.length;
    expect(rate5xx).toBeGreaterThan(0.15);
    expect(rate5xx).toBeLessThan(0.25);
  });

  it("down은 전부 연결 불가", async () => {
    expect((await run("down", 1)).every((r) => r.status === "error" && r.kind === "unavailable")).toBe(true);
  });

  it("lost-ack는 쓰기를 반영하고 응답만 잃는다", async () => {
    const sys = new MockBusinessSystem(mock);
    const jack = new MockJack("gaga-api", sys, FAULT_PROFILES["lost-ack"]!, new Rng(11));
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => jack.call(write(`k${i}`))));
    const lost = results.filter((r) => r.status === "ok" && !Number.isFinite(r.latencyMs)).length;
    expect(lost).toBeGreaterThan(10);
    expect(sys.writes).toHaveLength(50); // 응답을 잃어도 서버에는 반영됐다
  });

  it("slow의 p95는 설정값 근처", async () => {
    const lat = (await run("slow", 5, read, 3000)).map((r) => r.latencyMs).sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)]!;
    expect(p95).toBeGreaterThan(2200);
    expect(p95).toBeLessThan(3500);
  });
});
