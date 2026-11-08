import { createHmac, timingSafeEqual } from "node:crypto";
import { OperatorHistoryPage, OperatorSnapshot } from "@computah/contracts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { expect, test } from "vitest";
import { CoreError, interactionId, workerId } from "../src/core.js";
import { createOperatorProjection } from "../src/operator.js";

const scope = { tenantId: "test", userId: "alice", agentId: "computah" };
const entry = (
  id: number,
  kind: string,
  model: NonNullable<EntryRecord["model"]>,
): EntryRecord => ({
  id: id as EntryRecord["id"],
  conversationId: 1 as EntryRecord["conversationId"],
  kind,
  model,
});
const task = (id: string, label: string) =>
  fauxAssistantMessage(
    [
      {
        ...fauxToolCall("Task", { worker: label, text: "PRIVATE ARGUMENT" }),
        id,
      },
    ],
    { stopReason: "toolUse" },
  );

function fixture(
  readExisting: (
    id: string,
    cursor?: Cursor,
  ) => Promise<Page<EntryRecord, Cursor> | null>,
) {
  const viewer = {
    ...scope,
    displayName: "Computah",
    capabilities: ["history.read", "operator.read"],
    tokenHash: "PRIVATE TOKEN HASH",
  };
  let allowed = true;
  const sign = (data: string) =>
    createHmac("sha256", "synthetic-secret-not-a-credential")
      .update(JSON.stringify([scope, "operator-history", data]))
      .digest("base64url");
  const projection = createOperatorProjection({
    mode: "faux",
    viewer,
    session: {
      interactionId: interactionId(scope),
      workerId: (label) => workerId(scope, label),
    },
    readExisting,
    authorize: async () => {
      if (!allowed) throw new CoreError("denied");
    },
    redactValues: ["LOCAL-EXAMPLE-SECRET"],
    privilegedUrlPrefixes: ["https://provider.invalid/admin/"],
    seal: (value) => {
      const data = Buffer.from(JSON.stringify(value)).toString("base64url");
      return `${data}.${sign(data)}`;
    },
    open: (cursor) => {
      const [data, signature, extra] = cursor.split(".");
      if (!data || !signature || extra !== undefined)
        throw new CoreError("denied");
      const a = Buffer.from(signature);
      const b = Buffer.from(sign(data));
      if (a.length !== b.length || !timingSafeEqual(a, b))
        throw new CoreError("denied");
      return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    },
  });
  return {
    projection,
    viewer,
    revoke: () => {
      allowed = false;
    },
  };
}

test("operator projection exposes scoped transcript evidence, not tool payloads or invented actors", async () => {
  const pages = new Map<string, Page<EntryRecord, Cursor>>([
    [
      interactionId(scope),
      {
        items: [
          entry(1, "pi.user", [
            {
              role: "user",
              content:
                "Public user text LOCAL-EXAMPLE-SECRET https://provider.invalid/admin/session?id=123 https://example.com/readme https://public.invalid/,https://provider.invalid/admin/session?id=456",
              timestamp: 1,
            },
          ]),
          entry(2, "pi.assistant", [
            task("call-a", "research"),
            task("call-b", "missing"),
            task(
              "call-c",
              "https://public.invalid/,https://provider.invalid/admin/session?id=456",
            ),
            task(
              "https://public.invalid/,https://provider.invalid/admin/session?id=789",
              "other",
            ),
          ]),
          entry(3, "pi.tool", [
            {
              role: "toolResult",
              toolCallId: "call-a",
              toolName: "Task",
              content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }],
              isError: true,
              timestamp: 3,
            },
          ]),
          entry(4, "pi.assistant", [
            fauxAssistantMessage([
              { type: "thinking", thinking: "PRIVATE REASONING" },
              { type: "text", text: "Public final answer" },
            ]),
          ]),
        ],
        next: { after: 4 },
      },
    ],
    [workerId(scope, "research"), { items: [], next: { after: 10 } }],
  ]);
  const { projection } = fixture(async (id, cursor) =>
    cursor?.after === 10
      ? {
          items: [
            entry(11, "pi.assistant", [
              fauxAssistantMessage("Worker continuation"),
            ]),
          ],
        }
      : (pages.get(id) ?? null),
  );
  const snapshot = Schema.decodeUnknownSync(OperatorSnapshot)(
    await projection.snapshot(),
  );
  expect(snapshot.tasks.map((item) => item.status)).toEqual([
    "result-recorded",
    "recorded",
  ]);
  expect(
    snapshot.workers.map((item) => [
      item.label,
      item.availability,
      item.messages,
    ]),
  ).toEqual([
    ["research", "present", []],
    ["missing", "missing", []],
  ]);
  expect(
    snapshot.interaction.messages.flatMap((message) => message.blocks),
  ).toEqual([
    {
      id: "text-1",
      kind: "text",
      text: "Public user text [redacted] [redacted URL] https://example.com/readme [redacted URL]",
    },
    { id: "text-4", kind: "text", text: "Public final answer" },
  ]);
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  expect(JSON.stringify(snapshot)).not.toContain("LOCAL-EXAMPLE-SECRET");
  expect(JSON.stringify(snapshot)).not.toContain(
    "https://provider.invalid/admin/",
  );
  const cursor = snapshot.workers[0]?.nextCursor;
  expect(cursor).toBeTruthy();
  if (!cursor) throw new Error("Expected Worker continuation");
  const page = Schema.decodeUnknownSync(OperatorHistoryPage)(
    await projection.history(cursor),
  );
  expect(page.actorId).toBe(workerId(scope, "research"));
  expect(page.messages[0]?.blocks[0]).toMatchObject({
    text: "Worker continuation",
  });
  await expect(projection.snapshot(cursor)).rejects.toThrow("invalid");
  await expect(projection.history(`${cursor}x`)).rejects.toThrow("denied");
  const empty = fixture(async (id) => {
    if (id !== interactionId(scope)) throw new Error("Invented Worker");
    return null;
  });
  expect(await empty.projection.snapshot()).toMatchObject({
    interaction: { availability: "missing", messages: [] },
    tasks: [],
    workers: [],
  });
});

test("current authorization is required before release, including missing actors", async () => {
  for (const page of [null, { items: [] }]) {
    const state = fixture(async () => {
      state.revoke();
      return page;
    });
    await expect(state.projection.snapshot()).rejects.toThrow("denied");
  }
  for (const missing of ["operator.read", "history.read"]) {
    const state = fixture(async () => {
      throw new Error("Must not read");
    });
    state.viewer.capabilities = state.viewer.capabilities.filter(
      (grant) => grant !== missing,
    );
    await expect(state.projection.snapshot()).rejects.toThrow("denied");
  }
});

test("projection bounds UTF-8 text, escaped JSON and discovered Workers with explicit limitations", async () => {
  const calls = Array.from({ length: 9 }, (_, index) =>
    task(`call-${index}`, `worker-${index}`),
  );
  const { projection } = fixture(async (id) => ({
    items:
      id === interactionId(scope)
        ? [
            entry(1, "pi.assistant", calls),
            ...Array.from({ length: 90 }, (_, index) =>
              entry(index + 2, "pi.user", [
                {
                  role: "user",
                  content: "\u0000".repeat(12_000),
                  timestamp: index + 2,
                },
              ]),
            ),
          ]
        : [
            entry(100, "pi.assistant", [
              fauxAssistantMessage("界".repeat(3000)),
            ]),
          ],
  }));
  const snapshot = await projection.snapshot();
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
    65_536,
  );
  expect(snapshot.workers).toHaveLength(8);
  expect(snapshot.tasks).toHaveLength(8);
  expect(snapshot.limitations.join(" ")).toContain(
    "Additional Tasks or Workers omitted",
  );
  expect(snapshot.limitations.join(" ")).toContain(
    "Response-size limit omitted",
  );
  expect(snapshot.interaction.truncatedMessageIds.length).toBeGreaterThan(0);
  for (const actor of [snapshot.interaction, ...snapshot.workers]) {
    for (const message of actor.messages) {
      for (const block of message.blocks) {
        if (block.kind === "text")
          expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(8192);
      }
    }
  }
  const unicode = fixture(async () => ({
    items: [
      entry(1, "pi.user", [
        { role: "user", content: "界".repeat(3000), timestamp: 1 },
      ]),
    ],
  }));
  const block = (await unicode.projection.snapshot()).interaction.messages[0]
    ?.blocks[0];
  expect(block).toMatchObject({ kind: "text", text: "界".repeat(2730) });
});
