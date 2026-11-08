import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Effect } from "effect";
import { effectTracing } from "../src/effect.js";
import {
  sanitizeTraces,
  startObservability,
  traceEvent,
  traceHttp,
  traceOperation,
} from "../src/index.js";

test("OTLP export preserves native relationships and outcomes but removes content and identities", () => {
  const secret = "private-content-not-exportable";
  const traceId = "a".repeat(32);
  const spanId = "b".repeat(16);
  const output = sanitizeTraces(
    {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "host.name", value: { stringValue: secret } }],
          },
          scopeSpans: [
            {
              scope: { name: secret },
              spans: [
                {
                  name: "pi.durable.phase",
                  traceId,
                  spanId,
                  parentSpanId: "c".repeat(16),
                  startTimeUnixNano: "123456789",
                  endTimeUnixNano: "223456789",
                  kind: 1,
                  status: { code: 2, message: secret },
                  attributes: [
                    { key: "rivet.actor.id", value: { stringValue: secret } },
                    { key: "prompt", value: { stringValue: secret } },
                    { key: "tool.arguments", value: { stringValue: secret } },
                    {
                      key: "http.response.status_code",
                      value: { intValue: "503" },
                    },
                    { key: "outcome", value: { stringValue: "faulted" } },
                    { key: "tool.name", value: { stringValue: secret } },
                  ],
                  events: [
                    {
                      name: secret,
                      timeUnixNano: "123456790",
                      attributes: [
                        {
                          key: "exception.message",
                          value: { stringValue: secret },
                        },
                      ],
                    },
                  ],
                  links: [
                    {
                      traceId,
                      spanId,
                      traceState: secret,
                      attributes: [
                        { key: "user", value: { stringValue: secret } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    "backend",
    "d".repeat(40),
  );
  const encoded = JSON.stringify(output);
  assert.ok(!encoded.includes(secret));
  assert.ok(!encoded.includes("rivet.actor.id"));
  const span = output.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
  assert.equal(span?.traceId, traceId);
  assert.equal(span?.parentSpanId, "c".repeat(16));
  assert.equal(span?.name, "pi.durable.phase");
  assert.equal(span?.startTimeUnixNano, "123456789");
  assert.deepEqual(span?.status, { code: 2 });
  assert.deepEqual(span?.attributes, [
    { key: "http.response.status_code", value: { doubleValue: 503 } },
    { key: "outcome", value: { stringValue: "faulted" } },
  ]);
});

test("SDK, Effect, HTTP and native JSON spans pass through one relay; sink failure does not fail application work", async () => {
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  let fail = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      exported.push(String(init?.body));
      return new Response("{}", { status: fail ? 503 : 200 });
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-private-credential";
  const telemetry = await startObservability("backend");
  const http = createServer(async (_request, response) => {
    await traceOperation("submit", async () => 42);
    response.writeHead(204).end();
  });
  traceHttp(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(
      (
        await originalFetch(
          `http://127.0.0.1:${address.port}/private-path?token=private-content`,
        )
      ).status,
      204,
    );
    await Effect.runPromise(
      Effect.succeed(42).pipe(
        Effect.withSpan("computah.history"),
        Effect.provide(effectTracing),
      ),
    );
    traceEvent("synthetic", {
      requested: "priority",
      prompt: "private-content",
    });
    const native = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "pi.durable.submit",
                  traceId: "1".repeat(32),
                  spanId: "2".repeat(16),
                  startTimeUnixNano: "1",
                  endTimeUnixNano: "2",
                },
              ],
            },
          ],
        },
      ],
    };
    const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    assert.ok(endpoint);
    const result = await originalFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(native),
    });
    assert.equal(result.status, 200);
    fail = true;
    assert.equal(await traceOperation("cancel", async () => 17), 17);
    assert.equal(
      (
        await originalFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(native),
        })
      ).status,
      503,
    );
    fail = false;
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  }
  const spans = exported.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: {
        scopeSpans: {
          spans: {
            name: string;
            traceId: string;
            spanId: string;
            parentSpanId?: string;
          }[];
        }[];
      }) => r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  for (const name of [
    "computah.http",
    "computah.submit",
    "computah.history",
    "computah.synthetic",
    "pi.durable.submit",
  ])
    assert.ok(
      spans.some((span) => span.name === name),
      `missing ${name}`,
    );
  const httpSpan = spans.find((span) => span.name === "computah.http");
  const submitSpan = spans.find((span) => span.name === "computah.submit");
  assert.equal(submitSpan?.parentSpanId, httpSpan?.spanId);
  assert.ok(!exported.join().includes("private-content"));
  assert.ok(!exported.join().includes("synthetic-private-credential"));
});
