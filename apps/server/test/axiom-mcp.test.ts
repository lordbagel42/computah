import { startObservability, traceOperation } from "@computah/observability";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { setupTest } from "rivetkit/test";
import { expect, type TestContext, test } from "vitest";
import { createAxiomMcp } from "../src/axiom-mcp.js";
import { createCore } from "../src/core.js";

const scope = {
  tenantId: "private-tenant",
  userId: "operator",
  agentId: "default",
};
const pat = "synthetic-private-pat";
const signal = () => new AbortController().signal;
const tools = [
  "listDatasets",
  "getDatasetFields",
  "queryDataset",
  "createDataset",
  "deleteMonitor",
].map((name) => ({ name, inputSchema: { type: "object" } }));

function mcp(onCall?: (name: string) => void, isError = false): typeof fetch {
  return async (url, init) => {
    expect(String(url)).toBe("https://mcp.axiom.co/mcp");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${pat}`,
    );
    expect(new Headers(init?.headers).get("x-axiom-org-id")).toBe(
      "synthetic-org",
    );
    expect(init?.redirect).toBe("error");
    const message = JSON.parse(String(init?.body));
    if (!message.id) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize")
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic", version: "1" },
      };
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      onCall?.(message.params.name);
      result = {
        content: [{ type: "text", text: "synthetic-query-evidence" }],
        isError,
      };
    } else throw new Error("Unexpected method");
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

test("official protocol discovery and query are read-allowlisted and grant checked before dispatch and disclosure", async () => {
  let grant = true;
  const calls: string[] = [];
  const client = createAxiomMcp({
    pat,
    orgId: "synthetic-org",
    authorize: (_scope, capability) => grant && capability === "axiom.read",
    fetch: mcp((name) => calls.push(name)),
  });
  const discovered = await client.run(scope, signal());
  expect(discovered).toMatchObject({
    status: "ready",
    result: tools.slice(0, 3),
  });
  const call = {
    name: "queryDataset",
    argumentsJson: '{"query":"private-query-canary"}',
  };
  expect(await client.run(scope, signal(), call)).toMatchObject({
    status: "ready",
    result: { content: [{ text: "synthetic-query-evidence" }] },
  });
  expect(
    await client.run(scope, signal(), { ...call, name: "createDataset" }),
  ).toMatchObject({ code: "invalid_input" });
  expect(calls).toEqual(["queryDataset"]);
  grant = false;
  expect(await client.run(scope, signal(), call)).toMatchObject({
    code: "denied",
  });
  expect(calls).toHaveLength(1);
  grant = true;
  const revoked = createAxiomMcp({
    pat,
    orgId: "synthetic-org",
    authorize: () => grant,
    fetch: mcp(() => {
      grant = false;
    }),
  });
  expect(await revoked.run(scope, signal(), call)).toMatchObject({
    code: "denied",
  });
  expect(
    await createAxiomMcp({ authorize: () => true }).run(scope, signal()),
  ).toMatchObject({ code: "not_configured" });
});

test("SSE reader cleanup settles before disclosure, including revocation or abort during session close", async () => {
  for (const outcome of ["denied", "cancelled"] as const) {
    let grant = true;
    let settled = false;
    const abort = new AbortController();
    const base = mcp();
    const client = createAxiomMcp({
      pat,
      orgId: "synthetic-org",
      authorize: () => grant,
      fetch: async (input, init) => {
        if (init?.method === "DELETE") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (outcome === "denied") grant = false;
          else abort.abort();
          return new Response(null, { status: 204 });
        }
        const message = JSON.parse(String(init?.body));
        if (message.method === "tools/list") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } })}\n\n`,
                  ),
                );
              },
              async cancel() {
                await new Promise((resolve) => setTimeout(resolve, 15));
                settled = true;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        const response = await base(input, init);
        response.headers.set("mcp-session-id", "synthetic-session");
        return response;
      },
    });
    expect(await client.run(scope, abort.signal)).toEqual({
      status: "unavailable",
      code: outcome,
    });
    expect(settled).toBe(true);
  }
});

test("four admitted operations reject a fifth and release slots after cancellation", async () => {
  let dispatched = 0;
  const client = createAxiomMcp({
    pat,
    orgId: "synthetic-org",
    authorize: () => true,
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) => {
        dispatched++;
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      }),
  });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const pending = controllers.map((controller) =>
    client.run(scope, controller.signal),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(dispatched).toBe(4);
  expect(await client.run(scope, signal())).toMatchObject({ code: "capacity" });
  for (const controller of controllers) controller.abort();
  expect(
    (await Promise.all(pending)).every(
      (result) =>
        result.status === "unavailable" && result.code === "cancelled",
    ),
  ).toBe(true);
  const last = new AbortController();
  const next = client.run(scope, last.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(dispatched).toBe(5);
  last.abort();
  expect(await next).toMatchObject({ code: "cancelled" });
});

test("native MCP discovery/call, wake and denial plus failure/cancel/timeout export safe linked span outcomes", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      bodies.push(String(init?.body));
      return Response.json({});
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  const telemetry = await startObservability("backend");
  try {
    await traceOperation("synthetic", async () => {
      const ready = createAxiomMcp({
        pat,
        orgId: "synthetic-org",
        authorize: () => true,
        fetch: mcp(),
      });
      expect(await ready.run(scope, signal())).toMatchObject({
        status: "ready",
      });
      const rejected = createAxiomMcp({
        pat,
        orgId: "synthetic-org",
        authorize: () => true,
        fetch: async () => new Response(pat, { status: 403 }),
      });
      expect(await rejected.run(scope, signal())).toMatchObject({
        code: "authorization_required",
      });
      const abort = new AbortController();
      const cancelled = createAxiomMcp({
        pat,
        orgId: "synthetic-org",
        authorize: () => true,
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error(pat)),
              { once: true },
            );
            abort.abort();
          }),
      });
      expect(await cancelled.run(scope, abort.signal)).toMatchObject({
        code: "cancelled",
      });
      const timeout = createAxiomMcp({
        pat,
        orgId: "synthetic-org",
        authorize: () => true,
        fetch: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error(pat)),
              { once: true },
            );
          }),
      });
      expect(await timeout.run(scope, signal())).toMatchObject({
        code: "timeout",
      });
      const huge = createAxiomMcp({
        pat,
        orgId: "synthetic-org",
        authorize: () => true,
        fetch: async () =>
          new Response("x".repeat(262_145), {
            headers: { "content-type": "application/json" },
          }),
      });
      expect(await huge.run(scope, signal())).toMatchObject({
        code: "response_too_large",
      });
      const toolError = createAxiomMcp({
        pat,
        orgId: "synthetic-org",
        authorize: () => true,
        fetch: mcp(undefined, true),
      });
      expect(
        await toolError.run(scope, signal(), {
          name: "queryDataset",
          argumentsJson: '{"query":"private-query-canary"}',
        }),
      ).toEqual({ status: "unavailable", code: "provider_error" });
    });
    await exerciseNative(context);
  } finally {
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  }
  const spans: {
    name: string;
    spanId: string;
    parentSpanId: string;
    status: { code: number };
    attributes: { key: string; value: { stringValue: string } }[];
  }[] = bodies.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: {
        scopeSpans: {
          spans: {
            name: string;
            spanId: string;
            parentSpanId: string;
            status: { code: number };
            attributes: { key: string; value: { stringValue: string } }[];
          }[];
        }[];
      }) => r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const parent = spans.find((s) => s.name === "computah.synthetic");
  const children = spans.filter(
    (s) =>
      s.name === "computah.axiom.discover" && s.parentSpanId === parent?.spanId,
  );
  expect(children).toHaveLength(5);
  expect(children.every((s) => s.parentSpanId === parent?.spanId)).toBe(true);
  expect(
    children.map((s) => [
      s.status.code,
      s.attributes.find((a) => a.key === "outcome")?.value.stringValue,
    ]),
  ).toEqual([
    [0, "ready"],
    [2, "authorization_required"],
    [2, "cancelled"],
    [2, "timeout"],
    [2, "response_too_large"],
  ]);
  expect(bodies.join()).not.toContain(pat);
  expect(bodies.join()).not.toContain(scope.tenantId);
  expect(bodies.join()).not.toContain("private-query-canary");
  const nativeCalls = spans.filter((s) => s.name === "computah.axiom.call");
  expect(nativeCalls).toHaveLength(3);
  expect(
    nativeCalls
      .find((s) => s.parentSpanId === parent?.spanId)
      ?.attributes.find((a) => a.key === "outcome")?.value.stringValue,
  ).toBe("provider_error");
  expect(
    nativeCalls.every((s) => spans.some((p) => p.spanId === s.parentSpanId)),
  ).toBe(true);
});

async function exerciseNative(context: TestContext) {
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
    provider: "axiom-test",
    api: "axiom-test",
    tokensPerSecond: 0,
    models: [model],
  });
  const observed: unknown[] = [];
  let calls = 0;
  const core = createCore({
    connectionSecret: "a".repeat(64),
    model: "axiom-test/test",
    apiKeys: { "axiom-test": "synthetic" },
    authorize: (s, capability) =>
      capability !== "axiom.read" || s.userId === "operator",
    axiomMcp: { pat, orgId: "synthetic-org", fetch: mcp(() => calls++) },
    providers: {
      "axiom-test": {
        api: "axiom-test",
        baseUrl: "http://unused.invalid",
        models: [model],
        streamSimple(model, request, options) {
          expect(
            request.messages
              .filter((m) => m.role === "system")
              .map(getSystemMessageText)
              .join(),
          ).toContain("axiom.read operator grant");
          const last = request.messages.at(-1);
          let response = fauxAssistantMessage("evidence received");
          if (last?.role === "toolResult") {
            const evidence = JSON.parse(
              last.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(""),
            );
            observed.push(evidence);
            response =
              last.toolName === "axiom_discover" && evidence.status === "ready"
                ? fauxAssistantMessage(
                    fauxToolCall("axiom_read", {
                      name: "queryDataset",
                      argumentsJson: "{}",
                    }),
                    { stopReason: "toolUse" },
                  )
                : fauxAssistantMessage("evidence received");
          } else
            response = fauxAssistantMessage(
              fauxToolCall("axiom_discover", {}),
              { stopReason: "toolUse" },
            );
          faux.setResponses([response]);
          return faux.streamSimple(model, request, options);
        },
      },
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const operator = core.attach(client)(scope);
    const first = await operator.submit(
      operator.interactionId,
      "discover",
      "first",
    );
    await operator.wait(operator.interactionId, first.submissionId);
    expect(observed).toHaveLength(2);
    expect(calls).toBe(1);
    await operator.sleep(operator.interactionId);
    const second = await operator.submit(
      operator.interactionId,
      "discover",
      "second",
    );
    await operator.wait(operator.interactionId, second.submissionId);
    expect(calls).toBe(2);
    const denied = core.attach(client)({ ...scope, userId: "nonoperator" });
    const input = await denied.submit(
      denied.interactionId,
      "discover",
      "denied",
    );
    await denied.wait(denied.interactionId, input.submissionId);
    expect(observed.at(-1)).toMatchObject({ code: "denied" });
    expect(calls).toBe(2);
  } finally {
    await core.close();
  }
}
