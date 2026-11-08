import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../../apps/server/src/config.ts";
import {
  closeHttp,
  createHttpServer,
  projectMessages,
} from "../../apps/server/src/http.ts";

test("public projection drops internal instructions, tools, reasoning and nonfinal answers without restyling deliverables", () => {
  const hidden = "synthetic-private-canary http://localhost:6420/inspector";
  const message = (role: string, content: unknown, stopReason = "stop") => ({
    role,
    content,
    stopReason,
    timestamp: 0,
  });
  const entries = [
    { id: 1, kind: "pi.system", model: [message("system", hidden)] },
    { id: 2, kind: "pi.tool", model: [message("toolResult", hidden)] },
    { id: 3, kind: "pi.compaction", model: [message("assistant", hidden)] },
    {
      id: 4,
      kind: "pi.assistant",
      model: [message("assistant", hidden, "toolUse")],
    },
    {
      id: 5,
      kind: "pi.assistant",
      model: [
        message("assistant", [
          { type: "thinking", thinking: hidden },
          { type: "toolCall", name: "internal", arguments: { url: hidden } },
          { type: "text", text: "HTTP API: Keep MixedCase and Computah." },
        ]),
      ],
    },
    { id: 6, kind: "pi.user", model: [message("user", "Keep This Case")] },
  ];
  const projected = projectMessages(
    entries as unknown as Parameters<typeof projectMessages>[0],
  );
  assert.deepEqual(
    projected.map((m) => m.blocks),
    [
      [
        {
          id: "text-5",
          kind: "text",
          text: "HTTP API: Keep MixedCase and Computah.",
        },
      ],
      [{ id: "text-6", kind: "text", text: "Keep This Case" }],
    ],
  );
  assert.ok(!JSON.stringify(projected).includes(hidden));
});

test("public errors never expose runtime secrets, privileged URLs or stacks", async () => {
  const token = "synthetic-token-".repeat(4);
  const config = readConfig({
    COMPUTAH_MODE: "faux",
    COMPUTAH_CONNECTION_SECRET: "synthetic-key-".repeat(4),
    COMPUTAH_AUTH_JSON: JSON.stringify([
      {
        token,
        tenantId: "test",
        userId: "test",
        agentId: "test",
        capabilities: ["history.read"],
      },
    ]),
  });
  const server = createHttpServer({
    ...config,
    bind() {
      throw new Error(
        "synthetic-private-canary http://localhost:6420/inspector",
      );
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/history`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 503);
    const error = await response.json();
    assert.deepEqual(Object.keys(error).sort(), [
      "code",
      "correlationId",
      "message",
      "retryable",
    ]);
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "unavailable");
    assert.equal(error.retryable, true);
    assert.match(error.correlationId, /^[a-f0-9-]{36}$/);
  } finally {
    await closeHttp(server);
  }
});
