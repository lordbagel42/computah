import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type Usage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry } from "@earendil-works/pi-durable";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterEach, expect, test } from "vitest";
import { OperationalAnalytics, observeModels } from "../src/analytics.js";
import {
  interactionModel,
  priorityModels,
  workerModel,
} from "../src/model-policy.js";
import { smokeProvider } from "../src/smoke-model.js";

const directories: string[] = [];
const stores: OperationalAnalytics[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const model = "analytics-test/deterministic";
const secret = "private-test-key-not-a-real-secret-92857";
const usage: Usage = {
  input: 130,
  output: 37,
  cacheRead: 90,
  cacheWrite: 11,
  totalTokens: 268,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
function store(
  options: Partial<ConstructorParameters<typeof OperationalAnalytics>[0]> = {},
) {
  const result = new OperationalAnalytics({
    path: ":memory:",
    secret,
    models: [model],
    ...options,
  });
  stores.push(result);
  return result;
}

test("persistent dedup, asymmetric hourly rollups, retention and bounded series", () => {
  let now = 10 * 86400_000 + 1234;
  const dir = mkdtempSync(join(tmpdir(), "computah-analytics-"));
  directories.push(dir);
  const path = join(dir, "analytics.sqlite");
  let analytics = new OperationalAnalytics({
    path,
    secret,
    models: [model],
    now: () => now,
  });
  const dims = {
    role: "worker" as const,
    model,
  };
  const correlation = {
    principal: ["tenant-private", "user-private", "agent"] as const,
  };
  analytics.record(
    "attempt-one",
    dims,
    { "worker.duration": 17 },
    { correlation },
  );
  analytics.record(
    "attempt-two",
    dims,
    { "worker.duration": 83 },
    { correlation },
  );
  analytics.close();
  analytics = store({ path, now: () => now });
  expect(
    analytics.record("attempt-one", dims, { "worker.duration": 9000 }),
  ).toBe(false);
  expect(analytics.snapshot().rollups[0]).toMatchObject({
    count: 2,
    sum: 100,
    min: 17,
    max: 83,
    mean: 50,
    unit: "ms",
  });
  expect(JSON.stringify(analytics.snapshot())).not.toMatch(
    /tenant-private|user-private|attempt-one/,
  );
  now += 3_600_000;
  analytics.record("attempt-three", dims, { "worker.duration": 7 });
  expect(analytics.snapshot().rollups).toHaveLength(2);
  now += 8 * 86400_000;
  expect(analytics.snapshot().rollups).toHaveLength(0);
  for (let i = 0; i < 100; i++)
    analytics.record(
      `correlated:${i}`,
      dims,
      { "task.duration": i },
      { correlation: { task: `task:${i}` } },
    );
  expect(analytics.snapshot().rollups).toHaveLength(1);
  expect(analytics.receipts()).toHaveLength(100);
  expect(JSON.stringify(analytics.snapshot().rollups)).not.toContain("task:");
  const models = Array.from({ length: 100 }, (_, i) => `configured/model-${i}`);
  const bounded = store({ models });
  const outcomes = [
    "ok",
    "error",
    "aborted",
    "unknown",
    "accepted",
    "duplicate",
    "ignored",
    "uncertain",
    "rate_limited",
  ] as const;
  const roles = ["worker", "interaction", "slack", "runtime"] as const;
  const operations = ["submit", "wait", "result"] as const;
  for (let i = 0; i < 10_001; i++)
    bounded.record(
      `id:${i}`,
      {
        model: models[i % 100],
        outcome: outcomes[Math.floor(i / 100) % 9],
        role: roles[Math.floor(i / 900) % 4],
        operation: operations[Math.floor(i / 3600) % 3],
      },
      { "task.duration": i },
    );
  expect(bounded.snapshot().rollups).toHaveLength(10_000);
  expect(bounded.snapshot().diagnostics.dropped).toBe(1);
});

test("native cumulative usage replaces on refresh; stale reads cannot reverse totals", () => {
  const analytics = store();
  const state = { models: { [model]: usage }, tools: {} };
  const at = Date.now();
  analytics.replaceUsage("actor-private", {}, state, at);
  analytics.replaceUsage("actor-private", {}, state, at + 1);
  analytics.replaceUsage(
    "actor-private",
    {},
    { models: {}, tools: {} },
    at - 1,
  );
  const snapshot = analytics.snapshot();
  expect(snapshot.usage).toHaveLength(1);
  expect(snapshot.usage[0]?.models).toEqual([
    expect.objectContaining({
      input: 130,
      output: 37,
      reasoning: null,
      cacheWrite1h: null,
      cost: expect.objectContaining({
        amount: 10,
        basis: "sdk-cumulative-mixed-or-estimated",
      }),
    }),
  ]);
  expect(snapshot.rollups).toHaveLength(0);
});

test("unreported SDK-default usage stays unknown while explicit provider-reported zero remains zero", () => {
  const analytics = store();
  const empty = fauxAssistantMessage("").usage;
  analytics.modelAttempt(
    "unreported",
    { model },
    { durationMs: 2, usage: empty },
  );
  const reported = {
    ...empty,
    cost: { ...empty.cost, totalFromProvider: true },
  };
  analytics.modelAttempt(
    "reported",
    { model },
    { durationMs: 3, usage: reported },
  );
  analytics.replaceUsage(
    "unreported",
    {},
    { models: { [model]: empty }, tools: {} },
  );
  analytics.replaceUsage(
    "reported",
    {},
    { models: { [model]: reported }, tools: {} },
  );
  const snapshot = analytics.snapshot();
  expect(
    snapshot.rollups.find((row) => row.metric === "model.usage_missing")?.sum,
  ).toBe(1);
  expect(
    snapshot.rollups.find((row) => row.metric === "model.tokens.total"),
  ).toMatchObject({ count: 1, sum: 0 });
  expect(
    snapshot.usage.map((entry) => entry.models[0].totalTokens).sort(),
  ).toEqual([0, null]);
  expect(
    snapshot.usage.map((entry) => entry.models[0].cost.amount).sort(),
  ).toEqual([0, null]);
});

test("cost provenance, optional reasoning and cache subsets never inflate totals", () => {
  const analytics = store();
  const rate = {
    version: "catalog-v1",
    currency: "USD" as const,
    input: 2,
    output: 7,
    cacheRead: 0.5,
    cacheWrite: 3,
    cacheWrite1h: 4,
  };
  analytics.modelAttempt(
    "request-a",
    { model },
    { durationMs: 12, usage, rate },
  );
  analytics.modelAttempt(
    "request-b",
    { model },
    {
      durationMs: 19,
      usage: { ...usage, reasoning: 13, cacheWrite1h: 5 },
      rate: { ...rate, version: "catalog-v2", output: 9 },
    },
  );
  analytics.modelAttempt(
    "request-c",
    { model },
    {
      durationMs: 31,
      usage: {
        ...usage,
        cost: { ...usage.cost, total: 0.07, totalFromProvider: true },
      },
    },
  );
  analytics.modelAttempt(
    "request-failed",
    { model, outcome: "error" },
    { durationMs: 5 },
  );
  const rows = analytics.snapshot().rollups;
  expect(rows.filter((r) => r.metric === "model.cost.estimated")).toHaveLength(
    1,
  );
  expect(
    rows.find((r) => r.metric === "model.cost.estimated")?.sum,
  ).toBeCloseTo(0.001273, 12);
  expect(rows.find((r) => r.metric === "model.cost.reported")?.sum).toBe(0.07);
  expect(
    rows.filter((r) => r.metric === "model.tokens.reasoning"),
  ).toHaveLength(1);
  expect(
    rows.filter((r) => r.metric === "model.tokens.total").map((r) => r.sum),
  ).toEqual([804]);
  expect(rows.find((r) => r.metric === "model.usage_missing")?.sum).toBe(1);
  expect(
    analytics
      .receipts()
      .filter((r) => r.values["model.cost.estimated"] !== undefined)
      .every((r) => r.metadata.rate.version.startsWith("catalog-v")),
  ).toBe(true);
  expect(
    rows.some(
      (r) =>
        r.metric === "model.tokens.input" && r.dimensions.outcome === "error",
    ),
  ).toBe(false);
});

test("exporter labels exclude identity/task/provenance; exporter failure cannot undo local commit", async () => {
  const metrics = new InMemoryTelemetryContext();
  const analytics = store({ metrics });
  analytics.record(
    "id",
    {
      model,
      outcome: "ok",
    },
    { "tool.duration": 7 },
    {
      correlation: {
        principal: ["private-tenant", "private-user", "agent"],
        task: "private-task",
      },
    },
  );
  const exported = await metrics.findMetrics({
    name: "computah.tool.duration",
  });
  expect(exported[0]?.attributes).toEqual({
    model,
    provider: "analytics-test",
    outcome: "ok",
    role: "runtime",
    operation: "unknown",
  });
  const broken = store({
    metrics: {
      histogram() {
        throw new Error("private exporter details");
      },
      counter() {
        throw new Error("private exporter details");
      },
      upDownCounter() {
        throw new Error("private exporter details");
      },
    },
  });
  expect(
    await broken.measure({ operation: "submit" }, async () => "done"),
  ).toBe("done");
  expect(broken.snapshot().diagnostics.export_failures).toBe(1);
  expect(JSON.stringify(broken.snapshot())).not.toContain(
    "private exporter details",
  );
});

test("configured ModelRuntime preserves exact events/options/signal and separates failed attempts", async () => {
  const analytics = store();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const smoke = smokeProvider();
  let receivedOptions: unknown;
  let source: ReturnType<typeof createAssistantMessageEventStream> | undefined;
  runtime.registerProvider("analytics-test", {
    ...smoke,
    streamSimple(_model, _context, options) {
      receivedOptions = options;
      source = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        const message = fauxAssistantMessage("", { stopReason: "aborted" });
        source?.push({ type: "error", reason: "aborted", error: message });
        source?.end();
      });
      return source;
    },
  });
  await runtime.setRuntimeApiKey("analytics-test", "synthetic-no-secret");
  const selected = runtime.getModel("analytics-test", "deterministic");
  if (!selected) throw new Error("Missing synthetic model");
  const observed = observeModels(runtime, analytics);
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const response = observed.streamSimple(selected, { messages: [] }, options);
  await expect
    .poll(() => receivedOptions)
    .toMatchObject({ signal: abort.signal });
  const iterator = response[Symbol.asyncIterator]();
  const next = iterator.next();
  const message = {
    ...fauxAssistantMessage("private synthetic content"),
    usage,
  };
  const event = {
    type: "text_delta" as const,
    contentIndex: 0,
    delta: "private synthetic content",
    partial: message,
  };
  source?.push(event);
  expect((await next).value).toBe(event);
  source?.push({ type: "done", reason: "stop", message });
  source?.end();
  expect(await response.result()).toBe(message);
  receivedOptions = undefined;
  const failed = observed.streamSimple(selected, { messages: [] }, options);
  await expect
    .poll(() => receivedOptions)
    .toMatchObject({ signal: abort.signal });
  abort.abort();
  expect((await failed.result()).stopReason).toBe("aborted");
  const tiered = {
    ...selected,
    cost: {
      input: 2,
      output: 7,
      cacheRead: 0.5,
      cacheWrite: 3,
      tiers: [
        {
          inputTokensAbove: 200_000,
          input: 4,
          output: 14,
          cacheRead: 1,
          cacheWrite: 6,
        },
      ],
    },
  };
  for (const input of [199_899, 199_900]) {
    // Total tier input includes 90 cache-read + 11 cache-write tokens.
    const previous = source;
    const completed = observed.completeSimple(tiered, { messages: [] });
    await expect.poll(() => source !== previous).toBe(true);
    const terminal = {
      ...fauxAssistantMessage(""),
      usage: { ...usage, input, cacheWrite1h: 5 },
    };
    source?.push({ type: "done", reason: "stop", message: terminal });
    source?.end();
    await completed;
  }
  const previous = source;
  const unreported = observed.completeSimple(selected, { messages: [] });
  await expect.poll(() => source !== previous).toBe(true);
  source?.push({
    type: "done",
    reason: "stop",
    message: fauxAssistantMessage(""),
  });
  source?.end();
  await unreported;
  const snapshot = analytics.snapshot();
  expect(
    snapshot.rollups
      .filter((r) => r.metric === "model.requests")
      .reduce((n, r) => n + r.sum, 0),
  ).toBe(5);
  const tierCosts = analytics
    .receipts()
    .filter(
      (r) =>
        r.values["model.cost.estimated"] !== undefined &&
        r.metadata.rate.inputTokensAbove === 200_000,
    );
  expect(tierCosts).toHaveLength(1);
  expect(tierCosts[0]?.values["model.cost.estimated"]).toBe(0.800284);
  expect(
    analytics
      .receipts()
      .find(
        (r) =>
          r.values["model.cost.estimated"] !== undefined &&
          r.metadata.rate.input === 2,
      )?.values["model.cost.estimated"],
  ).toBe(0.40014);
  expect(
    snapshot.rollups.find((r) => r.metric === "model.first_output")?.count,
  ).toBe(1);
  expect(
    snapshot.rollups
      .filter((r) => r.metric === "model.usage_missing")
      .reduce((sum, row) => sum + row.sum, 0),
  ).toBe(2);
  expect(JSON.stringify(snapshot)).not.toMatch(
    /private synthetic content|synthetic-no-secret/,
  );
});

test("analytics composes with current priority runtime for both roles and preserves completion semantics", async () => {
  const analytics = store({ models: [interactionModel, workerModel] });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: `synthetic.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "private-fixture-account" } })).toString("base64url")}.signature`,
    refresh: "private-fixture-refresh",
    expires: Date.now() + 3_600_000,
  }));
  const native = await ModelRuntime.create({ credentials, modelsPath: null });
  const diagnostics: unknown[] = [];
  const prioritized = priorityModels(native, (entry) =>
    diagnostics.push(entry),
  );
  const models = observeModels(prioritized, analytics);
  let requests = 0;
  for (const method of [
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
  ] as const) {
    for (const id of ["gpt-6.1-terra", "gpt-6.1-sol"]) {
      const selected = models.getModel("openai-codex", id);
      if (!selected) throw new Error("Missing pinned model");
      const result = models[method](
        selected,
        { messages: [] },
        {
          transport: "sse",
          maxRetries: 0,
          onPayload: (payload) => ({
            ...(payload as object),
            service_tier: "default",
            reasoning: { effort: "low" },
          }),
          fetch: async (_input, init) => {
            requests++;
            const bytes = Buffer.from(init?.body as Uint8Array);
            const body = JSON.parse(
              new Headers(init?.headers).get("content-encoding") === "zstd"
                ? zstdDecompressSync(bytes).toString()
                : bytes.toString(),
            );
            expect(body).toMatchObject({
              model: id,
              service_tier: "priority",
              reasoning: { effort: "high" },
            });
            return new Response(
              `data: ${JSON.stringify({ type: "response.completed", response: { id: "synthetic", service_tier: "priority", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })}\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      );
      expect(
        (await ("result" in result ? result.result() : result)).stopReason,
      ).toBe("stop");
    }
  }
  expect(requests).toBe(8);
  expect(
    diagnostics.filter(
      (entry) => (entry as { event: string }).event === "terminal",
    ),
  ).toHaveLength(8);
  expect(
    analytics
      .snapshot()
      .rollups.filter((row) => row.metric === "model.requests")
      .reduce((sum, row) => sum + row.sum, 0),
  ).toBe(8);
  expect(
    analytics
      .snapshot()
      .rollups.filter((row) => row.metric === "model.tokens.total")
      .reduce((sum, row) => sum + row.sum, 0),
  ).toBe(32);
  const selected = models.getModel("openai-codex", "gpt-6.1-terra");
  if (!selected) throw new Error("Missing model");
  const completion = Promise.resolve({
    ...fauxAssistantMessage("completion-only-result"),
    usage,
  });
  const custom = observeModels(
    new Proxy(prioritized, {
      get(target, name) {
        return name === "completeSimple"
          ? () => completion
          : Reflect.get(target, name);
      },
    }),
    analytics,
  );
  expect(custom.completeSimple(selected, { messages: [] })).toBe(completion);
  expect(await completion).toMatchObject({ usage });
  expect(JSON.stringify(analytics.snapshot())).not.toMatch(
    /private-fixture|completion-only-result|signature/,
  );
});

test("durable span replay and task settlement dedup; aborts and sink failure preserve caller results", async () => {
  const analytics = store();
  const span = {
    id: "span-1",
    traceId: "trace-1",
    name: "pi.durable.phase",
    startedMs: 13,
    endedMs: 80,
    attributes: {
      resumed: true,
      outcome: "aborted",
      secret: "not-for-projection",
    },
    events: [
      {
        name: "pi.durable.replay",
        timeMs: 20,
        attributes: { payload: "private" },
      },
    ],
    links: [],
    status: { status: "ok" as const },
  };
  expect(analytics.consumeSpan(span)).toBe(true);
  expect(analytics.consumeSpan(span)).toBe(false);
  expect(analytics.consumeSpan({ ...span, name: "chat deterministic" })).toBe(
    false,
  );
  const receipt = {
    id: 9,
    startedAt: 23,
    endedAt: 105,
    restarts: 2,
    outcome: "aborted" as const,
  };
  expect(analytics.settledTask("actor", {}, receipt)).toBe(true);
  expect(analytics.settledTask("actor", {}, receipt)).toBe(false);
  const snapshot = analytics.snapshot();
  expect(
    snapshot.rollups.find((r) => r.metric === "runtime.phase_duration")?.sum,
  ).toBe(67);
  expect(snapshot.rollups.find((r) => r.metric === "task.duration")?.sum).toBe(
    82,
  );
  expect(
    snapshot.rollups.find((r) => r.metric === "runtime.restart_streak")?.sum,
  ).toBe(2);
  expect(snapshot.rollups.some((r) => r.metric === "operation.retries")).toBe(
    false,
  );
  expect(JSON.stringify(snapshot)).not.toMatch(/not-for-projection|private/);
  const abort = new DOMException("not-for-projection", "AbortError");
  await expect(
    analytics.measure({ operation: "wait" }, async () => {
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(
    analytics.snapshot().rollups.find((r) => r.metric === "operation.duration")
      ?.dimensions.outcome,
  ).toBe("aborted");
  const closed = new OperationalAnalytics({
    path: ":memory:",
    secret,
    models: [model],
  });
  closed.close();
  expect(
    await closed.measure({ operation: "submit" }, async () => "unblocked"),
  ).toBe("unblocked");
});

test("native Rivet/Pi usage capture is a safe replaceable projection across actor wake", async (context) => {
  const analytics = store({ models: ["computah-smoke/deterministic"] });
  const actor = pi({
    registry: createRegistry(),
    model: "computah-smoke/deterministic",
    providers: { "computah-smoke": smokeProvider() },
    apiKeys: { "computah-smoke": "explicit-faux" },
    actions: {
      capture: async (c) =>
        analytics.captureHarness(c.actorId, { role: "worker" }, c.pi),
      sleep: (c) => c.sleep(),
    },
  });
  const registry = setup({ use: { actor } });
  try {
    const { client } = await setupTest(context, registry);
    const handle = client.actor.getOrCreate(["synthetic-analytics"]);
    await handle.prompt("synthetic analytics native usage");
    await handle.capture();
    const before = analytics.snapshot().usage;
    expect(before).toHaveLength(1);
    expect(before[0]?.models[0]?.totalTokens).toBeGreaterThan(0);
    await handle.sleep();
    await handle.capture();
    expect(analytics.snapshot().usage[0]?.models).toEqual(before[0]?.models);
    expect(JSON.stringify(analytics.snapshot())).not.toContain(
      "synthetic analytics native usage",
    );
  } finally {
    await registry.shutdown();
  }
});
