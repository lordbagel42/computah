import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startObservability } from "@computah/observability";
import { DurableStreamTestServer } from "@durable-streams/server";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { busStreamPath, createBus } from "../src/bus.js";

test("receipt trace roots and initial queue timing survive restart, duplicate admission and append-success/lost-ack", async (context) => {
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
  try {
    let client = (await setupTest(context, bus.registry)).client;
    let session = bus.attach(client)(scope);
    const first = await session.admit(
      {
        clientMutationId: "causal-first",
        text: "private-message-causality-canary",
      },
      { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` },
    );
    const second = await session.admit({
      clientMutationId: "causal-second",
      text: "different private message",
    });
    const initialTiming = await session.timing(first.id);
    expect(initialTiming.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(initialTiming.traceId).not.toBe("a".repeat(32));
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
  const roots = spans.filter(
    (span) => span.name === "computah.bus.admit" && !span.parentSpanId,
  );
  expect(roots).toHaveLength(2);
  expect(new Set(roots.map((span) => span.traceId)).size).toBe(2);
  expect(
    roots.some((span) =>
      span.links.some(
        (link) =>
          link.traceId === "a".repeat(32) && link.spanId === "b".repeat(16),
      ),
    ),
  ).toBe(true);
  const appends = spans.filter(
    (span) => span.name === "computah.bus.stream.append",
  );
  expect(appends.length).toBeGreaterThanOrEqual(3);
  expect(
    appends.every((span) =>
      roots.some(
        (root) =>
          span.traceId === root.traceId && span.parentSpanId === root.spanId,
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
  const deliveries: {
    traceId: string;
    spanId: string;
    body: { stringValue: string };
  }[] = logged
    .flatMap((body) =>
      JSON.parse(body).resourceLogs.flatMap(
        (resource: { scopeLogs: { logRecords: unknown[] }[] }) =>
          resource.scopeLogs.flatMap((scope) => scope.logRecords),
      ),
    )
    .filter((record) => record.body.stringValue === "bus.delivery");
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
