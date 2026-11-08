import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { PiProviderConfig } from "@rivet-dev/pi";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { createCore } from "../src/core.js";
import {
  interactionInstructions,
  workerInstructions,
} from "../src/personality.js";

test("default voice reaches Interaction and Worker across Task follow-ups without changing tools or deliverable casing", async (context) => {
  const models = [
    {
      id: "voice-test",
      name: "voice-test",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
  ];
  models.push(
    { ...models[0], id: "interaction-next", name: "interaction-next" },
    { ...models[0], id: "execution-test", name: "execution-test" },
  );
  const faux = createFauxCore({
    api: "computah-personality-test",
    provider: "computah-personality-test",
    models,
    tokensPerSecond: 0,
  });
  const observed: {
    system: string;
    tools: string[];
    text: string;
    model: string;
  }[] = [];
  const deliverable = "HTTP API: Keep MixedCase and Computah.";
  const provider: PiProviderConfig = {
    api: "computah-personality-test",
    baseUrl: "http://unused.invalid",
    models,
    streamSimple(model, messages, options) {
      const tools = new Set<string>();
      for (const message of messages.messages)
        if (message.role === "system") {
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? [])
            tools.delete(tool.name);
        }
      const textOf = (content: unknown) =>
        typeof content === "string" ? content : JSON.stringify(content);
      const system = messages.messages
        .filter((message) => message.role === "system")
        .map((message) => getSystemMessageText(message))
        .join("\n");
      const user = messages.messages.findLast(
        (message) => message.role === "user",
      );
      const text = user ? textOf(user.content) : "";
      observed.push({ system, tools: [...tools], text, model: model.id });
      const last = messages.messages.at(-1);
      faux.setResponses([
        last?.role === "toolResult"
          ? fauxAssistantMessage(deliverable)
          : tools.has("Task")
            ? fauxAssistantMessage(
                fauxToolCall("Task", { worker: "primary", text }),
                { stopReason: "toolUse" },
              )
            : fauxAssistantMessage(deliverable),
      ]);
      return faux.streamSimple(model, messages, options);
    },
  };
  const options: Parameters<typeof createCore>[0] = {
    connectionSecret: randomBytes(32).toString("hex"),
    authorize: () => true,
    model: "computah-personality-test/voice-test",
    providers: { "computah-personality-test": provider },
    apiKeys: { "computah-personality-test": "synthetic-not-a-credential" },
  };
  const core = createCore(options);
  try {
    const { client } = await setupTest(context, core.registry);
    const gateway = core.attach(client)({
      tenantId: "voice-tenant",
      userId: "voice-user",
      agentId: "computah",
    });
    for (const [id, text] of [
      ["initial", "Draft a MixedCase HTTP API heading."],
      ["follow-up", "Keep the previous heading's casing."],
    ]) {
      const admitted = await gateway.submit(gateway.interactionId, text, id);
      const result = await gateway.result(
        gateway.interactionId,
        admitted.submissionId,
        true,
      );
      expect(JSON.stringify(result)).toContain(deliverable);
      if (id === "initial") {
        // Simulate an upgraded host reopening existing roots, retaining originals.
        options.model = "computah-personality-test/interaction-next";
        options.workerModel = "computah-personality-test/execution-test";
        await gateway.sleep(gateway.interactionId);
        await gateway.sleep(gateway.workerId());
      }
    }
    const interaction = observed.filter((request) =>
      request.tools.includes("Task"),
    );
    const worker = observed.filter(
      (request) => !request.tools.includes("Task"),
    );
    expect(interaction.length).toBeGreaterThanOrEqual(4);
    expect(worker).toHaveLength(2);
    for (const request of interaction) {
      expect(request.model).toBe(
        request.text.includes("previous heading")
          ? "interaction-next"
          : "voice-test",
      );
      expect(request.system).toContain(interactionInstructions);
      expect(request.system).toContain("Use lowercase for your own");
      expect(request.system).toContain(
        "Your voice applies to accompanying commentary, not the deliverable.",
      );
      expect(request.tools).toEqual(["Task"]);
    }
    for (const request of worker) {
      expect(request.tools).toEqual(["read", "write", "edit"]);
      expect(request.model).toBe(
        request.text.includes("previous heading")
          ? "execution-test"
          : "voice-test",
      );
      expect(request.system).toContain(workerInstructions);
      expect(request.system).not.toContain(interactionInstructions);
      expect(request.system).toContain(
        "not the primary conversational persona",
      );
      expect(request.text).toMatch(/MixedCase|previous heading/);
    }
    for (const request of observed) {
      expect(request.system).toContain("Computah");
      expect(request.system).not.toMatch(
        /June|Raygen|gpt-|claude-|#june-things/,
      );
      expect(request.system).toContain("Style never changes permissions");
      expect(request.system).toContain(
        "each list item on its own real newline",
      );
      expect(request.system).toContain("When the answer is for Slack");
      expect(request.system).toContain(
        "JSON decoding yields actual line breaks",
      );
    }
    const history = await gateway.history(gateway.workerId("primary"));
    expect(JSON.stringify(history.items)).toContain("MixedCase");
    expect(JSON.stringify(history.items)).toContain("previous heading");
  } finally {
    await core.close();
    if (process.env.HOME?.includes("computah-core-engine-"))
      await rm(process.env.HOME, { recursive: true, force: true });
  }
});
