import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { followUps, matches, type CallFilter, type Campaign, type Resolution, type StoredCall } from "./model.ts";

export interface OpsStore {
  campaigns(): Campaign[];
  calls(filter?: CallFilter): StoredCall[];
  putCampaign(campaign: Campaign): void;
  putCall(call: StoredCall): void;
  inbox(): ReturnType<typeof followUps>;
  resolve(id: string, resolution: Resolution): boolean;
  close(): void;
}
type Entry = { v: 1; type: "campaign"; value: Campaign } | { v: 1; type: "call"; value: StoredCall }
  | { v: 1; type: "resolution"; id: string; value: Resolution };

/** Single writer, append + fsync before publishing to the in-memory index. */
export class JsonlStore implements OpsStore {
  private readonly campaignIndex = new Map<string, Campaign>();
  private readonly callIndex = new Map<string, StoredCall>();
  private readonly resolutions = new Map<string, Resolution>();
  private fd: number;
  private readonly lock: string;
  private closed = false;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.lock = join(dir, "ops.lock");
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid operations store lock");
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        unlinkSync(this.lock);
      }
    }
    const lockFd = openSync(this.lock, "wx", 0o600);
    writeSync(lockFd, String(process.pid)); closeSync(lockFd);
    const file = join(dir, "ops.jsonl");
    try {
      if (existsSync(file)) {
        const content = readFileSync(file);
        const end = content.lastIndexOf(10) + 1;
        // An interrupted append has no newline commit marker. Preserve all committed records.
        for (const line of content.subarray(0, end).toString("utf8").split("\n").filter(Boolean)) {
          const entry = JSON.parse(line) as Entry;
          if (entry.v !== 1 || !["campaign", "call", "resolution"].includes(entry.type)) throw new Error("Unsupported operations record");
          this.apply(entry);
        }
        if (end !== content.length) truncateSync(file, end);
      }
      this.fd = openSync(file, "a", 0o600);
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  private apply(entry: Entry) {
    if (entry.type === "campaign") this.campaignIndex.set(entry.value.id, entry.value);
    else if (entry.type === "call") this.callIndex.set(entry.value.id, entry.value);
    else this.resolutions.set(entry.id, entry.value);
  }
  private append(entry: Entry) {
    if (this.closed) throw new Error("Operations store is closed");
    const data = Buffer.from(JSON.stringify(entry) + "\n");
    let offset = 0;
    try {
      while (offset < data.length) offset += writeSync(this.fd, data, offset, data.length - offset);
      fsyncSync(this.fd);
    } catch (error) { this.close(); throw error; }
    this.apply(JSON.parse(data.toString("utf8")) as Entry);
  }
  campaigns() { return structuredClone([...this.campaignIndex.values()].reverse()); }
  calls(filter: CallFilter = {}) { return structuredClone([...this.callIndex.values()].reverse().filter(c => matches(c, filter))); }
  putCampaign(value: Campaign) { this.append({ v: 1, type: "campaign", value }); }
  putCall(value: StoredCall) {
    if (this.callIndex.has(value.id)) throw new Error("Duplicate call");
    if (!this.campaignIndex.has(value.campaignId)) throw new Error("Missing campaign");
    this.append({ v: 1, type: "call", value });
  }
  inbox() { return this.calls().flatMap(followUps).map(item => ({ ...item, ...this.resolutions.get(item.id) })); }
  resolve(id: string, value: Resolution) {
    if (!this.inbox().some(item => item.id === id)) return false;
    this.append({ v: 1, type: "resolution", id, value }); return true;
  }
  close() { if (!this.closed) { this.closed = true; closeSync(this.fd); unlinkSync(this.lock); } }
}
