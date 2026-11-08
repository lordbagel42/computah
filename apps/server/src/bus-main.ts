import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  startObservability,
  traceEvent,
  traceHttp,
} from "@computah/observability";
import { DurableStreamTestServer } from "@durable-streams/server";
import { createBus, createBusClient } from "./bus.js";
import {
  type BusPrincipal,
  busAuthorizer,
  busTokenHash,
  createBusHttp,
} from "./bus-http.js";

async function main() {
  const telemetry = await startObservability("bus");
  const secret = process.env.COMPUTAH_BUS_SECRET;
  const home = process.env.HOME;
  const dataDir = process.env.COMPUTAH_BUS_DATA_DIR;
  if (
    !secret ||
    Buffer.byteLength(secret) < 32 ||
    !home ||
    !isAbsolute(home) ||
    !dataDir ||
    !isAbsolute(dataDir)
  )
    throw new Error("COMPUTAH_BUS_CONFIG invalid secret/HOME/data directory");
  const port = Number(process.env.PORT ?? "8792");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("COMPUTAH_BUS_CONFIG invalid PORT");
  const rows: unknown = JSON.parse(
    process.env.COMPUTAH_BUS_AUTH_JSON ?? "null",
  );
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("COMPUTAH_BUS_CONFIG invalid auth bindings");
  const principals = new Map<string, BusPrincipal>();
  const scopes = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.token !== "string" ||
      row.token.length < 32 ||
      ![row.tenantId, row.userId, row.agentId, row.audience].every(
        (x) => typeof x === "string" && x.length > 0 && x.length <= 200,
      ) ||
      !Array.isArray(row.capabilities) ||
      !row.capabilities.every((x: string) =>
        ["task.send", "history.read"].includes(x),
      )
    )
      throw new Error("COMPUTAH_BUS_CONFIG invalid auth binding");
    const tokenHash = busTokenHash(row.token);
    const key = JSON.stringify([
      row.tenantId,
      row.userId,
      row.agentId,
      row.audience,
    ]);
    if (principals.has(tokenHash) || scopes.has(key))
      throw new Error("COMPUTAH_BUS_CONFIG duplicate binding");
    scopes.add(key);
    principals.set(tokenHash, {
      tenantId: row.tenantId,
      userId: row.userId,
      agentId: row.agentId,
      audience: row.audience,
      capabilities: row.capabilities,
      tokenHash,
    });
  }
  // Never reuse the legacy backend's /data or inherit its remote engine endpoint.
  if (
    process.env.RIVET_ENDPOINT ||
    process.env.RIVET_NAMESPACE ||
    process.env.RIVET_TOKEN
  )
    throw new Error(
      "COMPUTAH_BUS_CONFIG remote/legacy engine configuration forbidden",
    );
  delete process.env.PORT;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const streams = new DurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: join(dataDir, "streams"),
  });
  const streamBaseUrl = await streams.start();
  const bus = createBus({
    secret,
    streamBaseUrl,
    authorize: busAuthorizer(principals),
  });
  bus.registry.config.shutdown = { disableSignalHandlers: true };
  const client = createBusClient(bus);
  const http = createBusHttp(bus, client, principals);
  traceHttp(http);
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (http.listening)
        await new Promise<void>((resolve, reject) => {
          http.close((e) => (e ? reject(e) : resolve()));
          http.closeAllConnections();
        });
      await client.dispose();
      await bus.registry.shutdown();
      await streams.stop();
      traceEvent("stopped");
      await telemetry.close();
    })());
  process.once("SIGTERM", () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  process.once("SIGINT", () => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
  try {
    await bus.registry.startAndWait();
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "0.0.0.0", resolve);
    });
    console.info("computah.bus.ready dispatch=disabled");
    traceEvent("ready");
  } catch (error) {
    await stop();
    throw error;
  }
}
void main().catch(() => {
  console.error("computah.bus.start.failed");
  process.exit(1);
});
