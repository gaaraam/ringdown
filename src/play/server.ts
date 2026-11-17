import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { listPackDirs, loadPack, type LoadedPack } from "../pack/load.ts";
import { FAULT_IDS } from "../jacks/faults.ts";
import { runMatrix } from "../soundcheck/runner.ts";
import { Fault } from "../soundcheck/report.ts";
import { resolveModels } from "../config/models.ts";
import { CallSession } from "./sessions.ts";

const Seed = z.number().int().min(-2147483648).max(2147483647);
const CallInput = z.strictObject({ pack: z.string().min(1), persona: z.string().min(1),
  fault: Fault.default("clean"), seed: Seed.default(7), mode: z.enum(["auto", "human"]).default("auto") });
const MatrixInput = z.strictObject({ pack: z.string().min(1),
  faults: z.array(Fault).min(1).max(5).refine(xs => new Set(xs).size === xs.length).default(["clean", "slow"]),
  seeds: z.array(Seed).min(1).max(3).refine(xs => new Set(xs).size === xs.length).default([7]) });
const SayInput = z.strictObject({ text: z.string().trim().min(1).max(2000) });
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON 본문이 필요해요.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 16_384) throw new HttpError(413, "요청이 너무 커요.");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "JSON 형식을 확인해 주세요."); }
}

/** Local-only HTTP adapter. No engine module depends on this module. */
export function createPlayServer(options: { packsRoot?: string; gitSha?: string } = {}) {
  const packs = new Map<string, LoadedPack>();
  for (const dir of listPackDirs(options.packsRoot ?? fileURLToPath(new URL("../../packs/", import.meta.url)))) {
    const loaded = loadPack(dir);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    if (loaded.value.mock && Object.values(loaded.value.jacks).every(j => j.type === "mock")) packs.set(loaded.value.pack.id, loaded.value);
  }
  const sessions = new Map<string, CallSession>();
  const streams = new Set<ServerResponse>();
  let matrixBusy = false;
  const packFor = (id: string) => {
    const pack = packs.get(id);
    if (!pack) throw new HttpError(404, "Pack을 찾을 수 없어요.");
    return pack;
  };
  const staticFiles: Record<string, [string, string]> = {
    "/": ["index.html", "text/html"], "/style.css": ["style.css", "text/css"],
    "/app.js": ["app.js", "text/javascript"], "/render.js": ["render.js", "text/javascript"],
    "/trace.js": ["trace.js", "text/javascript"],
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    // Loopback binding alone does not protect against hostile pages or DNS rebinding.
    const host = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new HttpError(403, "로컬 주소로 접속해 주세요.");
    if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new HttpError(403, "같은 주소의 화면에서 요청해 주세요.");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;
    if (req.method === "GET" && staticFiles[path]) {
      const [file, mime] = staticFiles[path];
      const content = readFileSync(new URL(`../../web/${file}`, import.meta.url));
      res.writeHead(200, { "content-type": `${mime}; charset=utf-8`, "cache-control": "no-cache" }); res.end(content); return;
    }
    if (req.method === "GET" && path === "/api/packs") {
      json(res, 200, [...packs.values()].map(p => ({ id: p.pack.id, description: p.pack.goal.description }))); return;
    }
    const packMatch = /^\/api\/packs\/([^/]+)$/.exec(path);
    if (req.method === "GET" && packMatch) {
      const p = packFor(decodeURIComponent(packMatch[1]!));
      json(res, 200, { id: p.pack.id, description: p.pack.goal.description, stages: p.pack.stages,
        personas: p.personas, faults: FAULT_IDS, jacks: Object.keys(p.jacks), silenceMaxSec: p.pack.policy.silenceMaxSec }); return;
    }
    if (req.method === "GET" && path === "/api/calls") {
      json(res, 200, [...sessions.values()].reverse().map(s => ({ ...s.view(), state: undefined, events: undefined }))); return;
    }
    if (req.method === "POST" && path === "/api/calls") {
      const input = CallInput.parse(await body(req)), p = packFor(input.pack);
      const persona = p.personas.find(persona => persona.id === input.persona);
      if (!persona) throw new HttpError(400, "페르소나를 확인해 주세요.");
      if ([...sessions.values()].filter(s => s.status === "waiting" || s.status === "running").length >= 8) throw new HttpError(429, "진행 중인 통화를 먼저 닫아 주세요.");
      while (sessions.size >= 100) {
        const old = [...sessions.values()].find(s => s.status === "complete" || s.status === "error");
        if (!old) break;
        sessions.delete(old.id);
      }
      const session = new CallSession(p, persona, input.fault, input.seed, input.mode);
      sessions.set(session.id, session); json(res, 201, session.view()); return;
    }
    const callMatch = /^\/api\/calls\/([^/]+)(?:\/(events|say))?$/.exec(path);
    if (callMatch) {
      const session = sessions.get(callMatch[1]!);
      if (!session) throw new HttpError(404, "통화를 찾을 수 없어요. 기록은 서버를 닫으면 사라져요.");
      if (req.method === "GET" && !callMatch[2]) { json(res, 200, session.view()); return; }
      if (req.method === "DELETE" && !callMatch[2]) { session.cancel(); json(res, 200, { ok: true }); return; }
      if (req.method === "POST" && callMatch[2] === "say") {
        const input = SayInput.parse(await body(req));
        if (!session.say(input.text)) throw new HttpError(409, "지금은 고객 입력을 기다리는 중이 아니에요.");
        json(res, 202, { ok: true }); return;
      }
      if (req.method === "GET" && callMatch[2] === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        streams.add(res);
        let blocked = false;
        let sentRevision = -1;
        const send = () => {
          if (res.writableEnded || res.destroyed || blocked || sentRevision === session.revision) return;
          sentRevision = session.revision;
          // Every message is a complete snapshot, so reconnects cannot lose or duplicate turns.
          const accepted = res.write(`id: ${session.revision}\nevent: snapshot\ndata: ${JSON.stringify(session.view())}\n\n`);
          blocked = !accepted;
          if (session.status === "complete" || session.status === "error") { session.listeners.delete(send); res.end(); }
        };
        res.on("drain", () => { blocked = false; send(); });
        const heartbeat = setInterval(() => { if (!blocked && !res.writableEnded) res.write(": keepalive\n\n"); }, 15_000);
        res.on("close", () => { clearInterval(heartbeat); session.listeners.delete(send); streams.delete(res); });
        session.listeners.add(send); send(); return;
      }
    }
    if (req.method === "POST" && path === "/api/soundcheck") {
      const input = MatrixInput.parse(await body(req)), p = packFor(input.pack);
      if (matrixBusy) throw new HttpError(429, "매트릭스가 실행 중이에요.");
      matrixBusy = true;
      try {
        const { report } = await runMatrix(p, { ...input, models: resolveModels({ env: {} }), gitSha: options.gitSha ?? "local",
          runId: `play-${p.pack.id}-${input.faults.join("-")}-${input.seeds.join("-")}` });
        json(res, 200, report);
      } finally { matrixBusy = false; }
      return;
    }
    throw new HttpError(404, "요청한 경로를 찾을 수 없어요.");
  };
  const server = createServer((req, res) => { void handler(req, res).catch(error => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof z.ZodError) json(res, 400, { error: "입력값을 확인해 주세요.", issues: error.issues });
    else if (error instanceof HttpError) json(res, error.status, { error: error.message });
    else { console.error("Play request failed", error); json(res, 500, { error: "처리하지 못했어요. 서버 로그와 Pack 설정을 확인해 주세요." }); }
  }); });
  return {
    server,
    async listen(port = 4310) {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No TCP address");
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      for (const s of sessions.values()) s.cancel();
      for (const stream of streams) stream.end();
      await Promise.all([...sessions.values()].map(s => s.done));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
