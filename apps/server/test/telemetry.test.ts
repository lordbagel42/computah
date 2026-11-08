import {
  currentTraceHeaders,
  startObservability,
  traceHttp,
  traceOperation,
} from "@computah/observability";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { readConfig } from "../src/config.js";
import { createCore } from "../src/core.js";
import { closeHttp, createHttpServer } from "../src/http.js";
import {
  createOperations,
  createOperationsExtension,
  type OperationalTarget,
} from "../src/operations.js";
import { smokeProvider } from "../src/smoke-model.js";
import { createTavily } from "../src/tavily.js";

test("Pi phases keep traces content-free while opted-in native content reaches private logs", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  const logBodies: string[] = [];
  const cleanupElapsed: number[] = [];
  let queryCleanupElapsed = 0;
  let ingress: Record<string, string> = {};
  let diagnosticsParent: Record<string, string> = {};
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    if (String(input) === "https://api.axiom.co/v1/logs") {
      logBodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-sentinel-logs";
  const priorContent = process.env.COMPUTAH_AXIOM_CONTENT_ENABLED;
  process.env.COMPUTAH_AXIOM_CONTENT_ENABLED = "1";
  const telemetry = await startObservability("backend");
  const scope = {
    tenantId: "private-tenant-canary",
    userId: "private-user-canary",
    agentId: "default",
  };
  let action: "allow" | "cancel" = "allow";
  let operationsAllowed = true;
  const smoke = smokeProvider();
  const smokeStream = smoke.streamSimple;
  if (!smokeStream) throw new Error("Smoke stream unavailable");
  const faux = createFauxCore({
    api: "computah-smoke",
    provider: "computah-smoke",
    models: smoke.models,
    tokensPerSecond: 0,
  });
  const core = createCore({
    connectionSecret: "a".repeat(64),
    authorize: (_scope, capability) =>
      capability !== "operations.read" || operationsAllowed,
    model: "computah-smoke/deterministic",
    providers: {
      "computah-smoke": {
        ...smoke,
        streamSimple(model, request, options) {
          const last = request.messages.at(-1);
          const command = request.messages.findLast(
            (message) => message.role === "user",
          );
          if (
            command?.role === "user" &&
            command.content === "causal-http-canary"
          ) {
            const interaction = request.messages
              .filter((message) => message.role === "system")
              .map(getSystemMessageText)
              .join("\n")
              .includes("Interaction agent");
            faux.setResponses([
              last?.role !== "toolResult"
                ? fauxAssistantMessage(fauxToolCall("self_docs_discover", {}), {
                    stopReason: "toolUse",
                  })
                : last.toolName === "self_docs_discover" && interaction
                  ? fauxAssistantMessage(
                      fauxToolCall("Task", {
                        worker: "primary",
                        text: "causal-http-canary",
                      }),
                      { stopReason: "toolUse" },
                    )
                  : fauxAssistantMessage("bounded completed answer"),
            ]);
            return faux.streamSimple(model, request, options);
          }
          if (
            command?.role !== "user" ||
            command.content !== "private-operations-canary"
          )
            return smokeStream(model, request, options);
          faux.setResponses([
            last?.role !== "toolResult"
              ? fauxAssistantMessage(fauxToolCall("operations_discover", {}), {
                  stopReason: "toolUse",
                })
              : last.toolName === "operations_discover"
                ? fauxAssistantMessage(
                    fauxToolCall("message_timing", { requestId: "previous" }),
                    { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage("Measured tool result received"),
          ]);
          return faux.streamSimple(model, request, options);
        },
      },
    },
    apiKeys: { "computah-smoke": "synthetic" },
    operations: {
      queryToken: "private-query-token-canary",
      fetch: async (_url, init) => {
        const { apl } = JSON.parse(String(init?.body));
        const root = /trace_id in \('([a-f0-9]{32})'/.exec(apl)?.[1];
        expect(root).toMatch(/^[a-f0-9]{32}$/);
        return Response.json({
          status: { isPartial: true },
          tables: [
            {
              fields: [
                "_time",
                "trace_id",
                "span_id",
                "name",
                "duration_ms",
              ].map((name) => ({ name })),
              columns: [
                [new Date().toISOString()],
                [root],
                ["f".repeat(16)],
                ["private-returned-span-canary"],
                [17],
              ],
            },
          ],
        });
      },
    },
    sentinel: {
      ownerScope: scope,
      reviews: [{ scope, mode: "preflight" }],
      review: async (input) => ({
        action,
        reason: action === "allow" ? "consistent-with-intent" : "privacy-risk",
        evidence: action === "allow" ? [] : ["task"],
        scope: { reviewId: input.reviewId, stage: input.stage },
      }),
    },
  });
  const runtime = await setupTest(context, core.registry);
  const authToken = "synthetic-http-token-not-a-real-credential";
  const server = createHttpServer({
    ...readConfig({
      COMPUTAH_MODE: "faux",
      COMPUTAH_CONNECTION_SECRET: "s".repeat(64),
      COMPUTAH_AUTH_JSON: JSON.stringify([
        {
          ...scope,
          token: authToken,
          capabilities: ["task.send", "history.read"],
        },
      ]),
    }),
    bind: core.attach(runtime.client),
  });
  traceHttp(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing HTTP address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const session = core.attach(runtime.client)({
      tenantId: "private-tenant-canary",
      userId: "private-user-canary",
      agentId: "default",
    });
    const receipt = await session.submit(
      session.interactionId,
      "private-prompt-canary",
      "capture-request",
    );
    const result = await session.result(
      session.interactionId,
      receipt.submissionId,
      true,
    );
    expect(result.submission.status).toBe("done");
    expect(
      await session.submit(
        session.interactionId,
        "private-prompt-canary",
        "capture-request",
      ),
    ).toEqual(receipt);
    await expect(
      session.submit(
        session.interactionId,
        "rejected-conflict-content",
        "capture-request",
      ),
    ).rejects.toThrow();
    await traceOperation("synthetic", async () => {
      ingress = currentTraceHeaders();
      const admitted = await fetch(`${base}/v1/submissions`, {
        method: "POST",
        headers: {
          ...ingress,
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          text: "causal-http-canary",
          clientMutationId: "synthetic-request",
        }),
      });
      expect(admitted.status).toBe(202);
      const receipt = (await admitted.json()) as { id: string };
      const result = await fetch(
        `${base}/v1/submissions/${receipt.id}?wait=true`,
        { headers: { ...ingress, authorization: `Bearer ${authToken}` } },
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        submission: { outcome: "completed" },
      });
    });
    const operational = await session.submit(
      session.interactionId,
      "private-operations-canary",
      "private-operations-request-canary",
    );
    expect(
      (
        await session.result(
          session.interactionId,
          operational.submissionId,
          true,
        )
      ).submission.status,
    ).toBe("done");
    operationsAllowed = false;
    const operationalDenied = await session.submit(
      session.interactionId,
      "private-operations-canary",
      "private-denied-request-canary",
    );
    expect(
      (
        await session.result(
          session.interactionId,
          operationalDenied.submissionId,
          true,
        )
      ).submission.status,
    ).toBe("done");
    action = "cancel";
    const denied = await session.submit(
      session.interactionId,
      "private-sentinel-canary",
      "sentinel-denial",
    );
    expect(
      (await session.wait(session.interactionId, denied.submissionId)).status,
    ).toBe("unanswered");
    await traceOperation("synthetic", async () => {
      diagnosticsParent = currentTraceHeaders();
      const target: OperationalTarget = {
        requestId: "private-request-id-canary",
        submissionId: 1,
        actorId: "private-actor-canary",
        conversationId: 1,
        status: "done",
        entryId: 1,
        answerId: 2,
        admittedAt: new Date().toISOString(),
        traceId: "e".repeat(32),
        executionTraceId: null,
        workerLinksOmitted: 0,
      };
      for (const expected of ["ready", "denied", "cancelled", "unavailable"]) {
        let allowed = true;
        const abort = new AbortController();
        const extension = createOperationsExtension({
          client: createOperations({ authorize: () => allowed }),
          scope: async () => scope,
          target: async () => {
            if (expected === "denied") allowed = false;
            if (expected === "cancelled") abort.abort();
            return expected === "unavailable"
              ? []
              : [{ ...target, inputPreview: "private-catalog-preview-canary" }];
          },
          transportTiming: async () => {
            throw new Error("Catalog must not query transport");
          },
        });
        const tool = extension.tools?.find(
          (tool) => tool.name === "message_timing",
        );
        if (!tool) throw new Error("Missing timing tool");
        const result = JSON.stringify(
          await tool.execute(
            { requestId: "recent" },
            {} as ToolExecutionApi,
            withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
          ),
        );
        expect(result).toContain(expected);
        if (expected !== "ready")
          expect(result).not.toContain("private-catalog-preview-canary");
      }
      const controller = new AbortController();
      for (const [code, authorize, queryToken, fetch, targets, signal] of [
        [
          "denied",
          false,
          "private-query-token-canary",
          async () => Response.json({}),
          [target],
          new AbortController().signal,
        ],
        [
          "not_configured",
          true,
          undefined,
          async () => Response.json({}),
          [target],
          new AbortController().signal,
        ],
        [
          "correlation_unavailable",
          true,
          "private-query-token-canary",
          async () => Response.json({}),
          [{ ...target, traceId: null }],
          new AbortController().signal,
        ],
        [
          "invalid_response",
          true,
          "private-query-token-canary",
          async () =>
            Response.json({ unexpected: "private-invalid-response-canary" }),
          [target],
          new AbortController().signal,
        ],
        [
          "authorization_required",
          true,
          "private-query-token-canary",
          async () => {
            const started = performance.now();
            return new Response(
              new ReadableStream({
                async cancel() {
                  await new Promise((resolve) => setTimeout(resolve, 20));
                  queryCleanupElapsed = performance.now() - started;
                },
              }),
              { status: 403 },
            );
          },
          [target],
          new AbortController().signal,
        ],
        [
          "cancelled",
          true,
          "private-query-token-canary",
          async () => {
            return new Response(
              new ReadableStream({
                start(stream) {
                  controller.abort();
                  stream.error(new Error("private-cancellation-canary"));
                },
                async cancel() {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                },
              }),
            );
          },
          [target],
          controller.signal,
        ],
      ] as const) {
        const client = createOperations({
          authorize: () => authorize,
          queryToken,
          fetch,
        });
        expect(await client.query(scope, [...targets], signal)).toMatchObject({
          code,
        });
      }
      const originalTimeout = AbortSignal.timeout;
      const deadline = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) =>
          ms === 10_000 ? AbortSignal.abort() : originalTimeout(ms),
        );
      try {
        const client = createOperations({
          authorize: () => true,
          queryToken: "private-query-token-canary",
          fetch: async (_url, init) => {
            init?.signal?.throwIfAborted();
            throw new Error("Expected the query deadline to abort");
          },
        });
        expect(
          await client.query(scope, [target], new AbortController().signal),
        ).toMatchObject({ code: "timeout" });
      } finally {
        deadline.mockRestore();
      }
      const empty = createOperations({
        authorize: () => true,
        queryToken: "private-query-token-canary",
        fetch: async () =>
          Response.json({ status: { isPartial: false }, tables: [] }),
      });
      expect(
        await empty.query(scope, [target], new AbortController().signal),
      ).toMatchObject({ status: "ready", spans: [] });
      for (const [request, status] of [
        [{ query: "private-query-canary" }, 200],
        [{ urls: ["https://example.com/private-url-canary"] }, 429],
      ] as const) {
        const web = createTavily({
          apiKey: "private-key-canary",
          authorize: () => true,
          fetch: async () => Response.json({ results: [] }, { status }),
        });
        await Effect.runPromise(
          web.run(
            scope,
            "query" in request ? request : { urls: [...request.urls] },
          ),
        );
      }
      const denied = createTavily({ authorize: () => false });
      await Effect.runPromise(
        denied.run(scope, { query: "private-query-canary" }),
      );
      let cleanup = false;
      const timeout = createTavily({
        apiKey: "private-key-canary",
        authorize: () => true,
        timeoutMs: 10,
        fetch: async () => {
          const started = performance.now();
          return new Response(
            new ReadableStream({
              async cancel() {
                await new Promise((resolve) => setTimeout(resolve, 10));
                cleanup = true;
                cleanupElapsed.push(performance.now() - started);
              },
            }),
          );
        },
      });
      expect(
        await Effect.runPromise(
          timeout.run(scope, { query: "private-query-canary" }),
        ),
      ).toMatchObject({ code: "timeout" });
      expect(cleanup).toBe(true);
      cleanup = false;
      const abort = new AbortController();
      const cancelled = createTavily({
        apiKey: "private-key-canary",
        authorize: () => true,
        fetch: async () => {
          const started = performance.now();
          setTimeout(() => abort.abort(), 10);
          return new Response(
            new ReadableStream({
              async cancel() {
                await new Promise((resolve) => setTimeout(resolve, 10));
                cleanup = true;
                cleanupElapsed.push(performance.now() - started);
              },
            }),
          );
        },
      });
      await expect(
        Effect.runPromise(
          cancelled.run(scope, { query: "private-query-canary" }),
          { signal: abort.signal },
        ),
      ).rejects.toBeDefined();
      expect(cleanup).toBe(true);
    });
  } finally {
    await closeHttp(server);
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    if (priorContent === undefined)
      delete process.env.COMPUTAH_AXIOM_CONTENT_ENABLED;
    else process.env.COMPUTAH_AXIOM_CONTENT_ENABLED = priorContent;
  }
  const spans: {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    status: { code: number };
    attributes: { key: string; value: { stringValue?: string } }[];
  }[] = bodies.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: {
        scopeSpans: {
          spans: {
            name: string;
            traceId: string;
            spanId: string;
            parentSpanId?: string;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            status: { code: number };
            attributes: { key: string; value: { stringValue?: string } }[];
          }[];
        }[];
      }) => r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  expect(spans.some((s) => s.name === "pi.durable.phase")).toBe(true);
  expect(spans.some((s) => s.name === "interaction/admit")).toBe(true);
  expect(spans.some((s) => s.name === "worker/admit")).toBe(true);
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find((a) => a.key === key)?.value.stringValue;
  const turn = spans.filter(
    (s) => s.traceId === ingress.traceparent?.split("-")[1],
  );
  const admissions = turn.filter((s) => s.name === "pi.durable.submit");
  expect(admissions).toHaveLength(2);
  for (const admitted of admissions) {
    expect(turn.find((s) => s.spanId === admitted.parentSpanId)).toBeDefined();
  }
  expect(
    admissions.some((admitted) => {
      const parent = turn.find((s) => s.spanId === admitted.parentSpanId);
      return parent && attr(parent, "tool.name") === "Task";
    }),
  ).toBe(true);
  expect(
    turn.filter((s) => attr(s, "gen_ai.operation.name") === "chat"),
  ).toHaveLength(5);
  const searches = turn.filter((s) => s.name === "computah.self_docs.discover");
  expect(searches).toHaveLength(2);
  for (const search of searches) {
    expect(attr(search, "tool.name")).toBe("self_docs_discover");
    const ancestry = [];
    let span: (typeof spans)[number] | undefined = search;
    while (span && span.spanId !== ingress.traceparent?.split("-")[2]) {
      ancestry.push(span.name);
      span = turn.find((candidate) => candidate.spanId === span?.parentSpanId);
    }
    expect(span?.spanId).toBe(ingress.traceparent?.split("-")[2]);
    expect(ancestry).toContain("pi.durable.submit");
    expect(ancestry).toContain("pi.durable.phase");
  }
  const timing = spans.find((s) => s.name === "computah.operations.timing");
  expect(timing).toBeDefined();
  expect(timing && attr(timing, "tool.name")).toBe("message_timing");
  expect(timing && attr(timing, "outcome")).toBe("ready");
  const nativeTool = spans.find(
    (s) => s.spanId === timing?.parentSpanId && s.traceId === timing?.traceId,
  );
  expect(nativeTool?.name).toBe("pi.durable.phase");
  const discovery = spans.find(
    (s) =>
      s.name === "computah.operations.discover" &&
      attr(s, "tool.name") === "operations_discover",
  );
  expect(discovery && attr(discovery, "outcome")).toBe("ready");
  expect(
    spans.some(
      (s) =>
        s.spanId === discovery?.parentSpanId &&
        s.traceId === discovery?.traceId &&
        s.name === "pi.durable.phase",
    ),
  ).toBe(true);
  const query = spans.find(
    (s) =>
      s.name === "computah.operations.query" &&
      s.parentSpanId === timing?.spanId &&
      s.traceId === timing?.traceId,
  );
  expect(query && attr(query, "outcome")).toBe("ready");
  for (const name of ["operations_discover", "message_timing"]) {
    const denied = spans.find(
      (s) => attr(s, "tool.name") === name && attr(s, "outcome") === "denied",
    );
    expect(denied?.status.code).toBe(2);
  }
  const logs: {
    traceId: string;
    spanId: string;
    attributes: {
      key: string;
      value: { stringValue?: string; doubleValue?: number };
    }[];
  }[] = logBodies.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (r: {
        scopeLogs: {
          logRecords: typeof logs;
        }[];
      }) => r.scopeLogs.flatMap((s) => s.logRecords),
    ),
  );
  const catalogs = spans.filter(
    (span) =>
      span.name === "computah.operations.timing" &&
      span.traceId === diagnosticsParent.traceparent?.split("-")[1] &&
      span.parentSpanId === diagnosticsParent.traceparent?.split("-")[2],
  );
  expect(catalogs.map((span) => attr(span, "outcome")).sort()).toEqual([
    "cancelled",
    "denied",
    "ready",
    "target_not_found_or_legacy_or_scan_limit",
  ]);
  for (const catalog of catalogs) {
    const outcome = attr(catalog, "outcome");
    expect(catalog.status.code).toBe(outcome === "ready" ? 0 : 2);
    expect(
      logs.find(
        (row) =>
          row.traceId === catalog.traceId && row.spanId === catalog.spanId,
      ),
    ).toBeDefined();
    expect(
      spans.some(
        (span) =>
          span.name === "computah.operations.query" &&
          span.parentSpanId === catalog.spanId,
      ),
    ).toBe(false);
  }
  expect(JSON.stringify(spans)).not.toContain("private-catalog-preview-canary");
  expect(JSON.stringify(logs)).not.toContain("private-catalog-preview-canary");
  for (const search of searches) {
    expect(
      logs.find(
        (row) => row.traceId === search.traceId && row.spanId === search.spanId,
      )?.attributes,
    ).toContainEqual({ key: "outcome", value: { stringValue: "ready" } });
  }
  for (const span of [timing, discovery, query]) {
    const log = logs.find(
      (row) => row.traceId === span?.traceId && row.spanId === span?.spanId,
    );
    expect(log?.attributes).toContainEqual({
      key: "outcome",
      value: { stringValue: "ready" },
    });
    if (span !== discovery)
      expect(log?.attributes).toContainEqual({
        key: "count",
        value: { doubleValue: 1 },
      });
  }
  for (const code of [
    "denied",
    "not_configured",
    "correlation_unavailable",
    "invalid_response",
    "authorization_required",
    "cancelled",
    "timeout",
  ]) {
    const span = spans.find(
      (s) =>
        s.name === "computah.operations.query" && attr(s, "outcome") === code,
    );
    expect(span?.status.code).toBe(2);
    const log = logs.find(
      (row) => row.traceId === span?.traceId && row.spanId === span?.spanId,
    );
    expect(log?.attributes).toContainEqual({
      key: "outcome",
      value: {
        stringValue:
          code === "denied" || code === "cancelled" || code === "timeout"
            ? code
            : "error",
      },
    });
    if (code !== "denied" && code !== "cancelled" && code !== "timeout")
      expect(log?.attributes).toContainEqual({
        key: "reason",
        value: { stringValue: code },
      });
  }
  const rejected = spans.find(
    (s) =>
      s.name === "computah.operations.query" &&
      attr(s, "outcome") === "authorization_required",
  );
  expect(queryCleanupElapsed).toBeGreaterThan(10);
  expect(
    Number(
      BigInt(rejected?.endTimeUnixNano ?? "0") -
        BigInt(rejected?.startTimeUnixNano ?? "0"),
    ) / 1_000_000,
  ).toBeGreaterThanOrEqual(queryCleanupElapsed);
  expect(
    logs.some(
      (row) =>
        row.attributes.some(
          (a) =>
            a.key === "operation" && a.value.stringValue === "operations.query",
        ) &&
        row.attributes.some(
          (a) => a.key === "count" && a.value.doubleValue === 0,
        ) &&
        row.attributes.some(
          (a) => a.key === "outcome" && a.value.stringValue === "ready",
        ),
    ),
  ).toBe(true);
  const field = (row: (typeof logs)[number], key: string) =>
    row.attributes.find((a) => a.key === key)?.value.stringValue;
  const content = logs.filter((row) => field(row, "content.kind"));
  const ordinaryLogs = JSON.stringify(
    logs.filter((row) => !field(row, "content.kind")),
  );
  const incoming = content
    .filter((row) => field(row, "content.kind") === "incoming")
    .map((row) => JSON.parse(field(row, "content.payload") ?? "null"));
  expect(
    incoming.filter((row) => row.requestId === "input:capture-request"),
  ).toHaveLength(1);
  expect(incoming).toContainEqual(
    expect.objectContaining({
      scope,
      actorId: expect.any(String),
      submissionId: expect.any(Number),
      requestId: "input:capture-request",
      text: "private-prompt-canary",
    }),
  );
  expect(JSON.stringify(content)).not.toContain("rejected-conflict-content");
  const toolCalls = content.filter(
    (row) => field(row, "content.kind") === "tool.call",
  );
  expect(
    toolCalls.some((row) =>
      field(row, "content.payload")?.includes('"name":"Task"'),
    ),
  ).toBe(true);
  for (const row of toolCalls) {
    expect(
      spans.some(
        (span) =>
          span.traceId === row.traceId &&
          span.spanId === row.spanId &&
          span.name === "pi.durable.phase",
      ),
    ).toBe(true);
  }
  const results = content
    .filter((row) => field(row, "content.kind") === "tool.result")
    .map((row) => JSON.parse(field(row, "content.payload") ?? "null"));
  expect(
    results.some(
      (row) =>
        row.name === "Task" &&
        JSON.stringify(row.output).includes("private-prompt-canary"),
    ),
  ).toBe(true);
  expect(results.some((row) => row.isError === true)).toBe(true);
  expect(content.some((row) => field(row, "content.kind") === "activity")).toBe(
    true,
  );
  const finals = content
    .filter((row) => field(row, "content.kind") === "final")
    .map((row) => JSON.parse(field(row, "content.payload") ?? "null"));
  expect(
    finals.some((row) => JSON.stringify(row).includes("private-prompt-canary")),
  ).toBe(true);
  expect(
    finals.some((row) =>
      JSON.stringify(row).includes("private-sentinel-canary"),
    ),
  ).toBe(false);
  expect(JSON.stringify(content)).not.toContain("private-query-token-canary");
  expect(JSON.stringify(content)).not.toContain("a".repeat(64));
  for (const privateValue of [
    "private-query-token-canary",
    "private-returned-span-canary",
    "private-operations-canary",
    "private-operations-request-canary",
    "private-denied-request-canary",
    "private-request-id-canary",
    "private-actor-canary",
    "private-invalid-response-canary",
    "private-cancellation-canary",
    "e".repeat(32),
    "f".repeat(16),
  ]) {
    expect(bodies.join()).not.toContain(privateValue);
    expect(ordinaryLogs).not.toContain(privateValue);
  }
  for (const operation of ["review", "enforce", "cancel"])
    expect(spans.some((s) => s.name === `computah.sentinel.${operation}`)).toBe(
      true,
    );
  const cancellation = spans.find((s) => s.name === "computah.sentinel.cancel");
  expect(cancellation?.traceId).toMatch(/^[a-f0-9]{32}$/);
  expect(cancellation?.parentSpanId).toMatch(/^[a-f0-9]{16}$/);
  for (const operation of ["review", "enforce"])
    expect(
      spans.some(
        (s) =>
          s.name === `computah.sentinel.${operation}` &&
          s.traceId === cancellation?.traceId &&
          s.parentSpanId === cancellation?.parentSpanId,
      ),
    ).toBe(true);
  expect(
    spans
      .filter((s) => s.name === "computah.sentinel.enforce")
      .some((s) =>
        s.attributes.some(
          (a) => a.key === "outcome" && a.value.stringValue === "fenced",
        ),
      ),
  ).toBe(true);
  expect(bodies.join()).not.toContain("private-sentinel-canary");
  expect(bodies.join()).not.toContain("reviewKey");
  for (const operation of ["review", "enforce", "cancel"])
    expect(logBodies.join()).toContain(`sentinel.${operation}`);
  for (const privateValue of [
    "private-sentinel-canary",
    "private-prompt-canary",
    "private-user-canary",
    "private-tenant-canary",
    "reviewKey",
  ])
    expect(ordinaryLogs).not.toContain(privateValue);
  const parent = spans.find(
    (s) => s.spanId === diagnosticsParent.traceparent?.split("-")[2],
  );
  expect(parent?.spanId).toMatch(/^[a-f0-9]{16}$/);
  const web = spans.filter((s) =>
    ["computah.web.search", "computah.web.extract"].includes(s.name),
  );
  expect(web).toHaveLength(5);
  expect(web.every((s) => s.parentSpanId === parent?.spanId)).toBe(true);
  expect(
    web.map((s) => [
      s.status.code,
      s.attributes.find((a) => a.key === "outcome")?.value.stringValue,
    ]),
  ).toEqual([
    [0, "ready"],
    [2, "rate_limited"],
    [2, "denied"],
    [2, "timeout"],
    [2, "cancelled"],
  ]);
  expect(cleanupElapsed).toHaveLength(2);
  for (const [index, span] of web.slice(3).entries())
    expect(
      Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) /
        1_000_000,
    ).toBeGreaterThanOrEqual(cleanupElapsed[index]);
  expect(bodies.join()).not.toContain("private-query-canary");
  expect(bodies.join()).not.toContain("private-url-canary");
  expect(bodies.join()).not.toContain("private-key-canary");
  expect(bodies.join()).not.toContain("private-prompt-canary");
  expect(bodies.join()).not.toContain("private-user-canary");
  expect(bodies.join()).not.toContain("private-tenant-canary");
}, 30000);
