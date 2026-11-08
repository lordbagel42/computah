import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Backend } from "./backend.mjs";

test("REST boundary pages history, recovers ambiguous admission without duplicate work, and reports truthful cancellation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "computah-native-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outbox = join(dir, "outbox.json");
  const mutations = [];
  let first = true;
  let cancel = "unknown";
  let terminal = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-test-token");
    const url = new URL(req.url, "http://fixture");
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/v1/viewer")
      return reply(200, {
        version: 1,
        conversationId: "primary",
        viewer: { tenantId: "fixture", userId: "owner", agentId: "computah" },
      });
    if (url.pathname === "/v1/history") {
      const second = url.searchParams.get("cursor") === "opaque/second?";
      return reply(200, {
        version: 1,
        conversationId: "primary",
        messages: [
          { id: second ? "older" : "newer" },
          ...(terminal
            ? [
                {
                  id: "sent-user",
                  role: "user",
                  blocks: [{ kind: "text", text: "Keep this exact request" }],
                },
              ]
            : []),
        ],
        nextCursor: second ? null : "opaque/second?",
      });
    }
    if (url.pathname === "/v1/submissions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      assert.deepEqual(Object.keys(body).sort(), ["clientMutationId", "text"]);
      const saved = JSON.parse(await readFile(outbox, "utf8"));
      assert.equal(
        saved.pending.clientMutationId,
        body.clientMutationId,
        "saved before admission",
      );
      assert.equal(saved.pending.text, body.text);
      mutations.push(body);
      if (first) {
        first = false;
        return reply(503, { error: "admitted but acknowledgement lost" });
      }
      return reply(202, {
        version: 1,
        id: "signed/handle?",
        clientMutationId: body.clientMutationId,
        outcome: "accepted",
      });
    }
    if (url.pathname.endsWith("/cancel"))
      return reply(200, { submissionId: "signed/handle?", status: cancel });
    assert.equal(
      decodeURIComponent(url.pathname),
      "/v1/submissions/signed/handle?",
    );
    assert.equal(url.searchParams.get("wait"), "true");
    return reply(terminal ? 200 : 202, {
      version: 1,
      submission: {
        id: "signed/handle?",
        outcome: terminal ? "completed" : "streaming",
      },
      messages: terminal
        ? [
            {
              id: "final",
              role: "assistant",
              blocks: [{ id: "answer", kind: "text", text: "A final answer" }],
            },
          ]
        : [],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const options = {
    url: `http://127.0.0.1:${server.address().port}`,
    token: "synthetic-test-token",
    outbox,
  };
  const events = [];
  const before = new Backend({
    ...options,
    emit: (event) => events.push(event),
  });
  await before.connect();
  assert.deepEqual(
    events.find((e) => e.type === "history").messages.map((m) => m.id),
    ["newer", "older"],
  );
  await mkdir(outbox);
  await assert.rejects(before.send("Keep this exact request"));
  const failedWriteId = before.pending.clientMutationId;
  assert.equal(mutations.length, 0, "failed checkpoint must not admit");
  await rm(outbox, { recursive: true });
  await assert.rejects(before.send());
  const persisted = JSON.parse(await readFile(outbox, "utf8"));
  assert.equal(persisted.pending.id, null);
  assert.equal(persisted.pending.clientMutationId, failedWriteId);
  const after = new Backend({
    ...options,
    emit: (event) => events.push(event),
  });
  await after.connect();
  assert.equal(after.pending.clientMutationId, mutations[0].clientMutationId);
  await assert.rejects(after.send("A different request"));
  const running = after.send();
  while (!after.pending.id)
    await new Promise((resolve) => setTimeout(resolve, 10));
  for (const status of ["unknown", "too-late", "cancelled"]) {
    cancel = status;
    await after.cancel();
  }
  assert(events.some((e) => e.text?.includes("Cancellation unknown")));
  assert(events.some((e) => e.text?.includes("Too late")));
  assert(events.some((e) => e.text?.includes("Cancellation confirmed")));
  terminal = true;
  await running;
  assert.equal(mutations.length, 2);
  assert.deepEqual(mutations[0], mutations[1]);
  assert.equal(JSON.parse(await readFile(outbox, "utf8")).pending, null);
  assert(
    events
      .filter((e) => e.type === "history")
      .at(-1)
      .messages.some((m) => m.id === "sent-user"),
  );
  assert.equal(
    events.find((e) => e.type === "result").messages[0].blocks[0].text,
    "A final answer",
  );
  await assert.rejects(after.send('"'.repeat(70000)));
  assert.equal(
    after.pending,
    null,
    "rejected request must not strand an outbox entry",
  );
  assert.equal(mutations.length, 2);
});
