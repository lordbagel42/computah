import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect, Redacted } from "effect";

// Alchemy local state unwraps secrets. Every state file must inherit owner-only permissions.
process.umask(0o077);
if (
  (!process.env.COMPUTAH_AXIOM_QUERY_TOKEN ||
    (process.env.PUBLIC_ID_SECRET?.length ?? 0) < 32) &&
  process.env.COMPUTAH_OBSERVATORY_BOOTSTRAP !== "1"
) {
  throw new Error(
    "Provide runtime secrets or explicitly select unconfigured bootstrap; refusing to clear live bindings",
  );
}

export default Alchemy.Stack(
  "computah-public-observatory",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("Observatory", {
      name: "computah-observatory",
      main: "../src/worker.ts",
      assets: { directory: "../public", runWorkerFirst: true },
      compatibility: {
        date: "2026-11-08",
        flags: ["nodejs_compat", "enable_request_signal"],
      },
      workersDev: { enabled: true, previewsEnabled: false },
      domain: "observe.raygen.dev",
      env: {
        TRACES: Cloudflare.DurableObject("PublicTraceFeed", {
          className: "PublicTraceFeed",
          storage: "sqlite",
        }),
        // Only genuine, explicitly provisioned runtime credentials; never fall back to ambient AXIOM_TOKEN.
        COMPUTAH_AXIOM_QUERY_TOKEN: Redacted.make(
          process.env.COMPUTAH_AXIOM_QUERY_TOKEN ?? "",
        ),
        PUBLIC_ID_SECRET: Redacted.make(process.env.PUBLIC_ID_SECRET ?? ""),
        COMPUTAH_AXIOM_INGEST_TOKEN: Redacted.make(
          process.env.COMPUTAH_AXIOM_INGEST_TOKEN ?? "",
        ),
        OBSERVATORY_LIVE_TOKEN: Redacted.make(
          process.env.OBSERVATORY_LIVE_TOKEN ?? "",
        ),
      },
      observability: { enabled: true, headSamplingRate: 1 },
    });
    return { url: worker.url };
  }),
);
