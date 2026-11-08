import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentTraceHeaders,
  startObservability,
  traceOperation,
} from "@computah/observability";
import { DurableStreamTestServer } from "@durable-streams/server";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { busStreamPath, createBus } from "../src/bus.js";

test("causal admission, dispatch and append survive restart, duplicate admission and lost acknowledgement", async (context) => {
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  const logged: string[] = [];
  let available = false;
  let loseAck = true;
  let lostAck = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      exported.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (String(input) === "https://api.axiom.co/v1/logs") {
      logged.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (String(input).includes("/v1/stream/") && init?.method) {
      if (!available) return new Response(null, { status: 503 });
      const response = await originalFetch(input, init);
      if (init.method === "POST" && loseAck) {
        loseAck = false;
        lostAck = true;
        available = false;
        await response.body?.cancel();
        throw new Error("synthetic lost append acknowledgement");
      }
      return response;
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-bus-logs";
  const telemetry = await startObservability("bus");
  const dataDir = await mkdtemp(join(tmpdir(), "computah-bus-causality-"));
  const streams = new DurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
  });
  const streamBaseUrl = await streams.start();
  const scope = {
    tenantId: "private-tenant-causality-canary",
    userId: "private-user-causality-canary",
    agentId: "agent",
    audience: "private-audience-causality-canary",
  };
  const options = {
    secret: "synthetic-causality-secret-longer-than-thirty-two-bytes",
    streamBaseUrl,
    authorize: () => true,
  };
  let bus = createBus(options);
  let ingress: Record<string, string> = {};
  try {
    let client = (await setupTest(context, bus.registry)).client;
    let session = bus.attach(client)(scope);
    const first = await traceOperation("bus.test.ingress", async () => {
      ingress = currentTraceHeaders();
      return session.admit(
        {
          clientMutationId: "causal-first",
          text: "private-message-causality-canary",
        },
        ingress,
      );
    });
    const second = await session.admit({
      clientMutationId: "causal-second",
      text: "different private message",
    });
    const initialTiming = await session.timing(first.id);
    expect(initialTiming.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(initialTiming.traceId).toBe(ingress.traceparent.split("-")[1]);
    expect(initialTiming.receivedAtMs).toBeNull();
    expect(initialTiming.admittedAtMs).toBeGreaterThan(0);
    expect(initialTiming.outputs).toHaveLength(1);
    expect(initialTiming.outputs?.[0].enqueuedAtMs).toBe(
      initialTiming.admittedAtMs,
    );
    await expect(
      bus
        .attach(client)({ ...scope, audience: "other-audience" })
        .timing(first.id),
    ).rejects.toThrow("forbidden");
    await delay(50);
    await bus.registry.shutdown();
    available = true;
    bus = createBus(options);
    client = (await setupTest(context, bus.registry)).client;
    session = bus.attach(client)(scope);
    expect(await session.receipt(first.id)).toEqual(first);
    for (let i = 0; !lostAck && i < 100; i++) {
      await session.pump().catch(() => {});
      await delay(10);
    }
    expect(lostAck).toBe(true);
    await bus.registry.shutdown();
    bus = createBus(options);
    client = (await setupTest(context, bus.registry)).client;
    session = bus.attach(client)(scope);
    available = true;
    expect(
      await session.admit({
        clientMutationId: "causal-first",
        text: "private-message-causality-canary",
      }),
    ).toEqual(first);
    let records: unknown[] = [];
    for (let i = 0; records.length < 2 && i < 100; i++) {
      await session.pump();
      const response = await originalFetch(
        new URL(`${busStreamPath(scope)}?offset=-1`, streamBaseUrl),
      );
      if (response.ok) records = (await response.json()) as unknown[];
      if (records.length < 2) await delay(10);
    }
    expect(records).toEqual([
      { version: 1, receipt: first, text: null },
      { version: 1, receipt: second, text: null },
    ]);
    const finalTiming = await session.timing(first.id);
    expect(finalTiming.traceId).toBe(initialTiming.traceId);
    expect(finalTiming.admittedAtMs).toBe(initialTiming.admittedAtMs);
    expect(finalTiming.receivedAtMs).toBeNull();
    expect(finalTiming.outputs?.[0]).toMatchObject({
      enqueuedAtMs: initialTiming.admittedAtMs,
      attempts: 2,
    });
    expect(finalTiming.outputs?.[0].firstAttemptAtMs).toBeGreaterThanOrEqual(
      (initialTiming.admittedAtMs as number) + 50,
    );
    expect(finalTiming.outputs?.[0].acknowledgedAtMs).toBeGreaterThanOrEqual(
      finalTiming.outputs?.[0].firstAttemptAtMs as number,
    );
    await bus.registry.shutdown();
    let failDispatch = true;
    let dispatchFailures = 0;
    bus = createBus({
      ...options,
      dispatch: async () => {
        if (failDispatch) {
          dispatchFailures++;
          throw new Error("synthetic dispatch failure");
        }
        return {
          submissionId: "synthetic-submission",
          status: "completed",
          text: "safe result",
        };
      },
    });
    client = (await setupTest(context, bus.registry)).client;
    session = bus.attach(client)(scope);
    // The failed wake attempt leaves both durable receipts queued for retry.
    for (let i = 0; dispatchFailures === 0 && i < 100; i++) {
      await session.pump().catch(() => {});
      await delay(10);
    }
    expect(dispatchFailures).toBeGreaterThan(0);
    expect((await session.receipt(first.id)).status).toBe("queued");
    failDispatch = false;
    for (let i = 0; i < 100; i++) {
      await session.pump();
      if ((await session.receipt(second.id)).status === "completed") break;
      await delay(10);
    }
    expect((await session.receipt(first.id)).status).toBe("completed");
    expect((await session.receipt(second.id)).status).toBe("completed");
  } finally {
    await bus.registry.shutdown();
    await streams.stop();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
  type Span = {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    links: { traceId: string; spanId: string }[];
    status: { code: number };
    attributes: {
      key: string;
      value: { doubleValue?: number; stringValue?: string };
    }[];
  };
  const spans: Span[] = exported.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (resource: { scopeSpans: { spans: Span[] }[] }) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  const admissions = spans.filter((span) => span.name === "computah.bus.admit");
  expect(admissions).toHaveLength(3); // two initial admissions plus the duplicate
  const firstAdmission = admissions.find(
    (span) => span.parentSpanId === ingress.traceparent.split("-")[2],
  );
  expect(firstAdmission?.traceId).toBe(ingress.traceparent.split("-")[1]);
  const pumps = spans.filter((span) => span.name === "computah.bus.pump");
  expect(
    pumps.every(
      (pump) => !admissions.some((admit) => pump.parentSpanId === admit.spanId),
    ),
  ).toBe(true);
  const appends = spans.filter(
    (span) => span.name === "computah.bus.stream.append",
  );
  expect(appends.length).toBeGreaterThanOrEqual(3);
  expect(
    appends.every((span) =>
      admissions.some(
        (root) =>
          span.traceId === root.traceId && span.parentSpanId === root.spanId,
      ),
    ),
  ).toBe(true);
  expect(new Set(appends.map((span) => span.traceId)).size).toBe(2);
  const dispatches = spans.filter(
    (span) => span.name === "computah.bus.dispatch",
  );
  expect(dispatches.some((span) => span.status.code === 2)).toBe(true);
  expect(dispatches.filter((span) => span.status.code !== 2)).toHaveLength(2);
  expect(
    dispatches.every((span) =>
      admissions.some(
        (admit) =>
          span.traceId === admit.traceId && span.parentSpanId === admit.spanId,
      ),
    ),
  ).toBe(true);
  expect(
    [...appends, ...dispatches].every((span) =>
      span.links.some((link) =>
        pumps.some(
          (pump) =>
            pump.traceId === link.traceId && pump.spanId === link.spanId,
        ),
      ),
    ),
  ).toBe(true);
  const value = (span: Span, key: string) =>
    span.attributes.find((attr) => attr.key === key)?.value.doubleValue;
  const retried = appends.filter((span) => value(span, "attempt") === 2);
  expect(retried).toHaveLength(1);
  expect(value(retried[0], "http.response.status_code")).toBe(204);
  const originalAttempt = appends.find(
    (span) =>
      span.traceId === retried[0].traceId && value(span, "attempt") === 1,
  );
  expect(originalAttempt?.status.code).toBe(2);
  expect(value(retried[0], "queue.duration_ms")).toBe(
    value(originalAttempt as Span, "queue.duration_ms"),
  );
  expect(value(retried[0], "queue.duration_ms")).toBeGreaterThanOrEqual(50);
  expect(value(retried[0], "delivery.duration_ms")).toBeGreaterThanOrEqual(
    value(retried[0], "queue.duration_ms") as number,
  );
  const logRecords: {
    traceId: string;
    spanId: string;
    body: { stringValue: string };
  }[] = logged.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (resource: { scopeLogs: { logRecords: unknown[] }[] }) =>
        resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
  for (const span of [...admissions, ...dispatches])
    expect(
      logRecords.some(
        (record) =>
          record.body.stringValue === "operation.completed" &&
          record.traceId === span.traceId &&
          record.spanId === span.spanId,
      ),
    ).toBe(true);
  const deliveries = logRecords.filter(
    (record) => record.body.stringValue === "bus.delivery",
  );
  expect(
    deliveries.some(
      (record) =>
        record.spanId === retried[0].spanId &&
        record.traceId === retried[0].traceId,
    ),
  ).toBe(true);
  expect(
    deliveries.some(
      (record) =>
        record.spanId === originalAttempt?.spanId &&
        record.traceId === originalAttempt?.traceId,
    ),
  ).toBe(true);
  for (const canary of [
    scope.tenantId,
    scope.userId,
    scope.audience,
    "private-message-causality-canary",
    "causal-first",
  ])
    expect(exported.join() + logged.join()).not.toContain(canary);
}, 60000);
