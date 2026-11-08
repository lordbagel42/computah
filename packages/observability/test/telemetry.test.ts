import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Effect } from "effect";
import { effectTracing } from "../src/effect.js";
import {
  createTraceCarrier,
  currentTraceHeaders,
  sanitizeTraces,
  startObservability,
  traceEvent,
  traceHttp,
  traceInterval,
  traceLifecycle,
  traceOperation,
  withTraceContext,
} from "../src/index.js";

test("durable carriers remain unique and restorable without telemetry enabled", async () => {
  const first = createTraceCarrier("slack.job");
  const second = createTraceCarrier("slack.job");
  assert.match(first.traceparent ?? "", /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  assert.notEqual(first.traceparent, second.traceparent);
  const child = createTraceCarrier("slack.job", [], first);
  assert.equal(
    child.traceparent?.split("-")[1],
    first.traceparent?.split("-")[1],
  );
  assert.notEqual(
    child.traceparent?.split("-")[2],
    first.traceparent?.split("-")[2],
  );
  const invalid = createTraceCarrier("slack.job", [], {
    traceparent: "invalid",
  });
  assert.notEqual(
    invalid.traceparent?.split("-")[1],
    first.traceparent?.split("-")[1],
  );
  assert.deepEqual(withTraceContext(first, currentTraceHeaders), first);
  await withTraceContext(second, async () => {
    await Promise.resolve();
    assert.deepEqual(currentTraceHeaders(), second);
    assert.deepEqual(
      withTraceContext({ traceparent: "invalid" }, currentTraceHeaders),
      {},
    );
    await traceOperation(
      "slack.admit",
      async () => assert.deepEqual(currentTraceHeaders(), first),
      first,
    );
    await traceOperation(
      "slack.admit",
      async () => assert.deepEqual(currentTraceHeaders(), {}),
      {},
    );
    for (const suffix of ["\n", "\r", "\r\n"])
      assert.deepEqual(
        withTraceContext(
          { traceparent: first.traceparent + suffix },
          currentTraceHeaders,
        ),
        {},
      );
  });
  assert.deepEqual(currentTraceHeaders(), {});
});

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
                    {
                      key: "computah.debugshare.id",
                      value: {
                        stringValue: "12b42dd4-8123-4234-9234-123456789abc",
                      },
                    },
                    {
                      key: "computah.debugshare.id",
                      value: {
                        stringValue: "computah_bug_abcd0123456789efghijklmn",
                      },
                    },
                    ...[
                      "computah_bug_abcd0123456789efghijklmno",
                      "computah_bug_Abcd0123456789efghijklmn",
                      "computah_bug_abcd0123456789efghijklmn\n",
                    ].map((stringValue) => ({
                      key: "computah.debugshare.id",
                      value: { stringValue },
                    })),
                    {
                      key: "computah.debugshare.id",
                      value: { stringValue: secret },
                    },
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
    {
      key: "computah.debugshare.id",
      value: { stringValue: "12b42dd4-8123-4234-9234-123456789abc" },
    },
    {
      key: "computah.debugshare.id",
      value: { stringValue: "computah_bug_abcd0123456789efghijklmn" },
    },
  ]);
});

test("SDK, Effect, HTTP and native JSON spans pass through one relay; sink failure does not fail application work", async () => {
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  const logs: string[] = [];
  let fail = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/logs") {
      logs.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (String(input) === "https://api.axiom.co/v1/traces") {
      exported.push(String(init?.body));
      return new Response("{}", { status: fail ? 503 : 200 });
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-private-credential";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "computah-prod-logs";
  const telemetry = await startObservability("backend");
  const http = createServer(async (_request, response) => {
    await traceOperation("submit", async () => 42);
    response.writeHead(204).end();
  });
  traceHttp(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  let caller: Record<string, string> = {};
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
    assert.deepEqual(currentTraceHeaders(), {});
    await traceOperation("slack.core", async () => {
      caller = currentTraceHeaders();
      assert.deepEqual(Object.keys(caller), ["traceparent"]);
      await originalFetch(`http://127.0.0.1:${address.port}/`, {
        headers: { ...caller, baggage: "private-content" },
      });
    });
    // Upstream sampling cannot disable our always-on collection.
    await originalFetch(`http://127.0.0.1:${address.port}/`, {
      headers: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-00` },
    });
    for (const traceparent of [
      `00-${"0".repeat(32)}-${"b".repeat(16)}-01`,
      `00-${"a".repeat(32)}-${"0".repeat(16)}-01`,
      "private-content",
      `${caller.traceparent}, ${caller.traceparent}`,
    ])
      await originalFetch(`http://127.0.0.1:${address.port}/`, {
        headers: { traceparent },
      });
    const failure = new Error("private-content");
    await assert.rejects(
      traceOperation("wait", async () => {
        throw failure;
      }),
      (error) => error === failure,
    );
    await assert.rejects(
      traceOperation("cancel", async (span) => {
        span.setAttribute("outcome", "cancelled");
        throw failure;
      }),
      (error) => error === failure,
    );
    await traceOperation("ready", async () => {
      assert.equal(await traceLifecycle("registry", async () => 73), 73);
      await assert.rejects(
        traceLifecycle("registry_drain", async () => {
          throw failure;
        }),
        (error) => error === failure,
      );
    });
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
    traceEvent("ready");
    await traceOperation("web.search", async (span) => {
      span.setAttribute("outcome", "not_configured").setStatus({ code: 2 });
      return { status: "unavailable", content: "private-content" };
    });
    await traceOperation("slack.step", async () => {
      const incoming = currentTraceHeaders();
      const job = createTraceCarrier("slack.job", [
        incoming,
        { traceparent: "invalid" },
      ]);
      assert.notEqual(
        job.traceparent?.split("-")[1],
        incoming.traceparent?.split("-")[1],
      );
      const child = createTraceCarrier("slack.admit", [], incoming);
      assert.equal(
        child.traceparent?.split("-")[1],
        incoming.traceparent?.split("-")[1],
      );
      await traceOperation(
        "slack.submit",
        async () => {
          assert.equal(
            currentTraceHeaders().traceparent?.split("-")[1],
            job.traceparent?.split("-")[1],
          );
          await Promise.resolve();
        },
        job,
      );
      traceInterval("slack.queue", 1700000000123, 1700000000987, job, {
        phase: "queue",
      });
      traceInterval("slack.queue", 20, 10, job);
      traceInterval("bus.receipt", 0, 100, job);
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
    delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
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
            status: { code: number };
            attributes: {
              key: string;
              value: {
                stringValue?: string;
                intValue?: string;
                doubleValue?: number;
              };
            }[];
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
  const httpSpans = spans.filter((span) => span.name === "computah.http");
  assert.equal(httpSpans.length, 7);
  assert.equal(httpSpans[1]?.traceId, caller.traceparent?.split("-")[1]);
  assert.equal(httpSpans[1]?.parentSpanId, caller.traceparent?.split("-")[2]);
  assert.equal(httpSpans[2]?.traceId, "a".repeat(32));
  assert.equal(httpSpans[2]?.parentSpanId, "b".repeat(16));
  for (const rejected of httpSpans.slice(3)) {
    assert.equal(rejected.parentSpanId, undefined);
    assert.notEqual(rejected.traceId, "a".repeat(32));
  }
  assert.equal(
    spans.find((span) => span.name === "computah.wait")?.status.code,
    2,
  );
  const lifecycle = spans.filter((span) => span.name === "computah.lifecycle");
  assert.equal(lifecycle.length, 2);
  const parent = spans.find((span) => span.name === "computah.ready");
  for (const [index, span] of lifecycle.entries()) {
    assert.equal(span.parentSpanId, parent?.spanId);
    assert.equal(span.traceId, parent?.traceId);
    const attrs = new Map<string, { stringValue?: string }>(
      span.attributes.map(
        (attr: { key: string; value: { stringValue?: string } }) => [
          attr.key,
          attr.value,
        ],
      ),
    );
    assert.equal(
      attrs.get("phase")?.stringValue,
      index === 0 ? "registry" : "registry_drain",
    );
    assert.equal(
      attrs.get("outcome")?.stringValue,
      index === 0 ? "success" : "error",
    );
    assert.ok(attrs.has("duration.ms"));
  }
  assert.equal(lifecycle[1]?.status.code, 2);
  const job = spans.find((span) => span.name === "computah.slack.job");
  const submitted = spans.find((span) => span.name === "computah.slack.submit");
  assert.ok(job);
  assert.equal(job.parentSpanId, undefined);
  const causal = spans.find((span) => span.name === "computah.slack.admit");
  const receive = spans.find((span) => span.name === "computah.slack.step");
  assert.equal(causal?.traceId, receive?.traceId);
  assert.equal(causal?.parentSpanId, receive?.spanId);
  assert.equal(submitted?.traceId, job.traceId);
  assert.equal(submitted?.parentSpanId, job.spanId);
  const intervals = spans.filter(
    (span) => span.name === "computah.slack.queue",
  );
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0]?.startTimeUnixNano, "1700000000123000000");
  assert.equal(intervals[0]?.endTimeUnixNano, "1700000000987000000");
  assert.equal(job.links.length, 1);
  assert.equal(
    job.links[0].spanId,
    spans.find((span) => span.name === "computah.slack.step")?.spanId,
  );
  const early = spans.find((span) => span.name === "computah.bus.receipt");
  assert.equal(early?.startTimeUnixNano, "0");
  assert.equal(early?.endTimeUnixNano, "100000000");
  type LogRecord = {
    body: { stringValue: string };
    traceId?: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const records: LogRecord[] = logs.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (r: { scopeLogs: { logRecords: LogRecord[] }[] }) =>
        r.scopeLogs.flatMap((s) => s.logRecords),
    ),
  );
  assert.ok(
    records.some((record) => record.body.stringValue === "runtime.ready"),
  );
  const unavailable = records.find((record) =>
    record.attributes.some(
      (a) => a.key === "operation" && a.value.stringValue === "web.search",
    ),
  );
  assert.ok(unavailable);
  assert.ok(
    unavailable.attributes.some(
      (a) => a.key === "outcome" && a.value.stringValue === "error",
    ),
  );
  assert.ok(
    unavailable.attributes.some(
      (a) => a.key === "reason" && a.value.stringValue === "not_configured",
    ),
  );
  assert.ok(unavailable.traceId);
  assert.ok(
    records.some((record) =>
      record.attributes.some(
        (a) => a.key === "outcome" && a.value.stringValue === "cancelled",
      ),
    ),
  );
  assert.ok(!logs.join().includes("private-content"));
  assert.ok(
    spans.some((span) => span.name === "computah.logs.export"),
    "log export spans must drain before provider shutdown",
  );
  assert.ok(!exported.join().includes("private-content"));
  assert.ok(!exported.join().includes("synthetic-private-credential"));
});
