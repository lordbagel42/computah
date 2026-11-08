import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import {
  createOperations,
  createOperationsExtension,
  type OperationalTarget,
} from "../src/operations.js";

const scope = { tenantId: "test", userId: "alice", agentId: "default" };
const target: OperationalTarget = {
  requestId: "input:prior",
  submissionId: 1,
  actorId: "synthetic",
  conversationId: 1,
  status: "done",
  entryId: 1,
  answerId: 2,
  admittedAt: new Date().toISOString(),
  traceId: "a".repeat(32),
  executionTraceId: "b".repeat(32),
  workerLinksOmitted: 0,
};
const signal = new AbortController().signal;
function response(partial = false) {
  return Response.json({
    status: { isPartial: partial },
    tables: [
      {
        fields: [
          "_time",
          "trace_id",
          "span_id",
          "name",
          "service.name",
          "duration_ms",
        ].map((name) => ({ name })),
        columns: [
          [target.admittedAt, target.admittedAt],
          [target.traceId, target.executionTraceId],
          ["c".repeat(16), "d".repeat(16)],
          ["pi.durable.phase", "chat gpt-6.1-terra"],
          ["computah-backend", "computah-backend"],
          [1000, 700.125],
        ],
      },
    ],
  });
}

test("operational queries require explicit grant and separate configuration, and recheck revocation", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  const denied = createOperations({
    queryToken: "synthetic-query",
    authorize: () => false,
    fetch,
  });
  expect(await denied.query(scope, [target], signal)).toMatchObject({
    code: "denied",
  });
  const noHistory = createOperations({
    queryToken: "synthetic-query",
    authorize: (_scope, capability) => capability !== "history.read",
    fetch,
  });
  expect(await noHistory.discover(scope)).toMatchObject({
    status: "configured",
  });
  expect(await noHistory.discover(scope, true)).toMatchObject({
    code: "denied",
  });
  const missing = createOperations({ authorize: () => true, fetch });
  expect(await missing.discover(scope)).toMatchObject({
    code: "not_configured",
  });
  expect(await missing.query(scope, [target], signal)).toMatchObject({
    code: "not_configured",
  });
  expect(fetch).not.toHaveBeenCalled();
  let allowed = true;
  const client = createOperations({
    queryToken: "synthetic-query",
    authorize: () => allowed,
    fetch: async () => {
      allowed = false;
      return response();
    },
  });
  expect(await client.query(scope, [target], signal)).toMatchObject({
    code: "denied",
  });
});

test("query uses recorded admission and execution roots, explicit milliseconds, and preserves overlapping and partial evidence", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(true));
  const client = createOperations({
    queryToken: "synthetic-query",
    authorize: () => true,
    fetch,
  });
  const result = await client.query(scope, [target], signal);
  expect(result).toMatchObject({
    status: "ready",
    partial: true,
    units: "ms",
    spans: [{ durationMs: 1000 }, { durationMs: 700.125 }],
  });
  expect(result).not.toHaveProperty("totalMs");
  expect(JSON.stringify(result)).not.toContain("synthetic-query");
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe(
    "https://us-east-1.aws.edge.axiom.co/v1/query/_apl?format=tabular",
  );
  const body = JSON.parse(String(init?.body));
  expect(body.apl).toContain(
    `trace_id in ('${target.traceId}','${target.executionTraceId}')`,
  );
  expect(body.apl).toContain("duration_ms = duration / 1ms");
  expect(body.apl).toContain("take 201");
  expect(
    Date.parse(body.endTime) - Date.parse(body.startTime),
  ).toBeLessThanOrEqual(86_400_000);
});

test("foreign roots, provider failures, and oversized responses cannot disclose raw payloads", async () => {
  const client = (fetch: typeof globalThis.fetch) =>
    createOperations({
      queryToken: "synthetic-query",
      authorize: () => true,
      fetch,
    });
  const foreign = await client(async () => {
    const payload = await response().json();
    payload.tables[0].columns[1][0] = "e".repeat(32);
    return Response.json(payload);
  }).query(scope, [target], signal);
  expect(foreign).toMatchObject({ code: "invalid_response" });
  expect(
    await client(
      async () => new Response("synthetic-query", { status: 403 }),
    ).query(scope, [target], signal),
  ).toMatchObject({ code: "authorization_required" });
  expect(
    await client(async () => new Response("x".repeat(262_145))).query(
      scope,
      [target],
      signal,
    ),
  ).toMatchObject({ code: "response_too_large" });
});

test("large valid evidence is explicitly truncated inside valid tool JSON, never cut by Pi", async () => {
  const client = createOperations({
    queryToken: "synthetic-query",
    authorize: () => true,
    fetch: async () => {
      const payload = await response().json();
      const table = payload.tables[0];
      table.fields.push({ name: "phase" }, { name: "task" });
      table.columns = [
        Array(200).fill(target.admittedAt),
        Array(200).fill(target.traceId),
        Array(200).fill("c".repeat(16)),
        Array(200).fill("界".repeat(190)),
        Array(200).fill("service"),
        Array(200).fill(1),
        Array(200).fill("p".repeat(80)),
        Array(200).fill("t".repeat(80)),
      ];
      return Response.json(payload);
    },
  });
  const extension = createOperationsExtension({
    client,
    scope: async () => scope,
    target: async () => [target],
  });
  const tool = extension.tools?.find((tool) => tool.name === "message_timing");
  if (!tool) throw new Error("Missing timing tool");
  const result = await tool.execute(
    { requestId: "previous" },
    {} as ToolExecutionApi,
    BACKGROUND_CONTEXT,
  );
  const text =
    result.output
      ?.map((part) =>
        typeof part === "string" ? part : part.type === "text" ? part.text : "",
      )
      .join("") ?? "";
  const envelope = JSON.parse(text);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120_000);
  expect(envelope.evidence.truncated).toBe(true);
  expect(envelope.evidence.spans.length).toBeLessThan(200);
  expect(envelope.evidence.spans.length).toBeGreaterThan(0);
});
