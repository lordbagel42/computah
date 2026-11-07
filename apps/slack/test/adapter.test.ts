import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type Binding,
  type Ingress,
  SlackAdapter,
  type Transport,
} from "../src/adapter.js";

const binding: Binding = {
  teamId: "TTEST",
  slackUserId: "UOWNER",
  tenantId: "tenant",
  userId: "owner",
  agentId: "agent",
  coreToken: "synthetic-token-not-a-credential",
  channelIds: ["CALLOWED"],
};
const mention: Ingress = {
  team_id: "TTEST",
  event_id: "Ev1",
  event: {
    type: "app_mention",
    user: "UOWNER",
    channel: "CALLOWED",
    text: "<@UBOT> follow up",
    ts: "123.456",
  },
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "computah-slack-"));
  const path = join(dir, "inbox.sqlite");
  const calls: { principal: Binding; path: string; body?: unknown }[] = [];
  const posts: unknown[][] = [];
  const transport: Transport = {
    async request(principal, path, body) {
      calls.push({ principal, path, body });
      return body
        ? { id: "signed-handle" }
        : {
            submission: { outcome: "completed" },
            messages: [
              {
                role: "assistant",
                blocks: [{ kind: "text", text: "Private answer <@everyone>" }],
              },
            ],
          };
    },
    async openDm(user) {
      assert.equal(user, "UOWNER");
      return "DPRIVATE";
    },
    async post(...args) {
      posts.push(args);
    },
  };
  return {
    path,
    calls,
    posts,
    transport,
    cleanup: () => rmSync(dir, { recursive: true }),
  };
}

test("durable admission survives restart; channel mention results only go to private DM", async () => {
  const f = fixture();
  let adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
  try {
    assert.equal(adapter.admit(mention), "accepted");
    adapter.close();
    adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
    assert.equal(
      adapter.admit({
        ...mention,
        event: { ...mention.event, channel: "COTHER" },
      }),
      "ignored",
    );
    assert.equal(adapter.admit(mention), "duplicate");
    await adapter.step();
    adapter.close();
    adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
    await adapter.step();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]?.principal, binding);
    assert.match(
      JSON.stringify(f.calls[0]?.body),
      /"clientMutationId":"slack:[a-f0-9]{64}"/,
    );
    assert.deepEqual(f.posts, [
      ["DPRIVATE", "Private answer <@everyone>", null],
    ]);
    assert.deepEqual(adapter.counts(), { done: 1 });
  } finally {
    adapter.close();
    f.cleanup();
  }
});

test("rejects unmapped users/workspaces, bot loops, edits and unallowlisted channels", () => {
  const f = fixture();
  const adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
  try {
    for (const input of [
      { ...mention, team_id: "TOTHER" },
      ...[
        { user: "UOTHER" },
        { user: "UBOT" },
        { bot_id: "BBOT" },
        { subtype: "message_changed" },
        { channel: "COTHER" },
      ].map((patch) => ({ ...mention, event: { ...mention.event, ...patch } })),
    ])
      assert.equal(adapter.admit(input), "ignored");
    assert.deepEqual(adapter.counts(), {});
  } finally {
    adapter.close();
    f.cleanup();
  }
});

test("DM follow-ups keep thread routing; ambiguous posts are never retried after restart", async () => {
  const f = fixture();
  f.transport.post = async (...args) => {
    f.posts.push(args);
    throw new Error("Synthetic lost response");
  };
  let adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
  try {
    adapter.admit({
      ...mention,
      event: {
        ...mention.event,
        type: "message",
        channel: "DPRIVATE",
        channel_type: "im",
        thread_ts: "100.001",
      },
    });
    await adapter.step();
    await adapter.step();
    assert.deepEqual(adapter.counts(), { uncertain: 1 });
    adapter.close();
    adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
    assert.equal(await adapter.step(), false);
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0]?.[2], "100.001");
  } finally {
    adapter.close();
    f.cleanup();
  }
});

test("a failed DM open does not block another user's existing DM", async () => {
  const f = fixture();
  f.transport.openDm = async () => {
    throw new Error("Synthetic unavailable DM");
  };
  const other = { ...binding, slackUserId: "UOTHER", userId: "other" };
  let adapter = new SlackAdapter(f.path, [binding, other], "UBOT", f.transport);
  try {
    adapter.admit(mention);
    adapter.admit({
      ...mention,
      event_id: "EvOther",
      event: {
        ...mention.event,
        user: "UOTHER",
        type: "message",
        channel: "DOTHER",
        channel_type: "im",
      },
    });
    for (let i = 0; i < 4; i++) await adapter.step();
    assert.deepEqual(adapter.counts(), { done: 1, uncertain: 1 });
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0]?.[0], "DOTHER");
    adapter.close();
    adapter = new SlackAdapter(f.path, [binding, other], "UBOT", f.transport);
    assert.equal(await adapter.step(), false);
    assert.equal(f.posts.length, 1);
  } finally {
    adapter.close();
    f.cleanup();
  }
});

test("lost core admission response retries same mutation; binding reassignment never forwards old work", async () => {
  const f = fixture();
  const request = f.transport.request;
  let lose = true;
  f.transport.request = async (...args) => {
    const result = await request(...args);
    if (lose) {
      lose = false;
      throw new Error("Synthetic response loss");
    }
    return result;
  };
  let adapter = new SlackAdapter(f.path, [binding], "UBOT", f.transport);
  try {
    adapter.admit(mention);
    await adapter.step();
    await adapter.step();
    assert.deepEqual(f.calls[0]?.body, f.calls[1]?.body);
    adapter.close();
    adapter = new SlackAdapter(
      f.path,
      [{ ...binding, tenantId: "other-tenant" }],
      "UBOT",
      f.transport,
    );
    await adapter.step();
    assert.equal(f.calls.length, 2);
    assert.equal(f.posts.length, 0);
  } finally {
    adapter.close();
    f.cleanup();
  }
});

test("pending work has truthful deadline; oversized output has explicit omission notice", async () => {
  const f = fixture();
  let now = 1000;
  const adapter = new SlackAdapter(
    f.path,
    [binding],
    "UBOT",
    f.transport,
    () => now,
  );
  try {
    adapter.admit(mention);
    now += 300_001;
    await adapter.step();
    assert.equal(f.calls.length, 0);
    assert.match(String(f.posts[0]?.[1]), /not a cancellation/);
    f.transport.request = async (_binding, _path, body) =>
      body
        ? { id: "signed" }
        : {
            submission: { outcome: "completed" },
            messages: [
              {
                role: "assistant",
                blocks: [{ kind: "text", text: "x".repeat(5000) }],
              },
            ],
          };
    adapter.admit({ ...mention, event_id: "Ev2" });
    await adapter.step();
    await adapter.step();
    assert.ok(String(f.posts[1]?.[1]).length < 2800);
    assert.match(String(f.posts[1]?.[1]), /Answer shortened/);
  } finally {
    adapter.close();
    f.cleanup();
  }
});
