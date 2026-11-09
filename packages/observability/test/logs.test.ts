import assert from "node:assert/strict";
import test, { after } from "node:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { registerContentSecrets } from "../src/content.js";
import { type EdgeOutcome, Telemetry } from "../src/edge.js";
import { runtimeSlackReplyLatency, sanitizeTraces } from "../src/index.js";
import {
  createRuntimeLogger,
  type RuntimeLogFields,
  type RuntimeMetricSample,
  type RuntimeSlackReplyLatency,
} from "../src/logs.js";

const sink = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(sink)],
});
provider.register();
after(() => provider.shutdown());
const config = {
  service: "backend" as const,
  token: "synthetic-token-not-real",
  dataset: "test-logs",
  revision: "d".repeat(40),
};

test("structured logs preserve active correlation and approved scalars, never arbitrary content", async () => {
  let payload = "";
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (url, init) => {
      assert.equal(url, "https://api.axiom.co/v1/logs");
      assert.equal(init?.redirect, "error");
      payload = String(init?.body);
      return new Response("{}");
    },
  });
  const parent = provider.getTracer("test").startSpan("computah.synthetic");
  const { context, trace } = await import("@opentelemetry/api");
  const secret = "private-history-credential-reasoning-canary";
  const logId = context.with(trace.setSpan(context.active(), parent), () =>
    logger.emit(
      "runtime.cancelled",
      {
        outcome: "cancelled",
        operation: "model",
        reason: secret,
        attempt: 3,
        count: -1,
        duration_ms: 17.5,
        status_code: Number.NaN,
        resumed: false,
        prompt: secret,
        token: secret,
        "log.id": secret,
        traceId: secret,
      } as unknown as RuntimeLogFields,
      "warn",
    ),
  );
  assert.ok(logId);
  assert.equal(logger.emit(secret as "runtime.ready"), undefined);
  assert.equal(
    logger.emit(
      "runtime.ready",
      new Proxy(
        {},
        {
          get() {
            throw new Error(secret);
          },
        },
      ),
    ),
    undefined,
  );
  const result = await logger.close();
  const parsed = JSON.parse(payload);
  assert.deepEqual(parsed.resourceLogs[0].resource.attributes, [
    { key: "service.name", value: { stringValue: "computah-backend" } },
    { key: "service.version", value: { stringValue: config.revision } },
  ]);
  const row = parsed.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(row.traceId, parent.spanContext().traceId);
  assert.equal(row.spanId, parent.spanContext().spanId);
  assert.equal(row.body.stringValue, "runtime.cancelled");
  assert.equal(row.severityNumber, 13);
  assert.deepEqual(row.attributes, [
    { key: "outcome", value: { stringValue: "cancelled" } },
    { key: "operation", value: { stringValue: "model" } },
    { key: "attempt", value: { doubleValue: 3 } },
    { key: "duration_ms", value: { doubleValue: 17.5 } },
    { key: "resumed", value: { boolValue: false } },
    { key: "log.id", value: { stringValue: logId } },
  ]);
  assert.ok(!payload.includes(secret));
  assert.ok(!payload.includes(config.token));
  assert.equal(result.exported, 1);
  assert.equal(result.rejected, 2);
  const exported = sink.getFinishedSpans().at(-1);
  assert.ok(exported);
  const sanitized = sanitizeTraces(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: exported.name,
                  traceId: exported.spanContext().traceId,
                  spanId: exported.spanContext().spanId,
                  status: exported.status,
                  links: exported.links.map((link) => ({
                    traceId: link.context.traceId,
                    spanId: link.context.spanId,
                  })),
                },
              ],
            },
          ],
        },
      ],
    },
    "backend",
  );
  assert.ok(JSON.stringify(sanitized).includes(parent.spanContext().spanId));
  assert.equal(exported.attributes.outcome, "success");
  parent.end();
});

test("exporter self-telemetry does not generate log batches on idle ticks", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let requests = 0;
  const logger = createRuntimeLogger({
    ...config,
    fetch: async () => {
      requests++;
      return new Response("{}");
    },
  });
  logger.emit("runtime.ready");
  await logger.flush();
  for (let index = 0; index < 3; index++) {
    t.mock.timers.tick(1000);
    await logger.flush();
  }
  assert.equal(requests, 1);
  assert.equal(logger.stats().queued, 0);
  await logger.close();
});

test("queue includes in-flight records, drops newest on overload, batches serially and closes admission", async () => {
  const batches: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logger = createRuntimeLogger({
    ...config,
    revision: "private-invalid-revision",
    fetch: async (_, init) => {
      const resource = JSON.parse(String(init?.body)).resourceLogs[0];
      assert.deepEqual(resource.resource.attributes, [
        { key: "service.name", value: { stringValue: "computah-backend" } },
      ]);
      const records = resource.scopeLogs[0].logRecords;
      batches.push(records.length);
      if (batches.length === 1) await gate;
      return new Response("{}");
    },
  });
  logger.emit("runtime.ready");
  const early = logger.flush();
  for (let i = 0; i < 511; i++)
    assert.ok(logger.emit("runtime.report", { count: i }));
  assert.equal(logger.emit("runtime.report"), undefined);
  assert.equal(logger.stats().queued, 512);
  const closing = logger.close();
  assert.equal(logger.emit("runtime.stopped"), undefined);
  release();
  await early;
  const result = await closing;
  assert.deepEqual(batches, [1, 64, 64, 64, 64, 64, 64, 64, 63]);
  assert.equal(result.exported, 512);
  assert.equal(result.failed, 0);
  assert.equal(result.dropped, 1);
  assert.equal(result.queued, 0);
  assert.deepEqual(await logger.close(), result);
});

test("HTTP, network, partial rejection, malformed and oversized responses settle without retries", async () => {
  for (const response of [
    () => new Response("private-provider-error", { status: 503 }),
    () => {
      throw new Error("private-network-error");
    },
    () =>
      new Response(
        '{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"private"}}',
      ),
    () => new Response("null"),
    () => new Response("x".repeat(4097)),
  ]) {
    let calls = 0;
    const logger = createRuntimeLogger({
      ...config,
      fetch: async () => {
        calls++;
        return response();
      },
    });
    logger.emit("runtime.report", { outcome: "error" }, "error");
    const result = await logger.flush();
    assert.equal(result.failed, 1);
    assert.equal(result.exported, 0);
    assert.equal(result.queued, 0);
    await logger.close();
    assert.equal(calls, 1);
  }
  // Sanitized export keeps telemetry operation lifetime/outcome without error text.
  const spans = sink
    .getFinishedSpans()
    .filter(
      (span) =>
        span.name === "computah.logs.export" &&
        span.status.code === SpanStatusCode.ERROR,
    );
  assert.ok(spans.length >= 5);
  const sanitized = sanitizeTraces(
    {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: spans.map((span) => ({
                traceId: span.spanContext().traceId,
                spanId: span.spanContext().spanId,
                name: span.name,
                status: span.status,
                attributes: Object.entries(span.attributes).map(
                  ([key, value]) => ({ key, value: { stringValue: value } }),
                ),
              })),
            },
          ],
        },
      ],
    },
    "backend",
  );
  const encoded = JSON.stringify(sanitized);
  assert.ok(encoded.includes('"stringValue":"error"'));
  assert.ok(!encoded.includes("private"));
});

test("batch deadline aborts even a stalled transport and automatic flushing needs no caller", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let signal: AbortSignal | null | undefined;
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (_, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
  });
  logger.emit("runtime.recovery", { outcome: "timeout", resumed: true });
  t.mock.timers.tick(1000);
  assert.ok(signal);
  const closing = logger.close();
  t.mock.timers.tick(5000);
  const result = await closing;
  assert.equal(signal.aborted, true);
  assert.equal(result.failed, 1);
  assert.equal(result.queued, 0);
  const span = sink.getFinishedSpans().at(-1);
  assert.equal(span?.attributes.outcome, "timeout");
});

test("missing or invalid protected configuration disables collection with no ambient token fallback", async () => {
  for (const options of [
    { token: "", dataset: "test-logs" },
    { token: "test", dataset: "" },
    { token: "test", dataset: "computah-prod-traces" },
    { token: "test", dataset: "https://private.invalid" },
  ]) {
    const logger = createRuntimeLogger({
      service: "bus",
      ...options,
      fetch: async () => {
        assert.fail("disabled logger sent data");
      },
    });
    assert.equal(logger.emit("runtime.ready"), undefined);
    const stats = await logger.close();
    assert.equal(stats.enabled, false);
    assert.equal(stats.accepted, 0);
  }
});

test("Slack reply latency validates clocks and emits only correlated safe fields through the bounded queue", async () => {
  let payload = "";
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (_, init) => {
      payload = String(init?.body);
      return new Response("{}");
    },
  });
  const overdue: RuntimeSlackReplyLatency = {
    messageId: "a".repeat(64),
    phase: "overdue",
    receivedAtMs: 0,
    observedAtMs: 5001,
    elapsedMs: 5001,
    thresholdMs: 5000,
  };
  const confirmed: RuntimeSlackReplyLatency = {
    ...overdue,
    phase: "confirmed",
    observedAtMs: 5100,
    confirmedAtMs: 5000,
    elapsedMs: 5000,
  };
  assert.equal(runtimeSlackReplyLatency(overdue), false); // No bootstrap.
  const parent = provider.getTracer("test").startSpan("computah.synthetic");
  const { context, trace } = await import("@opentelemetry/api");
  context.with(trace.setSpan(context.active(), parent), () => {
    assert.equal(logger.slackReplyLatency(overdue), true);
    assert.equal(logger.slackReplyLatency(confirmed), true);
  });
  parent.end();
  for (const invalid of [
    { ...overdue, observedAtMs: 5000, elapsedMs: 5000 },
    { ...overdue, observedAtMs: 5001.5, elapsedMs: 5001.5 },
    { ...overdue, receivedAtMs: -1, elapsedMs: 5002 },
    { ...overdue, observedAtMs: Number.POSITIVE_INFINITY },
    { ...overdue, observedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...overdue, elapsedMs: Number.NaN },
    { ...overdue, thresholdMs: 5001 },
    { ...overdue, messageId: "private-raw-message-id" },
    { ...overdue, messageId: `${"a".repeat(64)}\n` },
    { ...overdue, messageId: `${"a".repeat(64)}\r\n` },
    { ...overdue, messageId: "A".repeat(64) },
    { ...overdue, phase: "error" },
    { ...overdue, text: "private-content-canary" },
    { ...overdue, toString: "private-content-canary" },
    { ...overdue, traceId: "b".repeat(32) },
    { ...overdue, confirmedAtMs: 5001 },
    { ...confirmed, confirmedAtMs: undefined },
    { ...confirmed, confirmedAtMs: 5101, elapsedMs: 5101 },
    { ...confirmed, receivedAtMs: 5001 },
    { ...confirmed, elapsedMs: 4999 },
    null,
  ])
    assert.equal(
      logger.slackReplyLatency(invalid as RuntimeSlackReplyLatency),
      false,
    );
  assert.equal(
    logger.emit("slack.reply_latency" as "runtime.ready"),
    undefined,
  );
  await logger.flush();
  const rows = JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(rows.length, 2);
  for (const [index, sample] of [overdue, confirmed].entries()) {
    const row = rows[index];
    const attrs = Object.fromEntries(
      row.attributes.map((attribute: { key: string; value: unknown }) => [
        attribute.key,
        attribute.value,
      ]),
    );
    assert.ok(attrs["log.id"]);
    delete attrs["log.id"];
    assert.deepEqual(attrs, {
      "slack.message_id": { stringValue: overdue.messageId },
      "slack.reply.phase": { stringValue: sample.phase },
      "slack.reply.received_at_ms": { doubleValue: 0 },
      "slack.reply.observed_at_ms": { doubleValue: index === 0 ? 5001 : 5100 },
      "slack.reply.elapsed_ms": { doubleValue: index === 0 ? 5001 : 5000 },
      "slack.reply.threshold_ms": { doubleValue: 5000 },
      ...(index === 1
        ? { "slack.reply.confirmed_at_ms": { doubleValue: 5000 } }
        : {}),
    });
    assert.equal(row.body.stringValue, "slack.reply_latency");
    assert.equal(row.traceId, parent.spanContext().traceId);
    assert.equal(row.spanId, parent.spanContext().spanId);
  }
  assert.ok(!payload.includes("private-"));
  for (let index = 0; index < 512; index++) logger.emit("runtime.ready");
  assert.equal(logger.slackReplyLatency(overdue), false);
  await logger.close();
  assert.equal(logger.slackReplyLatency(overdue), false);
  const disabled = createRuntimeLogger({ ...config, token: "" });
  assert.equal(disabled.slackReplyLatency(overdue), false);
  await disabled.close();
});

test("analytics samples use only the fixed scalar catalog and distinct cost provenance through the same queue", async () => {
  const rows: {
    body: { stringValue: string };
    attributes: {
      key: string;
      value: { stringValue?: string; doubleValue?: number };
    }[];
  }[] = [];
  const logger = createRuntimeLogger({
    ...config,
    fetch: async (_, init) => {
      rows.push(
        ...JSON.parse(String(init?.body)).resourceLogs[0].scopeLogs[0]
          .logRecords,
      );
      return new Response("{}");
    },
  });
  const sample: RuntimeMetricSample = {
    measurements: {
      "model.requests": 1,
      "model.tokens.input": 71,
      "model.cost.reported": 0.25,
      "model.cost.estimated": 0.004,
    },
    role: "worker",
    operation: "Task",
    outcome: "error",
    model: "openai-codex/gpt-6.1-sol",
    provider: "openai-codex",
    sdk: "pi-ai@1.5.0",
    reportedFromProvider: true,
    rate: {
      version: "pi-ai@1.5.0/runtime-model",
      currency: "USD",
      input: 3,
      output: 12,
      cacheRead: 0.3,
      cacheWrite: 4,
      cacheWrite1h: 6,
      inputTokensAbove: 200000,
    },
  };
  const canary = "private-principal-task-credential";
  const id = logger.metric({
    ...sample,
    measurements: {
      ...sample.measurements,
      "model.tokens.output": Number.POSITIVE_INFINITY,
      [canary]: 1,
    },
    [canary]: canary,
  } as RuntimeMetricSample);
  assert.ok(id);
  // A cast cannot bypass the typed, runtime-validated analytics-only route.
  assert.equal(logger.emit("analytics.sample" as "runtime.ready"), undefined);
  assert.ok(
    logger.metric({
      ...sample,
      reportedFromProvider: undefined,
      rate: undefined,
    }),
  );
  assert.equal(
    logger.metric({
      ...sample,
      model: canary,
    } as unknown as RuntimeMetricSample),
    undefined,
  );
  assert.equal(
    logger.metric({
      ...sample,
      sdk: "future-sdk",
    } as unknown as RuntimeMetricSample),
    undefined,
  );
  assert.equal(
    logger.metric({
      ...sample,
      measurements: {
        "model.duration": -1,
        "model.requests": Number.MAX_SAFE_INTEGER + 1,
      },
    }),
    undefined,
  );
  assert.ok(
    logger.metric({
      ...sample,
      measurements: {
        "model.requests": 0,
        "runtime.restart_streak": Number.MAX_SAFE_INTEGER,
      },
      model: "unknown",
      provider: "unknown",
    }),
  );
  const stats = await logger.close();
  assert.equal(stats.exported, 3);
  assert.equal(rows.length, 3);
  const attrs = (i: number) =>
    Object.fromEntries(
      rows[i].attributes.map(({ key, value }) => [
        key,
        value.stringValue ?? value.doubleValue,
      ]),
    );
  const first = attrs(0);
  assert.equal(rows[0].body.stringValue, "analytics.sample");
  assert.equal(first["log.id"], id);
  assert.equal(first["analytics.model.tokens.input"], 71);
  assert.equal(first["analytics.model.cost.reported"], 0.25);
  assert.equal(first["analytics.model.cost.estimated"], 0.004);
  assert.equal(
    first["analytics.cost.reported.basis"],
    "sdk-provider-reported-not-invoice",
  );
  assert.equal(
    first["analytics.cost.estimated.basis"],
    "base-catalog-estimate-excludes-tier-account-adjustments",
  );
  assert.equal(first["analytics.rate.inputTokensAbove"], 200000);
  assert.equal(first["analytics.rate.cacheWrite1h"], 6);
  assert.equal(first["analytics.currency"], "USD");
  assert.equal(attrs(1)["analytics.model.cost.reported"], undefined);
  assert.equal(attrs(1)["analytics.model.cost.estimated"], undefined);
  assert.equal(attrs(2)["analytics.model.requests"], 0);
  assert.equal(
    attrs(2)["analytics.runtime.restart_streak"],
    Number.MAX_SAFE_INTEGER,
  );
  assert.ok(!JSON.stringify(rows).includes(canary));
});

test("opted-in private content exports searchable text and identity but excludes credentials and hidden reasoning", async () => {
  const payloads: string[] = [];
  const priorAuth = process.env.COMPUTAH_AUTH_JSON;
  const priorToken = process.env.COMPUTAH_SYNTHETIC_TOKEN;
  process.env.COMPUTAH_AUTH_JSON = JSON.stringify([
    { token: "synthetic-auth-json-opaque" },
  ]);
  process.env.COMPUTAH_SYNTHETIC_TOKEN = "synthetic-env-token-opaque";
  const logger = createRuntimeLogger({
    ...config,
    contentEnabled: true,
    fetch: async (_url, init) => {
      payloads.push(String(init?.body));
      return new Response("{}");
    },
  });
  if (priorAuth === undefined) delete process.env.COMPUTAH_AUTH_JSON;
  else process.env.COMPUTAH_AUTH_JSON = priorAuth;
  if (priorToken === undefined) delete process.env.COMPUTAH_SYNTHETIC_TOKEN;
  else process.env.COMPUTAH_SYNTHETIC_TOKEN = priorToken;
  const credential = "synthetic-known-protected-value";
  registerContentSecrets([credential]);
  const { context, trace } = await import("@opentelemetry/api");
  const parent = provider.getTracer("test").startSpan("computah.synthetic");
  context.with(trace.setSpan(context.active(), parent), () => {
    assert.ok(
      logger.content("incoming", {
        text: `mewofanoinwewaoi;neaw ${credential} Bearer synthetic-auth-value`,
        actor: { userId: "synthetic-participant", source: "synthetic-channel" },
        authorization: "auth-field-canary",
        token: "token-field-canary",
        coreToken: "core-token-field-canary",
        toolOutput: "synthetic-auth-json-opaque synthetic-env-token-opaque",
        diagnosticText:
          'Cookie: first=cookie-one-canary; second=cookie-two-canary\npassword="quoted password canary"',
        nested: {
          apiKey: "api-field-canary",
          tool: { query: "useful actual query" },
        },
        content: [
          { type: "thinking", thinking: "hidden-thinking-canary" },
          { type: "text", text: "actual final reply" },
        ],
        reasoningSummary: "Available explicit summary, not hidden reasoning",
        usage: { input_tokens: 37, output_tokens: 9, totalTokens: 46 },
      }),
    );
  });
  parent.end();
  assert.equal(logger.emit("content.record" as "runtime.ready"), undefined);
  await logger.close();
  const serialized = payloads.join("");
  for (const value of [
    credential,
    "synthetic-auth-value",
    "auth-field-canary",
    "token-field-canary",
    "core-token-field-canary",
    "synthetic-auth-json-opaque",
    "synthetic-env-token-opaque",
    "cookie-one-canary",
    "cookie-two-canary",
    "quoted password canary",
    "api-field-canary",
    "hidden-thinking-canary",
    config.token,
  ])
    assert.ok(!serialized.includes(value), value);
  for (const value of [
    "mewofanoinwewaoi;neaw",
    "synthetic-participant",
    "useful actual query",
    "actual final reply",
    "Available explicit summary",
  ])
    assert.ok(serialized.includes(value), value);
  const row = JSON.parse(payloads[0]).resourceLogs[0].scopeLogs[0]
    .logRecords[0];
  assert.equal(row.traceId, parent.spanContext().traceId);
  assert.equal(row.spanId, parent.spanContext().spanId);
  const attrs = Object.fromEntries(
    row.attributes.map(
      (attr: {
        key: string;
        value: { stringValue?: string; boolValue?: boolean };
      }) => [attr.key, attr.value.stringValue ?? attr.value.boolValue],
    ),
  );
  assert.equal(attrs["content.schema"], "computah.content.v1");
  assert.equal(attrs["content.truncated"], false);
  assert.equal(attrs["content.redacted"], true);
  assert.equal(attrs["content.correlation"], "active");
  assert.equal(JSON.parse(attrs["content.payload"]).usage.input_tokens, 37);
  assert.ok(attrs["content.missing"].includes("hidden_reasoning_excluded"));

  const disabled = createRuntimeLogger({ ...config, contentEnabled: false });
  assert.equal(
    disabled.content("incoming", { text: "not exported" }),
    undefined,
  );
  assert.equal((await disabled.close()).accepted, 0);
  const publicService = createRuntimeLogger({
    ...config,
    service: "observatory",
    contentEnabled: true,
  });
  assert.equal(
    publicService.content("incoming", { text: "never public" }),
    undefined,
  );
  await publicService.close();
});

test("private content bounds encoded bytes, reserves scalar capacity and fails open on malformed input", async () => {
  const batches: string[] = [];
  const logger = createRuntimeLogger({
    ...config,
    contentEnabled: true,
    fetch: async (_url, init) => {
      batches.push(String(init?.body));
      return new Response("{}", { status: 503 });
    },
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.ok(logger.content("tool.result", cyclic));
  assert.ok(
    logger.content(
      "tool.result",
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("not-exported-error-canary");
          },
        },
      ),
    ),
  );
  assert.ok(
    logger.content("tool.result", { text: "🙂\n\u0000".repeat(100_000) }),
  );
  for (let index = 0; index < 180; index++)
    logger.content("tool.result", {
      text: "bounded useful output ".repeat(2000),
    });
  assert.ok(logger.stats().dropped > 0);
  assert.ok(logger.emit("runtime.stopped", { outcome: "stopped" }));
  const result = await logger.close();
  assert.equal(result.exported, 0);
  assert.equal(result.failed, result.accepted);
  assert.equal(result.queued, 0);
  const rows = batches.flatMap(
    (batch) => JSON.parse(batch).resourceLogs[0].scopeLogs[0].logRecords,
  );
  assert.ok(rows.some((row) => row.body.stringValue === "runtime.stopped"));
  assert.ok(!batches.join("").includes("not-exported-error-canary"));
  for (const batch of batches) assert.ok(Buffer.byteLength(batch) < 270_000);
  const contents = rows.filter(
    (row) => row.body.stringValue === "content.record",
  );
  assert.ok(contents.length <= 128);
  assert.ok(
    contents.reduce(
      (sum, row) => sum + Buffer.byteLength(JSON.stringify(row)),
      0,
    ) <=
      2 * 1024 * 1024,
  );
  const attributes = contents.map((row) =>
    Object.fromEntries(
      row.attributes.map(
        (attr: {
          key: string;
          value: { stringValue?: string; boolValue?: boolean };
        }) => [attr.key, attr.value.stringValue ?? attr.value.boolValue],
      ),
    ),
  );
  assert.ok(
    attributes.some((attr) => attr["content.missing"] === "projection_failed"),
  );
  assert.ok(
    attributes.some((attr) => attr["content.missing"] === "cyclic_value"),
  );
  assert.ok(attributes.some((attr) => attr["content.truncated"] === true));
  for (const attr of attributes) {
    assert.equal(attr["content.correlation"], "missing");
    assert.ok(Buffer.byteLength(attr["content.payload"]) <= 65_536);
    JSON.parse(attr["content.payload"]);
  }
  assert.equal(logger.content("incoming", {}), undefined);
});

test("redaction registry saturation stops private content without stopping scalar logs", async () => {
  const logger = createRuntimeLogger({
    ...config,
    contentEnabled: true,
    fetch: async () => new Response("{}"),
  });
  registerContentSecrets(
    Array.from({ length: 513 }, (_, i) => `synthetic-registry-only-${i}`),
  );
  registerContentSecrets(["synthetic-unretained-opaque-credential"]);
  assert.equal(
    logger.content("incoming", {
      text: "synthetic-unretained-opaque-credential",
    }),
    undefined,
  );
  assert.ok(logger.emit("runtime.ready", { outcome: "ready" }));
  const stats = await logger.close();
  assert.equal(stats.exported, 1);
  assert.equal(stats.dropped, 1);
});

test("edge lifecycle logs retain explicit span context without an active context manager", async () => {
  let payload = "";
  const logger = createRuntimeLogger({
    ...config,
    service: "observatory",
    fetch: async (_url, init) => {
      payload = String(init?.body);
      return new Response("{}");
    },
  });
  const span = {
    traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef",
    traceFlags: 1,
  };
  logger.emit(
    "operation.completed",
    { operation: "observatory.poll", outcome: "timeout" },
    "warn",
    span,
  );
  logger.emit(
    "operation.completed",
    { operation: "observatory.http", outcome: "cancelled" },
    "warn",
    { ...span, traceId: "0".repeat(32) },
  );
  await logger.close();
  const rows = JSON.parse(payload).resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(rows[0].traceId, span.traceId);
  assert.equal(rows[0].spanId, span.spanId);
  assert.equal(rows[1].traceId, undefined);
  assert.equal(rows[1].spanId, undefined);
  assert.ok(
    rows[0].attributes.some(
      (a: { key: string; value: { stringValue: string } }) =>
        a.key === "outcome" && a.value.stringValue === "timeout",
    ),
  );
});

test("DEBUGSHARE end flushes isolated sanitized logs correlated to edge spans without bootstrap", async () => {
  const requests: {
    url: string;
    token: string | null;
    dataset: string | null;
    body: string;
  }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(url),
      token: headers.get("Authorization"),
      dataset: headers.get("X-Axiom-Dataset"),
      body: String(init?.body),
    });
    return new Response("{}");
  };
  const telemetry = new Telemetry("synthetic-edge-ingest", transport);
  const parent = telemetry.start("computah.debugshare.http");
  const expected: [EdgeOutcome, string][] = [
    ["ready", "success"],
    ["not_configured", "denied"],
    ["error", "error"],
    ["cancelled", "cancelled"],
    ["denied", "denied"],
    ["queued", "queued"],
    ["retry", "retry"],
  ];
  for (const [outcome, mapped] of expected) {
    const child = telemetry.start("computah.debugshare.store", parent.span);
    Object.assign(child.span, { body: "PRIVATE-body", name: "PRIVATE-path" });
    await child.end(outcome);
    const logRequest = requests.at(-1);
    assert.ok(logRequest);
    assert.equal(logRequest.url, "https://api.axiom.co/v1/logs");
    assert.equal(logRequest.token, "Bearer synthetic-edge-ingest");
    assert.equal(logRequest.dataset, "computah-prod-logs");
    const logResource = JSON.parse(logRequest.body).resourceLogs[0];
    assert.equal(
      logResource.resource.attributes[0].value.stringValue,
      "computah-debugshare",
    );
    const row = logResource.scopeLogs[0].logRecords[0];
    assert.equal(row.traceId, parent.span.traceId);
    assert.equal(row.spanId, child.span.spanId);
    const attrs = Object.fromEntries(
      row.attributes.map(
        (a: { key: string; value: { stringValue: string } }) => [
          a.key,
          a.value.stringValue,
        ],
      ),
    );
    assert.equal(attrs.operation, "debugshare.store");
    assert.equal(attrs.outcome, mapped);
    const spanRequest = requests.at(-2);
    assert.ok(spanRequest);
    const span = JSON.parse(spanRequest.body).resourceSpans[0].scopeSpans[0]
      .spans[0];
    assert.equal(span.parentSpanId, parent.span.spanId);
    assert.equal(span.spanId, row.spanId);
  }
  await parent.end("success");
  assert.ok(!JSON.stringify(requests).includes("PRIVATE"));
  const other = new Telemetry(undefined, transport, Date.now, {
    logsToken: "synthetic-dedicated-logs",
    logsDataset: "edge-test-logs",
  });
  await other.start("computah.debugshare.auth").end("denied");
  assert.equal(requests.at(-1)?.token, "Bearer synthetic-dedicated-logs");
  assert.equal(requests.at(-1)?.dataset, "edge-test-logs");
  const count = requests.length;
  await new Telemetry(undefined, transport)
    .start("computah.debugshare.notice")
    .end("queued");
  assert.equal(requests.length, count);
});

test("DEBUGSHARE edge log flushes bound concurrent admission and settle failures without retries", async () => {
  const batches: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const telemetry = new Telemetry(
    undefined,
    async (url, init) => {
      assert.equal(url, "https://api.axiom.co/v1/logs");
      batches.push(String(init?.body));
      if (batches.length === 1) await gate;
      return new Response("PRIVATE-response", { status: 503 });
    },
    Date.now,
    { logsToken: "synthetic-edge-logs" },
  );
  const endings = Array.from({ length: 540 }, () =>
    telemetry.start("computah.debugshare.reconcile").end("retry"),
  );
  assert.equal(batches.length, 1);
  release();
  await Promise.all(endings);
  const rows = batches.flatMap(
    (batch) => JSON.parse(batch).resourceLogs[0].scopeLogs[0].logRecords,
  );
  assert.equal(rows.length, 512);
  assert.ok(
    batches.every(
      (batch) =>
        JSON.parse(batch).resourceLogs[0].scopeLogs[0].logRecords.length <= 64,
    ),
  );
  assert.equal(new Set(rows.map((row) => row.spanId)).size, 512);
  assert.ok(!batches.join("").includes("PRIVATE"));
  let calls = 0;
  const failing = new Telemetry("synthetic-edge-ingest", async () => {
    calls++;
    throw new Error("PRIVATE-error");
  });
  await failing.start("computah.debugshare.mcp").end("cancelled");
  assert.equal(calls, 2);
});

test("DEBUGSHARE logger requires explicit configuration and never enables the generic content lane", async () => {
  const disabled = createRuntimeLogger({
    service: "debugshare",
    autoFlush: false,
  });
  assert.equal(disabled.stats().enabled, false);
  await disabled.close();
  const logger = createRuntimeLogger({
    ...config,
    service: "debugshare",
    autoFlush: false,
    contentEnabled: true,
    fetch: async () => new Response("{}"),
  });
  assert.equal(
    logger.content("incoming", { text: "PRIVATE-content" }),
    undefined,
  );
  assert.equal(logger.stats().dropped, 0);
  assert.ok(
    logger.emit("operation.completed", {
      operation: "debugshare.notice",
      outcome: "queued",
    }),
  );
  assert.equal((await logger.close()).exported, 1);
});

test("DEBUGSHARE end settles a stalled shared log transport at its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const telemetry = new Telemetry(
    undefined,
    async (_url, init) => {
      calls++;
      signal = init?.signal;
      return new Promise<Response>(() => {});
    },
    Date.now,
    { logsToken: "synthetic-edge-logs" },
  );
  const ending = telemetry.start("computah.debugshare.notice").end("timeout");
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(5000);
  await ending;
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});
