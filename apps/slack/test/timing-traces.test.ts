import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  currentTraceHeaders,
  startObservability,
  traceOperation,
} from "@computah/observability";
import { type Binding, SlackAdapter, type Transport } from "../src/adapter.js";

test("real sanitized export preserves per-job roots through ACK, retries, reopen and capture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computah-slack-traces-"));
  const path = join(directory, "inbox.sqlite");
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      exported.push(String(init?.body));
      return new Response("{}");
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-axiom-secret-not-real";
  const telemetry = await startObservability("slack");
  const binding: Binding = {
    teamId: "TFAKE",
    slackUserId: "UFAKE",
    tenantId: "fake-tenant",
    userId: "fake-owner",
    agentId: "fake-agent",
    coreToken: "synthetic-core-secret",
    channelIds: [],
  };
  let failing = true;
  const coreRoots: string[] = [];
  const transport: Transport = {
    async request(_binding, _path, body) {
      coreRoots.push(currentTraceHeaders().traceparent?.split("-")[1]);
      if (failing) throw new Error("private-synthetic-failure");
      return body
        ? { id: "private-submission-handle" }
        : { submission: { outcome: "cancelled" } };
    },
    async openDm() {
      return "DFAKE";
    },
    async post() {
      throw new Error("private-ambiguous-send");
    },
    async status() {
      return "ok";
    },
  };
  let now = Date.now();
  let adapter = new SlackAdapter(
    path,
    [binding],
    "BFAKE",
    transport,
    () => now,
  );
  const input = {
    team_id: "TFAKE",
    event_id: "fake-event",
    event: {
      type: "message",
      channel_type: "im",
      user: "UFAKE",
      channel: "DFAKE",
      ts: "1794120000.001",
      text: "private-synthetic-message",
    },
  };
  try {
    await traceOperation("slack.receive", async () => {
      adapter.admit(input, now - 4);
      await adapter.acknowledge(input, async () => {});
    });
    const db = new DatabaseSync(path);
    const root = (
      db.prepare("SELECT traceparent FROM job_timing").get() as {
        traceparent: string;
      }
    ).traceparent;
    now += 87;
    await adapter.step();
    adapter.close();
    adapter = new SlackAdapter(path, [binding], "BFAKE", transport, () => now);
    failing = false;
    await adapter.step();
    await adapter.step();
    assert.deepEqual(coreRoots, [
      root.split("-")[1],
      root.split("-")[1],
      root.split("-")[1],
    ]);
    assert.deepEqual(adapter.counts(), { uncertain: 1 });
    adapter.admit(
      {
        ...input,
        event_id: "debug-event",
        event: { ...input.event, ts: "1794120001.001", text: "DEBUGSHARE" },
      },
      now,
    );
    await adapter.step();
    const report = JSON.parse(
      (db.prepare("SELECT report FROM debugshares").get() as { report: string })
        .report,
    );
    assert.ok(report.capture?.traceId);
    assert.equal(report.capture.traceId, report.transport.traceId);
    assert.notEqual(report.transport.traceId, root.split("-")[1]);
    assert.equal(report.transport.requestId.startsWith("input:slack:"), true);
    db.close();
    adapter.close();
    await telemetry.close();
    const encoded = exported.join("\n");
    for (const secret of [
      "private-synthetic",
      "fake-owner",
      "DFAKE",
      "UFAKE",
      "synthetic-core-secret",
      "private-submission-handle",
      "fake-event",
    ])
      assert.ok(!encoded.includes(secret), secret);
    const spans = exported.flatMap((batch) =>
      JSON.parse(batch).resourceSpans.flatMap(
        (resource: { scopeSpans: { spans: Record<string, unknown>[] }[] }) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );
    const jobSpans = spans.filter(
      (span) => span.traceId === root.split("-")[1],
    );
    assert.equal(
      jobSpans.filter((span) => span.name === "computah.slack.submit").length,
      2,
    );
    assert.ok(
      jobSpans.some(
        (span) =>
          span.name === "computah.slack.submit" &&
          (span.status as { code?: number })?.code === 2,
      ),
    );
    assert.ok(
      jobSpans.some(
        (span) =>
          span.name === "computah.slack.delivery" &&
          (span.status as { code?: number })?.code === 2,
      ),
    );
    const queue = jobSpans.find((span) => span.name === "computah.slack.queue");
    assert.ok(queue);
    assert.equal(
      (BigInt(queue.endTimeUnixNano as string) -
        BigInt(queue.startTimeUnixNano as string)) /
        1_000_000n,
      87n,
    );
    assert.ok(
      jobSpans.some(
        (span) =>
          span.name === "computah.slack.ack" &&
          Array.isArray(span.links) &&
          span.links.length > 0,
      ),
    );
    assert.ok(
      spans.some(
        (span) =>
          span.name === "computah.debugshare.capture" &&
          span.traceId === report.capture.traceId &&
          span.spanId === report.capture.spanId,
      ),
    );
  } finally {
    try {
      adapter.close();
    } catch {
      /* Already closed on success. */
    }
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    await rm(directory, { recursive: true });
  }
});
