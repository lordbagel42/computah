import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LiveSpanProcessor } from "../src/live.js";

test("SDK live operations arrive before completion, update, then settle without private data", async () => {
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
  await new Promise((resolve) => setTimeout(resolve, 1100));
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
  span.end();
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

test("link-heavy bursts fit receiver byte limits without discarding unsent records", async () => {
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
  await processor.forceFlush();
  assert.equal(ended.size, 128);
  await provider.shutdown();
});
