import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  runtimeMetric,
  startObservability,
  traceEvent,
  traceHttp,
  traceLifecycle,
} from "@computah/observability";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createClient } from "rivetkit/client";
import { OperationalAnalytics, observeModels } from "./analytics.js";
import { principalKey, readConfig } from "./config.js";
import {
  type CoreOptions,
  type CoreSession,
  createCore,
  type Scope,
} from "./core.js";
import { createGmailRuntime, gmailConfig } from "./gmail-runtime.js";
import { closeHttp, createHttpServer } from "./http.js";
import { priorityModels } from "./model-policy.js";
import { createSentinel } from "./sentinel.js";
import { smokeProvider } from "./smoke-model.js";
import {
  createTransportTiming,
  readTransportTimingConfig,
} from "./transport-timing.js";

async function main() {
  console.info("computah.lifecycle phase=bootstrap outcome=started");
  const telemetry = await startObservability("backend");
  const config = readConfig(process.env);
  let analytics: OperationalAnalytics | undefined;
  try {
    process.umask(0o077);
    const directory = join(homedir(), ".computah");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    analytics = new OperationalAnalytics({
      path: join(directory, "analytics.sqlite"),
      secret: config.secret,
      models: [...new Set([config.model, config.workerModel])],
      onObservation: runtimeMetric,
    });
  } catch {
    traceEvent("report", { reason: "storage_failed" });
  }
  // PORT belongs to this ingress, not to native child services.
  delete process.env.PORT;
  // Explicit mount only: never discover another application's local credentials.
  // The official runtime owns file locking, refresh and provider-specific auth.
  const models = await traceLifecycle("models", () =>
    ModelRuntime.create({
      ...(config.mode === "real" && config.authFile
        ? { authPath: config.authFile }
        : { credentials: new InMemoryCredentialStore() }),
      modelsPath: null,
    }),
  );
  if (config.mode === "faux") {
    models.registerProvider("computah-smoke", smokeProvider());
    await models.setRuntimeApiKey("computah-smoke", "explicit-smoke");
  } else {
    for (const [provider, key] of Object.entries(config.apiKeys ?? {}))
      await models.setRuntimeApiKey(provider, key);
  }
  const priorityRuntime =
    config.mode === "real"
      ? priorityModels(models, (diagnostic) => {
          console.info(`computah.model ${JSON.stringify(diagnostic)}`);
          traceEvent("model", diagnostic);
        })
      : models;
  const runtimeModels = analytics
    ? observeModels(priorityRuntime, analytics)
    : priorityRuntime;
  const byScope = new Map(
    [...config.principals.values()].map((principal) => [
      principalKey(principal),
      principal,
    ]),
  );
  const authorize: CoreOptions["authorize"] = (scope, capability) =>
    byScope.get(principalKey(scope))?.capabilities.includes(capability) ??
    false;
  const timing = readTransportTimingConfig(process.env);
  let bind: ((scope: Scope) => CoreSession) | undefined;
  const gmailSettings = gmailConfig(process.env, config.principals.values());
  if (gmailSettings && config.mode !== "real")
    throw new Error("COMPUTAH_GMAIL_JSON requires real mode");
  const gmail = gmailSettings
    ? createGmailRuntime({
        config: gmailSettings,
        authorize: (scope) => {
          const principal = byScope.get(principalKey(scope));
          return (
            !!principal?.capabilities.includes("history.read") &&
            principal.capabilities.includes("task.send")
          );
        },
        bind: (scope) => {
          if (!bind) throw new Error("Runtime unavailable");
          return bind(scope);
        },
      })
    : undefined;
  const core = createCore({
    connectionSecret: config.secret,
    authorize,
    transportTiming: timing
      ? createTransportTiming({ ...timing, authorize })
      : undefined,
    model: config.model,
    analytics,
    workerModel: config.workerModel,
    thinkingLevel: config.mode === "real" ? "high" : undefined,
    // A removed connection configuration cannot authorize old source-bearing
    // native checkpoints. Retain the hard boundary in the real model runtime.
    sources:
      config.mode === "real"
        ? (gmail?.sources ?? {
            available: () => false,
            check: async () => {
              throw new Error("Source access denied");
            },
            preload: async () => null,
          })
        : undefined,
    tavily: process.env.COMPUTAH_TAVILY_API_KEY
      ? { apiKey: process.env.COMPUTAH_TAVILY_API_KEY }
      : undefined,
    operations: { queryToken: process.env.COMPUTAH_AXIOM_QUERY_TOKEN },
    axiomMcp: {
      pat: process.env.COMPUTAH_AXIOM_MCP_PAT,
      oauthFile: process.env.COMPUTAH_AXIOM_MCP_OAUTH_FILE,
      orgId: process.env.COMPUTAH_AXIOM_MCP_ORG_ID,
    },
    models: runtimeModels,
    sentinel:
      config.sentinel && runtimeModels
        ? {
            ...config.sentinel,
            review: createSentinel({
              models: runtimeModels,
              model: config.workerModel,
            }).review,
          }
        : undefined,
    apiKeys:
      config.mode === "faux"
        ? { "computah-smoke": "explicit-smoke" }
        : undefined,
    providers:
      config.mode === "faux"
        ? { "computah-smoke": smokeProvider() }
        : undefined,
  });
  let client: ReturnType<typeof createClient<typeof core.registry>> | undefined;
  let http: ReturnType<typeof createHttpServer> | undefined;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // Do not race native startup/HTTP listen against storage shutdown.
      await startup?.catch(() => {});
      const server = http;
      if (server?.listening)
        await traceLifecycle("http_drain", () => closeHttp(server));
      await gmail?.close();
      await traceLifecycle("registry_drain", () => core.close());
      await traceLifecycle("client_drain", async () => client?.dispose());
      analytics?.close();
      traceEvent("stopped");
      await telemetry.close();
    })());
  const shutdown = () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  // Host owns signal shutdown: stop public admissions before draining the actors.
  core.registry.config.shutdown = { disableSignalHandlers: true };
  startup = (async () => {
    // Bind authority before native checkpoint recovery can issue requests.
    await gmail?.initialize();
    await traceLifecycle("registry", () => core.registry.startAndWait());
    if (stopping) return;
    const runtime = core.registry.parseConfig();
    client = createClient<typeof core.registry>({
      endpoint: runtime.endpoint,
      namespace: runtime.namespace,
      token: runtime.token,
      poolName: runtime.node.poolName,
      headers: runtime.headers,
    });
    bind = core.attach(client);
    gmail?.start();
    http = createHttpServer({
      ...config,
      operatorRedactValues: [
        ...config.operatorRedactValues,
        ...(runtime.token ? [runtime.token] : []),
      ],
      privilegedUrlPrefixes: [
        ...config.privilegedUrlPrefixes,
        runtime.endpoint,
      ].filter((value): value is string => Boolean(value)),
      bind,
      gmail,
      revision: process.env.COMPUTAH_REVISION,
      ready: () => !stopping,
    });
    traceHttp(http);
    await traceLifecycle(
      "listener",
      () =>
        new Promise<void>((resolve, reject) => {
          http?.once("error", reject);
          http?.listen(config.port, "0.0.0.0", resolve);
        }),
    );
    console.info(`computah.http.ready mode=${config.mode} port=${config.port}`);
    traceEvent("ready");
  })();
  try {
    await startup;
  } catch (error) {
    await stop();
    throw error;
  }
}

void main().catch((error: unknown) => {
  // Config errors contain names only. Never print SDK errors, env values or stack traces.
  const message =
    error instanceof Error &&
    /^(COMPUTAH_|PORT |Invalid COMPUTAH_|Duplicate auth |Missing provider credential)/.test(
      error.message,
    )
      ? error.message
      : "Runtime startup failed";
  console.error(`computah.start.failed ${message}`);
  process.exit(1);
});
