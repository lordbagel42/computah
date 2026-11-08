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

test("sanitized traces and logs connect first receive to durable job, retries, reopen and delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computah-slack-traces-"));
  const path = join(directory, "inbox.sqlite");
  const originalFetch = globalThis.fetch;
  const exported: string[] = [];
  const logs: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      exported.push(String(init?.body));
      return new Response("{}");
    }
    if (String(input) === "https://api.axiom.co/v1/logs") {
      logs.push(String(init?.body));
      return new Response("{}");
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-axiom-secret-not-real";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-private-logs";
  process.env.COMPUTAH_AXIOM_CONTENT_ENABLED = "1";
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
  const coreCarriers: string[] = [];
  const transport: Transport = {
    async request(_binding, _path, body) {
      return traceOperation("slack.core", async () => {
        const carrier = currentTraceHeaders().traceparent;
        coreCarriers.push(carrier);
        coreRoots.push(carrier.split("-")[1]);
        if (body) {
          const text = (body as { text: string }).text;
          assert.match(text, /\[Slack source: host-observed context/);
          assert.match(text, /"author":"UFAKE"/);
        }
        if (failing) throw new Error("private-synthetic-failure");
        return body
          ? { id: "private-submission-handle" }
          : { submission: { outcome: "cancelled" } };
      });
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
    false,
    500,
    true,
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
    let receive = "";
    await traceOperation("slack.receive", async () => {
      receive = currentTraceHeaders().traceparent;
      adapter.admit(input, now - 4);
      await adapter.acknowledge(input, async () => {});
    });
    const db = new DatabaseSync(path);
    const root = (
      db.prepare("SELECT traceparent FROM job_timing").get() as {
        traceparent: string;
      }
    ).traceparent;
    assert.equal(root.split("-")[1], receive.split("-")[1]);
    assert.notEqual(root.split("-")[2], receive.split("-")[2]);
    // Independent receives must not replace the durable first parent.
    const extraReceives: string[] = [];
    for (const extra of [
      input,
      {
        ...input,
        event_id: "burst-event",
        event: {
          ...input.event,
          ts: "1794120000.002",
          text: "private-synthetic-followup",
        },
      },
    ])
      await traceOperation("slack.receive", async () => {
        extraReceives.push(currentTraceHeaders().traceparent);
        adapter.admit(extra, now);
        await adapter.acknowledge(extra, async () => {});
      });
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM jobs").get() as { n: number }).n,
      1,
    );
    assert.equal(
      (
        db.prepare("SELECT traceparent FROM job_timing").get() as {
          traceparent: string;
        }
      ).traceparent,
      root,
    );
    now += 587;
    await adapter.step();
    adapter.close();
    adapter = new SlackAdapter(
      path,
      [binding],
      "BFAKE",
      transport,
      () => now,
      false,
      0,
      true,
    );
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
    // Migrated rows with no carrier must not borrow the current background pump
    // trace or invent an ancestry the journal never recorded.
    adapter.admit(
      {
        ...input,
        event_id: "legacy-event",
        event: { ...input.event, ts: "1794120002.001" },
      },
      now,
    );
    db.prepare(
      "UPDATE job_timing SET traceparent=NULL WHERE job=(SELECT job FROM receipts WHERE source=?)",
    ).run(JSON.stringify(["TFAKE", "DFAKE", "1794120002.001"]));
    const pumps: string[] = [];
    for (let i = 0; i < 2; i++)
      await traceOperation("slack.step", async () => {
        pumps.push(currentTraceHeaders().traceparent);
        await adapter.step();
      });
    assert.equal(coreCarriers.length, 5);
    for (const carrier of coreCarriers.slice(3)) {
      assert.notEqual(carrier.split("-")[1], root.split("-")[1]);
      assert.ok(
        pumps.every((pump) => pump.split("-")[1] !== carrier.split("-")[1]),
      );
    }
    db.close();
    adapter.close();
    await telemetry.close();
    const privateRows = logs.flatMap((batch) =>
      JSON.parse(batch).resourceLogs.flatMap(
        (resource: {
          scopeLogs: {
            logRecords: {
              traceId?: string;
              attributes: { key: string; value: { stringValue?: string } }[];
            }[];
          }[];
        }) => resource.scopeLogs.flatMap((scope) => scope.logRecords),
      ),
    );
    const records = privateRows.map((row) => ({
      traceId: row.traceId,
      spanId: row.spanId,
      event: row.body?.stringValue,
      attributes: Object.fromEntries(
        row.attributes.map(
          (attr: { key: string; value: { stringValue?: string } }) => [
            attr.key,
            attr.value.stringValue,
          ],
        ),
      ),
    }));
    const contents = records.filter((row) => row.attributes["content.payload"]);
    assert.ok(
      contents.some(
        (row) =>
          row.traceId === root.split("-")[1] &&
          row.attributes["content.kind"] === "incoming" &&
          row.attributes["content.payload"]?.includes(
            "private-synthetic-message",
          ),
      ),
    );
    assert.ok(
      contents.some(
        (row) =>
          row.attributes["content.kind"] === "final" &&
          row.attributes["content.payload"]?.includes('"outcome":"attempt"'),
      ),
    );
    assert.ok(!logs.join("").includes("synthetic-core-secret"));
    assert.ok(!logs.join("").includes("private-ambiguous-send"));
    const encoded = exported.join("\n");
    for (const secret of [
      "private-synthetic",
      "fake-owner",
      "DFAKE",
      "UFAKE",
      "synthetic-core-secret",
      "private-submission-handle",
      "fake-event",
      "1794120000.001",
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
    const jobSpan = jobSpans.find((span) => span.spanId === root.split("-")[2]);
    assert.equal(jobSpan?.parentSpanId, receive.split("-")[2]);
    assert.equal(jobSpan?.name, "computah.slack.job");
    for (const name of ["submit", "wait", "delivery", "ack", "queue"]) {
      const phases = jobSpans.filter(
        (span) =>
          span.name === `computah.slack.${name}` &&
          (name === "queue" ||
            (span.attributes as { key: string }[]).some(
              (attr) => attr.key === "attempt",
            )),
      );
      assert.ok(phases.length > 0, name);
      for (const span of phases)
        assert.equal(span.parentSpanId, jobSpan?.spanId, name);
    }
    for (const carrier of extraReceives)
      assert.ok(
        jobSpans.some(
          (span) =>
            span.name === "computah.slack.ack" &&
            (
              span.links as { traceId: string; spanId: string }[] | undefined
            )?.some(
              (link) =>
                link.traceId === carrier.split("-")[1] &&
                link.spanId === carrier.split("-")[2],
            ),
        ),
        "duplicate/burst receives link to the original job without replacing its parent",
      );
    for (const carrier of coreCarriers.slice(0, 3)) {
      const core = jobSpans.find(
        (span) => span.spanId === carrier.split("-")[2],
      );
      const parent = jobSpans.find(
        (span) => span.spanId === core?.parentSpanId,
      );
      assert.equal(core?.name, "computah.slack.core");
      assert.ok(
        ["computah.slack.submit", "computah.slack.wait"].includes(
          String(parent?.name),
        ),
      );
    }
    for (const carrier of coreCarriers.slice(3)) {
      const core = spans.find((span) => span.spanId === carrier.split("-")[2]);
      const parent = spans.find((span) => span.spanId === core?.parentSpanId);
      assert.ok(
        parent && !parent.parentSpanId,
        "legacy phase starts a new root",
      );
    }
    for (const phase of jobSpans.filter(
      (span) =>
        [
          "computah.slack.submit",
          "computah.slack.wait",
          "computah.slack.delivery",
        ].includes(String(span.name)) &&
        (span.attributes as { key: string }[]).some(
          (attr) => attr.key === "attempt",
        ),
    ))
      assert.ok(
        records.some(
          (log) =>
            log.traceId === phase.traceId &&
            log.spanId === phase.spanId &&
            log.event === "operation.completed" &&
            log.attributes.outcome ===
              ((phase.status as { code?: number })?.code === 2
                ? "error"
                : "success"),
        ),
        String(phase.name),
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
      587n,
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
    delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
    delete process.env.COMPUTAH_AXIOM_CONTENT_ENABLED;
    await rm(directory, { recursive: true });
  }
});
