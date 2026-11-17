import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createPlayServer } from "./server.ts";
const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 4310);
let gitSha = "local";
try { gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { /* A source archive has no Git metadata. */ }
const app = createPlayServer({ gitSha });
await app.listen(port);
console.log(`Ringdown Playground http://localhost:${port} (RuleBrain, mock only)`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
