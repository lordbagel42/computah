import { startObservability } from "@computah/observability";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { PiProviderConfig } from "@rivet-dev/pi";
import { setupTest } from "rivetkit/test";
import { expect, test } from "vitest";
import { createCore } from "../src/core.js";

test("timing selects the earlier answered exchange and its Worker, never this diagnostic run or a newer input, across sleep and retry", async (context) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url) === "https://api.axiom.co/v1/traces"
      ? new Response("{}")
      : originalFetch(url, init);
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  const telemetry = await startObservability("backend");
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
    provider: "ops-test",
    api: "ops-test",
    tokensPerSecond: 0,
    models: [model],
  });
  const observed: {
    targets: {
      requestId: string;
      submissionId: number;
      traceId: string | null;
      executionTraceId: string | null;
    }[];
    evidence: { status: string; code?: string };
  }[] = [];
  const queries: string[] = [];
  let enqueue: (() => void) | undefined;
  const provider: PiProviderConfig = {
    api: "ops-test",
    baseUrl: "http://unused.invalid",
    models: [model],
    streamSimple(model, request, options) {
      const system = request.messages
        .filter((m) => m.role === "system")
        .map((m) => getSystemMessageText(m))
        .join("\n");
      const interaction = system.includes("Interaction agent");
      const user = request.messages.findLast((m) => m.role === "user");
      const text = JSON.stringify(user?.content);
      const last = request.messages.at(-1);
      let response = fauxAssistantMessage("prior reply");
      if (interaction && text.includes("diagnose")) {
        expect(system).toContain("Admission is not ingress");
        if (last?.role === "toolResult") {
          observed.push(
            JSON.parse(
              last.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join(""),
            ),
          );
          response = fauxAssistantMessage("measured evidence received");
        } else {
          enqueue?.();
          enqueue = undefined;
          response = fauxAssistantMessage(
            fauxToolCall("message_timing", { requestId: "previous" }),
            { stopReason: "toolUse" },
          );
        }
      } else if (
        interaction &&
        text.includes("prior") &&
        last?.role !== "toolResult"
      ) {
        response = fauxAssistantMessage(
          fauxToolCall("Task", { worker: "primary", text: "prior work" }),
          { stopReason: "toolUse" },
        );
      }
      faux.setResponses([response]);
      return faux.streamSimple(model, request, options);
    },
  };
  const core = createCore({
    connectionSecret: "a".repeat(64),
    model: "ops-test/test",
    providers: { "ops-test": provider },
    apiKeys: { "ops-test": "synthetic" },
    authorize: (scope, capability) =>
      scope.userId === "alice" || capability !== "operations.read",
    operations: {
      queryToken: "synthetic-query",
      fetch: async (_url, init) => {
        const query = JSON.parse(String(init?.body)).apl as string;
        queries.push(query);
        const trace = /trace_id in \('([a-f0-9]{32})'/.exec(query)?.[1];
        return Response.json({
          status: { isPartial: false },
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
                [trace],
                ["c".repeat(16)],
                ["pi.durable.phase"],
                [42.25],
              ],
            },
          ],
        });
      },
    },
  });
  try {
    const { client } = await setupTest(context, core.registry);
    const alice = core.attach(client)({
      tenantId: "synthetic",
      userId: "alice",
      agentId: "default",
    });
    const prior = await alice.submit(alice.interactionId, "prior", "prior");
    const result = await alice.result(
      alice.interactionId,
      prior.submissionId,
      true,
    );
    expect(result.submission.status).toBe("done");
    expect(await alice.submit(alice.interactionId, "prior", "prior")).toEqual(
      prior,
    );
    await expect(
      alice.submit(alice.interactionId, "different", "prior"),
    ).rejects.toMatchObject({ code: "conflict" });
    await alice.sleep(alice.interactionId);
    let later: ReturnType<typeof alice.submit> | undefined;
    enqueue = () => {
      later = alice.submit(alice.interactionId, "later", "later");
    };
    const diagnostic = await alice.submit(
      alice.interactionId,
      "diagnose",
      "diagnostic",
    );
    await alice.wait(alice.interactionId, diagnostic.submissionId);
    expect(observed).toHaveLength(1);
    expect(observed[0].targets[0]).toMatchObject({
      requestId: "input:prior",
      submissionId: prior.submissionId,
    });
    expect(observed[0].targets[0].traceId).toBe(
      result.submission.trace?.traceparent?.split("-")[1],
    );
    expect(observed[0].targets[0].executionTraceId).toMatch(/^[a-f0-9]{32}$/);
    expect(observed[0].targets[1].requestId).toMatch(/^task:/);
    expect(observed[0].evidence.status).toBe("ready");
    expect(queries).toHaveLength(1);
    const diagnosticRecord = (
      await alice.result(alice.interactionId, diagnostic.submissionId)
    ).submission;
    expect(diagnosticRecord.trace?.traceparent).toMatch(/^00-/);
    expect(queries[0]).not.toContain(
      diagnosticRecord.trace?.traceparent.split("-")[1],
    );
    if (later)
      await alice.wait(alice.interactionId, (await later).submissionId);
    const bob = core.attach(client)({
      tenantId: "synthetic",
      userId: "bob",
      agentId: "default",
    });
    const denied = await bob.submit(bob.interactionId, "diagnose", "denied");
    await bob.wait(bob.interactionId, denied.submissionId);
    expect(queries).toHaveLength(1);
    expect(JSON.stringify(observed.at(-1))).toContain("denied");
  } finally {
    await core.close();
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  }
});
