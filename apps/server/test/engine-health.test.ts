import { createServer } from "node:http";
import { startObservability, traceLifecycle } from "@computah/observability";
import { expect, test } from "vitest";
import { readConfig } from "../src/config.js";
import { watchEngine } from "../src/engine-health.js";
import { createHttpServer } from "../src/http.js";

test("engine dependency fences failure, bounds stalled probes, cancels stop and exports linked sanitized outcomes", async () => {
  const originalFetch = globalThis.fetch;
  const traces: string[] = [],
    logs: string[] = [];
  const token = "synthetic-engine-secret-not-for-telemetry";
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://api.axiom.co/v1/traces") {
      traces.push(String(init?.body));
      return new Response("{}");
    }
    if (String(url) === "https://api.axiom.co/v1/logs") {
      logs.push(String(init?.body));
      return new Response("{}");
    }
    return originalFetch(url, init);
  };
  process.env.COMPUTAH_AXIOM_INGEST_TOKEN = "synthetic-only";
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-engine-logs";
  const telemetry = await startObservability("backend");
  let status = 200,
    stalled = false,
    calls = 0,
    failures = 0;
  const probeParents: string[] = [];
  const server = createServer((req, res) => {
    expect(req.url).toBe("/health");
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    probeParents.push(String(req.headers.traceparent));
    calls++;
    if (!stalled) res.writeHead(status).end("private-response-canary");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let guard: Awaited<ReturnType<typeof watchEngine>> | undefined;
  const gateway = createHttpServer({
    ...readConfig({
      COMPUTAH_MODE: "faux",
      COMPUTAH_CONNECTION_SECRET: token,
      COMPUTAH_AUTH_JSON: JSON.stringify([
        {
          tenantId: "t",
          userId: "u",
          agentId: "a",
          token,
          capabilities: ["task.send"],
        },
      ]),
    }),
    ready: () => guard?.ready() ?? false,
    bind: () => {
      throw new Error("Must not bind while unavailable");
    },
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const ingress = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const drains: Promise<void>[] = [];
  const failed = () => {
    failures++;
    drains.push(
      (async () => {
        await Promise.resolve();
        await traceLifecycle("registry_drain", async () => {});
      })(),
    );
  };
  try {
    status = 503;
    await expect(watchEngine({ endpoint, token }, failed)).rejects.toThrow(
      "Engine unavailable",
    );
    expect(failures).toBe(1);
    failures = 0;
    for (const failure of ["http", "timeout", "stop"] as const) {
      status = 200;
      stalled = false;
      guard = await watchEngine({ endpoint, token }, failed);
      expect(guard.ready()).toBe(true);
      expect((await fetch(`${ingress}/healthz`)).status).toBe(200);
      const prior = calls;
      if (failure === "http") status = 503;
      else stalled = true;
      await expect.poll(() => calls, { timeout: 2000 }).toBeGreaterThan(prior);
      if (failure === "stop") {
        await guard.close();
        expect(failures).toBe(2);
      } else {
        await expect.poll(() => guard?.ready(), { timeout: 3000 }).toBe(false);
        expect(failures).toBe(failure === "http" ? 1 : 2);
        await guard.close();
      }
      expect(guard.ready()).toBe(false);
      expect(await (await fetch(`${ingress}/healthz`)).json()).toMatchObject({
        ready: false,
      });
      expect(
        (
          await fetch(`${ingress}/v1/submissions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: "{}",
          })
        ).status,
      ).toBe(503);
    }
  } finally {
    await guard?.close();
    await Promise.all(drains);
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
  }
  const spans = traces.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: {
        scopeSpans: {
          spans: {
            spanId: string;
            parentSpanId: string;
            traceId: string;
            attributes: { key: string; value: { stringValue?: string } }[];
          }[];
        }[];
      }) => r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find((a: { key: string }) => a.key === key)?.value
      .stringValue;
  const watches = spans.filter(
    (span) => attr(span, "phase") === "engine_watch",
  );
  expect(watches.map((span) => attr(span, "outcome")).sort()).toEqual([
    "cancelled",
    "error",
    "error",
  ]);
  for (const watch of watches) {
    const probes = spans.filter((span) => span.parentSpanId === watch.spanId);
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => probe.traceId === watch.traceId)).toBe(true);
  }
  for (const parent of probeParents) {
    const [, traceId, spanId] = parent.split("-");
    const probe = spans.find((span) => span.spanId === spanId);
    expect(probe).toBeDefined();
    expect(probe.traceId).toBe(traceId);
    expect(attr(probe, "phase")).toBe("engine_health");
  }
  const drainSpans = spans.filter(
    (span) => attr(span, "phase") === "registry_drain",
  );
  expect(drainSpans).toHaveLength(3);
  for (const drain of drainSpans) {
    const probe = spans.find((span) => span.spanId === drain.parentSpanId);
    expect(probe).toBeDefined();
    expect(attr(probe, "phase")).toBe("engine_health");
    expect(probe.traceId).toBe(drain.traceId);
    expect(attr(probe, "outcome")).toBe("error");
  }
  const exported = [...traces, ...logs].join("\n");
  for (const secret of [token, endpoint, "private-response-canary"])
    expect(exported).not.toContain(secret);
  const records = logs.flatMap((body) =>
    JSON.parse(body).resourceLogs.flatMap(
      (resource: {
        scopeLogs: {
          logRecords: {
            traceId: string;
            spanId: string;
            attributes: { key: string; value: { stringValue?: string } }[];
            body: { stringValue: string };
          }[];
        }[];
      }) => resource.scopeLogs.flatMap((scope) => scope.logRecords),
    ),
  );
  for (const span of spans.filter(
    (span) =>
      ["engine_watch", "engine_health"].includes(attr(span, "phase")) &&
      ["error", "cancelled"].includes(attr(span, "outcome")),
  )) {
    const matching = records.filter((record) => record.spanId === span.spanId);
    expect(matching).toHaveLength(1);
    expect(matching[0].traceId).toBe(span.traceId);
    expect(matching[0].body.stringValue).toBe("operation.completed");
    expect(attr(matching[0], "outcome")).toBe(attr(span, "outcome"));
  }
});
