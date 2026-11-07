import { execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { Effect } from "effect";

// Local state must survive checkout/image replacement. The caller holds flock.
process.umask(0o077);
await mkdir("/var/lib/computah/alchemy", { recursive: true });
process.chdir("/var/lib/computah/alchemy");
const Alchemist = await import("alchemy/Alchemist");
const { default: stack } = await import("./alchemy.run.js");
await Effect.runPromise(
  Effect.gen(function* () {
    const plan = yield* Alchemist.plan({
      stack,
      operation: "deploy",
      stage: "nest-bagel",
    });
    yield* Alchemist.apply(plan);
  }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
);

// Apply completion is not readiness. Only publish an observed receipt after HTTP.
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch("http://127.0.0.1:8787/healthz", {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      ready = true;
      break;
    }
  } catch {
    // Startup may still be opening the persistent registry.
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) throw new Error("Computah failed readiness; no rollback attempted");
const observed = execFileSync(
  "docker",
  ["inspect", "computah-backend", "--format", "{{.Image}}"],
  { encoding: "utf8" },
).trim();
if (observed !== process.env.COMPUTAH_IMAGE) {
  throw new Error("Running image differs from the selected immutable artifact");
}
const receipt = {
  revision: process.env.COMPUTAH_REVISION,
  image: process.env.COMPUTAH_IMAGE,
  observedHealthyAt: new Date().toISOString(),
};
await writeFile("/var/lib/computah/active.json.tmp", JSON.stringify(receipt));
await rename(
  "/var/lib/computah/active.json.tmp",
  "/var/lib/computah/active.json",
);
console.log(JSON.stringify(receipt));
