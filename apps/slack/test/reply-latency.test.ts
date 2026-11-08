import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startObservability, traceOperation } from "@computah/observability";
import { type Binding, SlackAdapter, type Transport } from "../src/adapter.js";
import { CoreDenied } from "../src/lifecycle.js";

test("per-receipt answer deadlines survive blocked core, batches, restart and uncertain sends without counting control posts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-reply-latency-"));
  const originalFetch = globalThis.fetch;
  const batches: string[] = [];
  globalThis.fetch = async (_input, init) => {
    batches.push(String(init?.body));
    return new Response("{}");
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-latency-token";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-latency-logs";
  delete process.env.COMPUTAH_AXIOM_CONTENT_ENABLED;
  const telemetry = await startObservability("slack");
  const binding: Binding = {
    teamId: "TFAKE",
    slackUserId: "UFAKE",
    tenantId: "tenant",
    userId: "owner",
    agentId: "private",
    coreToken: "private-token-canary",
    channelIds: [],
  };
  let sequence = 0;
  const fixture = (debounce = 0) => {
    const path = join(dir, `${sequence++}.sqlite`);
    const db = new DatabaseSync(path);
    let now = 0;
    let answer = "private-answer-canary";
    let outcome = "completed";
    let denied = false;
    let ambiguous = false;
    let release: (() => void) | undefined;
    let block = false;
    let posts = 0;
    const transport: Transport = {
      async request(_binding, _path, body) {
        if (denied) throw new CoreDenied();
        if (body) return { id: "private-handle-canary" };
        if (block)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return {
          submission: { outcome },
          messages: [
            { role: "assistant", blocks: [{ kind: "text", text: answer }] },
          ],
        };
      },
      async post() {
        posts++;
        if (ambiguous) throw new Error("ambiguous");
      },
      async openDm() {
        return "DFAKE";
      },
      async status() {
        return "ok";
      },
    };
    let adapter = new SlackAdapter(
      path,
      [binding],
      "UBOT",
      transport,
      () => now,
      false,
      debounce,
    );
    const event = (id: string, text = "private-request-canary") => ({
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
    return {
      db,
      transport,
      get adapter() {
        return adapter;
      },
      event,
      now(value: number) {
        now = value;
      },
      block() {
        block = true;
      },
      release() {
        release?.();
      },
      ambiguous() {
        ambiguous = true;
      },
      denied() {
        denied = true;
      },
      outcome(value: string) {
        outcome = value;
      },
      empty() {
        answer = "";
      },
      get posts() {
        return posts;
      },
      rows() {
        return db
          .prepare(
            "SELECT phase,observed,confirmed,elapsed,sent FROM reply_latency_outbox ORDER BY elapsed,phase",
          )
          .all();
      },
      states() {
        return db
          .prepare("SELECT state FROM reply_receipts ORDER BY event")
          .all()
          .map((r) => r.state);
      },
      reopen() {
        adapter.close();
        adapter = new SlackAdapter(
          path,
          [binding],
          "UBOT",
          transport,
          () => now,
          false,
          debounce,
        );
      },
      close() {
        adapter.close();
        db.close();
      },
    };
  };
  try {
    // Different receipt clocks in one burst; a duplicate never resets the clock.
    const f = fixture(1000);
    await traceOperation("slack.receive", async () => {
      assert.equal(f.adapter.admit(f.event("1"), 0), "accepted");
    });
    const firstCarrier = (
      f.db.prepare("SELECT traceparent FROM job_timing").get() as {
        traceparent: string;
      }
    ).traceparent;
    f.now(100);
    f.adapter.admit(f.event("2"), 100);
    assert.equal(f.adapter.admit(f.event("1"), 999), "duplicate");
    f.now(1100);
    await f.adapter.step();
    f.block();
    const wait = f.adapter.step();
    await new Promise((resolve) => setImmediate(resolve));
    f.now(5000);
    f.adapter.pumpReplyLatency();
    assert.equal(f.rows().length, 0);
    f.now(5001);
    f.adapter.pumpReplyLatency();
    assert.deepEqual(
      f.rows().map((r) => [r.phase, r.elapsed]),
      [["overdue", 5001]],
    );
    assert.equal(f.posts, 0, "blocked HTTP must not prevent overdue detection");
    f.now(5200);
    f.release();
    await wait;
    f.reopen(); // confirmed facts retained before exporter pump/restart
    f.adapter.pumpReplyLatency();
    assert.deepEqual(
      f.rows().map((r) => [r.phase, r.elapsed]),
      [
        ["overdue", 5001],
        ["confirmed", 5100],
        ["confirmed", 5200],
      ],
    );
    assert.deepEqual(f.states(), ["confirmed", "confirmed"]);
    f.now(100_000);
    f.adapter.pumpReplyLatency();
    assert.equal(
      f.rows().length,
      3,
      "no repeated overdue samples after confirmation",
    );
    f.close();

    // Unknown send may already be visible to Slack: never call it confirmed,
    // retry its post, or lose the unanswered deadline on reopen.
    const uncertain = fixture();
    uncertain.adapter.admit(uncertain.event("3"), 0);
    await uncertain.adapter.step();
    uncertain.ambiguous();
    await uncertain.adapter.step();
    assert.deepEqual(uncertain.adapter.counts(), { uncertain: 1 });
    uncertain.reopen();
    uncertain.now(5001);
    uncertain.adapter.pumpReplyLatency();
    uncertain.adapter.pumpReplyLatency();
    await uncertain.adapter.step();
    assert.deepEqual(
      uncertain.rows().map((r) => r.phase),
      ["overdue"],
    );
    assert.equal(uncertain.posts, 1);
    uncertain.close();

    // Actual successful post at the boundary is not a breach.
    const exact = fixture();
    exact.adapter.admit(exact.event("4"), 0);
    await exact.adapter.step();
    exact.now(5000);
    await exact.adapter.step();
    exact.adapter.pumpReplyLatency();
    assert.deepEqual(
      exact.rows().map((r) => [r.phase, r.elapsed]),
      [["confirmed", 5000]],
    );
    exact.close();

    const working = fixture();
    working.transport.acknowledgement = async () =>
      "i'll compare those options.";
    working.outcome("streaming");
    working.adapter.admit(working.event("working"), 0);
    await working.adapter.step();
    working.now(1);
    await working.adapter.step();
    assert.equal(working.posts, 1, "acknowledgement is visible");
    working.adapter.pumpReplyLatency();
    assert.deepEqual(
      working.rows(),
      [],
      "acknowledgement never confirms an answer",
    );
    working.now(5001);
    working.adapter.pumpReplyLatency();
    assert.deepEqual(
      working.rows().map((r) => r.phase),
      ["overdue"],
    );
    working.outcome("completed");
    await working.adapter.step();
    working.adapter.pumpReplyLatency();
    assert.deepEqual(
      working.rows().map((r) => [r.phase, r.elapsed]),
      [
        ["confirmed", 5001],
        ["overdue", 5001],
      ],
    );
    assert.equal(
      working.posts,
      2,
      "final answer still uses its independent delivery path",
    );
    working.close();

    for (const kind of ["failed", "cancelled", "empty", "denied"] as const) {
      const terminal = fixture();
      terminal.adapter.admit(terminal.event(`terminal-${kind}`), 0);
      if (kind === "denied") terminal.denied();
      else {
        await terminal.adapter.step();
        if (kind === "empty") terminal.empty();
        else terminal.outcome(kind);
      }
      await terminal.adapter.step();
      terminal.reopen();
      terminal.now(6000);
      terminal.adapter.pumpReplyLatency();
      assert.deepEqual(terminal.states(), [kind === "empty" ? "failed" : kind]);
      assert.deepEqual(
        terminal.rows(),
        [],
        "host terminal reply is not an assistant answer or forever pending",
      );
      terminal.close();
    }
    const controls = fixture();
    controls.adapter.admit(controls.event("stop", "stop"), 0);
    controls.adapter.admit(controls.event("debug", "DEBUGSHARE"), 0);
    controls.adapter.admit(
      {
        ...controls.event("bot"),
        event: { ...controls.event("bot").event, bot_id: "BBOT" },
      },
      0,
    );
    await controls.adapter.step();
    await controls.adapter.step();
    controls.now(6000);
    controls.adapter.pumpReplyLatency();
    assert.deepEqual(controls.states(), []);
    assert.deepEqual(controls.rows(), []);
    controls.close();

    const bounded = fixture(1000);
    for (let i = 0; i < 129; i++)
      assert.equal(
        bounded.adapter.admit(bounded.event(`${100 + i}`), 0),
        "accepted",
      );
    bounded.reopen();
    bounded.now(5001);
    bounded.adapter.pumpReplyLatency();
    assert.equal(bounded.rows().length, 128);
    bounded.reopen();
    bounded.adapter.pumpReplyLatency();
    assert.equal(bounded.rows().length, 129);
    bounded.now(100_000);
    bounded.adapter.pumpReplyLatency();
    assert.equal(
      bounded.rows().length,
      129,
      "still-unanswered receipts remain once per kind across restart",
    );
    bounded.close();
    const betweenTicks = fixture();
    betweenTicks.adapter.admit(betweenTicks.event("late-failure"), 0);
    await betweenTicks.adapter.step();
    betweenTicks.now(5100);
    betweenTicks.outcome("failed");
    await betweenTicks.adapter.step();
    betweenTicks.adapter.pumpReplyLatency();
    assert.deepEqual(betweenTicks.states(), ["failed"]);
    assert.deepEqual(
      betweenTicks.rows().map((r) => [r.phase, r.elapsed]),
      [["overdue", 5100]],
    );
    betweenTicks.close();

    const fault = fixture();
    fault.db.exec(
      "CREATE TRIGGER latency_admit_fault BEFORE INSERT ON reply_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END",
    );
    assert.equal(
      fault.adapter.admit(fault.event("fault-admit"), 0),
      "accepted",
    );
    fault.db.exec("DROP TRIGGER latency_admit_fault");
    await fault.adapter.step();
    await fault.adapter.step();
    assert.equal(fault.posts, 1);
    fault.close();
    const faultAnswer = fixture();
    faultAnswer.adapter.admit(faultAnswer.event("fault-answer"), 0);
    await faultAnswer.adapter.step();
    faultAnswer.db.exec(
      "CREATE TRIGGER latency_answer_fault BEFORE UPDATE ON reply_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END",
    );
    await faultAnswer.adapter.step();
    assert.equal(faultAnswer.posts, 1);
    assert.deepEqual(faultAnswer.adapter.counts(), { done: 1 });
    faultAnswer.close();
    const faultCancel = fixture();
    faultCancel.adapter.admit(faultCancel.event("fault-work"), 0);
    faultCancel.db.exec(
      "CREATE TRIGGER latency_cancel_fault BEFORE UPDATE ON reply_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END",
    );
    faultCancel.adapter.admit(faultCancel.event("fault-stop", "stop"), 0);
    await faultCancel.adapter.step();
    assert.deepEqual(faultCancel.adapter.counts(), { done: 2 });
    faultCancel.close();
    await telemetry.close();
    const records = batches.flatMap((batch) =>
      (JSON.parse(batch).resourceLogs ?? []).flatMap(
        (r: { scopeLogs: { logRecords: unknown[] }[] }) =>
          r.scopeLogs.flatMap((s) => s.logRecords),
      ),
    ) as {
      body?: { stringValue?: string };
      traceId?: string;
      spanId?: string;
      attributes?: {
        key: string;
        value: { stringValue?: string; intValue?: string };
      }[];
    }[];
    const latency = records.filter(
      (r) => r.body?.stringValue === "slack.reply_latency",
    );
    assert.equal(latency.length, 137);
    assert.equal(
      latency.filter(
        (r) =>
          r.traceId === firstCarrier.split("-")[1] &&
          r.spanId === firstCarrier.split("-")[2],
      ).length,
      3,
      "all batch receipts retain their durable job's exact trace context",
    );
    assert.ok(
      latency.every(
        (r) =>
          /^[a-f0-9]{32}$/.test(r.traceId ?? "") &&
          /^[a-f0-9]{16}$/.test(r.spanId ?? ""),
      ),
    );
    assert.ok(
      latency.every((r) =>
        /^[a-f0-9]{64}$/.test(
          r.attributes?.find((a) => a.key === "slack.message_id")?.value
            .stringValue ?? "",
        ),
      ),
    );
    assert.ok(
      records.some(
        (r) =>
          r.body?.stringValue === "operation.completed" &&
          r.attributes?.some(
            (a) => a.key === "outcome" && a.value.stringValue === "denied",
          ),
      ),
    );
    assert.doesNotMatch(
      batches.join(""),
      /private-request-canary|private-answer-canary|private-token-canary|private-handle-canary/,
    );
  } finally {
    await telemetry.close();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
