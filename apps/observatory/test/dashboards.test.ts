import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DashboardCollector,
  projectPanel,
} from "../src/dashboard-collector.ts";
import {
  DASHBOARDS,
  dashboardQuery,
  parseDashboard,
} from "../src/dashboards.ts";
import { project } from "../src/projection.ts";
import { Telemetry } from "../src/telemetry.ts";

const secret = "synthetic-dashboard-identifier-secret-not-production";
const selection = (id: string, query = "") =>
  parseDashboard(new URL(`https://example/api/dashboards/${id}${query}`));
const envelope = (rows: Record<string, unknown>[], partial = false) => {
  const keys = Object.keys(rows[0] ?? {});
  return Response.json({
    status: { isPartial: partial },
    tables: [
      {
        fields: keys.map((name) => ({ name })),
        columns: keys.map((key) => rows.map((row) => row[key])),
      },
    ],
  });
};

test("seven inspected surfaces accept only their fixed public filters", () => {
  assert.deepEqual(
    DASHBOARDS.map((d) => d.id),
    [
      "turns",
      "dash",
      "health",
      "delivery",
      "models",
      "traces",
      "generative-ai",
    ],
  );
  for (const bad of [
    "?apl=print%20secret",
    "?service=computah-slack&service=computah-backend",
    "?revision=abc'%20%7C%20take%201",
    "?__proto__=secret",
    "?window=7d",
    "?model=private-model",
    "?status=error",
  ])
    assert.equal(selection("health", bad), null);
  const chosen = selection(
    "health",
    "?service=computah-slack&revision=abc123&window=1h",
  );
  assert.ok(chosen);
  const apl = dashboardQuery(chosen.dashboard.panels[0], chosen.filters);
  assert.match(apl, /\['service.name'\] == 'computah-slack'/);
  assert.match(apl, /startswith_cs 'abc123'/);
  assert.match(apl, /summarize arg_max/);
  assert.match(apl, /take 1001$/);
});

test("panel projection is positive, bounded, and shares opaque trace relationships with the horizon", () => {
  const turns = selection("turns");
  assert.ok(turns);
  const panel = turns.dashboard.panels[0];
  const trace = "1234567890abcdef1234567890abcdef";
  const rows = projectPanel(
    panel,
    [
      {
        _time: "2026-11-08T12:00:00Z",
        trace_id: trace,
        reply_state: "reply delivered",
        spans: 13,
        errors: 2,
        replies: 1,
        delivery_failures: 0,
        last_span: "2026-11-08T12:00:20Z",
        payload: "PRIVATE-CANARY",
        token: "PRIVATE-CANARY",
      },
    ],
    secret,
  );
  const spans = project(
    [
      {
        _time: "2026-11-08T12:00:00Z",
        trace_id: trace,
        span_id: "1111111111111111",
        duration_ms: 12,
      },
    ],
    secret,
  );
  assert.equal(rows[0].trace_id, spans[0].traceId);
  assert.equal(rows[0].spans, 13);
  assert.equal(rows[0].errors, 2);
  assert.doesNotMatch(
    JSON.stringify(rows),
    new RegExp(`${trace}|PRIVATE-CANARY|payload|token`),
  );
  const context = selection("generative-ai")?.dashboard.panels.find(
    (p) => p.id === "input-context",
  );
  assert.ok(context);
  const result = projectPanel(
    context,
    [
      {
        Model: "PRIVATE-CANARY",
        Agent: "worker",
        Context_pct: [
          { from: 5, to: 10, count: 3, secret: "PRIVATE-CANARY" },
          { from: 10, to: 20, count: "PRIVATE-CANARY" },
        ],
        P50_tokens: Infinity,
      },
    ],
    secret,
  )[0];
  assert.equal(result.Model, "other");
  assert.equal(result.P50_tokens, null);
  assert.deepEqual(result.Context_pct, [{ from: 5, to: 10, count: 3 }]);
  assert.equal(
    projectPanel(
      panel,
      Array.from({ length: 1002 }, () => ({ spans: 1 })),
      secret,
    ).length,
    1000,
  );
});

test("logs access fails closed without fallback; shared cache retains stale provenance on typed denial", async () => {
  const models = selection("models");
  assert.ok(models);
  const { dashboard, filters } = models;
  const panel = dashboard.panels[0];
  let now = 1794220800000,
    calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer dedicated-logs",
    );
    assert.equal(
      JSON.parse(String(init?.body)).endTime,
      new Date(Math.floor(now / 300000) * 300000).toISOString(),
    );
    return calls === 1
      ? envelope([{ Calls: 7 }])
      : new Response("private denial", { status: 403 });
  };
  const missing = new DashboardCollector(
    { traces: "must-not-be-used", secret },
    transport,
    () => now,
  );
  assert.equal((await missing.get(panel, filters)).state, "unconfigured");
  assert.equal(calls, 0);
  const collector = new DashboardCollector(
    { logs: "dedicated-logs", secret },
    transport,
    () => now,
  );
  const [a, b] = await Promise.all([
    collector.get(panel, filters),
    collector.get(panel, filters),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.deepEqual(a.rows, [{ Calls: 7 }]);
  now += 300001;
  const stale = await collector.get(panel, filters);
  assert.equal(stale.state, "unavailable");
  assert.equal(stale.fetchedAt, a.fetchedAt);
  assert.equal(stale.end, a.end);
  assert.deepEqual(stale.rows, a.rows);
  assert.equal((await collector.get(panel, filters)).state, "unavailable");
  assert.equal(calls, 2);
});

test("aggregate failure/recovery emits sanitized child lifetimes, never upstream text", async () => {
  const payloads: unknown[] = [];
  const telemetry = new Telemetry("synthetic-export", async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  });
  const parent = telemetry.start("computah.observatory.http");
  const health = selection("health");
  assert.ok(health);
  const { dashboard, filters } = health;
  let now = 1794220800000,
    fail = true;
  const collector = new DashboardCollector(
    { traces: "synthetic-query", secret },
    async () =>
      fail
        ? new Response("PRIVATE-CANARY", { status: 403 })
        : envelope([{ Spans: 4 }], true),
    () => now,
    telemetry,
  );
  assert.equal(
    (await collector.get(dashboard.panels[0], filters, parent.span)).state,
    "unavailable",
  );
  now += 30001;
  fail = false;
  assert.equal(
    (await collector.get(dashboard.panels[0], filters, parent.span)).state,
    "partial",
  );
  await parent.end("cancelled");
  const spans = (
    payloads as {
      resourceSpans: {
        scopeSpans: {
          spans: {
            traceId: string;
            parentSpanId?: string;
            status: { code: number };
            attributes: { key: string; value: { stringValue?: string } }[];
          }[];
        }[];
      }[];
    }[]
  ).flatMap((p) =>
    p.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
  );
  assert.equal(spans.length, 3);
  for (const span of spans.slice(0, 2)) {
    assert.equal(span.traceId, parent.span.traceId);
    assert.equal(span.parentSpanId, parent.span.spanId);
    assert.equal(span.status.code, 2);
  }
  assert.equal(spans[2].attributes[0].value.stringValue, "cancelled");
  assert.doesNotMatch(
    JSON.stringify(payloads),
    /PRIVATE-CANARY|synthetic-query|synthetic-export/,
  );
});

test("aggregate deadline aborts upstream work, exports timeout and permits recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const payloads: unknown[] = [];
  const telemetry = new Telemetry("synthetic-export", async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  });
  const health = selection("health");
  assert.ok(health);
  let now = 1794220800000;
  let started = 0;
  const collector = new DashboardCollector(
    { traces: "synthetic-query", secret },
    async (_url, init) => {
      if (++started > 1) return envelope([{ Spans: 9 }]);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("PRIVATE-CANARY")),
        );
      });
    },
    () => now,
    telemetry,
  );
  const pending = collector.get(health.dashboard.panels[0], health.filters);
  t.mock.timers.tick(8000);
  assert.equal((await pending).state, "unavailable");
  assert.match(JSON.stringify(payloads), /"stringValue":"timeout"/);
  assert.doesNotMatch(
    JSON.stringify(payloads),
    /PRIVATE-CANARY|synthetic-query/,
  );
  now += 30001;
  assert.deepEqual(
    (await collector.get(health.dashboard.panels[0], health.filters)).rows,
    [{ Spans: 9 }],
  );
});

test("aggregate concurrency and start budget stay bounded across arbitrary permitted filters", async () => {
  const health = selection("health");
  assert.ok(health);
  let now = 1794220800000,
    starts = 0;
  const release: (() => void)[] = [];
  const collector = new DashboardCollector(
    { traces: "synthetic", secret },
    async () => {
      starts++;
      await new Promise<void>((resolve) => release.push(resolve));
      return envelope([{ Spans: 2 }]);
    },
    () => now,
  );
  const filter = (revision: string) => ({ ...health.filters, revision });
  const pending = ["1000", "2000", "3000", "4000"].map((value) =>
    collector.get(health.dashboard.panels[0], filter(value)),
  );
  assert.equal(
    (await collector.get(health.dashboard.panels[0], filter("e"))).state,
    "busy",
  );
  assert.equal(starts, 4);
  for (const resolve of release.splice(0)) resolve();
  await Promise.all(pending);
  for (let i = 4; i < 60; i++) {
    const next = collector.get(
      health.dashboard.panels[0],
      filter(i.toString(16)),
    );
    release.shift()?.();
    assert.equal((await next).state, "ready");
  }
  assert.equal(starts, 60);
  assert.equal(
    (await collector.get(health.dashboard.panels[0], filter("fff"))).state,
    "busy",
  );
  now += 60001;
  const next = collector.get(health.dashboard.panels[0], filter("fff"));
  release.shift()?.();
  assert.equal((await next).state, "ready");
  assert.equal(starts, 61);
});
