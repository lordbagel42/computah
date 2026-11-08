import { startObservability } from "@computah/observability";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { createCore } from "../src/core.js";
import { smokeProvider } from "../src/smoke-model.js";

test("Pi phases and delegated Rivet actions reach the sanitized exporter without private content", async (context) => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://api.axiom.co/v1/traces") {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }
    return originalFetch(input, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  const telemetry = await startObservability("backend");
  const core = createCore({
    connectionSecret: "a".repeat(64),
    authorize: () => true,
    model: "computah-smoke/deterministic",
    providers: { "computah-smoke": smokeProvider() },
    apiKeys: { "computah-smoke": "synthetic" },
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
  } finally {
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
  }
  const spans = bodies.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: { scopeSpans: { spans: { name: string }[] }[] }) =>
        r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  expect(spans.some((s) => s.name === "pi.durable.phase")).toBe(true);
  expect(spans.some((s) => s.name === "interaction/admit")).toBe(true);
  expect(spans.some((s) => s.name === "worker/admit")).toBe(true);
  expect(bodies.join()).not.toContain("private-prompt-canary");
  expect(bodies.join()).not.toContain("private-user-canary");
  expect(bodies.join()).not.toContain("private-tenant-canary");
}, 30000);
