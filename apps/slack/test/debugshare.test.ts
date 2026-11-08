import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Ingress, SlackAdapter, type Transport } from "../src/adapter.js";
import { debugshareReply } from "../src/debugshare.js";

const uuid =
  /^DEBUGSHARE [a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\n/;

test("DEBUGSHARE mints distinct opaque UUIDs, without echoing report text", () => {
  const first = debugshareReply("DEBUGSHARE");
  const second = debugshareReply(" \nDEBUGSHARE padding is off");
  assert.match(first ?? "", uuid);
  assert.match(second ?? "", uuid);
  assert.notEqual(first, second);
  assert.doesNotMatch(second ?? "", /padding is off/);
  assert.match(first ?? "", /no diagnostics collected or shared/);
  assert.match(first ?? "", /no investigation or thread started/);
  assert.match(first ?? "", /not a diagnostics lookup key/);
  for (const text of [
    "DEBUGSHAREfoo",
    "debugshare",
    "please DEBUGSHARE",
    '"DEBUGSHARE"',
    "`DEBUGSHARE`",
    "```\nDEBUGSHARE\n```",
  ])
    assert.equal(debugshareReply(text), null);
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
    assert.match(posts[0]?.text ?? "", uuid);
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
    assert.match(posts[1]?.text ?? "", uuid);
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
    assert.equal(replies.filter((text) => uuid.test(text)).length, 2);
    assert.equal(await adapter.step(), false);
  } finally {
    adapter.close();
  }
});
