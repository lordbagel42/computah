import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startObservability, traceOperation } from "@computah/observability";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { startTimingBroker } from "../../slack/src/timing-broker.js";
import {
  createOperations,
  createOperationsExtension,
  type OperationalTarget,
} from "../src/operations.js";
import {
  createTransportTiming,
  readTransportTimingConfig,
} from "../src/transport-timing.js";

const scope = {
  tenantId: "private-tenant-canary",
  userId: "private-user-canary",
  agentId: "default",
};
const requestId = `input:slack:${"a".repeat(64)}`;
const token = "private-broker-credential-canary-123456";
const timing = {
  traceparent: `00-${"b".repeat(32)}-${"c".repeat(16)}-01`,
  receivedAt: 1700000000123,
  senderTs: "1700000000.000001",
  admittedAt: 1700000000137,
  firstDequeuedAt: 1700000000199,
  state: "done",
  receipts: [
    {
      receivedAt: 1700000000123,
      senderTs: "1700000000.000001",
      admittedAt: 1700000000137,
    },
  ],
  phases: [
    {
      phase: "delivery",
      attempt: 2,
      started: 1700000000300,
      completed: 1700000000379,
      outcome: "sent",
    },
  ],
};

async function broker(
  run: (
    socketPath: string,
    set: (handler: RequestListener) => void,
  ) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "timing-client-"));
  const socketPath = join(dir, "timing.sock");
  let handler: RequestListener = (_req, res) =>
    res.end(JSON.stringify({ timing }));
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run(socketPath, (next) => {
      handler = next;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("private UDS client authenticates exact receipts/scopes, bounds and projects data, rechecks revocation, and exports safe linked outcomes", async () => {
  const originalFetch = globalThis.fetch;
  const traces: string[] = [],
    logs: string[] = [];
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
  process.env.COMPUTAH_AXIOM_LOG_DATASET = "synthetic-timing-logs";
  const telemetry = await startObservability("backend");
  try {
    await broker(async (socketPath, set) => {
      let allowed = true,
        calls = 0;
      const client = createTransportTiming({
        socketPath,
        token,
        authorize: (binding, capability) => {
          expect(Object.isFrozen(binding)).toBe(true);
          expect(capability).toBe("operations.read");
          return allowed;
        },
      });
      set((req, res) => {
        calls++;
        expect(req.url).toBe("/v1/timing");
        expect(req.method).toBe("POST");
        expect(req.headers.authorization).toBe(`Bearer ${token}`);
        expect(req.headers.traceparent).toBeUndefined();
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          const input = JSON.parse(body);
          if (
            input.scope.userId !== scope.userId ||
            input.scope.tenantId !== scope.tenantId ||
            input.scope.agentId !== scope.agentId
          ) {
            res.writeHead(404).end("{}");
            return;
          }
          expect(input).toEqual({ requestId, scope });
          res.end(
            JSON.stringify({
              timing: {
                ...timing,
                privateData: "do-not-project",
                phases: timing.phases.map((p) => ({
                  ...p,
                  privateData: "do-not-project",
                })),
              },
            }),
          );
        });
      });
      const signal = new AbortController().signal;
      const result = await traceOperation("synthetic", async () =>
        client(scope, requestId, signal),
      );
      expect(result).toEqual({
        status: "ready",
        source: "Slack durable receipts",
        units: "ms",
        timing,
        truncated: false,
      });
      expect(JSON.stringify(result)).not.toContain("do-not-project");
      for (const field of ["tenantId", "userId", "agentId"] as const)
        expect(
          await client({ ...scope, [field]: "foreign" }, requestId, signal),
        ).toMatchObject({ code: "receipt_unavailable" });
      allowed = false;
      expect(await client(scope, requestId, signal)).toMatchObject({
        code: "denied",
      });
      expect(calls).toBe(4);
      allowed = true;
      expect(
        await client(scope, "input:caller-trace-id", signal),
      ).toMatchObject({ code: "not_slack_receipt" });
      expect(calls).toBe(4);
      set((_req, res) => {
        allowed = false;
        res.end(JSON.stringify({ timing }));
      });
      expect(await client(scope, requestId, signal)).toMatchObject({
        code: "denied",
      });
      allowed = true;
      for (const status of [401, 404, 429, 503]) {
        set((_req, res) => {
          res.writeHead(status).end(token);
        });
        const failure = await client(scope, requestId, signal);
        expect(failure.status).toBe("unavailable");
        expect(JSON.stringify(failure)).not.toContain(token);
      }
      for (const invalid of [
        { ...timing, receivedAt: "1700000000123" },
        { ...timing, phases: [{ ...timing.phases[0], completed: 1 }] },
        { ...timing, traceparent: `00-${"0".repeat(32)}-${"c".repeat(16)}-01` },
        { ...timing, receipts: Array(2049).fill(timing.receipts[0]) },
      ]) {
        set((_req, res) => {
          res.end(JSON.stringify({ timing: invalid }));
        });
        expect(await client(scope, requestId, signal)).toMatchObject({
          code: "invalid_response",
        });
      }
      set((_req, res) => {
        res.end("x".repeat(262145));
      });
      expect(await client(scope, requestId, signal)).toMatchObject({
        code: "response_too_large",
      });
      set(() => {});
      const cancel = new AbortController();
      const pending = client(scope, requestId, cancel.signal);
      setTimeout(() => cancel.abort(), 20);
      expect(await pending).toMatchObject({ code: "cancelled" });
      expect(await client(scope, requestId, signal)).toMatchObject({
        code: "timeout",
      });
      let closed: Promise<void> = Promise.resolve();
      set((req, res) => {
        closed = new Promise<void>((resolve) =>
          req.socket.once("close", () => resolve()),
        );
        res.writeHead(200);
        res.write('{"timing":');
      });
      const midBody = new AbortController();
      const partial = client(scope, requestId, midBody.signal);
      setTimeout(() => midBody.abort(), 20);
      expect(await partial).toMatchObject({ code: "cancelled" });
      await closed;
      set((_req, res) => res.end(JSON.stringify({ timing })));
      const lateCancel = new AbortController();
      let checks = 0;
      const duringAuthorization = createTransportTiming({
        socketPath,
        token,
        authorize: async () => {
          if (++checks === 2) lateCancel.abort();
          return true;
        },
      });
      expect(
        await duringAuthorization(scope, requestId, lateCancel.signal),
      ).toMatchObject({ code: "cancelled" });
    });
  } finally {
    await telemetry.close();
    globalThis.fetch = originalFetch;
    delete process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
    delete process.env.COMPUTAH_AXIOM_LOG_DATASET;
  }
  const spans = traces.flatMap((body) =>
    JSON.parse(body).resourceSpans.flatMap(
      (r: { scopeSpans: { spans: unknown[] }[] }) =>
        r.scopeSpans.flatMap((s) => s.spans),
    ),
  );
  const parent = spans.find((s) => s.name === "computah.synthetic");
  const children = spans.filter((s) => s.name === "computah.slack.timing");
  expect(
    children.some(
      (s) => s.parentSpanId === parent.spanId && s.traceId === parent.traceId,
    ),
  ).toBe(true);
  for (const outcome of ["ready", "denied", "error", "cancelled", "timeout"])
    expect(
      children.some((s) =>
        s.attributes.some(
          (a: { key: string; value: { stringValue?: string } }) =>
            a.key === "outcome" && a.value.stringValue === outcome,
        ),
      ),
    ).toBe(true);
  expect(logs.join("")).toContain("slack.timing");
  for (const privateValue of [
    token,
    scope.tenantId,
    scope.userId,
    requestId,
    "do-not-project",
  ])
    expect([...traces, ...logs].join("")).not.toContain(privateValue);
});

test("timing tool retains bounded transport evidence without an Axiom credential and hides it after revocation", async () => {
  await broker(async (socketPath, set) => {
    let allowed = true;
    const target: OperationalTarget = {
      requestId,
      submissionId: 1,
      actorId: "synthetic",
      conversationId: 1,
      status: "done",
      entryId: 1,
      answerId: 2,
      admittedAt: null,
      traceId: null,
      executionTraceId: null,
      workerLinksOmitted: 0,
    };
    const client = createTransportTiming({
      socketPath,
      token,
      authorize: () => true,
    });
    const extension = createOperationsExtension({
      client: createOperations({ authorize: () => allowed }),
      scope: async () => scope,
      target: async () => [target],
      transportTiming: async (binding, id, signal, parent) => {
        expect(Object.isFrozen(binding)).toBe(true);
        expect(id).toBe(requestId);
        const result = await client(binding, id, signal, parent);
        if (revoke) allowed = false;
        return result;
      },
    });
    let revoke = false;
    const tool = extension.tools?.find(
      (tool) => tool.name === "message_timing",
    );
    if (!tool) throw new Error("Timing tool missing");
    const execute = async () => {
      const result = await tool.execute(
        { requestId: "previous" },
        {} as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      return JSON.parse(
        result.output
          ?.map((p) =>
            typeof p === "string" ? p : p.type === "text" ? p.text : "",
          )
          .join("") ?? "",
      );
    };
    expect(await execute()).toMatchObject({
      targets: [target],
      evidence: { code: "not_configured" },
      transport: { status: "ready", timing },
    });
    set((_req, res) =>
      res.end(
        JSON.stringify({
          timing: { ...timing, phases: Array(2048).fill(timing.phases[0]) },
        }),
      ),
    );
    const large = await execute();
    expect(large.transport.status).toBe("ready");
    expect(large.transport.truncated).toBe(true);
    expect(large.transport.timing.phases.length).toBeLessThan(2048);
    expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThanOrEqual(
      120000,
    );
    revoke = true;
    expect(await execute()).toMatchObject({ code: "denied" });
  });
});

test("client interoperates with the shipped Slack broker over a real socket with authenticated current scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timing-broker-integration-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "timing.sock");
  let current = true;
  const broker = await startTimingBroker({
    socketPath,
    token,
    read: (id, binding) =>
      current &&
      id === requestId &&
      binding.tenantId === scope.tenantId &&
      binding.userId === scope.userId &&
      binding.agentId === scope.agentId
        ? timing
        : null,
  });
  try {
    const client = createTransportTiming({
      socketPath,
      token,
      authorize: () => true,
    });
    const signal = new AbortController().signal;
    expect(await client(scope, requestId, signal)).toMatchObject({
      status: "ready",
      timing,
    });
    expect(
      await client({ ...scope, userId: "foreign" }, requestId, signal),
    ).toMatchObject({ code: "receipt_unavailable" });
    const forged = createTransportTiming({
      socketPath,
      token: "x".repeat(32),
      authorize: () => true,
    });
    expect(await forged(scope, requestId, signal)).toMatchObject({
      code: "authorization_required",
    });
    current = false;
    expect(await client(scope, requestId, signal)).toMatchObject({
      code: "receipt_unavailable",
    });
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backend timing activation is opt-in and requires a private credential file", () => {
  expect(readTransportTimingConfig({})).toBeUndefined();
  expect(() =>
    readTransportTimingConfig({
      COMPUTAH_SLACK_TIMING_SOCKET: "/tmp/timing.sock",
    }),
  ).toThrow();
  const dir = mkdtempSync(join(tmpdir(), "timing-config-")),
    file = join(dir, "credential");
  try {
    writeFileSync(file, token, { mode: 0o600 });
    const env = {
      COMPUTAH_SLACK_TIMING_SOCKET: join(dir, "timing.sock"),
      COMPUTAH_SLACK_TIMING_TOKEN_FILE: file,
    };
    expect(readTransportTimingConfig(env)).toEqual({
      socketPath: env.COMPUTAH_SLACK_TIMING_SOCKET,
      token,
    });
    chmodSync(file, 0o640);
    expect(() => readTransportTimingConfig(env)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
