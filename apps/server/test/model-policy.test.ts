import { zstdDecompressSync } from "node:zlib";
import {
  createTraceCarrier,
  currentTraceHeaders,
  registerContentSecrets,
  startObservability,
  withTraceContext,
} from "@computah/observability";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  InMemoryCredentialStore,
  type Models,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  NOOP_TELEMETRY_CONTEXT,
  NOOP_TELEMETRY_PROPAGATION,
} from "@earendil-works/pi-telemetry";
import { expect, test, vi } from "vitest";
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
  const restored = createTraceCarrier("model");
  const unrelated = createTraceCarrier("http");
  const telemetry: NonNullable<StreamOptions["telemetry"]> = {
    ...NOOP_TELEMETRY_CONTEXT,
    propagation: { ...NOOP_TELEMETRY_PROPAGATION, inject: () => restored },
    addLink() {},
    addEvent() {},
    setAttributes() {},
    setStatus() {},
  };
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
        telemetry,
        transport: "sse" as const,
        reasoning: "low" as const,
        reasoningEffort: "off" as const,
        serviceTier: "default" as const,
        maxRetries: 0,
        onPayload: async (body: unknown) => {
          expect(currentTraceHeaders().traceparent?.split("-")[1]).toBe(
            restored.traceparent?.split("-")[1],
          );
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
      const result = withTraceContext(unrelated, () =>
        models[method](
          model,
          {
            messages: [
              {
                role: "user",
                content: "synthetic-private-prompt",
                timestamp: 1,
              },
            ],
          },
          options,
        ),
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

test("opted-in model evidence preserves native async parents, content, usage and terminal failures without hidden blocks", async () => {
  const bodies: string[] = [];
  const traces: string[] = [];
  vi.stubEnv("COMPUTAH_AXIOM_INGEST_TOKEN", "synthetic-content-ingest");
  vi.stubEnv("COMPUTAH_AXIOM_LOG_DATASET", "synthetic-model-content");
  vi.stubEnv("COMPUTAH_AXIOM_CONTENT_ENABLED", "1");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://api.axiom.co/v1/logs") {
      bodies.push(String(init?.body));
      return Response.json({});
    }
    if (String(url) === "https://api.axiom.co/v1/traces") {
      traces.push(String(init?.body));
      return Response.json({});
    }
    return originalFetch(url, init);
  };
  const telemetry = await startObservability("backend");
  const native = await runtime();
  const model = native.getModel("openai-codex", "gpt-6.1-terra");
  if (!model) throw new Error("Missing Terra");
  const restored = createTraceCarrier("model");
  const unrelated = createTraceCarrier("http");
  const input: StreamOptions = {
    telemetry: {
      ...NOOP_TELEMETRY_CONTEXT,
      propagation: { ...NOOP_TELEMETRY_PROPAGATION, inject: () => restored },
      addLink() {},
      addEvent() {},
      setAttributes() {},
      setStatus() {},
    },
  };
  registerContentSecrets(["synthetic-configured-secret"]);
  const request = {
    systemPrompt: "private-system-canary",
    tools: [
      {
        name: "lookup",
        description: "private-tool-description",
        parameters: { type: "object" },
      },
    ],
    messages: [
      {
        role: "user" as const,
        content: "private-input-canary synthetic-configured-secret",
        timestamp: 1,
      },
      fauxAssistantMessage([
        fauxThinking("hidden-input-canary"),
        fauxText("visible-prior-answer"),
      ]),
    ],
  };
  const diagnostics: unknown[] = [];
  try {
    for (const method of [
      "stream",
      "streamSimple",
      "complete",
      "completeSimple",
    ] as const) {
      for (const stopReason of ["stop", "error", "aborted"] as const) {
        const message = fauxAssistantMessage(
          [
            fauxThinking("hidden-output-canary"),
            fauxText("private-output-canary"),
          ],
          { stopReason },
        );
        message.usage.input = 7;
        message.errorMessage =
          stopReason === "error" ? "private-provider-error" : undefined;
        const stream = createAssistantMessageEventStream();
        const models = priorityModels(
          new Proxy(native, {
            get(target, property) {
              if (property === method)
                return () => {
                  expect(currentTraceHeaders().traceparent?.split("-")[1]).toBe(
                    restored.traceparent?.split("-")[1],
                  );
                  return method.startsWith("stream")
                    ? stream
                    : Promise.resolve(message);
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }) as Models,
          (entry) => diagnostics.push(entry),
        );
        const boundedRequest =
          method === "stream" && stopReason === "stop"
            ? {
                ...request,
                messages: [
                  ...Array.from({ length: 65 }, (_, index) => ({
                    role: "user" as const,
                    content:
                      index === 0 ? "old-omitted-canary" : "older context",
                    timestamp: 1,
                  })),
                  ...request.messages,
                ],
              }
            : request;
        const result = withTraceContext(unrelated, () =>
          models[method](model, boundedRequest, input),
        );
        if ("result" in result) {
          expect(result).toBe(stream);
          // Resolve outside the model's active context, as native streams do.
          withTraceContext(unrelated, () => stream.end(message));
        }
        expect(await ("result" in result ? result.result() : result)).toBe(
          message,
        );
      }
    }
    const rejected = new Error("private-thrown-error");
    const models = priorityModels(
      new Proxy(native, {
        get(target, property) {
          if (property === "completeSimple")
            return () => Promise.reject(rejected);
          if (property === "streamSimple")
            return () => {
              throw rejected;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Models,
      (entry) => diagnostics.push(entry),
    );
    await expect(models.completeSimple(model, request, input)).rejects.toBe(
      rejected,
    );
    expect(() => models.streamSimple(model, request, input)).toThrow(rejected);
  } finally {
    await telemetry.close();
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  }
  type Row = {
    traceId: string;
    spanId: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  };
  const rows: Row[] = bodies.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (r: { scopeLogs: { logRecords: Row[] }[] }) =>
        r.scopeLogs.flatMap((s) => s.logRecords),
    ),
  );
  const field = (row: Row, key: string) =>
    row.attributes.find((a) => a.key === key)?.value.stringValue;
  const content = rows.filter((row) => field(row, "content.kind"));
  expect(content).toHaveLength(28);
  const inputs = content.filter(
    (row) => field(row, "content.kind") === "model.input",
  );
  const outputs = content.filter(
    (row) => field(row, "content.kind") === "model.output",
  );
  expect(inputs).toHaveLength(14);
  expect(outputs).toHaveLength(14);
  const firstInput = JSON.parse(field(inputs[0], "content.payload") ?? "null");
  expect(firstInput.sourceTruncated).toBe(true);
  expect(firstInput.messages).toHaveLength(64);
  expect(firstInput.missing).toContain("hidden_reasoning_excluded");
  expect(JSON.stringify(firstInput)).not.toContain("old-omitted-canary");
  for (let i = 0; i < inputs.length; i++) {
    expect(inputs[i].traceId).toBe(restored.traceparent?.split("-")[1]);
    expect(outputs[i].traceId).toBe(inputs[i].traceId);
    expect(outputs[i].spanId).toBe(inputs[i].spanId);
  }
  const payloads = outputs.map((row) =>
    JSON.parse(field(row, "content.payload") ?? "null"),
  );
  expect(payloads.filter((row) => row.stopReason === "aborted")).toHaveLength(
    4,
  );
  expect(payloads.filter((row) => row.stopReason === "error")).toHaveLength(4);
  expect(
    payloads.filter((row) => row.error === "model_request_failed"),
  ).toHaveLength(2);
  expect(payloads[0].usage.input).toBe(7);
  const exported = JSON.stringify(content);
  for (const visible of [
    "private-system-canary",
    "private-tool-description",
    "private-input-canary",
    "visible-prior-answer",
    "private-output-canary",
    "private-provider-error",
  ])
    expect(exported).toContain(visible);
  for (const excluded of [
    "hidden-input-canary",
    "hidden-output-canary",
    "synthetic-configured-secret",
    "private-thrown-error",
  ])
    expect(exported).not.toContain(excluded);
  expect(traces.join()).not.toMatch(
    /private-input-canary|private-output-canary|private-provider-error|hidden-output-canary/,
  );
  expect(
    diagnostics.filter(
      (row) => (row as { outcome?: string }).outcome === "aborted",
    ),
  ).toHaveLength(4);
});
