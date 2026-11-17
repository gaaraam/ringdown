import { randomUUID } from "node:crypto";
import type { LoadedPack } from "../pack/load.ts";
import type { Persona } from "../pack/schema.ts";
import { RuleBrain } from "../brain/rule.ts";
import { runCall, type CallSnapshot, type TraceEvent } from "../runtime/call.ts";
import { HumanCustomer } from "./customer.ts";

export class CallSession {
  readonly id = randomUUID();
  readonly events: TraceEvent[] = [];
  readonly listeners = new Set<() => void>();
  readonly customer?: HumanCustomer;
  readonly done: Promise<void>;
  state?: CallSnapshot;
  status: "running" | "waiting" | "complete" | "error" = "running";
  error?: string;
  revision = 0;
  private cancelled = false;

  constructor(readonly loaded: LoadedPack, readonly persona: Persona, readonly fault: string,
    readonly seed: number, readonly mode: "auto" | "human") {
    if (mode === "human") this.customer = new HumanCustomer(() => { this.status = "waiting"; this.publish(); });
    this.done = runCall(loaded, persona, fault, seed, {
      brain: new RuleBrain(), customerSource: this.customer,
      onEvent: (event) => { if (this.cancelled) throw new Error("통화를 닫았어요."); this.events.push(event); },
      onState: (state) => { this.state = state; this.publish(); },
    }).then(() => { this.status = "complete"; }, () => {
      this.status = "error"; this.error = "통화가 중단됐어요. 새 통화를 시작해 주세요.";
    }).finally(() => this.publish());
  }
  private publish() { this.revision++; for (const notify of this.listeners) notify(); }
  view() {
    return { id: this.id, pack: this.loaded.pack.id, persona: this.persona.id, fault: this.fault,
      seed: this.seed, mode: this.mode, status: this.status, revision: this.revision,
      state: this.state, events: this.events, error: this.error };
  }
  say(text: string) {
    if (this.status !== "waiting" || !this.customer?.say(text)) return false;
    this.status = "running";
    this.publish();
    return true;
  }
  cancel() { this.cancelled = true; this.customer?.cancel(); }
}
