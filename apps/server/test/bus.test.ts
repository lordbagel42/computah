import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpProxy,
  request as httpRequest,
} from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startObservability, traceHttp } from "@computah/observability";
import { DurableStreamTestServer } from "@durable-streams/server";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { busStreamPath, createBus } from "../src/bus.js";
import { coreBusDispatch } from "../src/bus-core.js";
import {
  type BusPrincipal,
  busTokenHash,
  createBusHttp,
} from "../src/bus-http.js";
import { readConfig } from "../src/config.js";
import { createCore } from "../src/core.js";
import { closeHttp, createHttpServer } from "../src/http.js";
import { smokeProvider } from "../src/smoke-model.js";

const alice = {
  tenantId: "t",
  userId: "u",
  agentId: "agent",
  audience: "private-a",
};
const bob = { ...alice, audience: "private-b" };
const secret = "synthetic-bus-secret-longer-than-thirty-two-bytes";
const aliceToken = "synthetic-alice-token-longer-than-thirty-two-bytes";
const bobToken = "synthetic-bob-token-longer-than-thirty-two-bytes";
const historyToken = "synthetic-history-token-longer-than-thirty-two-bytes";
const taskToken = "synthetic-task-token-longer-than-thirty-two-bytes";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("standalone bus-only process persists receipts and actual Durable Streams replay, reconnect, dedup and audience isolation across restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "computah-bus-process-"));
  const port = await freePort();
  const enginePort = await freePort();
  let processHandle: ChildProcess | undefined;
  let output = "";
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    output = "";
    processHandle = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./test/bus-no-models.mjs",
        "src/bus-main.ts",
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          PATH: process.env.PATH,
          NODE_OPTIONS: process.env.NODE_OPTIONS,
          HOME: home,
          PORT: String(port),
          RIVET_RUN_ENGINE: "1",
          RIVET_RUN_ENGINE_PORT: String(enginePort),
          COMPUTAH_BUS_SECRET: secret,
          COMPUTAH_BUS_DATA_DIR: join(home, "bus"),
          COMPUTAH_BUS_AUTH_JSON: JSON.stringify([
            {
              ...alice,
              token: aliceToken,
              capabilities: ["task.send", "history.read"],
            },
            {
              ...bob,
              token: bobToken,
              capabilities: ["task.send", "history.read"],
            },
            {
              ...alice,
              audience: "history-only",
              token: historyToken,
              capabilities: ["history.read"],
            },
            {
              ...alice,
              audience: "task-only",
              token: taskToken,
              capabilities: ["task.send"],
            },
          ]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    processHandle.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    processHandle.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    for (let i = 0; i < 300; i++) {
      if (processHandle.exitCode !== null)
        throw new Error(`Bus exited before readiness: ${output.slice(-1500)}`);
      try {
        const response = await fetch(`${base}/healthz`);
        if (response.ok) {
          expect(await response.json()).toEqual({
            ready: true,
            mode: "bus-only",
            dispatch: "disabled",
          });
          return;
        }
      } catch {}
      await delay(100);
    }
    throw new Error(`Bus readiness timeout: ${output.slice(-1500)}`);
  };
  const stop = async () => {
    if (!processHandle || processHandle.exitCode !== null) return;
    const exited = once(processHandle, "exit");
    processHandle.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      delay(15000).then(() => {
        throw new Error("Bus shutdown timeout");
      }),
    ]);
    expect(result[0]).toBe(0);
  };
  const request = (path: string, token = aliceToken, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  const send = async (id: string, text: string, token = aliceToken) => {
    const response = await request("/v1/bus/receipts", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: id, text }),
    });
    expect(response.status).toBe(202);
    return (await response.json()) as {
      id: string;
      status: string;
      submissionId: string | null;
    };
  };
  const records = async (offset = "-1", token = aliceToken) => {
    for (let i = 0; i < 150; i++) {
      const response = await request(
        `/v1/bus/stream?offset=${encodeURIComponent(offset)}`,
        token,
      );
      if (response.ok)
        return {
          items: (await response.json()) as {
            receipt: { id: string; status: string };
            text: string | null;
          }[],
          offset: response.headers.get("stream-next-offset"),
        };
      expect([404, 503]).toContain(response.status);
      await delay(100);
    }
    throw new Error("Stream not ready");
  };
  try {
    await start();
    expect((await fetch(`${base}/v1/bus/stream?offset=-1`)).status).toBe(401);
    expect(
      (
        await request("/v1/bus/receipts", historyToken, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMutationId: "denied", text: "x" }),
        })
      ).status,
    ).toBe(403);
    const taskOnly = await send("only-task", "private", taskToken);
    expect(
      (await request(`/v1/bus/receipts/${taskOnly.id}`, taskToken)).status,
    ).toBe(403);
    expect((await request("/v1/bus/stream?offset=-1", taskToken)).status).toBe(
      403,
    );
    const first = await send(
      "first",
      " PRIVATE EVIDENCE MUST NOT ENTER PUBLIC STREAM ",
    );
    expect(first).toMatchObject({ status: "queued", submissionId: null });
    expect(
      await send("first", " PRIVATE EVIDENCE MUST NOT ENTER PUBLIC STREAM "),
    ).toEqual(first);
    const changed = await request("/v1/bus/receipts", aliceToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: "first", text: "changed" }),
    });
    expect(changed.status).toBe(409);
    expect(
      (await request(`/v1/bus/receipts/${first.id}`, bobToken)).status,
    ).toBe(403);
    const injected = await request("/v1/bus/receipts", aliceToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMutationId: "bad",
        text: "x",
        audience: bob.audience,
      }),
    });
    expect(injected.status).toBe(400);
    let initial = await records();
    for (let i = 0; initial.items.length < 1 && i < 100; i++) {
      await delay(100);
      initial = await records();
    }
    expect(initial.items).toEqual([{ version: 1, receipt: first, text: null }]);
    expect(initial.offset).toBeTruthy();
    expect(
      (
        await request("/v1/bus/stream", aliceToken, {
          method: "POST",
          body: "injected assistant",
        })
      ).status,
    ).toBe(404);
    const controller = new AbortController();
    const live = await request(
      `/v1/bus/stream?offset=${encodeURIComponent(initial.offset as string)}&live=sse`,
      aliceToken,
      { signal: controller.signal },
    );
    expect(live.status).toBe(200);
    const second = await send("second", "second private input");
    const reader = live.body?.getReader();
    let sse = "";
    for (let i = 0; i < 10 && !sse.includes(second.id); i++) {
      const next = await reader?.read();
      if (!next || next.done) break;
      sse += new TextDecoder().decode(next.value);
    }
    expect(sse).toContain(second.id);
    expect(sse).toContain("event: control");
    controller.abort();
    const resumed = await records(initial.offset as string);
    expect(resumed.items).toEqual([
      { version: 1, receipt: second, text: null },
    ]);
    const theirs = await send("first", "other audience", bobToken);
    let other = await records("-1", bobToken);
    for (let i = 0; other.items.length < 1 && i < 100; i++) {
      await delay(100);
      other = await records("-1", bobToken);
    }
    expect(other.items).toEqual([{ version: 1, receipt: theirs, text: null }]);
    expect(theirs.id).not.toBe(first.id);
    await stop();
    await start();
    expect((await records()).items).toEqual([
      ...initial.items,
      ...resumed.items,
    ]);
    expect((await records(initial.offset as string)).items).toEqual(
      resumed.items,
    );
    expect(
      await send("first", " PRIVATE EVIDENCE MUST NOT ENTER PUBLIC STREAM "),
    ).toEqual(first);
    expect((await request(`/v1/bus/receipts/${first.id}`)).status).toBe(200);
    const reconnected = request(
      `/v1/bus/stream?offset=${encodeURIComponent(resumed.offset as string)}&live=long-poll`,
    );
    const third = await send("third", "third evidence");
    const tail = await reconnected;
    expect(tail.status).toBe(200);
    expect(await tail.json()).toEqual([
      { version: 1, receipt: third, text: null },
    ]);
    expect(output).not.toContain("Forbidden model-runtime import");
  } finally {
    await stop();
    await rm(home, { recursive: true, force: true });
  }
}, 120000);

test("bus actor dispatch uses only authorized Interaction admission and reconciles native deterministic output", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "computah-bus-core-stream-"));
  const streams = new DurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
  });
  const streamBaseUrl = await streams.start();
  const core = createCore({
    connectionSecret: secret,
    authorize: (scope) => scope.userId === alice.userId,
    model: "computah-smoke/deterministic",
    providers: { "computah-smoke": smokeProvider() },
    apiKeys: { "computah-smoke": "synthetic" },
  });
  let coreClient: Awaited<
    ReturnType<typeof setupTest<typeof core.registry>>
  >["client"];
  const bus = createBus({
    secret,
    streamBaseUrl,
    authorize: () => true,
    dispatch: coreBusDispatch({
      secret,
      bind: (scope) => core.attach(coreClient)(scope),
    }),
  });
  try {
    const { client } = await setupTest(context, bus.registry);
    // Share ONLY this isolated test engine; production bus entry never constructs core.
    core.registry.config.endpoint = bus.registry.parseConfig().endpoint;
    core.registry.config.namespace = "default";
    core.registry.config.node = { poolName: "computah-bus-core-test" };
    core.registry.config.startServices = false;
    coreClient = (await setupTest(context, core.registry)).client;
    const session = bus.attach(client)(alice);
    const first = await session.admit({
      clientMutationId: "native-core",
      text: "Keep MixedCase CANARY",
    });
    let done = first;
    for (let i = 0; i < 200; i++) {
      done = await session.receipt(first.id);
      if (done.status === "completed") break;
      await delay(100);
    }
    expect(done.status).toBe("completed");
    expect(done.submissionId).toMatch(/\./);
    const config = readConfig({
      COMPUTAH_MODE: "faux",
      COMPUTAH_CONNECTION_SECRET: secret,
      COMPUTAH_AUTH_JSON: JSON.stringify([
        {
          ...alice,
          token: aliceToken,
          capabilities: ["task.send", "history.read"],
        },
      ]),
    });
    const http = createHttpServer({ ...config, bind: core.attach(coreClient) });
    try {
      await new Promise<void>((resolve) =>
        http.listen(0, "127.0.0.1", resolve),
      );
      const publicResult = await fetch(
        `http://127.0.0.1:${(http.address() as { port: number }).port}/v1/submissions/${done.submissionId}`,
        { headers: { authorization: `Bearer ${aliceToken}` } },
      );
      expect(publicResult.status).toBe(200);
      const result = await publicResult.json();
      expect(result.submission.id).toBe(done.submissionId);
      expect(JSON.stringify(result.messages)).toContain(
        "Keep MixedCase CANARY",
      );
    } finally {
      await closeHttp(http);
    }
    await session.pump();
    const replay = await fetch(
      new URL(`${busStreamPath(alice)}?offset=-1`, streamBaseUrl),
    );
    const rows = (await replay.json()) as {
      receipt: { status: string };
      text: string | null;
    }[];
    expect(rows.map((row) => row.receipt.status)).toEqual([
      "queued",
      "completed",
    ]);
    expect(rows[0].text).toBeNull();
    expect(rows[1].text).toContain("Keep MixedCase CANARY");
    expect(
      await session.admit({
        clientMutationId: "native-core",
        text: "Keep MixedCase CANARY",
      }),
    ).toEqual(done);
    await session.pump();
    const again = await fetch(
      new URL(`${busStreamPath(alice)}?offset=-1`, streamBaseUrl),
    );
    expect(await again.json()).toEqual(rows);
  } finally {
    await core.close();
    await bus.registry.shutdown();
    await streams.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("native actor reopens pending outbox and recovers append-success/lost-ack with actual producer dedup", async (context) => {
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  const logged: string[] = [];
  const previousToken = process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  const previousDataset = process.env.COMPUTAH_AXIOM_LOG_DATASET;
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-bus-trace-token";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "computah-bus-test-logs";
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      exported.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (String(input) === "https://api.axiom.co/v1/logs") {
      logged.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input, init);
  };
  const telemetry = await startObservability("bus");
  const scope = { ...alice, audience: "commit-gap-isolated" };
  const dataDir = await mkdtemp(join(tmpdir(), "computah-bus-gap-"));
  const streams = new DurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
  });
  const target = await streams.start();
  let available = false;
  let drop = true;
  let hang = false;
  let hanging = false;
  const appends: number[] = [];
  const proxy = createHttpProxy(async (request, response) => {
    try {
      if (hang) {
        hanging = true;
        return;
      }
      if (!available) {
        response.writeHead(503);
        response.end();
        return;
      }
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      const headers: Record<string, string> = {};
      for (const name of [
        "content-type",
        "producer-id",
        "producer-epoch",
        "producer-seq",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      const upstream = await fetch(new URL(request.url ?? "/", target), {
        method: request.method,
        headers,
        signal: controller.signal,
        ...(body.length ? { body: Buffer.concat(body) } : {}),
      });
      if (request.method === "GET" || request.method === "HEAD") {
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "stream-next-offset"]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(upstream.status, headers);
        if (upstream.body)
          for await (const chunk of upstream.body) response.write(chunk);
        response.end();
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (request.method === "POST") {
        appends.push(upstream.status);
        if (drop) {
          drop = false;
          available = false;
          response.destroy();
          return;
        }
      }
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(bytes);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const streamBaseUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const options = { secret, streamBaseUrl, authorize: () => true };
  let bus = createBus(options);
  try {
    let client = (await setupTest(context, bus.registry)).client;
    let session = bus.attach(client)(scope);
    const first = await session.admit({
      clientMutationId: "commit-gap",
      text: "private evidence",
    });
    const absent = await fetch(
      new URL(`${busStreamPath(scope)}?offset=-1`, target),
    );
    expect(absent.status).toBe(404);
    // Admission/outbox is durable while publishing is unavailable, without a browser.
    await bus.registry.shutdown();
    bus = createBus(options);
    available = true;
    client = (await setupTest(context, bus.registry)).client;
    session = bus.attach(client)(scope);
    expect(await session.receipt(first.id)).toEqual(first);
    for (let i = 0; appends.length < 1 && i < 100; i++) await delay(100);
    expect(appends).toEqual([200]);
    available = false;
    await bus.registry.shutdown();
    const stored = await fetch(
      new URL(`${busStreamPath(scope)}?offset=-1`, target),
    );
    expect(await stored.json()).toEqual([
      { version: 1, receipt: first, text: null },
    ]);
    // Reopen after append committed but the actor never received its response.
    bus = createBus(options);
    client = (await setupTest(context, bus.registry)).client;
    session = bus.attach(client)(scope);
    available = true;
    await session.receipt(first.id);
    for (let i = 0; !appends.includes(204) && i < 150; i++) await delay(100);
    expect(appends).toContain(204);
    const replay = await fetch(
      new URL(`${busStreamPath(scope)}?offset=-1`, target),
    );
    expect(await replay.json()).toEqual([
      { version: 1, receipt: first, text: null },
    ]);
    const duplicates = await Promise.all(
      Array.from({ length: 8 }, () =>
        session.admit({ clientMutationId: "concurrent", text: "same bytes" }),
      ),
    );
    expect(new Set(duplicates.map((receipt) => receipt.id)).size).toBe(1);
    await session.pump();
    const concurrent = await fetch(
      new URL(`${busStreamPath(scope)}?offset=-1`, target),
    );
    expect(
      (await concurrent.json()).map(
        (row: { receipt: { clientMutationId: string } }) =>
          row.receipt.clientMutationId,
      ),
    ).toEqual(["commit-gap", "concurrent"]);
    const oldPrincipal: BusPrincipal = {
      ...scope,
      tokenHash: busTokenHash(aliceToken),
      capabilities: ["task.send", "history.read"],
    };
    const principals = new Map([[oldPrincipal.tokenHash, oldPrincipal]]);
    const rotate = () => {
      principals.delete(oldPrincipal.tokenHash);
      principals.set(busTokenHash(bobToken), {
        ...oldPrincipal,
        tokenHash: busTokenHash(bobToken),
      });
    };
    const http = createBusHttp(bus, client, principals);
    traceHttp(http);
    try {
      await new Promise<void>((resolve) =>
        http.listen(0, "127.0.0.1", resolve),
      );
      const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
      let bodyPermitted: () => void = () => {};
      const permission = new Promise<void>((resolve) => {
        bodyPermitted = resolve;
      });
      bus.authorize = () => {
        bodyPermitted();
        return true;
      };
      let finishBody: () => void = () => {};
      const response = new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          `${base}/v1/bus/receipts`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${aliceToken}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.write('{"text":');
        finishBody = () =>
          request.end('"blocked old token","clientMutationId":"rotated"}');
      });
      await permission;
      rotate();
      finishBody();
      expect(await response).toBe(403);
      // The denied slow-body request must not have frozen the mutation payload.
      expect(
        (
          await session.admit({
            clientMutationId: "rotated",
            text: "authorized different body",
          })
        ).status,
      ).toBe("queued");
      principals.clear();
      principals.set(oldPrincipal.tokenHash, oldPrincipal);
      let checks = 0;
      bus.authorize = () => {
        if (++checks === 2) rotate();
        return true;
      };
      const deniedEgress = await fetch(`${base}/v1/bus/receipts/${first.id}`, {
        headers: { authorization: `Bearer ${aliceToken}` },
      });
      expect(deniedEgress.status).toBe(403);
      expect(await deniedEgress.json()).toEqual({ code: "forbidden" });
      principals.clear();
      principals.set(oldPrincipal.tokenHash, oldPrincipal);
      bus.authorize = () => true;
      const replayRequest = (query: string, init: RequestInit = {}) =>
        fetch(`${base}/v1/bus/stream?${query}`, {
          ...init,
          headers: {
            authorization: `Bearer ${aliceToken}`,
            traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
          },
        });
      const replayed = await replayRequest("offset=-1");
      expect(replayed.status).toBe(200);
      expect((await replayed.json()).length).toBeGreaterThanOrEqual(2);
      // Offset contents must never become attributes, even when supplied by a client.
      const invalid = await replayRequest(
        "offset=private-offset-canary&live=invalid",
      );
      expect(invalid.status).toBe(400);
      await invalid.body?.cancel();
      const head = await replayRequest("offset=-1", { method: "HEAD" });
      expect(head.status).toBe(200);
      const offset = head.headers.get("stream-next-offset");
      expect(offset).toBeTruthy();
      const resumed = await replayRequest(
        `offset=${encodeURIComponent(offset as string)}`,
      );
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual([]);
      const abort = new AbortController();
      const live = await replayRequest(
        `offset=${encodeURIComponent(offset as string)}&live=sse`,
        { signal: abort.signal },
      );
      expect(live.status).toBe(200);
      const reader = live.body?.getReader();
      await reader?.read();
      await delay(1200);
      abort.abort();
      await reader?.cancel().catch(() => {});
      bus.authorize = () => false;
      const deniedReplay = await replayRequest("offset=-1");
      expect(deniedReplay.status).toBe(403);
      await deniedReplay.body?.cancel();
      bus.authorize = () => true;
      available = false;
      const failedReplay = await replayRequest("offset=-1");
      expect(failedReplay.status).toBe(503);
      await failedReplay.body?.cancel();
      available = true;
      // Native cron really attempts publication without a browser/admission.
      hang = true;
      for (let i = 0; !hanging && i < 100; i++) await delay(100);
      expect(hanging).toBe(true);
      await delay(5500);
      hang = false;
      await session.pump();
      // Shutdown must cancel an actual in-flight scheduled network attempt.
      hanging = false;
      hang = true;
      for (let i = 0; !hanging && i < 100; i++) await delay(100);
      expect(hanging).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    }
  } finally {
    await bus.registry.shutdown();
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve());
      proxy.closeAllConnections();
    });
    await streams.stop();
    await rm(dataDir, { recursive: true, force: true });
    await telemetry.close();
    globalThis.fetch = originalFetch;
    if (previousToken === undefined)
      delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    else process.env.COMPUTAH_AXIOM_INGEST_TOKEN = previousToken;
    if (previousDataset === undefined)
      delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
    else process.env.COMPUTAH_AXIOM_LOG_DATASET = previousDataset;
  }
  type ExportedSpan = {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    status: { code: number };
    attributes: {
      key: string;
      value: {
        stringValue?: string;
        doubleValue?: number;
        boolValue?: boolean;
      };
    }[];
  };
  const spans: ExportedSpan[] = exported.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (resource: { scopeSpans: { spans: ExportedSpan[] }[] }) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  const attribute = (span: Pick<ExportedSpan, "attributes">, key: string) =>
    span.attributes.find((attribute) => attribute.key === key)?.value;
  const named = (name: string) =>
    spans.filter((span) => span.name === `computah.${name}`);
  expect(
    named("bus.pump").some(
      (span) => attribute(span, "phase")?.stringValue === "prepare",
    ),
  ).toBe(true);
  expect(
    named("bus.pump").some(
      (span) => attribute(span, "phase")?.stringValue === "poll",
    ),
  ).toBe(true);
  expect(
    named("bus.stream.create").some(
      (span) =>
        attribute(span, "http.response.status_code")?.doubleValue === 503 &&
        span.status.code === 2,
    ),
  ).toBe(true);
  expect(
    named("bus.stream.create").some(
      (span) =>
        attribute(span, "outcome")?.stringValue === "timeout" &&
        span.status.code === 2 &&
        BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano) >=
          4_500_000_000n,
    ),
  ).toBe(true);
  expect(
    named("bus.stream.create").some(
      (span) =>
        attribute(span, "outcome")?.stringValue === "cancelled" &&
        span.status.code === 2,
    ),
  ).toBe(true);
  expect(
    named("bus.stream.append").some(
      (span) =>
        attribute(span, "outcome")?.stringValue === "error" &&
        span.status.code === 2,
    ),
  ).toBe(true);
  expect(
    named("bus.stream.append").some(
      (span) =>
        attribute(span, "http.response.status_code")?.doubleValue === 204 &&
        attribute(span, "outcome")?.stringValue === "success",
    ),
  ).toBe(true);
  for (const span of [
    ...named("bus.stream.create"),
    ...named("bus.stream.append"),
  ]) {
    const parent = named("bus.pump").find(
      (pump) =>
        pump.spanId === span.parentSpanId && pump.traceId === span.traceId,
    );
    expect(parent).toBeDefined();
    // SDK spans individually anchor Date.now() to a monotonic clock; compare durations,
    // not sub-millisecond wall-clock ordering between independently anchored spans.
    expect(
      BigInt(parent?.endTimeUnixNano ?? "0") -
        BigInt(parent?.startTimeUnixNano ?? "0"),
    ).toBeGreaterThanOrEqual(
      BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano),
    );
  }
  const replays = named("bus.replay");
  for (const outcome of [
    "success",
    "error",
    "denied",
    "invalid_input",
    "cancelled",
  ])
    expect(
      replays.some(
        (span) => attribute(span, "outcome")?.stringValue === outcome,
      ),
    ).toBe(true);
  expect(
    replays.some(
      (span) =>
        attribute(span, "resumed")?.boolValue === true &&
        attribute(span, "outcome")?.stringValue === "success",
    ),
  ).toBe(true);
  expect(
    replays.some(
      (span) =>
        attribute(span, "outcome")?.stringValue === "cancelled" &&
        BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano) >=
          1_000_000_000n,
    ),
  ).toBe(true);
  for (const span of replays) {
    expect(span.traceId).toBe("a".repeat(32));
    const parent = spans.find((parent) => parent.spanId === span.parentSpanId);
    expect(parent?.name).toBe("computah.http");
    expect(parent?.parentSpanId).toBe("b".repeat(16));
  }
  const records: Pick<ExportedSpan, "attributes" | "traceId" | "spanId">[] =
    logged.flatMap((body) =>
      JSON.parse(body).resourceLogs.flatMap(
        (resource: {
          scopeLogs: {
            logRecords: Pick<
              ExportedSpan,
              "attributes" | "traceId" | "spanId"
            >[];
          }[];
        }) => resource.scopeLogs.flatMap((scope) => scope.logRecords),
      ),
    );
  for (const outcome of ["timeout", "cancelled"])
    expect(
      records.some(
        (record) =>
          attribute(record, "operation")?.stringValue === "bus.stream.create" &&
          attribute(record, "outcome")?.stringValue === outcome &&
          spans.some(
            (span) =>
              span.traceId === record.traceId && span.spanId === record.spanId,
          ),
      ),
    ).toBe(true);
  expect(
    records.some(
      (record) =>
        attribute(record, "operation")?.stringValue === "bus.replay" &&
        attribute(record, "reason")?.stringValue === "invalid_input" &&
        attribute(record, "outcome")?.stringValue !== "success",
    ),
  ).toBe(true);
  for (const canary of [
    secret,
    aliceToken,
    bobToken,
    "private evidence",
    scope.audience,
    "private-offset-canary",
    "synthetic-bus-trace-token",
  ])
    expect([...exported, ...logged].join("\n")).not.toContain(canary);
}, 120000);
