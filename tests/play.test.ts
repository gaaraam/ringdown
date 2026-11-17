import { afterEach, beforeEach, expect, it } from "vitest";
import { createPlayServer } from "../src/play/server.ts";
import { listPackDirs, loadPack } from "../src/pack/load.ts";
import { runCall, type CallSnapshot, type TraceEvent } from "../src/runtime/call.ts";
import { ScriptedPersona } from "../src/sim/persona.ts";
import { Rng } from "../src/sim/rng.ts";
import { Report } from "../src/soundcheck/report.ts";
import { runMatrix } from "../src/soundcheck/runner.ts";
import { resolveModels } from "../src/config/models.ts";
import { request as httpRequest } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loaded = loadPack(listPackDirs("packs")[0]!);
if (!loaded.ok) throw new Error("fixture pack");
const pack = loaded.value;
let app: ReturnType<typeof createPlayServer>, base: string, dataDir: string;
beforeEach(async () => { dataDir = mkdtempSync(join(tmpdir(), "ringdown-play-")); app = createPlayServer({ dataDir }); base = await app.listen(0); });
afterEach(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
const post = (path: string, input: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
const input = { pack: pack.pack.id, persona: pack.personas[0]!.id, fault: "clean", seed: 7 };
interface View { id: string; revision: number; status: string; state: CallSnapshot; events: TraceEvent[] }
async function settled(id: string): Promise<View> {
  const response = await fetch(`${base}/api/calls/${id}/events`);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE ended before call settled");
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const message = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = message.split("\n").find(line => line.startsWith("data: "));
        if (data) { const view = JSON.parse(data.slice(6)) as View; if (view.status !== "running") return view; }
      }
    }
  } finally { await reader.cancel(); }
}
it("loopback server serves local assets, pack graph and persona catalogue", async () => {
  expect(app.server.address()).toMatchObject({ address: "127.0.0.1" });
  const catalogue = await (await fetch(base + "/api/packs")).json();
  expect(catalogue.map((p: { id: string }) => p.id)).toContain(input.pack);
  const detail = await (await fetch(`${base}/api/packs/${input.pack}`)).json();
  expect(detail.stages).toEqual(pack.pack.stages);
  expect(detail.personas).toEqual(pack.personas);
  for (const path of ["/", "/app.js", "/render.js", "/trace.js", "/style.css"]) expect((await fetch(base + path)).status).toBe(200);
  expect((await fetch(base + "/package.json")).status).toBe(404);
});
it("full auto call and SSE reconnect match the public runtime byte for byte", async () => {
  const response = await post("/api/calls", input); expect(response.status).toBe(201);
  const { id } = await response.json();
  const view = await settled(id);
  const expected = await runCall(pack, pack.personas[0]!, "clean", 7);
  expect(view.status).toBe("complete");
  expect(JSON.stringify([...view.events].sort((a, b) => a.at - b.at))).toBe(JSON.stringify(expected.events));
  expect(view.state.transcript).toEqual(expected.transcript);
  expect(view.state.metrics).toEqual(expected.metrics);
  expect(view.state.outcome).toBe(expected.outcome);
  expect((await settled(id)).revision).toBe(view.revision);
  expect((await post(`/api/calls/${id}/say`, { text: "네" })).status).toBe(409);
  expect((await (await fetch(base + "/api/calls")).json())[0].id).toBe(id);
});
it("human call waits without advancing, steps through /say and finishes with actual state", async () => {
  const { id } = await (await post("/api/calls", { ...input, mode: "human" })).json();
  let view = await settled(id);
  expect(view.status).toBe("waiting");
  expect(view.state.transcript.every(t => t.role === "agent")).toBe(true);
  const again = await settled(id);
  expect(again.state.at).toBe(view.state.at);
  const customer = new ScriptedPersona({ ...pack.personas[0]!, cooperativeness: 1, quirks: [], intent: "accept" }, new Rng(7));
  let sent = 0;
  while (view.status === "waiting" && sent < 12) {
    const stage = pack.pack.stages.find(s => s.id === view.state.stage)!;
    const text = customer.reply(stage, pack);
    expect((await post(`/api/calls/${id}/say`, { text })).status).toBe(202);
    view = await settled(id); sent++;
    expect(view.state.transcript.filter(t => t.role === "user")).toHaveLength(sent);
  }
  expect(view.status).toBe("complete");
  expect(view.state.outcome).toBe("success");
  expect(view.state.transitions.length).toBeGreaterThan(0);
  expect(view.state.facts.length).toBeGreaterThan(0);
  expect(Object.keys(view.state.jacks)).toEqual(Object.keys(pack.jacks));
  expect(view.state.metrics.policyViolations).toBe(0);
});
it("human opt-out is visible as an input rejection and cannot be followed by another turn", async () => {
  const { id } = await (await post("/api/calls", { ...input, mode: "human" })).json();
  await settled(id);
  await post(`/api/calls/${id}/say`, { text: "다시는 전화하지 마세요." });
  const call = await settled(id);
  expect(call.state.outcome).toBe("opted_out");
  expect(call.events).toContainEqual(expect.objectContaining({ type: "guard.reject", layer: "input", reason: "opted_out" }));
  expect((await post(`/api/calls/${id}/say`, { text: "네" })).status).toBe(409);
});
it("soundcheck returns schema v1 gates and Wilson CIs; selected cell replays the same trace", async () => {
  const request = { pack: input.pack, faults: ["clean", "down"], seeds: [7] };
  const response = await post("/api/soundcheck", request); expect(response.status).toBe(200);
  const report = Report.parse(await response.json());
  expect(report.matrix.calls).toBe(60); expect(report.metrics.goal_rate.ci95).toHaveLength(2);
  const down = Report.parse(await (await post("/api/soundcheck", { ...request, faults: ["down"] })).json());
  expect(down.gates.some(g => !g.pass)).toBe(true);
  const expected = await runMatrix(pack, { ...request, models: resolveModels({ env: {} }), gitSha: report.gitSha, runId: report.runId });
  expect(report).toEqual(JSON.parse(JSON.stringify({ ...expected.report, packDir: report.packDir })));
  const row = report.calls[0]!;
  const { id } = await (await post("/api/calls", { pack: input.pack, persona: row.persona, fault: row.fault, seed: row.seed })).json();
  const replay = await settled(id);
  expect(replay.state.outcome).toBe(row.outcome);
  expect([...replay.events].sort((a, b) => a.at - b.at)).toEqual(expected.traces[row.callId]);
});
it("bad JSON, unknown keys, invalid pack/persona/fault, excessive matrix and cross-origin are rejected", async () => {
  for (const change of [{ seed: 1.5 }, { seed: 2 ** 53 }, { persona: "missing" }, { fault: "missing" }, { mode: "llm" }, { brain: "ollama" }]) {
    expect((await post("/api/calls", { ...input, ...change })).status).toBe(400);
  }
  expect((await post("/api/calls", { ...input, pack: "../../" })).status).toBe(404);
  for (const change of [{ faults: [] }, { faults: ["clean", "clean"] }, { seeds: [1, 1] }, { seeds: [1, 2, 3, 4] }]) {
    expect((await post("/api/soundcheck", { pack: input.pack, ...change })).status).toBe(400);
  }
  expect((await fetch(base + "/api/calls", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  expect((await fetch(base + "/api/calls", { method: "POST", body: "{}" })).status).toBe(415);
  expect((await fetch(base + "/api/calls", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.invalid" }, body: JSON.stringify(input) })).status).toBe(403);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(base + "/api/packs", { headers: { host: "untrusted.invalid" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  expect(badHost).toBe(403);
  expect((await post("/api/calls/missing/say", { text: "hi" })).status).toBe(404);
  const { id } = await (await post("/api/calls", { ...input, mode: "human" })).json(); await settled(id);
  for (const text of ["", "  ", "x".repeat(2001)]) expect((await post(`/api/calls/${id}/say`, { text })).status).toBe(400);
  expect((await post(`/api/calls/${id}/say`, { text: "x".repeat(17_000) })).status).toBe(413);
});
it("cancel releases a waiting customer and shutdown closes SSE streams", async () => {
  const { id } = await (await post("/api/calls", { ...input, mode: "human" })).json(); await settled(id);
  expect((await fetch(`${base}/api/calls/${id}`, { method: "DELETE" })).status).toBe(200);
  expect((await settled(id)).status).toBe("error");
});
it("opt-in observation is detached and ScriptedPersona remains byte-identical", async () => {
  const baseline = await runCall(pack, pack.personas[0]!, "slow", 7);
  const observed = await runCall(pack, pack.personas[0]!, "slow", 7, {
    customerSource: new ScriptedPersona(pack.personas[0]!, new Rng(`7:${pack.personas[0]!.id}`).fork("persona")),
    onState: s => { s.slots.fake = { value: true, turn: 0 }; s.transcript.length = 0; s.facts.length = 0; },
    onEvent: e => { e.type = "brain.fallback"; },
  });
  expect(JSON.stringify(observed)).toBe(JSON.stringify(baseline));
});
it("checked-in 3-seed baselines remain exact", async () => {
  for (const dir of listPackDirs("packs")) {
    const p = loadPack(dir); if (!p.ok) throw new Error(dir);
    const baseline = JSON.parse(readFileSync(`baselines/${p.value.pack.id}.json`, "utf8"));
    const { report } = await runMatrix(p.value, { faults: baseline.matrix.faults, seeds: baseline.seeds, models: resolveModels({ env: {} }), gitSha: "test", runId: "test" });
    expect(report.metrics).toEqual(baseline.metrics);
  }
});
