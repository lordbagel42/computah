import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { readConfig } from "../src/config.js";
import {
  interactionModel,
  priorityModels,
  workerModel,
} from "../src/model-policy.js";

const bindings = {
  COMPUTAH_CONNECTION_SECRET: "synthetic-connection-secret-at-least-32-bytes",
  COMPUTAH_AUTH_JSON: JSON.stringify([
    {
      token: "synthetic-bootstrap-token-at-least-32-bytes",
      tenantId: "t",
      userId: "u",
      agentId: "a",
      capabilities: [],
    },
  ]),
};

test("role configuration fixes Terra/Sol, rejects legacy overrides and keeps faux explicit", () => {
  expect(readConfig(bindings)).toMatchObject({
    model: interactionModel,
    workerModel,
  });
  expect(() =>
    readConfig({ ...bindings, COMPUTAH_MODEL: workerModel }),
  ).toThrow("obsolete");
  expect(() =>
    readConfig({ ...bindings, COMPUTAH_INTERACTION_MODEL: workerModel }),
  ).toThrow("Terra/Sol");
  expect(() =>
    readConfig({ ...bindings, COMPUTAH_WORKER_MODEL: interactionModel }),
  ).toThrow("Terra/Sol");
  expect(readConfig({ ...bindings, COMPUTAH_MODE: "faux" })).toMatchObject({
    mode: "faux",
    model: "computah-smoke/deterministic",
    workerModel: "computah-smoke/deterministic",
  });
});

async function runtime() {
  const credentials = new InMemoryCredentialStore();
  const access = `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access,
    refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000,
  }));
  return ModelRuntime.create({ credentials, modelsPath: null });
}

test("official native request methods finalize priority/high after transforms and report raw downgraded tiers without blocking results", async () => {
  const native = await runtime();
  const diagnostics: unknown[] = [];
  const models = priorityModels(native, (entry) => diagnostics.push(entry));
  let payloadCalls = 0;
  let rawCalls = 0;
  let responses = 0;
  const sent: Record<string, unknown>[] = [];
  for (const method of [
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
  ] as const) {
    for (const id of ["gpt-6.1-terra", "gpt-6.1-sol"]) {
      const model = models.getModel("openai-codex", id);
      if (!model) throw new Error("Missing pinned catalog model");
      const options = {
        transport: "sse" as const,
        reasoning: "low" as const,
        reasoningEffort: "off" as const,
        serviceTier: "default" as const,
        maxRetries: 0,
        onPayload: async (body: unknown) => {
          payloadCalls++;
          return {
            ...(body as object),
            service_tier: "default",
            reasoning: { effort: "low", summary: "auto" },
          };
        },
        onResponse: () => {
          responses++;
        },
        onProviderStreamEvent: () => {
          rawCalls++;
        },
        fetch: async (_input: unknown, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const bytes = Buffer.from(init?.body as Uint8Array);
          const body =
            headers.get("content-encoding") === "zstd"
              ? zstdDecompressSync(bytes).toString()
              : bytes.toString();
          sent.push(JSON.parse(body));
          const events = [
            {
              type: "response.created",
              response: {
                id: "synthetic",
                service_tier: "auto",
                status: "in_progress",
              },
            },
            {
              type: "response.completed",
              response: {
                id: "synthetic",
                service_tier: "default",
                status: "completed",
                output: [],
                usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
              },
            },
          ];
          return new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      };
      const result = models[method](
        model,
        {
          messages: [
            { role: "user", content: "synthetic-private-prompt", timestamp: 1 },
          ],
        },
        options,
      );
      const message = await ("result" in result ? result.result() : result);
      expect(message.stopReason).toBe("stop");
      expect(sent.at(-1)).toMatchObject({
        model: id,
        service_tier: "priority",
        reasoning: { effort: "high", summary: "auto" },
      });
    }
  }
  expect(sent).toHaveLength(8);
  expect(payloadCalls).toBe(8);
  expect(responses).toBe(8);
  expect(rawCalls).toBe(16);
  expect(
    diagnostics.filter(
      (entry) => (entry as { tier?: string }).tier === "default",
    ),
  ).toHaveLength(8);
  expect(JSON.stringify(diagnostics)).not.toMatch(
    /synthetic-private-prompt|synthetic-account|signature|summary/,
  );
  const old = models.getModel("openai-codex", "gpt-5.6-luna");
  if (!old) throw new Error("Missing old catalog fixture");
  expect(() => models.streamSimple(old, { messages: [] })).toThrow(
    "checkpoint requires supported",
  );
});

test("HTTP provider error is preserved for caller while diagnostics redact message/auth", async () => {
  const entries: unknown[] = [];
  const models = priorityModels(await runtime(), (entry) =>
    entries.push(entry),
  );
  const model = models.getModel("openai-codex", "gpt-6.1-terra");
  if (!model) throw new Error("Missing Terra");
  const message = await models.completeSimple(
    model,
    { messages: [] },
    {
      transport: "sse",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "reasoning_effort_not_allowed",
              message: "This reasoning level isn't available; synthetic-secret",
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
    },
  );
  expect(message.stopReason).toBe("error");
  expect(entries).toContainEqual({
    model: interactionModel,
    event: "response",
    requested: "priority",
    status: 403,
  });
  expect(entries).toContainEqual({
    model: interactionModel,
    event: "terminal",
    requested: "priority",
    outcome: "reasoning-not-allowed",
  });
  expect(JSON.stringify(entries)).not.toContain("synthetic-secret");
});
