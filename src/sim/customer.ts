import type { LoadedPack } from "../pack/load.ts";
import type { Persona, Stage } from "../pack/schema.ts";

/** Customer behavior is independent of the transport. Waiting need not advance simulated time. */
export interface CustomerSource {
  readonly spec: Pick<Persona, "speechRate">;
  reply(stage: Stage, pack: LoadedPack, interrupted?: boolean): string | Promise<string>;
  responseDelay(): number;
  interruption(textDuration: number): number | undefined;
}
