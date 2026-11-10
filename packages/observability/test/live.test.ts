import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LiveSpanProcessor } from "../src/live.js";

test("SDK live operations arrive before completion, update, then settle without private data", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const sent: { records: Record<string, unknown>[] }[] = [];
  const processor = new LiveSpanProcessor(
    "backend",
    () => "runtime.operation",
    {
      url: "https://test.invalid/api/ingest",
      token: "test-only-token-not-a-real-credential",
    },
    (async (_url, request) => {
      sent.push(JSON.parse(request?.body as string));
      return new Response("{}");
    }) as typeof fetch,
  );
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("test").startSpan("PRIVATE-CANARY", {
    startTime: new Date(Date.now()),
    attributes: { prompt: "PRIVATE-CANARY", credential: "PRIVATE-CANARY" },
    links: [
      {
        context: {
          traceId: "1234567890abcdef1234567890abcdef",
          spanId: "1111111111111111",
          traceFlags: 1,
        },
        attributes: { content: "PRIVATE-CANARY" },
      },
    ],
  });
  await processor.forceFlush();
  const first = sent[0]?.records[0];
  assert.equal(first?.lifecycle, "active");
  assert.equal(first?.revision, 1);
  assert.deepEqual(first?.links, [
    {
      trace_id: "1234567890abcdef1234567890abcdef",
      span_id: "1111111111111111",
    },
  ]);
  t.mock.timers.tick(5000);
  await processor.forceFlush();
  assert.ok(
    sent.some((batch) =>
      batch.records.some(
        (record) =>
          (record.revision as number) > 1 && record.lifecycle === "active",
      ),
    ),
  );
  span.setStatus({ code: SpanStatusCode.ERROR, message: "PRIVATE-CANARY" });
  span.end(new Date(Date.now()));
  t.mock.timers.tick(5000);
  await processor.forceFlush();
  await provider.shutdown();
  const last = sent.at(-1)?.records[0];
  assert.equal(last?.lifecycle, "ended");
  assert.equal(last?.["status.code"], "ERROR");
  assert.equal(last?.trace_id, first?.trace_id);
  assert.equal(last?.span_id, first?.span_id);
  assert.ok((last?.duration_ms as number) >= 1000);
  assert.ok(!JSON.stringify(sent).includes("PRIVATE-CANARY"));
});

test("live delivery failure and invalid configuration never fail application work", async () => {
  const disabled = new LiveSpanProcessor("backend", () => "runtime.operation", {
    url: "not a url",
    token: "test",
  });
  await disabled.shutdown();
  const processor = new LiveSpanProcessor(
    "backend",
    () => "runtime.operation",
    {
      url: "https://test.invalid/api/ingest",
      token: "test-only-token-not-a-real-credential",
    },
    (async () => {
      throw new Error("PRIVATE-transport");
    }) as typeof fetch,
  );
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("test").startSpan("test");
  span.end();
  await provider.shutdown();
});

test("link-heavy bursts fit receiver byte limits without discarding unsent records", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const ended = new Set<string>();
  const processor = new LiveSpanProcessor(
    "backend",
    () => "runtime.operation",
    {
      url: "https://test.invalid/api/ingest",
      token: "test-only-token-not-a-real-credential",
    },
    (async (_url, request) => {
      const body = request?.body as string;
      assert.ok(Buffer.byteLength(body) <= 128 * 1024);
      for (const record of JSON.parse(body).records)
        if (record.lifecycle === "ended") ended.add(record.span_id);
      return new Response("{}");
    }) as typeof fetch,
  );
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  for (let index = 0; index < 128; index++) {
    provider
      .getTracer("test")
      .startSpan("test", {
        links: Array.from({ length: 32 }, () => ({
          context: {
            traceId: "1234567890abcdef1234567890abcdef",
            spanId: "1111111111111111",
            traceFlags: 1,
          },
        })),
      })
      .end();
  }
  for (let index = 0; index < 8; index++) {
    t.mock.timers.tick(5000);
    await processor.forceFlush();
  }
  assert.equal(ended.size, 128);
  await provider.shutdown();
});

test("sustained starts, ends and SDK flushes share a five-second request budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const starts: number[] = [];
  const ended = new Set<string>();
  const processor = new LiveSpanProcessor(
    "backend",
    () => "runtime.operation",
    { url: "https://test.invalid/api/ingest", token: "test-only-token" },
    (async (_url, init) => {
      starts.push(Date.now());
      const body = init?.body as string;
      assert.ok(Buffer.byteLength(body) < 128 * 1024);
      const records = JSON.parse(body).records;
      assert.ok(records.length <= 128);
      for (const record of records)
        if (record.lifecycle === "ended") ended.add(record.span_id);
      return new Response(null);
    }) as typeof fetch,
  );
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("budget");
  for (let index = 0; index < 6000; index++) {
    tracer.startSpan("short").end();
    t.mock.timers.tick(100);
    await processor.forceFlush();
  }
  t.mock.timers.tick(5000);
  await processor.forceFlush();
  assert.equal(ended.size, 6000);
  assert.ok(starts.length <= 121);
  for (let index = 1; index < starts.length; index++)
    assert.ok(starts[index] - starts[index - 1] >= 5000);
  await provider.shutdown();
  const count = starts.length;
  t.mock.timers.tick(60_000);
  await processor.forceFlush();
  assert.equal(starts.length, count);
});

for (const failure of ["503", "429", "throw"] as const) {
  test(`live ${failure} backs off and recovers active-to-ended delivery`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
    const start = Date.now();
    const attempts: number[] = [];
    const delivered: Record<string, unknown>[] = [];
    let healthy = false;
    let endDuringRequest = () => {};
    const processor = new LiveSpanProcessor(
      "backend",
      () => "runtime.operation",
      { url: "https://test.invalid/api/ingest", token: "test-only-token" },
      ((_url, init) => {
        attempts.push(Date.now() - start);
        endDuringRequest();
        if (!healthy && failure === "throw") throw new Error("private-error");
        if (healthy)
          delivered.push(
            ...JSON.parse(init?.body as string).records.map(
              (record: Record<string, unknown>) => ({
                ...record,
                receivedAt: Date.now(),
              }),
            ),
          );
        return Promise.resolve(
          new Response(null, { status: healthy ? 200 : Number(failure) }),
        );
      }) as typeof fetch,
    );
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("recovery");
    const span = tracer.startSpan("long");
    endDuringRequest = () => {
      if (!healthy) return;
      span.end();
      endDuringRequest = () => {};
    };
    for (let index = 0; index < 600; index++) {
      tracer.startSpan("short").end();
      t.mock.timers.tick(1000);
      await processor.forceFlush();
    }
    assert.deepEqual(attempts, [1000, 11000, 31000, 71000, 151000, 311000]);
    healthy = true;
    t.mock.timers.tick(11_000);
    await processor.forceFlush();
    assert.equal(attempts.at(-1), 611000);
    t.mock.timers.tick(5000);
    await processor.forceFlush();
    assert.equal(attempts.at(-1), 616000);
    const observations = delivered.filter(
      (record) => record.span_id === span.spanContext().spanId,
    );
    assert.deepEqual(
      observations.map((record) => record.lifecycle),
      ["active", "ended"],
    );
    assert.ok(
      (observations[1].revision as number) >
        (observations[0].revision as number),
    );
    assert.equal(observations[1].trace_id, span.spanContext().traceId);
    assert.ok(
      delivered.every(
        (record) =>
          (record.receivedAt as number) - (record.observed_at as number) <=
          25_000,
      ),
    );
    await provider.shutdown();
  });
}

test("an end queued during a failed request replaces the retried active revision", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  let rejectRequest = (_error: Error) => {};
  const delivered: Record<string, unknown>[] = [];
  let attempts = 0;
  const processor = new LiveSpanProcessor(
    "backend",
    () => "runtime.operation",
    { url: "https://test.invalid/api/ingest", token: "test-only-token" },
    (async (_url, init) => {
      if (++attempts === 1)
        return new Promise<Response>((_resolve, reject) => {
          rejectRequest = reject;
        });
      delivered.push(...JSON.parse(init?.body as string).records);
      return new Response(null);
    }) as typeof fetch,
  );
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("race").startSpan("long");
  const first = processor.forceFlush();
  await new Promise(setImmediate);
  span.end();
  rejectRequest(new Error("private-transport-error"));
  await first;
  await processor.forceFlush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(10_000);
  await processor.forceFlush();
  assert.equal(attempts, 2);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].lifecycle, "ended");
  assert.equal(delivered[0].revision, 2);
  assert.equal(delivered[0].span_id, span.spanContext().spanId);
  await provider.shutdown();
});
