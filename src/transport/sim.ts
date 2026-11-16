import type { Transport, SpeechHandle, UserTurn } from "../core/types.ts";
import type { LoadedPack } from "../pack/load.ts";
import type { Stage } from "../pack/schema.ts";
import { durationMs } from "../guard/index.ts";
import { ScriptedPersona } from "../sim/persona.ts";

export class SimTransport implements Transport {
  private listener?: (u: Omit<UserTurn, "role" | "seq">) => void;
  closed = false;
  constructor(readonly persona: ScriptedPersona, readonly until = Infinity) {}
  onUserUtterance(cb: (u: Omit<UserTurn, "role" | "seq">) => void): void { this.listener = cb; }
  speak(text: string, at: number): SpeechHandle {
    const duration = durationMs(text);
    const cut = Math.min(this.persona.interruption(duration) ?? duration, Math.max(0, this.until - at));
    let heard = text;
    if (cut < duration) {
      heard = "";
      for (const char of text) {
        if (durationMs(heard + char) > cut) break;
        heard += char;
      }
    }
    return { done: Promise.resolve({ interrupted: cut < duration, heard, endedAt: at + cut }) };
  }
  next(stage: Stage, pack: LoadedPack, at: number, interrupted: boolean): Omit<UserTurn, "role" | "seq"> {
    const text = this.persona.reply(stage, pack, interrupted);
    const startedAt = Math.min(at + this.persona.responseDelay(), this.until);
    const user = { text, startedAt, endedAt: Math.min(startedAt + durationMs(text, this.persona.spec.speechRate), this.until) };
    if (!this.closed) this.listener?.(user);
    return user;
  }
  hangup(_reason: string, _at: number): void { this.closed = true; }
}
