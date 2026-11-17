import { z } from "zod";
import { Outcome } from "../pack/schema.ts";
import type { LoadedPack } from "../pack/load.ts";
import { Fault } from "../soundcheck/report.ts";
import { CampaignRunner, customerFor } from "./campaigns.ts";
import { kindLabels, outcomeLabels, statistics } from "./model.ts";
import type { OpsStore } from "./store.ts";

const Id = z.string().min(1).max(200);
const CampaignInput = z.strictObject({ pack: Id,
  personas: z.array(Id).min(1).max(500).refine(xs => new Set(xs).size === xs.length).optional(),
  fault: Fault.default("clean"), seed: z.number().int().min(-2147483648).max(2147483647).default(7) });
const DateInput = z.iso.date();
const CallQuery = z.strictObject({ q: z.string().max(200).optional(), outcome: Outcome.optional(), campaign: Id.optional(), date: DateInput.optional() });
const InboxQuery = z.strictObject({ kind: z.enum(["handoff", "callback", "confirmation"]).optional(),
  status: z.enum(["open", "resolved"]).optional(), campaign: Id.optional() });
const ResolutionInput = z.strictObject({ status: z.enum(["open", "resolved"]),
  assignee: z.string().trim().max(100), note: z.string().trim().max(2000) });
export class OpsError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export function createOpsApi(store: OpsStore, packs: Map<string, LoadedPack>, clock?: () => Date) {
  const runner = new CampaignRunner(store, clock);
  const campaignViews = () => store.campaigns().map(c => ({ ...c, completed: store.calls({ campaign: c.id }).length, total: c.personas.length }));
  function query(url: URL) {
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) throw new OpsError(400, "중복된 검색 조건입니다.");
    return Object.fromEntries(url.searchParams);
  }
  return { runner, async handle(method: string, url: URL, body: () => Promise<unknown>) {
    const path = url.pathname;
    if (method === "GET" && path === "/api/ops/catalogue") return { status: 200, value: {
      outcomes: outcomeLabels, kinds: kindLabels, packs: [...packs.values()].map(p => ({ id: p.pack.id, name: p.pack.name,
        personas: p.personas.map(persona => ({ id: persona.id, description: persona.description, customer: customerFor(p, persona) })) })) } };
    if (method === "GET" && path === "/api/ops/campaigns") return { status: 200, value: campaignViews() };
    if (method === "POST" && path === "/api/ops/campaigns") {
      const input = CampaignInput.parse(await body());
      const pack = packs.get(input.pack);
      if (!pack) throw new OpsError(404, "캠페인 설정을 찾을 수 없습니다.");
      const personas = input.personas ?? pack.personas.map(p => p.id);
      if (personas.some(id => !pack.personas.some(p => p.id === id))) throw new OpsError(400, "통화 대상을 확인해 주세요.");
      if (runner.busy) throw new OpsError(409, "캠페인이 실행 중입니다.");
      return { status: 202, value: runner.start(pack, { ...input, personas }) };
    }
    const campaign = /^\/api\/ops\/campaigns\/([^/]+)$/.exec(path);
    if (method === "GET" && campaign) {
      const value = campaignViews().find(c => c.id === campaign[1]);
      if (!value) throw new OpsError(404, "캠페인을 찾을 수 없습니다.");
      return { status: 200, value };
    }
    if (method === "GET" && path === "/api/ops/calls") {
      const filter = CallQuery.parse(query(url));
      return { status: 200, value: store.calls(filter).map(c => ({ id: c.id, campaignId: c.campaignId, customer: c.customer,
        startedAt: c.startedAt, durationMs: c.durationMs, outcome: c.outcome, summary: c.summary })) };
    }
    const call = /^\/api\/ops\/calls\/([^/]+)$/.exec(path);
    if (method === "GET" && call) {
      const value = store.calls().find(c => c.id === call[1]);
      if (!value) throw new OpsError(404, "통화를 찾을 수 없습니다.");
      return { status: 200, value };
    }
    if (method === "GET" && path === "/api/ops/inbox") {
      const filter = InboxQuery.parse(query(url));
      return { status: 200, value: store.inbox().filter(i => (!filter.kind || i.kind === filter.kind) &&
        (!filter.status || i.status === filter.status) && (!filter.campaign || i.campaignId === filter.campaign)) };
    }
    const item = /^\/api\/ops\/inbox\/([^/]+)$/.exec(path);
    if (method === "PATCH" && item) {
      const input = ResolutionInput.parse(await body());
      if (!store.resolve(decodeURIComponent(item[1]!), input)) throw new OpsError(404, "후속 처리를 찾을 수 없습니다.");
      return { status: 200, value: { ok: true } };
    }
    if (method === "GET" && path === "/api/ops/overview") {
      const filter = z.strictObject({ campaign: Id.optional() }).parse(query(url));
      return { status: 200, value: statistics(store.calls(filter), store.inbox().filter(i => !filter.campaign || i.campaignId === filter.campaign)) };
    }
    throw new OpsError(404, "요청한 경로를 찾을 수 없습니다.");
  } };
}
