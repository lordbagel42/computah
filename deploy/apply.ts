import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { Effect } from "effect";

// Prove the artifact boots before stopping the only production storage writer.
// No real env files, production mounts, network or host ports enter this process.
const image = process.env.COMPUTAH_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? ""))
  throw new Error("An immutable local image ID is required");
// Fail before replacement rather than letting Docker create missing bind sources.
const slackUid = Number(
  execFileSync("id", ["-u", "computah-slack"], { encoding: "utf8" }),
);
const [timingDirectory, timingSocket, timingCredential] = await Promise.all([
  lstat("/run/computah-slack-timing"),
  lstat("/run/computah-slack-timing/timing.sock"),
  lstat("/etc/computah/slack-timing.token"),
]);
if (
  !timingDirectory.isDirectory() ||
  timingDirectory.uid !== slackUid ||
  timingDirectory.gid !== 27750 ||
  (timingDirectory.mode & 0o7777) !== 0o2750 ||
  !timingSocket.isSocket() ||
  timingSocket.uid !== slackUid ||
  timingSocket.gid !== 27750 ||
  (timingSocket.mode & 0o777) !== 0o660 ||
  !timingCredential.isFile() ||
  timingCredential.uid !== 1000 ||
  (timingCredential.mode & 0o777) !== 0o600 ||
  timingCredential.size < 32
)
  throw new Error("Private Slack timing bind sources are not ready");
const candidate = `computah-preflight-${randomUUID()}`;
process.umask(0o077);
// The managed engine checks for 4 GiB free capacity, even for a tiny smoke store.
// Use the disk filesystem, never a large RAM reservation or production data.
const candidateHome = await mkdtemp("/var/lib/computah/preflight-");
let cleanupFailed = false;
let preflightStage = "capacity";
let availableBytes: number | undefined;
try {
  const space = await statfs(candidateHome);
  availableBytes = space.bavail * space.bsize;
  if (availableBytes < 4 * 1024 ** 3)
    throw new Error("Insufficient candidate filesystem capacity");
  preflightStage = "candidate";
  await chown(candidateHome, 1000, 1000);
  await chmod(candidateHome, 0o700);
  execFileSync(
    "docker",
    [
      "run",
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
      "--mount",
      `type=bind,src=${candidateHome},dst=/data`,
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
    {
      timeout: 120000,
      maxBuffer: 128 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (error) {
  const failure = error as {
    status?: number;
    signal?: string;
    stdout?: unknown;
    stderr?: unknown;
  };
  // The candidate has synthetic credentials only. Never retain live process env
  // or forward child output into Actions; keep two bounded, scrubbed tails local.
  const tail = (value: unknown) =>
    Buffer.isBuffer(value)
      ? value
          .subarray(-8192)
          .toString("utf8")
          .replace(
            /synthetic-deployment-preflight-(secret|token)/g,
            "[redacted]",
          )
          .replace(/\p{Cc}/gu, (value) =>
            value === "\n" || value === "\t" ? value : "",
          )
      : "";
  const diagnostic = `/var/log/computah-deploy/${candidate}.json`;
  await mkdir("/var/log/computah-deploy", { recursive: true, mode: 0o700 });
  await writeFile(
    diagnostic,
    JSON.stringify({
      version: 1,
      observedAt: new Date().toISOString(),
      revision: process.env.COMPUTAH_REVISION,
      image,
      stage: preflightStage,
      availableBytes,
      requiredBytes: 4 * 1024 ** 3,
      status: failure.status ?? null,
      signal: failure.signal ?? null,
      stdout: tail(failure.stdout),
      stderr: tail(failure.stderr),
    }),
    { mode: 0o600, flag: "wx" },
  );
  throw new Error(
    `Candidate preflight failed; protected diagnostics: ${diagnostic}; production container was not replaced`,
  );
} finally {
  // Only our unique disposable container, including after a preflight timeout.
  try {
    execFileSync("docker", ["rm", "--force", candidate], { stdio: "ignore" });
  } catch {
    // A failed create may never have produced a container. Confirm absence
    // before deleting storage; if Docker is unavailable, retain it for recovery.
    const remaining = execFileSync(
      "docker",
      ["ps", "--all", "--quiet", "--filter", `name=^/${candidate}$`],
      { encoding: "utf8" },
    ).trim();
    cleanupFailed = remaining.length > 0;
  }
  if (!cleanupFailed) await rm(candidateHome, { recursive: true, force: true });
}
if (cleanupFailed)
  throw new Error("Candidate cleanup failed; isolated HOME retained");
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
