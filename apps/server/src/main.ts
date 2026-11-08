import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createClient } from "rivetkit/client";
import { principalKey, readConfig } from "./config.js";
import { createCore } from "./core.js";
import { closeHttp, createHttpServer } from "./http.js";
import { priorityModels } from "./model-policy.js";
import { smokeProvider } from "./smoke-model.js";

async function main() {
  const config = readConfig(process.env);
  // PORT belongs to this ingress, not to native child services.
  delete process.env.PORT;
  // Explicit mount only: never discover another application's local credentials.
  // The official runtime owns file locking, refresh and provider-specific auth.
  const models =
    config.mode === "real"
      ? await ModelRuntime.create({
          ...(config.authFile
            ? { authPath: config.authFile }
            : { credentials: new InMemoryCredentialStore() }),
          modelsPath: null,
        })
      : undefined;
  if (models) {
    for (const [provider, key] of Object.entries(config.apiKeys ?? {}))
      await models.setRuntimeApiKey(provider, key);
  }
  const byScope = new Map(
    [...config.principals.values()].map((principal) => [
      principalKey(principal),
      principal,
    ]),
  );
  const core = createCore({
    connectionSecret: config.secret,
    authorize: (scope, capability) =>
      byScope.get(principalKey(scope))?.capabilities.includes(capability) ??
      false,
    model: config.model,
    workerModel: config.workerModel,
    thinkingLevel: config.mode === "real" ? "high" : undefined,
    tavily: process.env.COMPUTAH_TAVILY_API_KEY
      ? { apiKey: process.env.COMPUTAH_TAVILY_API_KEY }
      : undefined,
    models: models
      ? priorityModels(models, (diagnostic) => {
          console.info(`computah.model ${JSON.stringify(diagnostic)}`);
        })
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
      if (http?.listening) await closeHttp(http);
      await core.close();
      await client?.dispose();
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
    await core.registry.startAndWait();
    if (stopping) return;
    const runtime = core.registry.parseConfig();
    client = createClient<typeof core.registry>({
      endpoint: runtime.endpoint,
      namespace: runtime.namespace,
      token: runtime.token,
      poolName: runtime.node.poolName,
      headers: runtime.headers,
    });
    http = createHttpServer({
      ...config,
      bind: core.attach(client),
      revision: process.env.COMPUTAH_REVISION,
      ready: () => !stopping,
    });
    await new Promise<void>((resolve, reject) => {
      http?.once("error", reject);
      http?.listen(config.port, "0.0.0.0", resolve);
    });
    console.info(`computah.http.ready mode=${config.mode} port=${config.port}`);
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
