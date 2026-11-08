import { randomBytes } from "node:crypto";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { PiProviderConfig } from "@rivet-dev/pi";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { readConfig } from "../src/config.js";
import { createCore } from "../src/core.js";
import {
  interactionInstructions,
  workerInstructions,
} from "../src/personality.js";

test("web bootstrap grants are explicit and independent; unknown grants fail closed", () => {
  const env = {
    COMPUTAH_MODE: "faux",
    COMPUTAH_CONNECTION_SECRET: "synthetic-connection-secret-at-least-32-bytes",
    COMPUTAH_AUTH_JSON: JSON.stringify([
      {
        token: "synthetic-bootstrap-token-at-least-32-bytes",
        tenantId: "t",
        userId: "alice",
        agentId: "a",
        capabilities: ["web.search"],
      },
    ]),
    COMPUTAH_TAVILY_API_KEY: "synthetic-key",
  };
  expect([...readConfig(env).principals.values()][0].capabilities).toEqual([
    "web.search",
  ]);
  env.COMPUTAH_AUTH_JSON = env.COMPUTAH_AUTH_JSON.replace(
    "web.search",
    "web.extract",
  );
  expect([...readConfig(env).principals.values()][0].capabilities).toEqual([
    "web.extract",
  ]);
  env.COMPUTAH_AUTH_JSON = env.COMPUTAH_AUTH_JSON.replace(
    '["web.extract"]',
    "[]",
  );
  expect([...readConfig(env).principals.values()][0].capabilities).toEqual([]);
  env.COMPUTAH_AUTH_JSON = env.COMPUTAH_AUTH_JSON.replace(
    "[]",
    '["web.admin"]',
  );
  expect(() => readConfig(env)).toThrow("Invalid COMPUTAH_AUTH_JSON");
});

test("Task delegates to a scoped Worker, which searches and extracts citations", async (context) => {
  const faux = createFauxCore({
    provider: "web-test",
    api: "web-test",
    tokensPerSecond: 0,
    models: [
      { id: "test", contextWindow: 100000, maxTokens: 4096 },
      { id: "execution", contextWindow: 100000, maxTokens: 4096 },
    ],
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(
      String(url).endsWith("search")
        ? {
            results: [
              {
                title: "Source",
                url: "https://example.com/",
                content: "search evidence",
              },
            ],
          }
        : {
            results: [
              {
                url: "https://example.com/",
                raw_content: "extracted evidence",
              },
            ],
            failed_results: [],
          },
    ),
  );
  const provider: PiProviderConfig = {
    api: "web-test",
    baseUrl: "http://unused.invalid",
    models: [
      {
        id: "test",
        name: "test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
      {
        id: "execution",
        name: "execution",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, request, options) {
      const tools = new Set<string>();
      for (const message of request.messages)
        if (message.role === "system") {
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? [])
            tools.delete(tool.name);
        }
      const last = request.messages.at(-1);
      expect(model.id).toBe(tools.has("Task") ? "test" : "execution");
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => getSystemMessageText(message))
        .join("\n");
      expect(system).toContain(
        tools.has("Task") ? interactionInstructions : workerInstructions,
      );
      const response = tools.has("Task")
        ? last?.role === "toolResult"
          ? fauxAssistantMessage("Cited: https://example.com/")
          : fauxAssistantMessage(
              fauxToolCall("Task", {
                worker: "research",
                text: "public research",
              }),
              { stopReason: "toolUse" },
            )
        : tools.has("web_search")
          ? last?.role !== "toolResult"
            ? fauxAssistantMessage(
                fauxToolCall("web_search", { query: "public research" }),
                { stopReason: "toolUse" },
              )
            : last.toolName === "web_search"
              ? fauxAssistantMessage(
                  fauxToolCall("web_extract", {
                    urls: ["https://example.com/"],
                  }),
                  { stopReason: "toolUse" },
                )
              : fauxAssistantMessage(
                  `Evidence: ${JSON.stringify(last.content)}`,
                )
          : fauxAssistantMessage("No web grant");
      faux.setResponses([response]);
      return faux.streamSimple(model, request, options);
    },
  };
  const core = createCore({
    connectionSecret: randomBytes(32).toString("hex"),
    model: "web-test/test",
    workerModel: "web-test/execution",
    providers: { "web-test": provider },
    apiKeys: { "web-test": "synthetic" },
    authorize: (scope, capability) =>
      scope.userId === "alice" || !capability.startsWith("web."),
    tavily: { apiKey: "synthetic-tavily", fetch },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const alice = core.attach(client)({
      tenantId: "t",
      userId: "alice",
      agentId: "a",
    });
    const submission = await alice.submit(
      alice.interactionId,
      "public research",
      "first",
    );
    expect(
      (await alice.wait(alice.interactionId, submission.submissionId)).status,
    ).toBe("done");
    expect(
      JSON.stringify(await alice.history(alice.workerId("research"))),
    ).toContain("extracted evidence");
    expect(JSON.stringify(await alice.history(alice.interactionId))).toContain(
      "Cited: https://example.com/",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const bob = core.attach(client)({
      tenantId: "t",
      userId: "bob",
      agentId: "a",
    });
    const denied = await bob.submit(
      bob.interactionId,
      "public research",
      "second",
    );
    expect(
      (await bob.wait(bob.interactionId, denied.submissionId)).status,
    ).toBe("done");
    expect(
      JSON.stringify(await bob.history(bob.workerId("research"))),
    ).toContain("No web grant");
    expect(fetch).toHaveBeenCalledTimes(2);
    let cleaned = false;
    fetch.mockImplementationOnce(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleaned = true;
                reject(new Error("synthetic transport abort"));
              }, 20);
            },
            { once: true },
          );
        }),
    );
    const pending = await alice.submit(
      alice.interactionId,
      "cancel public research",
      "cancel-third",
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3), {
      timeout: 10000,
    });
    expect(await alice.cancel(alice.interactionId, pending.submissionId)).toBe(
      "aborted",
    );
    expect(cleaned).toBe(true);
  } finally {
    await core.close();
  }
});
