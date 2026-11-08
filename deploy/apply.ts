import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { Effect } from "effect";

// Prove the artifact boots before stopping the only production storage writer.
// No real env files, mounts, network or host ports enter this disposable process.
const image = process.env.COMPUTAH_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? ""))
  throw new Error("An immutable local image ID is required");
const candidate = `computah-preflight-${randomUUID()}`;
try {
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      candidate,
      "--network",
      "none",
      "--user",
      "1000:1000",
      "--init",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "768m",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/data:rw,uid=1000,gid=1000,mode=0700,size=128m",
      "--env",
      "HOME=/data",
      "--env",
      "PORT=8787",
      "--env",
      "NODE_ENV=development",
      "--env",
      "RIVET_RUN_ENGINE=1",
      "--env",
      "COMPUTAH_MODE=faux",
      "--env",
      "COMPUTAH_CONNECTION_SECRET=synthetic-deployment-preflight-secret",
      "--env",
      `COMPUTAH_AUTH_JSON=${JSON.stringify([
        {
          token: "synthetic-deployment-preflight-token",
          tenantId: "preflight",
          userId: "preflight",
          agentId: "preflight",
          capabilities: ["task.send", "history.read"],
        },
      ])}`,
      "--entrypoint",
      "node",
      image as string,
      "--input-type=module",
      "--eval",
      await readFile(new URL("./preflight.mjs", import.meta.url), "utf8"),
    ],
    { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] },
  );
} catch {
  throw new Error(
    "Candidate preflight failed; production container was not replaced",
  );
} finally {
  // Only our unique disposable container, including after a preflight timeout.
  try {
    execFileSync("docker", ["rm", "--force", candidate], { stdio: "ignore" });
  } catch {}
}
console.info(
  "Candidate isolated startup, submission/result and graceful stop passed",
);

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
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://127.0.0.1:8787/healthz", {
      signal: AbortSignal.timeout(2000),
    });
    const health = await response.json();
    if (
      response.ok &&
      health.ready === true &&
      health.revision === process.env.COMPUTAH_REVISION &&
      health.mode === "real"
    ) {
      ready = true;
      break;
    }
  } catch {
    // Startup may still be opening the persistent registry.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready) throw new Error("Computah failed readiness; no rollback attempted");
const observed = execFileSync(
  "docker",
  [
    "inspect",
    "computah-backend",
    "--format",
    '{{.State.Running}}|{{.Image}}|{{index .Config.Labels "computah.revision"}}',
  ],
  { encoding: "utf8" },
).trim();
if (
  observed !==
  `true|${process.env.COMPUTAH_IMAGE}|${process.env.COMPUTAH_REVISION}`
) {
  throw new Error("Running image/revision differs from the selected artifact");
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
