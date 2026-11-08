import assert from "node:assert/strict";
import test, { after } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { sanitizeTraces } from "../src/index.js";
import { createRuntimeLogger, type RuntimeLogFields } from "../src/logs.js";

const sink = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(sink)],
});
provider.register();
after(() => provider.shutdown());
const config = {
  service: "backend" as const,
  token: "synthetic-token-not-real",
  dataset: "test-logs",
};

test("structured logs preserve active correlation and approved scalars, never arbitrary content", async () => {
  let payload = "";
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (url, init) => {
      assert.equal(url, "https://api.axiom.co/v1/logs");
      assert.equal(init?.redirect, "error");
      payload = String(init?.body);
      return new Response("{}");
    },
  });
  const parent = provider.getTracer("test").startSpan("computah.synthetic");
  const { context, trace } = await import("@opentelemetry/api");
  const secret = "private-history-credential-reasoning-canary";
  const logId = context.with(trace.setSpan(context.active(), parent), () =>
    logger.emit(
      "runtime.cancelled",
      {
        outcome: "cancelled",
        operation: "model",
        reason: secret,
        attempt: 3,
        count: -1,
        duration_ms: 17.5,
        status_code: Number.NaN,
        resumed: false,
        prompt: secret,
        token: secret,
        "log.id": secret,
        traceId: secret,
      } as unknown as RuntimeLogFields,
      "warn",
    ),
  );
  assert.ok(logId);
  assert.equal(logger.emit(secret as "runtime.ready"), undefined);
  assert.equal(
    logger.emit(
      "runtime.ready",
      new Proxy(
        {},
        {
          get() {
            throw new Error(secret);
          },
        },
      ),
    ),
    undefined,
  );
  const result = await logger.close();
  const parsed = JSON.parse(payload);
  const row = parsed.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(row.traceId, parent.spanContext().traceId);
  assert.equal(row.spanId, parent.spanContext().spanId);
  assert.equal(row.body.stringValue, "runtime.cancelled");
  assert.equal(row.severityNumber, 13);
  assert.deepEqual(row.attributes, [
    { key: "outcome", value: { stringValue: "cancelled" } },
    { key: "operation", value: { stringValue: "model" } },
    { key: "attempt", value: { doubleValue: 3 } },
    { key: "duration_ms", value: { doubleValue: 17.5 } },
    { key: "resumed", value: { boolValue: false } },
    { key: "log.id", value: { stringValue: logId } },
  ]);
  assert.ok(!payload.includes(secret));
  assert.ok(!payload.includes(config.token));
  assert.equal(result.exported, 1);
  assert.equal(result.rejected, 2);
  const exported = sink.getFinishedSpans().at(-1);
  assert.ok(exported);
  const sanitized = sanitizeTraces(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: exported.name,
                  traceId: exported.spanContext().traceId,
                  spanId: exported.spanContext().spanId,
                  status: exported.status,
                  links: exported.links.map((link) => ({
                    traceId: link.context.traceId,
                    spanId: link.context.spanId,
                  })),
                },
              ],
            },
          ],
        },
      ],
    },
    "backend",
  );
  assert.ok(JSON.stringify(sanitized).includes(parent.spanContext().spanId));
  assert.equal(exported.attributes.outcome, "success");
  parent.end();
});

test("queue includes in-flight records, drops newest on overload, batches serially and closes admission", async () => {
  const batches: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (_, init) => {
      const records = JSON.parse(String(init?.body)).resourceLogs[0]
        .scopeLogs[0].logRecords;
      batches.push(records.length);
      if (batches.length === 1) await gate;
      return new Response("{}");
    },
  });
  logger.emit("runtime.ready");
  const early = logger.flush();
  for (let i = 0; i < 511; i++)
    assert.ok(logger.emit("runtime.report", { count: i }));
  assert.equal(logger.emit("runtime.report"), undefined);
  assert.equal(logger.stats().queued, 512);
  const closing = logger.close();
  assert.equal(logger.emit("runtime.stopped"), undefined);
  release();
  await early;
  const result = await closing;
  assert.deepEqual(batches, [1, 64, 64, 64, 64, 64, 64, 64, 63]);
  assert.equal(result.exported, 512);
  assert.equal(result.failed, 0);
  assert.equal(result.dropped, 1);
  assert.equal(result.queued, 0);
  assert.deepEqual(await logger.close(), result);
});

test("HTTP, network, partial rejection, malformed and oversized responses settle without retries", async () => {
  for (const response of [
    () => new Response("private-provider-error", { status: 503 }),
    () => {
      throw new Error("private-network-error");
    },
    () =>
      new Response(
        '{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"private"}}',
      ),
    () => new Response("null"),
    () => new Response("x".repeat(4097)),
  ]) {
    let calls = 0;
    const logger = createRuntimeLogger({
      ...config,
      fetch: async () => {
        calls++;
        return response();
      },
    });
    logger.emit("runtime.report", { outcome: "error" }, "error");
    const result = await logger.flush();
    assert.equal(result.failed, 1);
    assert.equal(result.exported, 0);
    assert.equal(result.queued, 0);
    await logger.close();
    assert.equal(calls, 1);
  }
  // Sanitized export keeps telemetry operation lifetime/outcome without error text.
  const spans = sink
    .getFinishedSpans()
    .filter(
      (span) =>
        span.name === "computah.logs.export" &&
        span.status.code === SpanStatusCode.ERROR,
    );
  assert.ok(spans.length >= 5);
  const sanitized = sanitizeTraces(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: spans.map((span) => ({
                traceId: span.spanContext().traceId,
                spanId: span.spanContext().spanId,
                name: span.name,
                status: span.status,
                attributes: Object.entries(span.attributes).map(
                  ([key, value]) => ({ key, value: { stringValue: value } }),
                ),
              })),
            },
          ],
        },
      ],
    },
    "backend",
  );
  const encoded = JSON.stringify(sanitized);
  assert.ok(encoded.includes('"stringValue":"error"'));
  assert.ok(!encoded.includes("private"));
});

test("batch deadline aborts even a stalled transport and automatic flushing needs no caller", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let signal: AbortSignal | null | undefined;
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (_, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
  });
  logger.emit("runtime.recovery", { outcome: "timeout", resumed: true });
  t.mock.timers.tick(1000);
  assert.ok(signal);
  const closing = logger.close();
  t.mock.timers.tick(5000);
  const result = await closing;
  assert.equal(signal.aborted, true);
  assert.equal(result.failed, 1);
  assert.equal(result.queued, 0);
  const span = sink.getFinishedSpans().at(-1);
  assert.equal(span?.attributes.outcome, "timeout");
});

test("missing or invalid protected configuration disables collection with no ambient token fallback", async () => {
  for (const options of [
    { token: "", dataset: "test-logs" },
    { token: "test", dataset: "" },
    { token: "test", dataset: "https://private.invalid" },
  ]) {
    const logger = createRuntimeLogger({
      service: "bus",
      ...options,
      fetch: async () => {
        assert.fail("disabled logger sent data");
      },
    });
    assert.equal(logger.emit("runtime.ready"), undefined);
    const stats = await logger.close();
    assert.equal(stats.enabled, false);
    assert.equal(stats.accepted, 0);
  }
});
