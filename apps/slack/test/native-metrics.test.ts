import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startObservability } from "@computah/observability";
import { type Binding, SlackAdapter, type Transport } from "../src/adapter.js";

type ScalarPoint = {
  asDouble: number;
  startTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } }[];
};
type Metric = {
  name: string;
  gauge: { dataPoints: ScalarPoint[] };
  sum: { dataPoints: ScalarPoint[] };
  histogram: {
    aggregationTemporality: number;
    dataPoints: {
      count: string;
      sum: number;
      min: number;
      max: number;
      explicitBounds: number[];
      bucketCounts: string[];
    }[];
  };
};
type Span = {
  name: string;
  traceId: string;
  spanId: string;
  status: { code: number };
  attributes: { key: string; value: { stringValue?: string } }[];
  links: { traceId: string; spanId: string }[];
};
type TraceBatch = { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };

test("native metrics periodically export durable idle/stalled census, actual answer buckets and replay-safe terminal outcomes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "native-reply-metrics-"));
  const originalFetch = globalThis.fetch;
  const metrics: Metric[][] = [];
  const traces: TraceBatch[] = [];
  const logs: string[] = [];
  let failure = "none";
  let releaseExport = () => {};
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body);
    if (url.endsWith("/v1/metrics")) {
      assert.equal(url, "https://us-east-1.aws.edge.axiom.co/v1/metrics");
      assert.equal(
        new Headers(init?.headers).get("x-axiom-metrics-dataset"),
        "computah-prod-metrics",
      );
      metrics.push(JSON.parse(body).resourceMetrics[0].scopeMetrics[0].metrics);
      if (failure === "blocked")
        await new Promise<void>((resolve) => {
          releaseExport = resolve;
        });
      if (failure === "abort")
        throw new DOMException("private-canary", "AbortError");
      if (failure === "throw") throw new Error("private-canary");
      if (failure === "http") return new Response("{}", { status: 503 });
      if (failure === "oversize") return new Response("x".repeat(8193));
      return new Response(
        failure === "partial"
          ? '{"partialSuccess":{"rejectedDataPoints":"1"}}'
          : "{}",
      );
    }
    if (url.endsWith("/v1/logs")) logs.push(body);
    if (url.endsWith("/v1/traces")) traces.push(JSON.parse(body));
    return new Response("{}");
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-metrics-token";
  process.env.COMPUTAH_AXIOM_METRIC_DATASET = "computah-prod-metrics";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-metrics-logs";
  const telemetry = await startObservability("slack");
  const binding: Binding = {
    teamId: "TFAKE",
    slackUserId: "UFAKE",
    tenantId: "tenant-canary",
    userId: "owner-canary",
    agentId: "actor-canary",
    coreToken: "private-token-canary",
    channelIds: [],
  };
  let now = 0;
  let outcome = "completed";
  let ambiguous = false;
  let blocked = false;
  let release = () => {};
  let posts = 0;
  const transport: Transport = {
    async request(_binding, _path, body) {
      if (body) return { id: "submission-canary" };
      if (blocked)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        submission: { outcome },
        messages: [
          {
            role: "assistant",
            blocks: [{ kind: "text", text: "answer-canary" }],
          },
        ],
      };
    },
    async post() {
      posts++;
      if (ambiguous) throw new Error("send-canary");
    },
    async openDm() {
      return "DFAKE";
    },
    async status() {
      return "ok";
    },
  };
  const open = () =>
    new SlackAdapter(
      join(dir, "slack.sqlite"),
      [binding],
      "UBOT",
      transport,
      () => now,
      false,
      1000,
    );
  let adapter = open();
  const event = (id: string, text = "request-canary") => ({
    team_id: "TFAKE",
    event_id: id,
    event: {
      type: "message",
      channel_type: "im",
      channel: "DFAKE",
      user: "UFAKE",
      ts: `${id}.001`,
      text,
    },
  });
  const collect = async () => {
    const before = metrics.length;
    t.mock.timers.tick(10000);
    for (let i = 0; i < 50 && metrics.length === before; i++)
      await new Promise((r) => setImmediate(r));
    assert.equal(metrics.length, before + 1);
    // Join the exporter completion, not just the intercepted HTTP call.
    await new Promise((r) => setImmediate(r));
    return metrics[metrics.length - 1];
  };
  const gauge = (batch: Metric[]) =>
    batch.find((m) => m.gauge)?.gauge.dataPoints[0].asDouble;
  const totals = (batch: Metric[]) =>
    Object.fromEntries(
      (batch.find((m) => m.sum)?.sum.dataPoints ?? []).map((p) => [
        p.attributes[0].value.stringValue,
        p.asDouble,
      ]),
    );
  try {
    assert.equal(
      gauge(await collect()),
      0,
      "idle is a fresh zero, not no series",
    );
    adapter.admit(event("1"), 0);
    now = 100;
    adapter.admit(event("2"), 100);
    assert.equal(adapter.admit(event("1"), 999), "duplicate");
    now = 1100;
    await adapter.step();
    blocked = true;
    const wait = adapter.step();
    await new Promise((r) => setImmediate(r));
    assert.equal(
      gauge(await collect()),
      2,
      "blocked core cannot hide durable pending replies",
    );
    assert.equal(
      gauge(await collect()),
      2,
      "stalled gauge refreshes without ingress",
    );
    now = 5100;
    blocked = false;
    release();
    await wait;
    adapter.pumpReplyLatency();
    adapter.pumpReplyLatency();
    let batch = await collect();
    assert.equal(gauge(batch), 0);
    const histogram = batch.find((m) => m.histogram)?.histogram;
    assert.ok(histogram);
    assert.equal(histogram.aggregationTemporality, 1);
    const point = histogram.dataPoints[0];
    assert.equal(point.count, "2");
    assert.equal(point.sum, 10100);
    assert.equal(point.min, 5000);
    assert.equal(point.max, 5100);
    assert.deepEqual(
      point.explicitBounds,
      Array.from({ length: 60 }, (_, i) => (i + 1) * 5000),
    );
    assert.deepEqual(point.bucketCounts, ["1", "1", ...Array(59).fill("0")]);
    assert.deepEqual(totals(batch), {
      success: 2,
      error: 0,
      cancel: 0,
      uncertain: 0,
    });
    const epoch = batch.find((m) => m.sum)?.sum.dataPoints[0].startTimeUnixNano;

    for (const kind of ["failed", "cancelled", "uncertain"] as const) {
      now += 2000;
      adapter.admit(event(kind), now);
      now += 1100;
      await adapter.step();
      outcome = kind === "uncertain" ? "completed" : kind;
      ambiguous = kind === "uncertain";
      await adapter.step();
    }
    batch = await collect();
    assert.equal(gauge(batch), 0);
    assert.deepEqual(totals(batch), {
      success: 2,
      error: 1,
      cancel: 1,
      uncertain: 1,
    });
    adapter.close();
    adapter = open();
    batch = await collect();
    assert.equal(gauge(batch), 0);
    assert.deepEqual(totals(batch), {
      success: 2,
      error: 1,
      cancel: 1,
      uncertain: 1,
    });
    assert.equal(
      batch.find((m) => m.sum)?.sum.dataPoints[0].startTimeUnixNano,
      epoch,
    );
    assert.equal(
      batch.find((m) => m.histogram),
      undefined,
      "idle does not replay or fabricate duration observations",
    );
    for (failure of ["partial", "http", "throw", "oversize", "abort"]) {
      await collect(); // Including HTTP 200 partial rejection: never success.
    }
    failure = "blocked";
    await collect();
    const inFlight = metrics.length;
    t.mock.timers.tick(10000);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(
      metrics.length,
      inFlight,
      "one stalled export cannot accumulate concurrent HTTP requests",
    );
    failure = "none";
    releaseExport();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const db = new DatabaseSync(join(dir, "slack.sqlite"));
    db.exec("ALTER TABLE reply_metric_totals RENAME TO unavailable_totals");
    const beforeFault = metrics.length;
    t.mock.timers.tick(10000);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.ok(
      metrics
        .slice(beforeFault)
        .every((batch) => !batch.some((m) => m.gauge || m.sum)),
      "storage failure cannot report a stale count or invent zero",
    );
    db.exec("ALTER TABLE unavailable_totals RENAME TO reply_metric_totals");
    db.close();
    batch = await collect();
    assert.deepEqual(totals(batch), {
      success: 2,
      error: 1,
      cancel: 1,
      uncertain: 1,
    });
    assert.equal(
      posts,
      4,
      "no ambiguous send replay or exporter retry of Slack work",
    );
    await telemetry.close();
    const spans = traces.flatMap((r) =>
      r.resourceSpans.flatMap((s) => s.scopeSpans.flatMap((s) => s.spans)),
    );
    assert.ok(
      spans.some(
        (s) => s.name === "computah.metrics.export" && s.status.code === 2,
      ),
    );
    assert.ok(spans.some((s) => s.name === "computah.metrics.collect"));
    assert.ok(
      spans.some(
        (s) => s.name === "computah.metrics.collect" && s.status.code === 2,
      ),
    );
    assert.ok(
      spans.some(
        (s) =>
          s.name === "computah.metrics.export" &&
          s.attributes.some(
            (a) => a.key === "outcome" && a.value.stringValue === "cancelled",
          ),
      ),
    );
    const collections = spans.filter(
      (s) => s.name === "computah.metrics.collect",
    );
    assert.ok(
      spans
        .filter((s) => s.name === "computah.metrics.export")
        .every((s) =>
          s.links.some((l) =>
            collections.some(
              (c) => c.traceId === l.traceId && c.spanId === l.spanId,
            ),
          ),
        ),
    );
    const records = logs.flatMap((body) =>
      JSON.parse(body).resourceLogs.flatMap(
        (r: {
          scopeLogs: { logRecords: { attributes: Span["attributes"] }[] }[];
        }) => r.scopeLogs.flatMap((s) => s.logRecords),
      ),
    ) as { attributes: Span["attributes"] }[];
    for (const operation of ["metrics.collect", "metrics.export"])
      assert.ok(
        records.some(
          (r) =>
            r.attributes.some(
              (a) => a.key === "operation" && a.value.stringValue === operation,
            ) &&
            r.attributes.some(
              (a) => a.key === "outcome" && a.value.stringValue === "error",
            ),
        ),
        `${operation} failure keeps its fixed log category`,
      );
    const serialized = JSON.stringify(metrics);
    for (const secret of [
      "canary",
      "slack:",
      "submission",
      "traceId",
      "exemplars",
    ])
      assert.ok(!serialized.includes(secret), secret);
  } finally {
    adapter.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
