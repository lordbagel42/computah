import { startObservability, traceOperation } from "@computah/observability";
import { Effect } from "effect";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { createCore } from "../src/core.js";
import { smokeProvider } from "../src/smoke-model.js";
import { createTavily } from "../src/tavily.js";

test("Pi phases and delegated Rivet actions reach the sanitized exporter without private content", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  const logBodies: string[] = [];
  const cleanupElapsed: number[] = [];
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
  const telemetry = await startObservability("backend");
  const scope = {
    tenantId: "private-tenant-canary",
    userId: "private-user-canary",
    agentId: "default",
  };
  let action: "allow" | "cancel" = "allow";
  const core = createCore({
    connectionSecret: "a".repeat(64),
    authorize: () => true,
    model: "computah-smoke/deterministic",
    providers: { "computah-smoke": smokeProvider() },
    apiKeys: { "computah-smoke": "synthetic" },
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
  try {
    const session = core.attach(runtime.client)({
      tenantId: "private-tenant-canary",
      userId: "private-user-canary",
      agentId: "default",
    });
    const receipt = await session.submit(
      session.interactionId,
      "private-prompt-canary",
      "synthetic-request",
    );
    const result = await session.result(
      session.interactionId,
      receipt.submissionId,
      true,
    );
    expect(result.submission.status).toBe("done");
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
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
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
    expect(logBodies.join()).not.toContain(privateValue);
  const parent = spans.find((s) => s.name === "computah.synthetic");
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
