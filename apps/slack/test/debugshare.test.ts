import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Ingress, SlackAdapter, type Transport } from "../src/adapter.js";
import { debugshareReply } from "../src/debugshare.js";

const bugId = /^computah_bug_[a-z0-9]{24}\n/;

test("DEBUGSHARE mints distinct opaque bug IDs, without echoing report text", () => {
  const first = debugshareReply(
    "DEBUGSHARE",
    "UOWNER",
    Date.UTC(2026, 10, 8, 7),
  );
  const second = debugshareReply(
    " \nDEBUGSHARE padding is off",
    "UOTHER",
    Date.UTC(2026, 10, 8, 7, 1, 31),
  );
  assert.match(first ?? "", bugId);
  assert.match(second ?? "", bugId);
  assert.notEqual(first, second);
  assert.doesNotMatch(second ?? "", /padding is off/);
  assert.deepEqual(first?.split("\n").slice(1), [
    "time: 2026-11-08T07:00:00.000Z",
    "requested by: UOWNER",
    "amp link: [disabled]",
  ]);
  assert.deepEqual(second?.split("\n").slice(1), [
    "time: 2026-11-08T07:01:31.000Z",
    "requested by: UOTHER",
    "amp link: [disabled]",
  ]);
  for (const text of [
    "DEBUGSHAREfoo",
    "debugshare",
    "please DEBUGSHARE",
    '"DEBUGSHARE"',
    "`DEBUGSHARE`",
    "```\nDEBUGSHARE\n```",
  ])
    assert.equal(debugshareReply(text, "UOWNER", 1000), null);
});

test("authorized DEBUGSHARE bypasses core, replies privately, and never replays after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computah-debugshare-"));
  const path = join(dir, "inbox.sqlite");
  const binding = {
    teamId: "TTEST",
    slackUserId: "UOWNER",
    tenantId: "tenant",
    userId: "owner",
    agentId: "agent",
    coreToken: "synthetic-only",
    channelIds: ["CALLOWED"],
    channelBindings: [
      {
        channelId: "CALLOWED",
        tenantId: "tenant",
        userId: "channel",
        agentId: "channel",
        coreToken: "synthetic-channel-only",
      },
    ],
  };
  const posts: { channel: string; text: string; thread: string | null }[] = [];
  let requests = 0;
  let dmOpens = 0;
  let auxiliary = 0;
  let now = 1000;
  const transport: Transport = {
    async status() {
      auxiliary++;
      return "ok";
    },
    async threadContext() {
      auxiliary++;
      return { messages: [] };
    },
    async request() {
      requests++;
      throw new Error("DEBUGSHARE must not invoke the core");
    },
    async openDm(user) {
      dmOpens++;
      assert.equal(user, "UOWNER");
      return "DPRIVATE";
    },
    async post(channel, text, thread) {
      posts.push({ channel, text, thread });
    },
  };
  const event: Ingress = {
    team_id: "TTEST",
    event_id: "debug-1",
    event: {
      type: "app_mention",
      user: "UOWNER",
      channel: "CALLOWED",
      text: "<@UBOT> DEBUGSHARE private report",
      ts: "123.456",
    },
  };
  let adapter = new SlackAdapter(
    path,
    [binding],
    "UBOT",
    transport,
    () => now,
    true,
    0,
    true,
  );
  try {
    assert.equal(adapter.admit({ ...event, team_id: "TOTHER" }), "ignored");
    assert.equal(
      adapter.admit({ ...event, event: { ...event.event, user: "UOTHER" } }),
      "ignored",
    );
    assert.equal(
      adapter.admit({ ...event, event: { ...event.event, channel: "COTHER" } }),
      "ignored",
    );
    assert.equal(await adapter.step(), false);
    assert.equal(posts.length, 0);
    assert.equal(adapter.admit(event), "accepted");
    assert.equal(
      adapter.admit({
        ...event,
        event_id: "not-a-subscription",
        event: {
          ...event.event,
          type: "message",
          text: "ordinary follow-up",
          ts: "124.456",
          thread_ts: "123.456",
        },
      }),
      "ignored",
    );
    adapter.close();
    adapter = new SlackAdapter(path, [binding], "UBOT", transport, () => now);
    now += 300_001; // Even a delayed command must not imply model work is running.
    assert.equal(adapter.admit(event), "duplicate");
    await adapter.step();
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.text ?? "", bugId);
    assert.deepEqual(posts[0]?.text.split("\n").slice(1), [
      "time: 1970-01-01T00:00:01.000Z",
      "requested by: UOWNER",
      "amp link: [disabled]",
      "report: stored locally; tracker sync pending",
    ]);
    assert.equal(posts[0]?.channel, "DPRIVATE");
    assert.equal(posts[0]?.thread, null);
    assert.equal(dmOpens, 1);
    assert.equal(requests, 0);
    adapter.close();
    adapter = new SlackAdapter(
      path,
      [binding],
      "UBOT",
      transport,
      () => now,
      true,
    );
    assert.equal(adapter.admit(event), "duplicate");
    assert.equal(await adapter.step(), false);
    assert.equal(posts.length, 1);

    transport.post = async (channel, text, thread) => {
      posts.push({ channel, text, thread });
      throw new Error("Synthetic lost Slack response");
    };
    assert.equal(
      adapter.admit({
        ...event,
        event_id: "debug-2",
        event: {
          ...event.event,
          type: "message",
          channel: "DEXISTING",
          channel_type: "im",
          thread_ts: "100.001",
        },
      }),
      "accepted",
    );
    await adapter.step();
    assert.match(posts[1]?.text ?? "", bugId);
    assert.notEqual(posts[0]?.text, posts[1]?.text);
    assert.equal(posts[1]?.channel, "DEXISTING");
    assert.equal(posts[1]?.thread, "100.001");
    adapter.close();
    adapter = new SlackAdapter(path, [binding], "UBOT", transport, () => now);
    assert.equal(await adapter.step(), false);
    assert.equal(posts.length, 2);
    assert.equal(dmOpens, 1);
    assert.equal(requests, 0);
    assert.equal(auxiliary, 0);
    assert.deepEqual(adapter.counts(), { done: 1, uncertain: 1 });
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true });
  }
});

test("DEBUGSHARE never absorbs neighboring chat or disappears into a debounced burst", async () => {
  let now = 1000;
  const submitted: string[] = [];
  const replies: string[] = [];
  const adapter = new SlackAdapter(
    ":memory:",
    [
      {
        teamId: "T",
        slackUserId: "U",
        tenantId: "tenant",
        userId: "user",
        agentId: "agent",
        coreToken: "synthetic",
        channelIds: [],
      },
    ],
    "UBOT",
    {
      async request(_binding, _path, body) {
        if (body) {
          submitted.push((body as { text: string }).text);
          return { id: "signed-handle" };
        }
        return { submission: { outcome: "completed" }, messages: [] };
      },
      async openDm() {
        throw new Error("DM already exists");
      },
      async post(_channel, text) {
        replies.push(text);
      },
      async status() {
        throw new Error("Status disabled");
      },
    },
    () => now,
    false,
    500,
  );
  try {
    for (const [i, text] of [
      "ordinary first",
      "DEBUGSHARE note",
      "ordinary next",
      "DEBUGSHARE",
    ].entries()) {
      assert.equal(
        adapter.admit({
          team_id: "T",
          event_id: `event-${i}`,
          event: {
            type: "message",
            channel_type: "im",
            channel: "DPRIVATE",
            user: "U",
            ts: `100.${i}`,
            text,
          },
        }),
        "accepted",
      );
    }
    now += 501;
    for (let i = 0; i < 6; i++) await adapter.step();
    assert.deepEqual(submitted, ["ordinary first", "ordinary next"]);
    assert.equal(replies.filter((text) => bugId.test(text)).length, 2);
    assert.equal(await adapter.step(), false);
  } finally {
    adapter.close();
  }
});

for (const legacy of [false, true]) {
  test(`DEBUGSHARE durably indexes origin and retries a frozen ${legacy ? "legacy UUID" : "new bug ID"} snapshot after restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "computah-capture-"));
    const path = join(dir, "inbox.sqlite");
    const binding = {
      teamId: "TTEST",
      slackUserId: "UOWNER",
      tenantId: "tenant",
      userId: "owner",
      agentId: "agent",
      coreToken: "synthetic-credential",
      channelIds: [],
    };
    let now = 1000;
    let captures = 0;
    let available = false;
    const uploads: string[] = [];
    const posts: string[] = [];
    const transport: Transport = {
      async request() {
        throw new Error("No cognition for DEBUGSHARE");
      },
      async openDm() {
        return "DPRIVATE";
      },
      async post(_channel, text) {
        posts.push(text);
      },
      async status() {
        throw new Error("No status for DEBUGSHARE");
      },
      async diagnosticContext(source) {
        captures++;
        assert.deepEqual(source, {
          team: "TTEST",
          channel: "DPRIVATE",
          message: "100.003",
          thread: "100.001",
        });
        return {
          messages: [
            {
              user: "UOWNER",
              ts: "100.001",
              text: "The follow-up lost its context",
            },
            {
              user: "UBOT",
              ts: "100.002",
              thread_ts: "100.001",
              text: `${"x".repeat(3995)}synthetic-credential`,
            },
            {
              user: "UOTHER",
              ts: "100.0025",
              thread_ts: "99.001",
              text: "Unrelated thread must not leak",
            },
            {
              user: "UFUTURE",
              ts: "100.004",
              thread_ts: "100.001",
              text: "Future message",
            },
          ],
        };
      },
      async publishDebugshare(report) {
        uploads.push(JSON.stringify(report));
        if (!available) throw new Error("Offline");
        return `https://tracker.example/#${report.id}`;
      },
    };
    let adapter = new SlackAdapter(
      path,
      [binding],
      "UBOT",
      transport,
      () => now,
    );
    try {
      assert.equal(
        adapter.admit({
          team_id: "TTEST",
          event_id: "capture",
          event: {
            type: "message",
            channel_type: "im",
            channel: "DPRIVATE",
            user: "UOWNER",
            ts: "100.003",
            thread_ts: "100.001",
            text: "DEBUGSHARE context loss",
          },
        }),
        "accepted",
      );
      // Admission's returned ACK may only follow a committed ID/source mapping.
      let db = new DatabaseSync(path, { readOnly: true });
      const initial = db.prepare("SELECT id,report FROM debugshares").get() as {
        id: string;
        report: string;
      };
      assert.match(initial.id, /^computah_bug_[a-z0-9]{24}$/u);
      assert.equal(JSON.parse(initial.report).source.message, "100.003");
      assert.equal(posts.length, 0);
      db.close();
      adapter.close();
      if (legacy) {
        // Model an already admitted pre-upgrade report, without changing origin/job bindings.
        initial.id = "12b42dd4-8123-4234-9234-123456789abc";
        initial.report = JSON.stringify({
          ...JSON.parse(initial.report),
          id: initial.id,
        });
        db = new DatabaseSync(path);
        db.prepare("UPDATE debugshares SET id=?,report=?").run(
          initial.id,
          initial.report,
        );
        db.close();
      }
      adapter = new SlackAdapter(path, [binding], "UBOT", transport, () => now);
      await adapter.step();
      assert.ok(posts[0]?.startsWith(`${initial.id}\n`));
      assert.match(posts[0] ?? "", /stored locally; tracker sync pending/);
      assert.doesNotMatch(posts[0] ?? "", /https:/);
      const report = JSON.parse(uploads[0] ?? "");
      assert.deepEqual(report.participants, ["UOWNER", "UBOT"]);
      assert.deepEqual(
        report.messages.map((m: { text: string }) => m.text),
        [
          "The follow-up lost its context",
          `${"x".repeat(3995)}[reda`,
          "DEBUGSHARE context loss",
        ],
      );
      adapter.close();
      available = true;
      now += 30_001;
      adapter = new SlackAdapter(path, [binding], "UBOT", transport, () => now);
      await adapter.step();
      assert.equal(captures, 1);
      assert.equal(uploads[0], uploads[1]);
      db = new DatabaseSync(path, { readOnly: true });
      const saved = db
        .prepare("SELECT report,url FROM debugshares WHERE id=?")
        .get(initial.id) as { report: string; url: string };
      assert.equal(saved.report, uploads[0]);
      assert.equal(saved.url, `https://tracker.example/#${initial.id}`);
      db.close();
      assert.equal(posts.length, 1); // No blind Slack repost after durable outbox recovery.
      now += 8 * 86400_000;
      const event = {
        team_id: "TTEST",
        event_id: "newer-command",
        event: {
          type: "message",
          channel_type: "im",
          channel: "DPRIVATE",
          user: "UOWNER",
          ts: "200.001",
          text: "DEBUGSHARE another issue",
        },
      };
      assert.equal(adapter.admit(event), "accepted"); // Prunes old delivery receipts.
      assert.equal(
        adapter.admit({
          ...event,
          event_id: "capture-replayed-after-retention",
          event: { ...event.event, ts: "100.003" },
        }),
        "duplicate",
      );
    } finally {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
