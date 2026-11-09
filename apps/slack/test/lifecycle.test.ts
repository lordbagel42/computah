import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  type Binding,
  type Ingress,
  SlackAdapter,
  type Transport,
} from "../src/adapter.js";
import {
  CoreDenied,
  readAcknowledgement,
  type StreamUpdate,
} from "../src/lifecycle.js";

const owner: Binding = {
  teamId: "TTEST",
  slackUserId: "UOWNER",
  tenantId: "tenant",
  userId: "owner",
  agentId: "private",
  coreToken: "synthetic-core-token",
  channelIds: ["CALLOWED"],
  channelBindings: [
    {
      channelId: "CALLOWED",
      tenantId: "tenant",
      userId: "shared",
      agentId: "channel",
      coreToken: "synthetic-channel-token",
    },
  ],
};
const input = (
  id: string,
  text: string,
  overrides: Partial<NonNullable<Ingress["event"]>> = {},
): Ingress => ({
  team_id: "TTEST",
  event_id: id,
  event: {
    type: "message",
    channel_type: "im",
    channel: "DOWNER",
    user: "UOWNER",
    ts: `${id}.001`,
    text,
    ...overrides,
  },
});

function fixture(bindings = [owner]) {
  const dir = mkdtempSync(join(tmpdir(), "slack-lifecycle-"));
  const path = join(dir, "inbox.sqlite");
  const calls: { binding: Binding; path: string; body?: unknown }[] = [];
  const posts: [string, string, string | null][] = [];
  let now = 10_000;
  let outcome = "streaming";
  let cancel: unknown = { submissionId: "signed-handle", status: "cancelled" };
  let failPost = false;
  let failSubmit = false;
  const transport: Transport = {
    async request(binding, path, body) {
      calls.push({ binding, path, body });
      if (path.endsWith("/cancel")) {
        if (cancel instanceof Error) throw cancel;
        return cancel;
      }
      if (body) {
        if (failSubmit) throw new Error("lost admission response");
        return { id: "signed-handle" };
      }
      return {
        submission: { outcome },
        messages: [
          {
            role: "assistant",
            blocks: [{ kind: "text", text: "final answer" }],
          },
        ],
      };
    },
    async post(channel, text, thread) {
      posts.push([channel, text, thread]);
      if (failPost) throw new Error("ambiguous delivery");
    },
    async openDm() {
      throw new Error("unexpected DM open");
    },
    async status() {
      return "ok";
    },
    async acknowledgement() {
      return null;
    },
  };
  let adapter = new SlackAdapter(
    path,
    bindings,
    "UBOT",
    transport,
    () => now,
    false,
    1200,
    true,
  );
  return {
    calls,
    posts,
    transport,
    get adapter() {
      return adapter;
    },
    advance(ms = 6000) {
      now += ms;
    },
    outcome(value: string) {
      outcome = value;
    },
    cancel(value: unknown) {
      cancel = value;
    },
    legacyStream() {
      const db = new DatabaseSync(path);
      db.prepare(
        "UPDATE job_lifecycle SET progress=1, stream=? WHERE kind='work'",
      ).run(
        JSON.stringify({
          state: "open",
          phase: "worker",
          ts: "15.001",
          next: 0,
          attempts: 0,
        }),
      );
      db.close();
    },
    failPost() {
      failPost = true;
    },
    failSubmit(value: boolean) {
      failSubmit = value;
    },
    reopen(next = bindings) {
      adapter.close();
      adapter = new SlackAdapter(
        path,
        next,
        "UBOT",
        transport,
        () => now,
        false,
        1200,
        true,
      );
    },
    close() {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("legacy native cards survive reopen without new appends and close independently of the final answer", async () => {
  const f = fixture();
  const updates: StreamUpdate[] = [];
  f.transport.stream = async (_binding, update) => {
    updates.push(update);
    return { status: "ok", ts: "15.001" };
  };
  try {
    f.adapter.admit(input("1", "work", { thread_ts: "1.000" }));
    f.advance();
    await f.adapter.step();
    f.legacyStream();
    await f.adapter.step();
    assert.equal(updates.length, 0);
    f.reopen();
    f.advance();
    await f.adapter.step();
    f.reopen();
    f.advance();
    await f.adapter.step();
    assert.equal(updates.length, 0, "legacy cards never append new activity");
    f.outcome("completed");
    await f.adapter.step();
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0][1], "final answer");
    f.reopen();
    await f.adapter.step();
    assert.equal(updates[0].terminal, "completed");
    assert.equal(updates[0].ts, "15.001");
    f.reopen();
    await f.adapter.step();
    assert.equal(updates.length, 1);
    assert.equal(f.posts.length, 1);
  } finally {
    f.close();
  }
});

test("new work never starts phase cards or canned fallbacks, including in a source thread", async () => {
  for (const acknowledgement of [null, "i'll compare those options."]) {
    const f = fixture();
    let starts = 0;
    f.transport.stream = async () => {
      starts++;
      throw new Error("must not start a new native stream");
    };
    f.transport.acknowledgement = async () => acknowledgement;
    try {
      f.adapter.admit(input("1", "work", { thread_ts: "1.000" }));
      f.advance();
      await f.adapter.step();
      await f.adapter.step();
      f.reopen();
      f.advance();
      await f.adapter.step();
      assert.equal(starts, 0);
      assert.deepEqual(
        f.posts.map((post) => post[1]),
        acknowledgement ? [acknowledgement] : [],
      );
      f.outcome("completed");
      await f.adapter.step();
      await f.adapter.step();
      assert.equal(f.posts.at(-1)?.[1], "final answer");
      assert.equal(starts, 0);
    } finally {
      f.close();
    }
  }
});

test("legacy card cleanup is bounded, restart-safe and does not block failed or cancelled final delivery", async () => {
  for (const terminal of ["failed", "cancelled"]) {
    const f = fixture();
    let closes = 0;
    f.transport.stream = async (_binding, update) => {
      if (update.ts) {
        assert.equal(update.ts, "15.001");
        assert.equal(update.terminal, terminal);
        closes++;
        throw new Error("lost close response");
      }
      return { status: "ok", ts: "15.001" };
    };
    try {
      f.adapter.admit(input("1", "work", { thread_ts: "1.000" }));
      f.advance();
      await f.adapter.step();
      f.legacyStream();
      await f.adapter.step();
      if (terminal === "cancelled") {
        f.adapter.admit(input("2", "stop", { thread_ts: "1.000" }));
        await f.adapter.step();
        assert.match(f.posts[0][1], /Core confirmed cancellation/);
      }
      f.outcome(terminal);
      await f.adapter.step();
      assert.match(
        f.posts.at(-1)?.[1] ?? "",
        new RegExp(`status: ${terminal}`),
      );
      for (let i = 0; i < 5; i++) {
        f.reopen();
        f.advance(30_001);
        await f.adapter.step();
      }
      assert.equal(closes, 3);
      assert.equal(
        f.calls.filter((c) => c.path.endsWith("/cancel")).length,
        terminal === "cancelled" ? 1 : 0,
      );
    } finally {
      f.close();
    }
  }
});

test("top-level source never becomes a native stream even when reply preference is threaded", async () => {
  const f = fixture();
  f.transport.acknowledgement = async () => "i'll check that.";
  f.transport.stream = async () => {
    throw new Error("must not stream top-level origin");
  };
  try {
    f.adapter.admit(input("1", "reply in thread: work"));
    f.advance();
    await f.adapter.step();
    await f.adapter.step();
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0][2], null);
  } finally {
    f.close();
  }
});

test("ambiguous final delivery remains unreplayed while its known card is cleaned up", async () => {
  const f = fixture();
  const updates: StreamUpdate[] = [];
  f.transport.stream = async (_binding, update) => {
    updates.push(update);
    return { status: "ok", ts: "15.001" };
  };
  try {
    f.adapter.admit(input("1", "work", { thread_ts: "1.000" }));
    f.advance();
    await f.adapter.step();
    f.legacyStream();
    await f.adapter.step();
    f.failPost();
    f.outcome("completed");
    await f.adapter.step();
    f.reopen();
    await f.adapter.step();
    f.reopen();
    await f.adapter.step();
    assert.equal(f.posts.length, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].terminal, "completed");
    assert.equal(updates[0].ts, "15.001");
  } finally {
    f.close();
  }
});

test("requested cancellation remains nonterminal and card shutdown does not cancel native work", async () => {
  const f = fixture();
  const ends: StreamUpdate[] = [];
  f.transport.stream = async (_binding, update) => {
    if (update.terminal) ends.push(update);
    return { status: "ok", ts: "15.001" };
  };
  try {
    f.adapter.admit(input("1", "work", { thread_ts: "1.000" }));
    f.advance();
    await f.adapter.step();
    f.legacyStream();
    await f.adapter.step();
    f.cancel({ submissionId: "signed-handle", status: "requested" });
    f.adapter.admit(input("2", "stop", { thread_ts: "1.000" }));
    await f.adapter.step();
    assert.match(
      f.posts[0][1],
      /accepted the cancellation request; completion is not yet confirmed/,
    );
    assert.match(f.posts[0][1], /effects may still be running/);
    assert.equal(ends.length, 0);
    f.reopen();
    f.cancel({ submissionId: "signed-handle", status: "cancelled" });
    f.adapter.admit(input("3", "stop", { thread_ts: "1.000" }));
    await f.adapter.step();
    assert.match(f.posts[1][1], /Core confirmed cancellation/);
    assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 2);
    await f.adapter.stop();
    assert.equal(
      ends[0].terminal,
      "cancelled",
      "shutdown must not overwrite confirmed terminal intent",
    );
    assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 2);
  } finally {
    f.close();
  }
});

test("legacy user-stopped display is not cancellation authority and cleanup never restarts it", async () => {
  for (const stopped of [true, false]) {
    const f = fixture();
    let closes = 0;
    f.transport.stream = async (_binding, update) => {
      if (update.terminal) {
        closes++;
        if (!stopped) throw new Error("lost cleanup response");
        return { status: "closed" };
      }
      throw new Error("no starts or appends");
    };
    try {
      f.adapter.admit(input("1", "work", { thread_ts: "1.000" }));
      f.advance();
      await f.adapter.step();
      f.legacyStream();
      await f.adapter.step();
      f.advance();
      await f.adapter.step();
      f.reopen();
      f.advance();
      await f.adapter.step();
      assert.equal(closes, 0);
      assert.equal(
        f.calls.some((c) => c.path.endsWith("/cancel")),
        false,
      );
      await f.adapter.stop();
      assert.equal(closes, 1);
      assert.equal(
        f.calls.some((c) => c.path.endsWith("/cancel")),
        false,
      );
    } finally {
      f.close();
    }
  }
});

test("stop freezes its target before ACK, bypasses batching and withdraws without model work after reopen", async () => {
  const f = fixture();
  try {
    assert.equal(f.adapter.admit(input("1", "first")), "accepted");
    const stop = input("2", "stop");
    assert.equal(f.adapter.admit(stop), "accepted");
    assert.equal(f.adapter.admit(stop), "duplicate");
    // A newer request must not steal the already admitted control's target.
    f.adapter.admit(input("3", "newer"));
    f.reopen();
    await f.adapter.step();
    assert.equal(f.calls.length, 0);
    assert.match(f.posts[0][1], /Stopped your queued request/);
    assert.equal(f.posts[0][2], null);
    f.advance();
    await f.adapter.step();
    assert.equal(
      (f.calls[0].body as { text: string }).text.startsWith("newer\n"),
      true,
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.adapter.admit(stop), "duplicate");
  } finally {
    f.close();
  }
});

test("stop targets actual DM source thread, not reply placement; bursts cannot mix different sources", async () => {
  const f = fixture();
  try {
    f.adapter.admit(
      input("1", "reply top-level: work", { thread_ts: "10.001" }),
    );
    f.adapter.admit(input("2", "stop", { thread_ts: "10.001" }));
    f.reopen();
    await f.adapter.step();
    assert.equal(f.calls.length, 0);
    assert.match(f.posts[0][1], /Stopped your queued request/);
    // Equal requested reply placement cannot merge different source threads.
    f.adapter.admit(
      input("3", "reply top-level: first", { thread_ts: "20.001" }),
    );
    f.adapter.admit(
      input("4", "reply top-level: second", { thread_ts: "30.001" }),
    );
    f.adapter.admit(input("5", "stop", { thread_ts: "20.001" }));
    await f.adapter.step();
    assert.match(f.posts[1][1], /Stopped your queued request/);
    assert.equal(f.calls.length, 0);
    f.advance();
    await f.adapter.step();
    assert.match((f.calls[0].body as { text: string }).text, /^second\n/);
  } finally {
    f.close();
  }
});

test("submitted stop uses durable scope/handle after reopen and never sends the command to the model", async () => {
  const f = fixture();
  try {
    f.adapter.admit(input("1", "work"));
    f.advance();
    await f.adapter.step();
    f.adapter.admit(input("2", "stop current"));
    f.reopen();
    await f.adapter.step();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].path, "/v1/submissions/signed-handle/cancel");
    assert.equal(f.calls[1].binding.agentId, "private");
    assert.deepEqual(f.calls[1].body, {});
    assert.match(f.posts[0][1], /Core confirmed cancellation/);
    f.outcome("cancelled");
    await f.adapter.step();
    assert.deepEqual(f.adapter.counts(), { done: 2 });
  } finally {
    f.close();
  }
});

test("stop after lost admission response fences retries without creating model work or claiming cancellation", async () => {
  const f = fixture();
  try {
    f.adapter.admit(input("1", "work"));
    f.advance();
    f.failSubmit(true);
    await f.adapter.step();
    f.adapter.admit(input("2", "stop"));
    f.reopen();
    f.failSubmit(false);
    await f.adapter.step();
    assert.equal(f.calls.length, 1);
    assert.match(
      f.posts[0][1],
      /Cancellation is not confirmed: core admission was interrupted/,
    );
    assert.equal(f.adapter.counts().unresolved, 1);
    f.reopen();
    assert.equal(await f.adapter.step(), false);
    assert.equal(f.calls.length, 1);
  } finally {
    f.close();
  }
});

test("cancellation outcomes stay truthful, and ambiguous confirmation sends never replay", async () => {
  for (const [result, expected] of [
    [{ submissionId: "signed-handle", status: "unknown" }, /not confirmed/],
    [{ submissionId: "signed-handle", status: "too-late" }, /too late/],
    [new CoreDenied(), /Core denied cancellation/],
    [new Error("private provider error"), /could not be confirmed/],
    [
      { submissionId: "foreign", status: "cancelled" },
      /could not be confirmed/,
    ],
  ] as const) {
    const f = fixture();
    try {
      f.transport.acknowledgement = undefined;
      f.adapter.admit(input("1", "work"));
      f.advance();
      await f.adapter.step();
      f.cancel(result);
      f.adapter.admit(input("2", "stop"));
      f.failPost();
      await f.adapter.step();
      assert.match(f.posts[0][1], expected);
      assert.equal(f.adapter.counts().uncertain, 1);
      f.reopen();
      await f.adapter.step();
      assert.equal(f.posts.length, 1);
      assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 1);
    } finally {
      f.close();
    }
  }
});

test("channel stop cannot select private, foreign sender, or another thread work", async () => {
  const f = fixture();
  const channel = {
    type: "app_mention",
    channel: "CALLOWED",
    channel_type: "channel",
    thread_ts: "10.001",
  };
  try {
    f.adapter.admit(input("1", "private work"));
    f.advance();
    await f.adapter.step();
    f.adapter.admit(input("2", "<@UBOT> stop", channel));
    await f.adapter.step();
    assert.match(f.posts.at(-1)?.[1] ?? "", /No active work from you/);
    assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
    // With no shared-scope peer, the channel still cannot target the private job.
    f.reopen([owner]);
    f.adapter.admit(input("3", "<@UBOT> stop", channel));
    await f.adapter.step();
    assert.match(f.posts.at(-1)?.[1] ?? "", /No active work from you/);
    f.adapter.admit(input("4", "<@UBOT> work", channel));
    f.adapter.admit(
      input("5", "<@UBOT> stop", { ...channel, thread_ts: "20.001" }),
    );
    await f.adapter.step();
    assert.match(f.posts.at(-1)?.[1] ?? "", /No active work from you/);
    assert.equal(
      f.adapter.admit(input("6", "stop", { user: "UFOREIGN" })),
      "ignored",
    );
    assert.equal(f.calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
  } finally {
    f.close();
  }
});

test("retired senders retain a durable coalescing fence after bindings disappear", async () => {
  const peer: Binding = {
    ...owner,
    slackUserId: "UPEER",
    userId: "peer",
    agentId: "peer-private",
  };
  const f = fixture([owner, peer]);
  const channel = {
    type: "app_mention",
    channel: "CALLOWED",
    channel_type: "channel",
    thread_ts: "10.001",
  };
  try {
    f.adapter.admit(
      input("1", "<@UBOT> peer work", { ...channel, user: "UPEER" }),
    );
    f.advance();
    await f.adapter.step();
    f.reopen([owner]);
    await f.adapter.step(); // Lost binding does not settle native work.
    f.adapter.admit(input("2", "<@UBOT> owner work", channel));
    f.advance();
    await f.adapter.step();
    f.adapter.admit(input("3", "<@UBOT> stop", channel));
    f.reopen([owner]);
    await f.adapter.step();
    assert.match(f.posts[0][1], /Stop is unavailable/);
    assert.equal(
      f.calls.filter((call) => call.path.endsWith("/cancel")).length,
      0,
    );
  } finally {
    f.close();
  }
});

test("working acknowledgement stays at the source even when final reply placement differs", async () => {
  for (const [text, source, expected] of [
    ["reply in thread: work", undefined, null],
    ["reply top-level: work", "10.001", "10.001"],
  ] as const) {
    const f = fixture();
    f.transport.acknowledgement = async () => "i'll check that.";
    try {
      f.adapter.admit(input("1", text, { thread_ts: source }));
      f.advance();
      await f.adapter.step();
      await f.adapter.step();
      assert.equal(f.posts[0][2], expected);
      f.adapter.admit(input("2", "stop", { thread_ts: source }));
      await f.adapter.step();
      assert.match(f.posts[1][1], /Core confirmed cancellation/);
    } finally {
      f.close();
    }
  }
});

test("working acknowledgement is brief, at most one attempt across reopen/uncertain send, and preserves top-level DM", async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    f.transport.acknowledgement = async () => "i'll compare those options.";
    try {
      f.adapter.admit(input("1", "work"));
      f.advance();
      await f.adapter.step();
      if (failed) f.failPost();
      await f.adapter.step();
      assert.deepEqual(f.posts, [
        ["DOWNER", "i'll compare those options.", null],
      ]);
      f.reopen();
      await f.adapter.step();
      assert.equal(f.posts.length, 1);
      if (!failed) {
        f.outcome("completed");
        await f.adapter.step();
        assert.equal(f.posts[1][1], "final answer");
        assert.equal(f.posts[1][2], null);
      }
    } finally {
      f.close();
    }
  }
});

test("slow silent utilities and failed observations stay silent; a later chosen acknowledgement is not consumed", async () => {
  for (const observed of [
    null,
    "",
    " ",
    "x".repeat(3501),
    new Error("unavailable"),
  ]) {
    const f = fixture();
    f.transport.acknowledgement = async () => {
      if (observed instanceof Error) throw observed;
      return observed;
    };
    try {
      f.adapter.admit(input("1", "quick utility"));
      f.advance(1200);
      await f.adapter.step();
      for (let i = 0; i < 3; i++) {
        f.advance(60_000);
        await f.adapter.step();
        assert.deepEqual(
          f.posts,
          [],
          "time alone must never generate a placeholder",
        );
        f.reopen();
      }
      f.transport.acknowledgement = async () => "i'll compare those options.";
      await f.adapter.step();
      assert.deepEqual(f.posts, [
        ["DOWNER", "i'll compare those options.", null],
      ]);
      f.outcome("completed");
      await f.adapter.step();
      assert.deepEqual(
        f.posts.map((p) => p[1]),
        ["i'll compare those options.", "final answer"],
      );
    } finally {
      f.close();
    }
  }
});

test("chosen acknowledgement has no age gate; completed polls and stop admitted during observation suppress it", async () => {
  for (const state of ["pending", "completed", "stop"] as const) {
    const f = fixture();
    let reads = 0;
    f.transport.acknowledgement = async () => {
      reads++;
      if (state === "stop") f.adapter.admit(input("2", "stop"));
      return "i'll check those sources.";
    };
    try {
      f.adapter.admit(input("1", "research"));
      f.advance(1200); // Only the existing burst admission quiet window.
      await f.adapter.step();
      if (state === "completed") f.outcome("completed");
      await f.adapter.step();
      assert.deepEqual(
        f.posts.map((post) => post[1]),
        state === "pending"
          ? ["i'll check those sources."]
          : state === "completed"
            ? ["final answer"]
            : [],
      );
      assert.equal(reads, state === "completed" ? 0 : 1);
    } finally {
      f.close();
    }
  }
});

test("pending acknowledgement cannot block answers or stop, and late observations cannot post stale progress", async () => {
  for (const terminal of ["answer", "stop", "shutdown", "timeout"] as const) {
    const f = fixture();
    let release!: (value: string) => void;
    let reads = 0;
    let signal: AbortSignal | undefined;
    f.transport.acknowledgement = async (
      _binding,
      _submission,
      observedSignal,
    ) => {
      reads++;
      signal = observedSignal;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    let pending: Promise<boolean> | undefined;
    try {
      f.adapter.admit(input("1", "research"));
      f.advance();
      await f.adapter.step();
      pending = f.adapter.step();
      assert.equal(
        await Promise.race([
          pending.then(() => "ready"),
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 100)),
        ]),
        "ready",
        "optional observation must not hold the delivery pump",
      );
      await f.adapter.step();
      assert.equal(reads, 1, "only one observation may remain in flight");
      if (terminal === "answer") {
        f.outcome("completed");
        await f.adapter.step();
        assert.deepEqual(f.posts, [["DOWNER", "final answer", null]]);
      } else if (terminal === "stop") {
        f.adapter.admit(input("2", "stop"));
        await f.adapter.step();
        assert.match(f.posts[0][1], /Core confirmed cancellation/);
      } else if (terminal === "shutdown") {
        await f.adapter.stop();
        assert.equal(signal?.aborted, true);
        assert.deepEqual(f.posts, []);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 2100));
        assert.equal(signal?.aborted, true);
        assert.equal(signal?.reason.name, "TimeoutError");
      }
      const posts = [...f.posts];
      release("i'll check those sources.");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        f.posts,
        posts,
        "late progress must not follow a terminal outcome",
      );
      if (terminal === "timeout") {
        f.transport.acknowledgement = async () => "i'll check those sources.";
        await f.adapter.step();
        assert.deepEqual(f.posts, [
          ["DOWNER", "i'll check those sources.", null],
        ]);
      }
    } finally {
      release?.("late observation");
      await pending;
      await new Promise((resolve) => setImmediate(resolve));
      f.close();
    }
  }
});

test("observation reader consumes one bounded resync, ignores text/envelopes and closes the stream", async () => {
  let closed = false;
  const frame = {
    kind: "resync",
    submissionId: "signed",
    observations: [
      {
        submissionId: "signed",
        source: "interaction",
        workerLabel: null,
        phase: "generating",
        text: '{"requestId":"private-partial-envelope"}',
        acknowledgement: "i'll compare those options.",
      },
      {
        submissionId: "signed",
        source: "worker",
        phase: "generating",
        text: "private-worker-output",
        workerLabel: "private-label",
        acknowledgement: "must never use Worker text",
      },
    ],
  };
  const response = new Response(
    new ReadableStream({
      start(controller) {
        const encoded = new TextEncoder().encode(
          `data: ${JSON.stringify(frame)}\n\n`,
        );
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17));
      },
      cancel() {
        closed = true;
      },
    }),
  );
  assert.equal(
    await readAcknowledgement(response, "signed"),
    "i'll compare those options.",
  );
  assert.equal(closed, true);
  assert.equal(
    await readAcknowledgement(
      new Response(`data: ${JSON.stringify(frame)}\n\n`),
      "foreign",
    ),
    null,
  );
  assert.equal(
    await readAcknowledgement(
      new Response('data: {"kind":"result","submissionId":"signed"}\n\n'),
      "signed",
    ),
    null,
  );
  await assert.rejects(
    readAcknowledgement(new Response("x".repeat(128_001)), "signed"),
    /too large/,
  );
  for (const override of [
    { acknowledgement: undefined },
    { acknowledgement: "" },
    { acknowledgement: 3 },
    { acknowledgement: "x".repeat(3501) },
    { source: "worker" },
    { workerLabel: "private" },
    { submissionId: "foreign" },
    { phase: "completed" },
  ]) {
    const observations = [
      { ...frame.observations[0], ...override },
      frame.observations[1],
    ];
    assert.equal(
      await readAcknowledgement(
        new Response(`data: ${JSON.stringify({ ...frame, observations })}\n\n`),
        "signed",
      ),
      null,
    );
  }
});
