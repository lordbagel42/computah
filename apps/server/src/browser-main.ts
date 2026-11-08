import { startObservability } from "@computah/observability";
import { Effect } from "effect";
import { createBrowser } from "./browser.js";
import { createAgentOSBrowser } from "./browser-agentos.js";

// Explicit local operator entrypoint, not an HTTP service or default backend boot.
// VPS provisioning/activation belongs to the deployment owner, not this program.
const telemetry = await startObservability("backend");
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const executable = process.env.COMPUTAH_BROWSER_EXECUTABLE;
  const chromium = process.env.COMPUTAH_BROWSER_CHROMIUM;
  const url = process.argv[2];
  if (!executable || !chromium || !url || process.argv.length !== 3)
    throw new Error(
      "Set COMPUTAH_BROWSER_EXECUTABLE and COMPUTAH_BROWSER_CHROMIUM; pass one HTTP(S) URL",
    );
  const browser = createAgentOSBrowser(
    createBrowser({ executable, chromium, authorize: () => true }),
  );
  const result = await Effect.runPromise(
    browser.read(
      { tenantId: "local", userId: "operator", agentId: "browser" },
      url,
    ),
    { signal: controller.signal },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ready") process.exitCode = 1;
} catch {
  process.stderr.write(
    "Native browser unavailable; check explicit paths and runtime prerequisites\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", stop);
  process.removeListener("SIGINT", stop);
  await telemetry.close();
}
