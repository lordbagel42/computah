import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedJson,
  Collector,
  DIAGNOSTIC_QUERY,
  ENDPOINT,
  includeExporter,
  QUERY,
} from "../src/collector.ts";
import { LIMIT, project, readTable } from "../src/projection.ts";
import { Telemetry } from "../src/telemetry.ts";

const secret = "synthetic-public-identifier-secret-for-tests";
const trace = "1234567890abcdef1234567890abcdef";
const root = "1111111111111111";
const child = "2222222222222222";
const row = (overrides: Record<string, unknown> = {}) => ({
  _time: "2026-11-08T07:35:37.784Z",
  trace_id: trace,
  span_id: root,
  parent_span_id: null,
  name: "computah.http",
  "service.name": "computah-backend",
  duration_ms: 13.847,
  "status.code": "OK",
  error: null,
  links: [],
  ...overrides,
});
function envelope(rows: Record<string, unknown>[], partial = false) {
  const keys = Object.keys(rows[0] ?? row());
  return {
    status: { isPartial: partial },
    tables: [
      {
        fields: keys.map((name) => ({ name })),
        columns: keys.map((key) => rows.map((item) => item[key])),
      },
    ],
  };
}

test("public projection retains timing and true topology without private content or raw correlation keys", () => {
  const privateText = "CANARY-private-user-prompt-token-url";
  const spans = project(
    [
      row({
        attributes: { prompt: privateText },
        resources: privateText,
        events: [{ name: privateText }],
        error: false,
      }),
      row({
        span_id: child,
        parent_span_id: root,
        "status.code": "ERROR",
        error: true,
        "status.message": privateText,
        links: [{ trace_id: trace, span_id: root, attributes: privateText }],
      }),
      row({
        span_id: "3333333333333333",
        parent_span_id: "4444444444444444",
        name: privateText,
        "service.name": privateText,
      }),
    ],
    secret,
  );
  assert.equal(spans.length, 3);
  assert.equal(spans[1]?.parentState, "present");
  assert.equal(spans[1]?.parentId, spans[0]?.id);
  assert.deepEqual(spans[1]?.links, [
    { id: spans[0]?.id, traceId: spans[0]?.traceId, present: true },
  ]);
  assert.equal(spans[2]?.parentState, "missing");
  assert.equal(spans[2]?.name, "runtime.operation");
  assert.equal(spans[2]?.service, "runtime");
  assert.equal(spans[1]?.status, "error");
  assert.equal(spans[0]?.start, 1794123337784);
  assert.equal(spans[0]?.durationMs, 13.847);
  const serialized = JSON.stringify(spans);
  for (const forbidden of [
    privateText,
    trace,
    root,
    child,
    "attributes",
    "resources",
    "events",
    "status.message",
  ])
    assert.ok(!serialized.includes(forbidden));
  assert.notEqual(project([row()], `${secret}-rotated`)[0]?.id, spans[0]?.id);
  assert.equal(
    project([row({ trace_id: trace.toUpperCase() })], secret)[0]?.id,
    spans[0]?.id,
  );
});

test("unknown, malformed and absent causal information never becomes invented ancestry", () => {
  const spans = project(
    [
      row({ parent_span_id: "malformed" }),
      row({ span_id: child, parent_span_id: child, "status.code": null }),
      row({ span_id: "3333333333333333", parent_span_id: "0000000000000000" }),
    ],
    secret,
  );
  assert.equal(spans[0]?.parentState, "missing");
  assert.equal(spans[0]?.parentId, null);
  assert.equal(spans[1]?.parentState, "missing");
  assert.equal(spans[1]?.status, "unset");
  assert.equal(spans[2]?.parentState, "root");
  assert.deepEqual(
    project(
      [
        row({ duration_ms: -1 }),
        row({ trace_id: "0".repeat(32) }),
        row({ _time: "invalid" }),
      ],
      secret,
    ),
    [],
  );
});

test("tabular parsing is aligned, bounded and honest about truncation", () => {
  assert.deepEqual(readTable(envelope([row()])), {
    rows: [row()],
    partial: false,
  });
  assert.equal(readTable(envelope([row()], true)).partial, true);
  assert.equal(
    readTable(envelope(Array.from({ length: LIMIT + 5 }, () => row()))).rows
      .length,
    LIMIT + 1,
  );
  assert.throws(() => readTable({ tables: [] }));
  assert.throws(() =>
    readTable({
      status: { isPartial: false },
      tables: [{ fields: [{ name: "a" }, { name: "b" }], columns: [[1], []] }],
    }),
  );
});

test("collector shares one fixed query across visitors, backs off and preserves stale data on failure", async () => {
  let now = Date.parse("2026-11-08T07:40:00Z");
  let requests = 0;
  let fail = false;
  const transport: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(url, ENDPOINT);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.apl, QUERY);
    assert.equal(Date.parse(body.endTime) - Date.parse(body.startTime), 900000);
    if (fail) throw new Error("PRIVATE-token-error-body");
    return Response.json(envelope([row()]));
  };
  const collector = new Collector(
    { token: "private-query-token", secret },
    transport,
    () => now,
  );
  const [first, concurrent] = await Promise.all([
    collector.get(),
    collector.get(),
  ]);
  assert.equal(requests, 1);
  assert.equal(first, concurrent);
  assert.equal(first.state, "live");
  assert.equal(first.spans.length, 1);
  await collector.get();
  assert.equal(requests, 1);
  now += 5001;
  fail = true;
  const disconnected = await collector.get();
  assert.equal(disconnected.state, "disconnected");
  assert.equal(disconnected.fetchedAt, first.fetchedAt);
  assert.deepEqual(disconnected.spans, first.spans);
  assert.ok(!JSON.stringify(disconnected).includes("PRIVATE"));
  now += 5001;
  await collector.get();
  assert.equal(requests, 2);
  now += 5001;
  fail = false;
  assert.equal((await collector.get()).state, "live");
  assert.equal(requests, 3);
});

test("unconfigured collector makes no network calls and bounded body consumption rejects overflow", async () => {
  const collector = new Collector({}, async () => {
    throw new Error("must not fetch");
  });
  assert.equal((await collector.get()).state, "unconfigured");
  await assert.rejects(boundedJson(new Response("x".repeat(101)), 100));
});

test("exporter diagnostics are an explicit fixed query, isolated from the default cache", async () => {
  assert.equal(
    includeExporter(new URL("https://example.test/api/traces")),
    false,
  );
  assert.equal(
    includeExporter(
      new URL("https://example.test/api/traces?includeExporter=1"),
    ),
    true,
  );
  for (const query of [
    "?includeExporter=0",
    "?includeExporter=1&apl=private",
    "?includeExporter=1&includeExporter=1",
    "?apl=private",
  ])
    assert.equal(
      includeExporter(new URL(`https://example.test/api/traces${query}`)),
      null,
    );
  assert.ok(QUERY.includes("isnull(name) or name != 'computah.logs.export'"));
  assert.ok(
    QUERY.indexOf("name != 'computah.logs.export'") < QUERY.indexOf("| take"),
  );
  assert.ok(!DIAGNOSTIC_QUERY.includes("name !="));
  const calls: string[] = [];
  let fail = false;
  const transport: typeof fetch = async (_url, options) => {
    const apl = JSON.parse(String(options?.body)).apl;
    calls.push(apl);
    if (fail) throw new Error("private");
    return Response.json(
      envelope(
        [
          row({
            name: apl === QUERY ? "computah.http" : "computah.logs.export",
            "status.code": "ERROR",
          }),
        ],
        true,
      ),
    );
  };
  const normal = new Collector({ token: "synthetic", secret }, transport);
  const diagnostics = new Collector(
    { token: "synthetic", secret, includeExporter: true },
    transport,
  );
  const first = await normal.get();
  assert.equal(first.spans[0]?.name, "computah.http");
  assert.equal(first.spans[0]?.status, "error");
  assert.equal(first.truncated, true);
  fail = true;
  const disconnected = await diagnostics.get();
  assert.equal(disconnected.state, "disconnected");
  assert.deepEqual(disconnected.spans, []);
  assert.equal(await normal.get(), first);
  assert.deepEqual(calls, [QUERY, DIAGNOSTIC_QUERY]);
  fail = false;
  const included = await new Collector(
    { token: "synthetic", secret, includeExporter: true },
    transport,
  ).get();
  assert.equal(included.spans[0]?.name, "computah.logs.export");
  assert.equal(included.spans[0]?.status, "error");
});

test("safe exporter records actual poll outcomes under the initiating HTTP trace and fails open", async () => {
  const exported: {
    resourceSpans: {
      resource: unknown;
      scopeSpans: { spans: Record<string, unknown>[] }[];
    }[];
  }[] = [];
  const telemetry = new Telemetry(
    "synthetic-ingest-only",
    async (_url, options) => {
      exported.push(JSON.parse(String(options?.body)));
      return new Response(null, { status: 503 });
    },
  );
  const http = telemetry.start("computah.observatory.http");
  const collector = new Collector(
    { token: "synthetic-query-only", secret },
    async () => Response.json(envelope([row()])),
    Date.now,
    telemetry,
  );
  assert.equal((await collector.get(http.span)).state, "live");
  await http.end("ready");
  const poll = exported[0]?.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.equal(poll?.name, "computah.observatory.poll");
  assert.equal(poll?.traceId, http.span.traceId);
  assert.equal(poll?.parentSpanId, http.span.spanId);
  assert.deepEqual(poll?.status, { code: 1 });
  assert.deepEqual(poll?.attributes, [
    { key: "outcome", value: { stringValue: "ready" } },
    { key: "telemetry.dropped", value: { intValue: "0" } },
  ]);
  const failing = new Collector(
    { token: "synthetic-query-only", secret },
    async () => {
      throw new Error("PRIVATE-url-token");
    },
    Date.now,
    telemetry,
  );
  assert.equal((await failing.get(http.span)).state, "disconnected");
  const failure = exported[2]?.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.deepEqual(failure?.status, { code: 2 });
  assert.equal(failure?.parentSpanId, http.span.spanId);
  const cancelled = telemetry.start("computah.observatory.http");
  await cancelled.end("cancelled");
  assert.ok(!JSON.stringify(exported).includes("PRIVATE"));
  assert.ok(!JSON.stringify(exported).includes("synthetic-query-only"));
});

test("query deadline aborts body transport and exports timeout without private errors", async () => {
  const outcomes: unknown[] = [];
  const telemetry = new Telemetry(
    "synthetic-ingest-only",
    async (_url, options) => {
      outcomes.push(JSON.parse(String(options?.body)));
      return new Response(null);
    },
  );
  const collector = new Collector(
    { token: "synthetic-query-only", secret },
    async (_url, options) =>
      new Promise((_resolve, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE-abort")),
          { once: true },
        ),
      ),
    Date.now,
    telemetry,
  );
  assert.equal((await collector.get()).state, "disconnected");
  assert.ok(JSON.stringify(outcomes).includes('"stringValue":"timeout"'));
  assert.ok(!JSON.stringify(outcomes).includes("PRIVATE"));
});

test("visitor telemetry has a global time budget, reports dropped spans and cannot pollute the feed", async () => {
  let now = 10_000;
  const payloads: string[] = [];
  const telemetry = new Telemetry(
    "synthetic-ingest-only",
    async (_url, options) => {
      payloads.push(String(options?.body));
      return new Response(null);
    },
    () => now,
  );
  for (let index = 0; index < 30; index++)
    await telemetry.start("computah.observatory.http").end("ready");
  assert.equal(payloads.length, 8);
  now += 5000;
  await telemetry.start("computah.observatory.http").end("ready");
  assert.equal(payloads.length, 9);
  assert.ok(payloads[8]?.includes('"intValue":"22"'));
  assert.ok(
    QUERY.indexOf("['service.name'] != 'computah-observatory'") <
      QUERY.indexOf("| project"),
  );
});
