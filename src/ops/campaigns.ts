import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { RuleBrain } from "../brain/rule.ts";
import { runCall, type CallSnapshot } from "../runtime/call.ts";
import type { ToolCall } from "../core/types.ts";
import type { LoadedPack } from "../pack/load.ts";
import type { Persona } from "../pack/schema.ts";
import type { OpsStore } from "./store.ts";
import { attemptKey, summarize, type Campaign, type StoredCall, type WriteEvidence } from "./model.ts";

export function customerFor(pack: LoadedPack, persona: Persona) {
  const data = pack.mock?.collections[pack.pack.call.target.collection]?.[persona.targetId];
  const name = Object.entries(data ?? {}).find(([key, value]) => /name$/i.test(key) && typeof value === "string")?.[1];
  return { name: typeof name === "string" && name ? name : persona.targetId, targetId: persona.targetId };
}
export class CampaignRunner {
  private active?: Promise<void>;
  private closing = false;
  constructor(readonly store: OpsStore, private readonly clock = () => new Date()) {
    for (const campaign of store.campaigns()) if (campaign.status === "running") store.putCampaign({ ...campaign, status: "interrupted" });
  }
  get busy() { return !!this.active || this.closing; }
  start(pack: LoadedPack, input: { personas: string[]; fault: string; seed: number }): Campaign {
    if (this.busy) throw new Error("Campaign already running");
    const selected = input.personas.map(id => pack.personas.find(p => p.id === id));
    if (!selected.length || selected.some(p => !p)) throw new Error("Unknown persona");
    const campaign: Campaign = { id: randomUUID(), pack: pack.pack.id, name: pack.pack.name, ...input,
      startedAt: this.clock().toISOString(), status: "running" };
    this.store.putCampaign(campaign);
    this.active = this.run(campaign, pack, selected as Persona[]).catch(error => {
      console.error("Campaign failed", error);
      this.store.putCampaign({ ...campaign, status: "error" });
    }).finally(() => { this.active = undefined; });
    // Do not leave an unhandled rejection if disk failure also prevents saving the error marker.
    void this.active.catch(error => console.error("Campaign persistence failed", error));
    return campaign;
  }
  private async run(campaign: Campaign, loaded: LoadedPack, personas: Persona[]) {
    let clock = Date.parse(campaign.startedAt);
    for (const persona of personas) {
      await setImmediate(); // Let progress reads and shutdown run between simulated calls.
      let state: CallSnapshot | undefined;
      const result = await runCall(loaded, persona, campaign.fault, campaign.seed, { brain: new RuleBrain(), onState: s => { state = s; } });
      if (!state) throw new Error("Missing call snapshot");
      const end = result.events.find(e => e.type === "call.end")!;
      const durationMs = Number(end.durationMs);
      const writeEvidence: WriteEvidence[] = result.events.filter(e => e.type === "tool.call" && !e.builtin).flatMap(e => {
        const call = e.call as ToolCall, spec = loaded.pack.tools[call.tool];
        if (spec?.kind !== "write") return [];
        const route = loaded.mock!.routes.find(r => r.op === spec.op);
        const attempt = result.events.find(a => a.type === "tool.result" && a.callSeq === e.callSeq && a.attempt);
        return [{ tool: call.tool, callSeq: Number(e.callSeq), op: spec.op, args: call.args,
          field: route?.field, idempotencyKey: attempt ? attemptKey(attempt) : undefined }];
      });
      const record: StoredCall = { id: randomUUID(), campaignId: campaign.id, persona: persona.id,
        customer: customerFor(loaded, persona), startedAt: new Date(clock + end.at - durationMs).toISOString(), durationMs,
        outcome: result.outcome, summary: "", subject: loaded.pack.name,
        selections: Object.entries(result.slots).flatMap(([key, slot]) => {
          const label = loaded.pack.slots[key]?.labels?.[String(slot.value)];
          return label ? [label] : [];
        }), state, events: result.events, pending: result.pending,
        system: { collections: result.system.collections, writes: result.system.writes }, writeEvidence,
        silenceMaxSec: loaded.pack.policy.silenceMaxSec };
      record.summary = summarize(record);
      this.store.putCall(record);
      clock += end.at + 30_000;
    }
    this.store.putCampaign({ ...campaign, status: "complete" });
  }
  async settled() { await this.active; }
  async close() { this.closing = true; await this.active; }
}
