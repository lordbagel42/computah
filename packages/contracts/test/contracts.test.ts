import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Schema } from "effect";
import { applyEvent, Snapshot, StreamEvent } from "../src/index.js";
import { createMockSession } from "../src/mock.js";

const viewer = {
  tenantId: "alpha",
  userId: "same-user",
  agentId: "june",
  displayName: "June",
  capabilities: ["message.send", "message.cancel"],
};

test("send retries deduplicate, conflicting payloads fail and host scope cannot be supplied", async () => {
  const session = createMockSession(viewer);
  const request = {
    conversationId: session.conversationId,
    clientMutationId: "first",
    text: "PRIVATE ALPHA",
  };
  const first = await session.adapter.send(request);
  assert.equal((await session.adapter.send(request)).id, first.id);
  assert.equal(
    (await session.adapter.snapshot(session.conversationId)).messages.length,
    1,
  );
  await assert.rejects(
    session.adapter.send({ ...request, text: "changed" }),
    /conflict/,
  );
  await assert.rejects(
    session.adapter.send({ ...request, tenantId: "other" } as typeof request),
    /tenantId/,
  );

  const other = createMockSession({ ...viewer, tenantId: "beta" });
  await assert.rejects(
    other.adapter.snapshot(session.conversationId),
    /not-found/,
  );
  await assert.rejects(
    other.adapter.cancel({
      conversationId: other.conversationId,
      submissionId: first.id,
      clientMutationId: "cancel",
    }),
    /not-found/,
  );
  const forbidden = other.adapter
    .subscribe({ conversationId: session.conversationId, cursor: "" })
    [Symbol.asyncIterator]();
  await assert.rejects(forbidden.next(), /not-found/);
  assert.equal(
    JSON.stringify(await other.adapter.snapshot(other.conversationId)).includes(
      "PRIVATE ALPHA",
    ),
    false,
  );

  const readOnlyViewer = { ...viewer, capabilities: [] as string[] };
  const readOnly = createMockSession(readOnlyViewer);
  readOnlyViewer.capabilities.push("message.send");
  await assert.rejects(
    readOnly.adapter.send({
      ...request,
      conversationId: readOnly.conversationId,
    }),
    /forbidden/,
  );
});

test("snapshot plus replay converges, deduplicates and reports foreign/expired cursors", async () => {
  const session = createMockSession(viewer);
  let projected = await session.adapter.snapshot(session.conversationId);
  const controller = new AbortController();
  const stream = session.adapter
    .subscribe(
      { conversationId: session.conversationId, cursor: projected.cursor },
      controller.signal,
    )
    [Symbol.asyncIterator]();
  const awaiting = stream.next();
  const submission = await session.adapter.send({
    conversationId: session.conversationId,
    clientMutationId: "replay",
    text: "hello",
  });
  const first = (await awaiting).value;
  assert.ok(first);
  projected = applyEvent(projected, first);
  assert.deepEqual(applyEvent(projected, first), projected);
  session.advance(submission.id, "streaming", "Par");
  session.advance(submission.id, "completed", "Particular reply");
  for (let i = 0; i < 5; i++) {
    const next = (await stream.next()).value;
    assert.ok(next);
    projected = applyEvent(projected, next);
  }
  assert.deepEqual(
    projected,
    await session.adapter.snapshot(session.conversationId),
  );
  controller.abort();
  assert.equal((await stream.next()).done, true);
  const gap = session.adapter
    .subscribe({
      conversationId: session.conversationId,
      cursor: "another-user-cursor",
    })
    [Symbol.asyncIterator]();
  assert.equal((await gap.next()).value?.kind, "resync-required");
  assert.equal((await gap.next()).done, true);
});

test("confirmed cancellation is terminal, but unknown effects are not falsely cancelled", async () => {
  const session = createMockSession(viewer);
  const first = await session.adapter.send({
    conversationId: session.conversationId,
    clientMutationId: "one",
    text: "one",
  });
  const cancel = {
    conversationId: session.conversationId,
    submissionId: first.id,
    clientMutationId: "cancel-one",
  };
  assert.equal((await session.adapter.cancel(cancel)).status, "cancelled");
  assert.equal((await session.adapter.cancel(cancel)).status, "cancelled");
  assert.throws(() => session.advance(first.id, "completed"), /conflict/);
  const second = await session.adapter.send({
    conversationId: session.conversationId,
    clientMutationId: "two",
    text: "two",
  });
  session.advance(second.id, "unknown");
  assert.equal(
    (
      await session.adapter.cancel({
        ...cancel,
        submissionId: second.id,
        clientMutationId: "cancel-two",
      })
    ).status,
    "unknown",
  );
  await assert.rejects(
    session.adapter.cancel({ ...cancel, submissionId: second.id }),
    /conflict/,
  );
  session.advance(second.id, "completed", "Reconciled");
  assert.equal(
    (
      await session.adapter.cancel({
        ...cancel,
        submissionId: second.id,
        clientMutationId: "cancel-late",
      })
    ).status,
    "too-late",
  );
});

test("client refuses gaps and late output that would resurrect terminal work", async () => {
  const session = createMockSession(viewer);
  const submission = await session.adapter.send({
    conversationId: session.conversationId,
    clientMutationId: "one",
    text: "one",
  });
  await session.adapter.cancel({
    conversationId: session.conversationId,
    submissionId: submission.id,
    clientMutationId: "cancel",
  });
  const state = await session.adapter.snapshot(session.conversationId);
  const event: StreamEvent = {
    version: 1,
    eventId: "late",
    cursor: "late",
    conversationId: session.conversationId,
    revision: state.revision + 1,
    kind: "message",
    message: {
      id: "late",
      submissionId: submission.id,
      role: "assistant",
      createdAt: "2026-01-01T12:00:00.000Z",
      revision: 0,
      blocks: [{ id: "b", kind: "text", text: "Too late" }],
    },
  };
  assert.throws(() => applyEvent(state, event), /terminal/);
  assert.throws(
    () => applyEvent(state, { ...event, revision: state.revision + 2 }),
    /Snapshot required/,
  );
});

test("portable snapshot fixture validates and rejects executable component props", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/v1/conversation.json", import.meta.url),
      "utf8",
    ),
  );
  const decode = Schema.decodeUnknownSync(Snapshot);
  assert.equal(
    decode(fixture.snapshot).messages[0]?.blocks[0]?.kind,
    "component",
  );
  assert.throws(() => decode({ ...fixture.snapshot, version: 2 }));
  const executable = {
    ...fixture.snapshot,
    messages: [
      {
        ...fixture.snapshot.messages[0],
        blocks: [
          {
            ...fixture.snapshot.messages[0].blocks[0],
            props: { run: () => "unsafe" },
          },
        ],
      },
    ],
  };
  assert.throws(() => decode(executable));
  let state = decode(fixture.snapshot);
  for (const input of fixture.events) {
    state = applyEvent(state, Schema.decodeUnknownSync(StreamEvent)(input));
  }
  assert.equal(state.submissions[0]?.outcome, "completed");
  assert.deepEqual(state.messages[2]?.blocks, [
    { id: "b2", kind: "text", text: "Hello from the synthetic fixture." },
  ]);
});

test("closing an idle subscription settles pending reads without abort or new events", {
  timeout: 1000,
}, async () => {
  for (const signal of [undefined, new AbortController().signal]) {
    const session = createMockSession(viewer);
    const state = await session.adapter.snapshot(session.conversationId);
    const iterator = session.adapter
      .subscribe(
        { conversationId: session.conversationId, cursor: state.cursor },
        signal,
      )
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    assert.ok(iterator.return);
    const [read, closed] = await Promise.all([pending, iterator.return()]);
    assert.equal(read.done, true);
    assert.equal(closed.done, true);
    await session.adapter.send({
      conversationId: session.conversationId,
      clientMutationId: "after-close",
      text: "not delivered",
    });
    assert.equal((await iterator.next()).done, true);
  }
});
