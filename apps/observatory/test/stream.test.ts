import assert from "node:assert/strict";
import { test } from "node:test";
import type { Snapshot } from "../src/collector.ts";
import { project } from "../src/projection.ts";
import { FeedStream, LiveProjection } from "../src/stream.ts";

const now = Date.now();
const secret = "test-only-opaque-identifier-secret-not-real";
const trace = "1234567890abcdef1234567890abcdef";
const row = {
  _time: new Date(now - 2000).toISOString(),
  trace_id: trace,
  span_id: "1111111111111111",
  parent_span_id: null,
  name: "computah.http",
  "service.name": "computah-backend",
  duration_ms: 100,
  "status.code": "UNSET",
  lifecycle: "active",
  revision: 1,
  observed_at: now,
  attributes: { message: "PRIVATE-CANARY" },
};
const history: Snapshot = {
  state: "live",
  fetchedAt: now,
  windowMs: 900000,
  limit: 1000,
  truncated: false,
  spans: [],
};

test("live positive projection deduplicates/reorders safely, preserves ancestry and settled authority", () => {
  const live = new LiveProjection();
  const accept = (records: unknown[]) =>
    live.accept({ version: 1, records }, secret, now);
  assert.equal(accept([row]), 1);
  const active = live.merge(history, false, now);
  assert.equal(active.spans[0]?.lifecycle, "active");
  assert.equal(accept([row]), 0);
  assert.equal(
    accept([
      {
        ...row,
        revision: 3,
        lifecycle: "ended",
        duration_ms: 1900,
        "status.code": "ERROR",
      },
    ]),
    1,
  );
  assert.equal(
    accept([
      { ...row, revision: 2 },
      { ...row, revision: 4 },
    ]),
    0,
  );
  assert.equal(
    accept([
      {
        ...row,
        span_id: "2222222222222222",
        parent_span_id: row.span_id,
        links: [
          {
            trace_id: trace,
            span_id: row.span_id,
            attributes: "PRIVATE-CANARY",
          },
        ],
        revision: 1,
      },
    ]),
    1,
  );
  const result = live.merge(history, false, now);
  const parent = result.spans.find((span) => span.parentState === "root");
  const child = result.spans.find((span) => span.parentState === "present");
  assert.equal(parent?.lifecycle, "ended");
  assert.equal(parent?.status, "error");
  assert.equal(child?.parentId, parent?.id);
  assert.deepEqual(child?.links, [
    { traceId: parent?.traceId, id: parent?.id, present: true },
  ]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE-CANARY"));
  assert.ok(!JSON.stringify(result).includes(trace));
  assert.equal(accept([{ ...row, observed_at: now - 31000 }]), 0);
  assert.equal(live.merge(history, false, now + 900001).spans.length, 0);
});

test("SSE reconnect replays only newer frames; unknown/expired cursor resets and cancellation cleans up", async () => {
  const feed = new FeedStream();
  feed.publish(history);
  const abort = new AbortController();
  let closed = 0;
  const reader = feed
    .connect(null, abort.signal, () => closed++)
    .body?.getReader();
  assert.ok(reader);
  const decode = (value: Uint8Array | undefined) =>
    new TextDecoder().decode(value);
  const initial = decode((await reader.read()).value);
  assert.match(initial, /event: snapshot/);
  const cursor = initial.match(/id: (.+)/)?.[1] as string;
  await reader.read(); // reconnect retry interval
  feed.status({ source: "axiom-history", state: "live" });
  const status = decode((await reader.read()).value);
  abort.abort();
  assert.equal(feed.readers, 0);
  assert.equal(closed, 1);
  const resumed = feed
    .connect(cursor, new AbortController().signal, () => {})
    .body?.getReader();
  assert.ok(resumed);
  assert.equal(decode((await resumed.read()).value), status);
  await resumed.cancel();
  for (let index = 0; index < 260; index++) feed.status({ state: "live" });
  const reset = feed
    .connect(cursor, new AbortController().signal, () => {})
    .body?.getReader();
  assert.ok(reset);
  assert.match(decode((await reset.read()).value), /event: snapshot/);
  await reset.cancel();
  assert.equal(feed.readers, 0);
});

test("SSE closes a slow consumer rather than growing an unbounded replay queue", async () => {
  const feed = new FeedStream();
  feed.publish(history);
  let closed = false;
  const response = feed.connect(null, new AbortController().signal, () => {
    closed = true;
  });
  for (let index = 0; index < 20; index++)
    feed.status({ padding: "x".repeat(100000) });
  assert.equal(feed.readers, 0);
  assert.equal(closed, true);
  await response.body?.cancel();
});

test("large linked history truncates by bytes and reconnect resets rather than overflowing its queue", async () => {
  const spans = project(
    Array.from({ length: 1000 }, (_, index) => ({
      ...row,
      span_id: (index + 1).toString(16).padStart(16, "0"),
      links: Array.from({ length: 32 }, () => ({
        trace_id: trace,
        span_id: row.span_id,
      })),
    })),
    secret,
  );
  assert.ok(JSON.stringify(spans).length > 1024 * 1024);
  const snapshot = new LiveProjection().merge(
    { ...history, spans },
    false,
    now,
  );
  assert.equal(snapshot.truncated, true);
  assert.ok(JSON.stringify(snapshot).length < 512 * 1024);
  const feed = new FeedStream();
  feed.publish(snapshot);
  const first = feed
    .connect(null, new AbortController().signal, () => {})
    .body?.getReader();
  assert.ok(first);
  const initial = new TextDecoder().decode((await first.read()).value);
  assert.match(initial, /event: snapshot/);
  const cursor = initial.match(/id: (.+)/)?.[1] as string;
  await first.cancel();
  for (let index = 0; index < 10; index++)
    feed.status({ padding: "x".repeat(80000) });
  const resumed = feed
    .connect(cursor, new AbortController().signal, () => {})
    .body?.getReader();
  assert.ok(resumed);
  assert.match(
    new TextDecoder().decode((await resumed.read()).value),
    /event: snapshot/,
  );
  assert.equal(feed.readers, 1);
  await resumed.cancel();
});
