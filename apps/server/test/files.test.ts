import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservability } from "@computah/observability";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { PiProviderConfig } from "@rivet-dev/pi";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { readConfig } from "../src/config.js";
import { type Capability, createCore } from "../src/core.js";

test("file grants are explicit bootstrap capabilities, never host authority", () => {
  const env = {
    COMPUTAH_MODE: "faux",
    COMPUTAH_CONNECTION_SECRET: "synthetic-private-connection-key-32-bytes",
    COMPUTAH_AUTH_JSON: JSON.stringify([
      {
        token: "synthetic-private-bearer-32-bytes-long",
        tenantId: "t",
        userId: "u",
        agentId: "a",
        capabilities: ["files.read", "files.write"],
      },
    ]),
  };
  expect([...readConfig(env).principals.values()][0].capabilities).toEqual([
    "files.read",
    "files.write",
  ]);
  expect(() =>
    readConfig({
      ...env,
      COMPUTAH_AUTH_JSON: env.COMPUTAH_AUTH_JSON.replace(
        "files.write",
        "host.write",
      ),
    }),
  ).toThrow("Invalid");
});

test("native Task/Worker read-write-edit uses isolated durable DB files, not host files, and rechecks revoked grants", async (context) => {
  const originalFetch = globalThis.fetch;
  const traces: string[] = [];
  const logs: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (
      String(input) === "https://api.axiom.co/v1/traces" ||
      String(input) === "https://api.axiom.co/v1/logs"
    ) {
      (String(input).endsWith("traces") ? traces : logs).push(
        String(init?.body),
      );
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-logs";
  const telemetry = await startObservability("backend");
  const directory = await mkdtemp(join(tmpdir(), "computah-host-canary-"));
  const path = join(directory, "note.txt");
  await writeFile(path, "host-file-must-not-change");
  const granted = new Set<Capability>([
    "task.send",
    "history.read",
    "core.maintain",
    "files.read",
    "files.write",
  ]);
  const models = [
    {
      id: "test",
      name: "test",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
  ];
  const faux = createFauxCore({
    provider: "files-test",
    api: "files-test",
    models,
    tokensPerSecond: 0,
  });
  const offered: string[][] = [];
  const results: { name: string; error: boolean; content: string }[] = [];
  const provider: PiProviderConfig = {
    api: "files-test",
    baseUrl: "http://unused.invalid",
    models,
    streamSimple(model, request, options) {
      const tools = new Set<string>();
      for (const message of request.messages)
        if (message.role === "system") {
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? [])
            tools.delete(tool.name);
        }
      const user = request.messages.findLast((entry) => entry.role === "user");
      const command =
        typeof user?.content === "string"
          ? user.content
          : JSON.stringify(user?.content);
      const last = request.messages.at(-1);
      let response: ReturnType<typeof fauxAssistantMessage>;
      if (tools.has("Task")) {
        expect(tools).toEqual(
          new Set(["Task", "self_docs_discover", "self_docs_read"]),
        );
        response =
          last?.role === "toolResult"
            ? fauxAssistantMessage(JSON.stringify(last.content))
            : fauxAssistantMessage(
                fauxToolCall("Task", {
                  worker:
                    command === "secondary-read" ? "secondary" : "primary",
                  text: command,
                }),
                { stopReason: "toolUse" },
              );
      } else {
        offered.push([...tools]);
        if (last?.role === "toolResult") {
          results.push({
            name: last.toolName,
            error: last.isError,
            content: JSON.stringify(last.content),
          });
          response = fauxAssistantMessage(JSON.stringify(last.content));
        } else {
          if (command === "revoke") granted.delete("files.write");
          response = fauxAssistantMessage(
            command === "image-write"
              ? fauxToolCall("write", {
                  path: `${path}.gif`,
                  content: "GIF89a",
                })
              : command === "image-read"
                ? fauxToolCall("read", { path: `${path}.gif` })
                : command === "write" || command === "revoke"
                  ? fauxToolCall("write", {
                      path,
                      content:
                        command === "revoke"
                          ? "must-not-land"
                          : "private-original\nMixedCase\n",
                    })
                  : command === "edit"
                    ? fauxToolCall("edit", {
                        path,
                        edits: [
                          {
                            oldText: "private-original",
                            newText: "private-edited",
                          },
                        ],
                      })
                    : fauxToolCall("read", { path }),
            { stopReason: "toolUse" },
          );
        }
      }
      faux.setResponses([response]);
      return faux.streamSimple(model, request, options);
    },
  };
  const core = createCore({
    connectionSecret: randomBytes(32).toString("hex"),
    authorize: (_scope, capability) => granted.has(capability),
    model: "files-test/test",
    providers: { "files-test": provider },
    apiKeys: { "files-test": "synthetic" },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const bind = core.attach(client);
    const alice = bind({
      tenantId: "private-tenant",
      userId: "alice",
      agentId: "default",
    });
    const bob = bind({
      tenantId: "private-tenant",
      userId: "bob",
      agentId: "default",
    });
    async function run(session: typeof alice, command: string, id: string) {
      const receipt = await session.submit(session.interactionId, command, id);
      const result = await session.result(
        session.interactionId,
        receipt.submissionId,
        true,
      );
      expect(result.submission.status).toBe("done");
      return results.at(-1);
    }
    expect(await run(alice, "write", "a-write")).toMatchObject({
      name: "write",
      error: false,
    });
    expect(await run(alice, "edit", "a-edit")).toMatchObject({
      name: "edit",
      error: false,
    });
    await alice.sleep(alice.workerId());
    expect(await run(alice, "read", "a-read")).toMatchObject({
      name: "read",
      error: false,
      content: expect.stringContaining("private-edited"),
    });
    expect(await run(bob, "read", "b-read")).toMatchObject({
      name: "read",
      error: true,
    });
    expect(results.at(-1)?.content).not.toContain("private-edited");
    expect(
      await run(alice, "secondary-read", "a-secondary-read"),
    ).toMatchObject({ name: "read", error: true });
    expect(results.at(-1)?.content).not.toContain("private-edited");
    expect(await run(alice, "image-write", "a-image-write")).toMatchObject({
      name: "write",
      error: false,
    });
    expect(await run(alice, "image-read", "a-image-read")).toMatchObject({
      name: "read",
      error: true,
    });
    expect(await run(alice, "revoke", "a-revoke")).toMatchObject({
      name: "write",
      error: true,
      content: expect.stringContaining("denied"),
    });
    expect(await run(alice, "read", "a-read-again")).toMatchObject({
      name: "read",
      error: false,
      content: expect.stringContaining("private-edited"),
    });
    expect(await readFile(path, "utf8")).toBe("host-file-must-not-change");
    expect(
      offered.some(
        (tools) =>
          tools.includes("read") &&
          tools.includes("write") &&
          tools.includes("edit"),
      ),
    ).toBe(true);
    expect(offered.flat()).not.toContain("bash");
    await alice.sleep(alice.workerId());
    await run(alice, "read", "a-read-reopened");
    expect(offered.at(-1)).toEqual([
      "read",
      "self_docs_discover",
      "self_docs_read",
      "procedure_draft",
    ]);
    const history = JSON.stringify(
      (await alice.history(alice.workerId())).items,
    );
    expect(history).toContain("private-edited");
    expect(history).not.toContain("host-file-must-not-change");
  } finally {
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
  type Span = {
    name: string;
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const spans: Span[] = traces.flatMap((body) => {
    const batch = JSON.parse(body) as {
      resourceSpans: { scopeSpans: { spans: Span[] }[] }[];
    };
    return batch.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    );
  });
  const fileSpans = spans.filter((span) =>
    span.name.startsWith("computah.files."),
  );
  expect(fileSpans).toHaveLength(10);
  for (const span of fileSpans) {
    expect(
      spans.find((parent) => parent.spanId === span.parentSpanId)?.name,
    ).toBe("pi.durable.phase");
    expect(logs.join()).toContain(span.spanId);
  }
  expect(
    fileSpans.map(
      (span) =>
        span.attributes.find((entry) => entry.key === "outcome")?.value
          .stringValue,
    ),
  ).toEqual(expect.arrayContaining(["success", "denied", "error"]));
  expect(
    fileSpans.filter((span) =>
      span.attributes.some(
        (entry) =>
          entry.key === "outcome" && entry.value.stringValue === "error",
      ),
    ),
  ).toHaveLength(3);
  for (const privateValue of [
    path,
    "private-original",
    "private-edited",
    "must-not-land",
    "private-tenant",
    "host-file-must-not-change",
  ])
    expect([...traces, ...logs].join()).not.toContain(privateValue);
});
