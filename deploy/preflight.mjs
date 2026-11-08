// Executed inside the candidate image with disposable storage and synthetic auth.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/server/src/main.ts"],
  {
    stdio: "ignore",
  },
);
const exited = once(child, "exit");
const base = "http://127.0.0.1:8787";
const headers = {
  authorization: `Bearer ${JSON.parse(process.env.COMPUTAH_AUTH_JSON)[0].token}`,
  "content-type": "application/json",
};
const request = (path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(2000),
  });
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("candidate exited");
    try {
      const health = await request("/healthz");
      const value = await health.json();
      if (health.ok && value.ready && value.mode === "faux") break;
    } catch {}
    if (Date.now() >= deadline) throw new Error("startup deadline");
    await delay(100);
  }
  const admitted = await request("/v1/submissions", {
    method: "POST",
    body: JSON.stringify({
      text: "deployment preflight",
      clientMutationId: "preflight",
    }),
  });
  if (admitted.status !== 202) throw new Error("admission failed");
  const { id } = await admitted.json();
  const deadlineResult = Date.now() + 20000;
  for (;;) {
    const response = await request(`/v1/submissions/${id}`);
    const result = await response.json();
    if (response.status === 200) {
      if (
        result.submission.outcome !== "completed" ||
        !result.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.kind === "text" &&
              block.text.includes("deployment preflight"),
          ),
        )
      )
        throw new Error("incorrect result");
      break;
    }
    if (response.status !== 202 || Date.now() >= deadlineResult)
      throw new Error("result deadline");
    await delay(100);
  }
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    !child.kill("SIGTERM")
  )
    throw new Error("candidate exited before shutdown");
  const [code, signal] = await exited;
  if (code !== 0 || signal) throw new Error("unclean shutdown");
  console.log(
    "Candidate isolated startup, submission/result and graceful stop passed",
  );
} catch {
  child.kill("SIGKILL");
  console.error("Candidate isolated preflight failed");
  process.exitCode = 1;
}
