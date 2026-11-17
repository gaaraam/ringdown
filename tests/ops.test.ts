import { afterEach, beforeEach, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlStore } from "../src/ops/store.ts";
import { CampaignRunner, customerFor } from "../src/ops/campaigns.ts";
import { followUps, outcomeLabels, statistics, summarize, writeLanded, type StoredCall } from "../src/ops/model.ts";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { Outcome } from "../src/pack/schema.ts";
import { runCall } from "../src/runtime/call.ts";
import { createPlayServer } from "../src/play/server.ts";

const loaded = loadPack(listPackDirs("packs")[0]!);
if (!loaded.ok) throw new Error("fixture");
const pack = loaded.value;
const clock = () => new Date("2026-11-17T00:00:00Z");
let dir: string, store: JsonlStore, runner: CampaignRunner;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ringdown-ops-")); store = new JsonlStore(dir); runner = new CampaignRunner(store, clock); });
afterEach(async () => { await runner.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
async function run(fault = "clean", personas = pack.personas.map(p => p.id)) {
  const campaign = runner.start(pack, { personas, fault, seed: 7 }); await runner.settled(); return campaign;
}
it("persists every call unchanged, with source customer names and a serial simulated clock", async () => {
  const campaign = await run();
  const calls = store.calls().reverse();
  expect(calls).toHaveLength(pack.personas.length);
  expect(store.campaigns()[0]).toMatchObject({ id: campaign.id, status: "complete" });
  for (const [i, call] of calls.entries()) {
    const persona = pack.personas[i]!;
    const expected = await runCall(pack, persona, "clean", 7);
    expect(call.customer).toEqual(customerFor(pack, persona));
    expect(call.events).toEqual(expected.events);
    expect(call.state.transcript).toEqual(expected.transcript);
    expect(call.pending).toEqual(expected.pending);
    expect(call.system.collections).toEqual(expected.system.collections);
    expect(call.system.writes).toEqual(expected.system.writes);
    expect(call.outcome).toBe(expected.outcome);
    expect(call.durationMs).toBe(expected.events.find(e => e.type === "call.end")!.durationMs);
    if (i) expect(Date.parse(call.startedAt)).toBeGreaterThanOrEqual(Date.parse(calls[i - 1]!.startedAt) + calls[i - 1]!.durationMs + 30_000);
  }
  const before = JSON.stringify({ calls: store.calls(), campaigns: store.campaigns(), inbox: store.inbox() });
  store.close(); store = new JsonlStore(dir);
  expect(JSON.stringify({ calls: store.calls(), campaigns: store.campaigns(), inbox: store.inbox() })).toBe(before);
});
it("derives each pending operation once, persists assignee, resolution and reopen", async () => {
  await run("lost-ack");
  const items = store.inbox();
  expect(new Set(items.map(i => i.kind))).toEqual(new Set(["callback", "confirmation", "handoff"]));
  for (const call of store.calls()) expect(items.filter(i => i.callId === call.id).length).toBeGreaterThanOrEqual(call.pending.length);
  const item = items.find(i => i.kind === "confirmation")!;
  expect(item.reason).not.toMatch(/unknown_outcome|confirm_later|idempotency/);
  expect(store.resolve(item.id, { status: "resolved", assignee: "운영 담당", note: "업무 반영 확인 후 안내 완료" })).toBe(true);
  expect(store.resolve("missing", { status: "resolved", assignee: "", note: "" })).toBe(false);
  store.close(); store = new JsonlStore(dir);
  expect(store.inbox().find(i => i.id === item.id)).toMatchObject({ status: "resolved", assignee: "운영 담당", note: "업무 반영 확인 후 안내 완료", landed: true });
  store.resolve(item.id, { status: "open", assignee: "다음 담당", note: "추가 안내" });
  expect(store.inbox().find(i => i.id === item.id)?.status).toBe("open");
});
it("lost-ack confirmations read persisted exact write and field state for both landed and not landed", async () => {
  // The stock lost-ack profile always applies valid writes. A missing write route
  // models a rejected write; the 1ms deadline loses that rejection too. No engine or fault mutation.
  for (const rejected of [false, true]) {
    const fixture = structuredClone(pack);
    const tool = Object.values(fixture.pack.tools).find(t => t.kind === "write")!;
    tool.timeoutMs = 1; tool.retry.max = 0;
    if (rejected) fixture.mock!.routes = fixture.mock!.routes.filter(r => r.op !== tool.op);
    runner.start(fixture, { personas: [pack.personas[0]!.id], fault: "lost-ack", seed: 7 }); await runner.settled();
    const call = store.calls()[0]!;
    expect(call.events.some(e => (e.result as { kind?: string })?.kind === "unknown_outcome")).toBe(true);
    expect(call.pending.some(p => p.kind === "confirmation")).toBe(true);
    expect(followUps(call).find(i => i.kind === "confirmation")?.landed).toBe(!rejected);
  }
  store.close(); store = new JsonlStore(dir);
  expect(store.inbox().filter(i => i.kind === "confirmation").map(i => i.landed)).toEqual([false, true]);
  const applied = store.calls()[1]!;
  expect(writeLanded(applied, applied.writeEvidence[0])).toBe(true);
  const evidence = applied.writeEvidence[0]!;
  const write = applied.system.writes[0]!;
  // A success outcome or an old write ledger is insufficient when the state does not match.
  applied.system.collections[write.collection]![write.recordKey] = {};
  expect(writeLanded(applied, evidence)).toBe(false);
});
it("final unknown writes without pending registration are surfaced; recovered retries are not", async () => {
  await run("lost-ack");
  const call = store.calls().find(c => c.pending.some(p => p.kind === "confirmation"))!;
  const expected = followUps(call).filter(i => i.kind === "confirmation");
  call.pending = [];
  expect(followUps(call).filter(i => i.kind === "confirmation")).toHaveLength(expected.length);
  for (const event of call.events) if (event.type === "tool.result" && !event.attempt && event.callSeq) event.result = { status: "ok" };
  expect(followUps(call)).toEqual([]);
});
it("searches customer name or id, intersects outcome/campaign/Korean date filters, and returns detached records", async () => {
  const campaign = await run(); await run("down");
  const call = store.calls({ campaign: campaign.id })[0]!;
  expect(store.calls({ q: call.customer.targetId.toLowerCase(), campaign: campaign.id, outcome: call.outcome, date: "2026-11-17" })).toEqual([call]);
  expect(store.calls({ q: call.customer.name, campaign: campaign.id })).toContainEqual(call);
  expect(store.calls({ date: "2026-11-18" })).toEqual([]);
  expect(store.calls({ campaign: "missing" })).toEqual([]);
  call.state.transcript.length = 0;
  expect(store.calls({ campaign: campaign.id })[0]!.state.transcript.length).toBeGreaterThan(0);
});
it.each(Outcome.options)("summarizes %s with transcript, facts, result and remaining work", async outcome => {
  await run("clean", [pack.personas[0]!.id]);
  const call = store.calls()[0]!;
  call.outcome = outcome; call.pending = [{ kind: "callback" }];
  const summary = summarize(call);
  expect(summary).toContain(call.customer.name);
  expect(summary).toContain(call.state.transcript.filter(t => t.role === "user").at(-1)!.text);
  expect(summary).toContain("남은 처리: 콜백");
  const words: Record<string, string> = { success: "목표를 달성", failed: "목표를 달성하지 못", declined: "제안을 거절", opted_out: "수신 거부", handoff: "상담원 연결", callback_scheduled: "다시 연락", pending_confirmation: "확정하지 못" };
  expect(summary).toContain(words[outcome]);
  expect(summary).not.toContain(outcome);
});
it("computes distributions, rates, API kinds without double-counting attempts or built-ins", async () => {
  await run("down");
  const stats = statistics(store.calls(), store.inbox());
  expect(stats.total).toBe(pack.personas.length);
  expect(stats.api.requests).toBe(pack.personas.length);
  expect(stats.api.errors.unavailable).toBe(pack.personas.length);
  expect(stats.api.errorRates.unavailable).toBe(1);
  expect(stats.openFollowUps).toBe(store.inbox().length);
  expect(statistics([], []).goalRate).toBeNull();
  expect(statistics([], []).api.errorRates.timeout).toBeNull();
  const result = statistics(store.calls().map(c => ({ ...c, outcome: "opted_out" })), []);
  expect(result.optOutRate).toBe(1);
  expect(Object.keys(result.outcomes)).toEqual(Object.keys(outcomeLabels));
});
it("recovers an incomplete final append and marks interrupted campaigns without rerunning calls", async () => {
  await run("clean", [pack.personas[0]!.id]);
  const campaign = store.campaigns()[0]!;
  store.putCampaign({ ...campaign, status: "running" }); store.close();
  appendFileSync(join(dir, "ops.jsonl"), '{"v":1,"type":"call"');
  store = new JsonlStore(dir); runner = new CampaignRunner(store, clock);
  expect(store.campaigns()[0]!.status).toBe("interrupted");
  expect(store.calls()).toHaveLength(1);
  expect(readFileSync(join(dir, "ops.jsonl"), "utf8").endsWith("\n")).toBe(true);
  expect(() => new JsonlStore(dir)).toThrow();
});
it("does not silently discard corruption in committed records", () => {
  store.close(); appendFileSync(join(dir, "ops.jsonl"), 'not-json\n');
  expect(() => new JsonlStore(dir)).toThrow();
});
it("operations API validates requests, filters, resolution, progress and restart persistence", async () => {
  // This test uses the same temp store through the public HTTP server.
  store.close();
  let app = createPlayServer({ dataDir: dir, clock }); let base = await app.listen(0);
  const request = (path: string, value?: unknown, method = value ? "POST" : "GET") => fetch(base + "/api/ops" + path,
    { method, headers: value ? { "content-type": "application/json" } : {}, body: value ? JSON.stringify(value) : undefined });
  try {
    const input = { pack: pack.pack.id, fault: "lost-ack", seed: 7 };
    for (const change of [{ seed: 1.2 }, { seed: 2 ** 40 }, { fault: "bad" }, { personas: [] }, { personas: ["missing"] },
      { personas: [pack.personas[0]!.id, pack.personas[0]!.id] }, { brain: "llm" }]) expect((await request("/campaigns", { ...input, ...change })).status).toBe(400);
    expect((await request("/campaigns", { ...input, pack: "../packs" })).status).toBe(404);
    for (const path of ["/calls?outcome=bad", "/calls?date=2026-02-30", "/calls?bad=1", "/calls?q=a&q=b", "/inbox?status=bad", "/inbox?kind=bad", "/overview?x=1"]) expect((await request(path)).status).toBe(400);
    expect((await request("/inbox/missing", { status: "resolved", assignee: "", note: "" }, "PATCH")).status).toBe(404);
    for (const value of [{ status: "closed", assignee: "", note: "" }, { status: "resolved", assignee: "x".repeat(101), note: "" }, { status: "resolved", assignee: "", note: "x".repeat(2001) }, { status: "resolved" }]) expect((await request("/inbox/missing", value, "PATCH")).status).toBe(400);
    const response = await request("/campaigns", input); expect(response.status).toBe(202);
    const campaign = await response.json();
    let progress;
    for (let i = 0; i < 200; i++) { progress = await (await request(`/campaigns/${campaign.id}`)).json(); if (progress.status !== "running") break; }
    expect(progress).toMatchObject({ status: "complete", completed: pack.personas.length, total: pack.personas.length });
    const inbox = await (await request("/inbox?kind=confirmation&status=open")).json();
    expect(inbox.length).toBeGreaterThan(0);
    expect((await request(`/inbox/${inbox[0].id}`, { status: "resolved", assignee: "담당자", note: "안내 완료" }, "PATCH")).status).toBe(200);
    expect((await (await request("/inbox?status=resolved")).json())[0].assignee).toBe("담당자");
    const calls: StoredCall[] = await (await request(`/calls?campaign=${campaign.id}`)).json();
    const detail = await (await request(`/calls/${calls[0]!.id}`)).json();
    expect(detail.system.collections).toBeDefined(); expect(detail.summary).toBeTruthy();
    const filtered = await (await request(`/calls?q=${calls[0]!.customer.targetId}&date=2026-11-17`)).json();
    expect(filtered).toHaveLength(1);
    const stats = await (await request(`/overview?campaign=${campaign.id}`)).json(); expect(stats.total).toBe(pack.personas.length);
    await app.close(); app = createPlayServer({ dataDir: dir, clock }); base = await app.listen(0);
    expect(await (await request(`/calls?campaign=${campaign.id}`)).json()).toEqual(calls);
    expect((await (await request("/inbox?status=resolved")).json())[0].note).toBe("안내 완료");
    const catalogue = await (await request("/catalogue")).json(); expect(catalogue.packs[0].personas[0].customer).toEqual(customerFor(pack, pack.personas[0]!));
  } finally { await app.close(); }
});
it("rejects simultaneous campaigns, drains on shutdown, and keeps repeated runs distinct", async () => {
  const input = { personas: [pack.personas[0]!.id], fault: "clean", seed: 7 };
  const first = runner.start(pack, input);
  expect(() => runner.start(pack, input)).toThrow("Campaign already running");
  await runner.settled();
  const second = runner.start(pack, input); await runner.close();
  expect(first.id).not.toBe(second.id);
  expect(store.calls()).toHaveLength(2);
  expect(new Set(store.calls().map(c => c.id)).size).toBe(2);
  expect(store.campaigns().every(c => c.status === "complete")).toBe(true);
  expect(() => runner.start(pack, input)).toThrow();
});
it("uses the source target id when the mock record has no display name", () => {
  const fixture = structuredClone(pack), persona = pack.personas[0]!;
  fixture.mock!.collections[fixture.pack.call.target.collection]![persona.targetId] = {};
  expect(customerFor(fixture, persona)).toEqual({ name: persona.targetId, targetId: persona.targetId });
});
