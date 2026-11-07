import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { PiProviderConfig } from "@rivet-dev/pi";

/** Explicit smoke provider. Never selected as a fallback for real-provider errors. */
export function smokeProvider(): PiProviderConfig {
  const models = [
    {
      id: "deterministic",
      name: "Explicit Computah smoke model",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 4096,
    },
  ];
  return {
    api: "computah-smoke",
    baseUrl: "http://unused.invalid",
    models,
    streamSimple(model, context, options) {
      const user = context.messages.findLast(
        (message) => message.role === "user",
      );
      const text =
        user?.role === "user"
          ? typeof user.content === "string"
            ? user.content
            : user.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
          : "";
      const last = context.messages.at(-1);
      const tools = new Set<string>();
      for (const message of context.messages)
        if (message.role === "system") {
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? [])
            tools.delete(tool.name);
        }
      const answer =
        last?.role === "toolResult"
          ? fauxAssistantMessage(
              last.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
            )
          : tools.has("Task")
            ? fauxAssistantMessage(
                fauxToolCall("Task", { worker: "primary", text }),
                { stopReason: "toolUse" },
              )
            : fauxAssistantMessage(`[faux smoke, not a live model] ${text}`);
      const core = createFauxCore({
        api: "computah-smoke",
        provider: "computah-smoke",
        models,
        tokensPerSecond: 0,
      });
      core.setResponses([answer]);
      return core.streamSimple(model, context, options);
    },
  };
}
