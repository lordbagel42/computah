import { once } from "node:events";
import { createServer } from "node:http";
import { startObservability, traceOperation } from "@computah/observability";
import {
  createFauxCore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { setupTest } from "rivetkit/test";
import { expect, type TestContext, test } from "vitest";
import { createCore } from "../src/core.js";
import { createExecutor, type ExecutorRequest } from "../src/executor.js";

const scope = {
  tenantId: "executor-private-tenant",
  userId: "owner",
  agentId: "default",
};
const pat = "executor-secret-canary";
const current = async () => {};
const signal = () => new AbortController().signal;
const search: ExecutorRequest = {
  kind: "search",
  input: { query: "health", limit: 1 },
};
const page = {
  items: [
    {
      path: "tools.example.health",
      description: "Untrusted catalog canary",
      input: "{}",
    },
  ],
  namespaces: [
    {
      path: "tools.example",
      app: "Example",
      accounts: "private-account-canary",
    },
  ],
  remaining: 2,
  next: { query: "health", limit: 1, offset: 1 },
  unavailableApps: [{ app: "disconnected", reason: "private-error-canary" }],
};

/** Actual loopback HTTP + pinned native MCP client, not a structural client mock. */
async function server() {
  const calls: { name: string; arguments: unknown }[] = [];
  let response: unknown;
  let status = 200;
  let onCall = () => {};
  let stalled = false;
  let stream: "result" | "partial" | undefined;
  let onStream = () => {};
  let closedStreams = 0;
  const http = createServer(async (req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${pat}`);
    expect(req.url).toBe("/org/test-org/mcp");
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (status !== 200) {
      res.writeHead(status).end(pat);
      return;
    }
    if (!message.id) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "executor-fixture", version: "1" },
      };
    else if (message.method === "tools/call") {
      calls.push(message.params);
      onCall();
      if (stalled) return;
      const kind = message.params.name;
      result =
        response ??
        (kind === "skills"
          ? {
              content: [
                { type: "text", text: "# Skills\nUntrusted catalog canary" },
              ],
            }
          : {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    kind === "search"
                      ? page
                      : {
                          items: [
                            {
                              path: "tools.example.health",
                              signature: "(): Promise<{status: string}>",
                              description: "Health",
                            },
                          ],
                          missing: [],
                          namespaces: [],
                        },
                  ),
                },
              ],
            });
    } else {
      res.writeHead(400).end();
      return;
    }
    if (message.method === "tools/call" && stream) {
      res.on("close", () => {
        closedStreams++;
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        stream === "partial"
          ? 'event: message\ndata: {"'
          : `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      );
      onStream();
      return; // Deliberately leave the stream open: the client must clean it up.
    }
    res
      .writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "synthetic-session",
      })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const nativeFetch = globalThis.fetch;
  const transport: typeof fetch = (url, init) => {
    expect(String(url)).toBe("https://mcp.executor.sh/org/test-org/mcp");
    expect(init?.redirect).toBe("error");
    return nativeFetch(
      `http://127.0.0.1:${address.port}/org/test-org/mcp`,
      init,
    );
  };
  return {
    calls,
    closedStreams: () => closedStreams,
    stream(mode: "result" | "partial", opened = () => {}) {
      stream = mode;
      onStream = opened;
    },
    fetch: transport,
    setResponse(value: unknown) {
      response = value;
    },
    setStatus(value: number) {
      status = value;
    },
    onCall(value: () => void) {
      onCall = value;
    },
    stall() {
      stalled = true;
    },
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("native HTTP catalog preserves typed pages, skills and exact signatures, without effects or fabricated empty success", async () => {
  const remote = await server();
  try {
    const client = createExecutor({
      pat,
      organization: "test-org",
      fetch: remote.fetch,
      authorize: (s, cap) => s.userId === "owner" && cap === "executor.catalog",
    });
    expect(await client.run(scope, search, signal(), current)).toEqual({
      status: "ready",
      untrusted: true,
      catalog: {
        kind: "search",
        page: { ...page, unavailableApps: [{ app: "disconnected" }] },
      },
    });
    expect(
      await client.run(scope, { kind: "skills", input: {} }, signal(), current),
    ).toMatchObject({
      status: "ready",
      catalog: { kind: "skills", text: "# Skills\nUntrusted catalog canary" },
    });
    expect(
      await client.run(
        scope,
        { kind: "describe", input: { paths: ["tools.example.health"] } },
        signal(),
        current,
      ),
    ).toMatchObject({
      status: "ready",
      catalog: {
        kind: "describe",
        page: {
          items: [
            {
              path: "tools.example.health",
              signature: "(): Promise<{status: string}>",
            },
          ],
        },
      },
    });
    expect(remote.calls.map((call) => call.name)).toEqual([
      "search",
      "skills",
      "describe",
    ]);
    expect(
      await client.run(
        scope,
        { kind: "execute", input: {} } as unknown as ExecutorRequest,
        signal(),
        current,
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await client.run(
        scope,
        { kind: "search", input: { limit: 21 } },
        signal(),
        current,
      ),
    ).toMatchObject({ code: "invalid_input" });
    expect(
      await client.run(
        { ...scope, userId: "foreign" },
        search,
        signal(),
        current,
      ),
    ).toMatchObject({ code: "denied" });
    expect(remote.calls).toHaveLength(3);
    for (const invalid of [
      { content: [] },
      { content: [{ type: "text", text: "not a catalog" }] },
      { content: [{ type: "text", text: pat }] },
    ]) {
      remote.setResponse(invalid);
      expect(await client.run(scope, search, signal(), current)).toMatchObject({
        code: "invalid_response",
      });
    }
    remote.setResponse({
      content: [{ type: "text", text: "private-error-canary" }],
      isError: true,
    });
    expect(await client.run(scope, search, signal(), current)).toMatchObject({
      code: "provider_error",
    });
    remote.setResponse({
      content: [{ type: "text", text: "x".repeat(262145) }],
    });
    expect(await client.run(scope, search, signal(), current)).toMatchObject({
      code: "response_too_large",
    });
    remote.setResponse({
      structuredContent: {
        items: [],
        namespaces: [],
        remaining: 0,
        next: null,
      },
      content: [],
    });
    expect(await client.run(scope, search, signal(), current)).toMatchObject({
      status: "ready",
      catalog: { page: { items: [], remaining: 0 } },
    });
    remote.setStatus(401);
    expect(await client.run(scope, search, signal(), current)).toMatchObject({
      code: "authorization_required",
    });
    expect(
      await createExecutor({ authorize: () => true }).run(
        scope,
        search,
        signal(),
        current,
      ),
    ).toMatchObject({ code: "not_configured" });
  } finally {
    await remote.close();
  }
});

test("current principal and source generation are fenced after I/O; deadlines, cancellation and capacity settle", async () => {
  const remote = await server();
  try {
    let grant = true;
    let generation = 1;
    const source = async () => {
      if (generation !== 1) throw new Error("Revoked source");
    };
    const client = createExecutor({
      pat,
      organization: "test-org",
      fetch: remote.fetch,
      authorize: () => grant,
    });
    remote.onCall(() => {
      grant = false;
    });
    expect(await client.run(scope, search, signal(), source)).toMatchObject({
      code: "denied",
    });
    grant = true;
    remote.onCall(() => {
      generation++;
    });
    expect(await client.run(scope, search, signal(), source)).toMatchObject({
      code: "denied",
    });
    remote.stall();
    remote.onCall(() => {});
    const timeout = createExecutor({
      pat,
      organization: "test-org",
      fetch: remote.fetch,
      timeoutMs: 50,
      authorize: () => true,
    });
    expect(await timeout.run(scope, search, signal(), current)).toMatchObject({
      code: "timeout",
    });
    const beforeAdmission = remote.calls.length;
    const controls = Array.from({ length: 4 }, () => new AbortController());
    const pending = controls.map((c) =>
      client.run(scope, search, c.signal, current),
    );
    // The earlier timeout need not reach tools/call. Count only these admissions.
    await expect.poll(() => remote.calls.length).toBe(beforeAdmission + 4);
    expect(await client.run(scope, search, signal(), current)).toMatchObject({
      code: "capacity",
    });
    for (const control of controls) control.abort();
    expect(await Promise.all(pending)).toEqual(
      controls.map(() => ({ status: "unavailable", code: "cancelled" })),
    );
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await client.run(scope, search, aborted.signal, current),
    ).toMatchObject({ code: "cancelled" });
  } finally {
    await remote.close();
  }
});

test("native SSE result and partial-body cancellation close the owned response stream", async () => {
  const remote = await server();
  try {
    const client = createExecutor({
      pat,
      organization: "test-org",
      fetch: remote.fetch,
      authorize: () => true,
    });
    remote.stream("result");
    expect(await client.run(scope, search, signal(), current)).toMatchObject({
      status: "ready",
    });
    await expect.poll(remote.closedStreams).toBe(1);
    const control = new AbortController();
    remote.stream("partial", () => control.abort());
    expect(
      await client.run(scope, search, control.signal, current),
    ).toMatchObject({ code: "cancelled" });
    await expect.poll(remote.closedStreams).toBe(2);
    const bounded = createExecutor({
      pat,
      organization: "test-org",
      fetch: remote.fetch,
      authorize: () => true,
      timeoutMs: 50,
    });
    expect(
      await bounded.run(() => new Promise(() => {}), search, signal(), current),
    ).toMatchObject({ code: "timeout" });
    expect(
      await bounded.run(scope, search, signal(), () => new Promise(() => {})),
    ).toMatchObject({ code: "timeout" });
  } finally {
    await remote.close();
  }
});

test("native Worker catalog and failures export sanitized spans and linked completion logs", async (context) => {
  const remote = await server();
  const originalFetch = globalThis.fetch;
  const traces: string[] = [],
    logs: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://api.axiom.co/v1/traces") {
      traces.push(String(init?.body));
      return Response.json({});
    }
    if (String(url) === "https://api.axiom.co/v1/logs") {
      logs.push(String(init?.body));
      return Response.json({});
    }
    return originalFetch(url, init);
  };
  const previous = {
    token: process.env.COMPUTAH_AXIOM_INGEST_TOKEN,
    dataset: process.env.COMPUTAH_AXIOM_LOG_DATASET,
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-logs";
  const telemetry = await startObservability("backend");
  try {
    await traceOperation("synthetic", async () => {
      const client = createExecutor({
        pat,
        organization: "test-org",
        fetch: remote.fetch,
        authorize: () => true,
        timeoutMs: 50,
      });
      remote.setStatus(403);
      expect(await client.run(scope, search, signal(), current)).toMatchObject({
        code: "authorization_required",
      });
      remote.setStatus(200);
      remote.stall();
      expect(await client.run(scope, search, signal(), current)).toMatchObject({
        code: "timeout",
      });
      const control = new AbortController();
      remote.onCall(() => control.abort());
      expect(
        await client.run(scope, search, control.signal, current),
      ).toMatchObject({ code: "cancelled" });
    });
    await exerciseWorker(context);
  } finally {
    await remote.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    if (previous.token === undefined)
      delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    else process.env.COMPUTAH_AXIOM_INGEST_TOKEN = previous.token;
    if (previous.dataset === undefined)
      delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
    else process.env.COMPUTAH_AXIOM_LOG_DATASET = previous.dataset;
  }
  type Span = {
    name: string;
    spanId: string;
    traceId: string;
    parentSpanId?: string;
    attributes: { key: string; value: { stringValue: string } }[];
  };
  const spans: Span[] = traces.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: { scopeSpans: { spans: Span[] }[] }) =>
        r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const catalogs = spans.filter((s) => s.name === "computah.executor.catalog");
  expect(catalogs.length).toBeGreaterThanOrEqual(7);
  for (const span of catalogs) {
    expect(
      spans.some(
        (p) => p.spanId === span.parentSpanId && p.traceId === span.traceId,
      ),
    ).toBe(true);
    expect(logs.join()).toContain(span.spanId);
  }
  expect(
    catalogs.map(
      (s) => s.attributes.find((a) => a.key === "outcome")?.value.stringValue,
    ),
  ).toEqual(
    expect.arrayContaining([
      "ready",
      "denied",
      "authorization_required",
      "timeout",
      "cancelled",
    ]),
  );
  for (const canary of [
    pat,
    scope.tenantId,
    "Untrusted catalog canary",
    "private-account-canary",
    "private-error-canary",
  ])
    expect([...traces, ...logs].join()).not.toContain(canary);
});

async function exerciseWorker(context: TestContext) {
  const remote = await server();
  const model = {
    id: "test",
    name: "test",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
  const faux = createFauxCore({
    provider: "executor-test",
    api: "executor-test",
    tokensPerSecond: 0,
    models: [model],
  });
  const observed: unknown[] = [];
  let grant = true;
  const core = createCore({
    connectionSecret: "a".repeat(64),
    model: "executor-test/test",
    apiKeys: { "executor-test": "synthetic" },
    authorize: (s, cap) =>
      cap !== "executor.catalog" || (grant && s.userId === "owner"),
    executor: { pat, organization: "test-org", fetch: remote.fetch },
    providers: {
      "executor-test": {
        api: "executor-test",
        baseUrl: "http://unused.invalid",
        models: [model],
        streamSimple(model, request, options) {
          expect(
            request.messages
              .filter((m) => m.role === "system")
              .map(getSystemMessageText)
              .join(),
          ).toContain("No app call/execute/resume");
          const last = request.messages.at(-1);
          let response = fauxAssistantMessage(
            fauxToolCall("executor_skills", {}),
            { stopReason: "toolUse" },
          );
          if (last?.role === "toolResult") {
            const evidence = JSON.parse(
              last.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(""),
            );
            observed.push(evidence);
            response =
              evidence.status === "ready" &&
              last.toolName !== "executor_describe"
                ? fauxAssistantMessage(
                    fauxToolCall(
                      last.toolName === "executor_skills"
                        ? "executor_search"
                        : "executor_describe",
                      last.toolName === "executor_skills"
                        ? { query: "health", limit: 1 }
                        : { paths: ["tools.example.health"] },
                    ),
                    { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage("catalog received");
          }
          faux.setResponses([response]);
          return faux.streamSimple(model, request, options);
        },
      },
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const session = core.attach(client)(scope);
    const worker = session.workerId("catalog");
    const first = await session.submit(worker, "discover", "first");
    await session.wait(worker, first.submissionId);
    expect(observed).toHaveLength(3);
    expect(remote.calls.map((c) => c.name)).toEqual([
      "skills",
      "search",
      "describe",
    ]);
    await session.sleep(worker);
    grant = false;
    const second = await session.submit(worker, "discover", "revoked");
    await session.wait(worker, second.submissionId);
    expect(observed.at(-1)).toMatchObject({ code: "denied" });
    expect(remote.calls).toHaveLength(3);
    expect(JSON.stringify(await session.history(worker))).not.toContain(pat);
  } finally {
    await core.close();
    await remote.close();
  }
}

test("native Worker source-check outage settles within the Executor deadline without dispatch", async (context) => {
  const remote = await server();
  const faux = fauxProvider({
    provider: "executor-source-test",
    models: [{ id: "test" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  let stall = false;
  const observed: string[] = [];
  faux.setResponses([
    () => {
      stall = true;
      return fauxAssistantMessage(fauxToolCall("executor_skills", {}), {
        stopReason: "toolUse",
      });
    },
    (request) => {
      observed.push(JSON.stringify(request.messages));
      return fauxAssistantMessage("source unavailable");
    },
  ]);
  const core = createCore({
    connectionSecret: "b".repeat(64),
    authorize: () => true,
    model: "executor-source-test/test",
    models,
    executor: { pat, organization: "test-org", fetch: remote.fetch },
    sources: {
      available: () => true,
      preload: async () => ({
        text: "private-source-canary",
        grants: [{ handle: "opaque", version: "generation-one" }],
      }),
      check: async () => {
        if (stall) {
          stall = false;
          await new Promise(() => {});
        }
      },
    },
    settings: { retry: { enabled: false } },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const session = core.attach(client)(scope);
    const worker = session.workerId("stalled-source");
    const submitted = await session.submit(worker, "catalog", "stalled-source");
    const started = performance.now();
    const settled = await session.wait(worker, submitted.submissionId);
    expect(settled.status).toBe("done");
    expect(observed.join()).toContain("timeout");
    expect(performance.now() - started).toBeLessThan(20000);
    expect(remote.calls).toHaveLength(0);
  } finally {
    await core.close();
    await remote.close();
  }
});
