import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("IPC cancel failure retains active work; EOF drains result and correlated sanitized telemetry", {
  timeout: 20000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "computah-native-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exported = [];
  const carriers = [];
  const canary = "PRIVATE_NATIVE_BODY_TOKEN_IDENTITY_CANARY";
  let terminal = false;
  let waiting;
  const pollStarted = new Promise((resolve) => {
    waiting = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.url === "/sink") {
      let body = "";
      for await (const chunk of req) body += chunk;
      exported.push(body);
      res.writeHead(200).end("{}");
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${canary}`);
    carriers.push(req.headers.traceparent);
    const reply = (status, value) =>
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (req.url === "/v1/viewer")
      return reply(200, {
        version: 1,
        conversationId: "primary",
        viewer: { tenantId: canary, userId: canary, agentId: canary },
      });
    if (req.url === "/v1/history")
      return reply(200, {
        version: 1,
        conversationId: "primary",
        messages: [],
        nextCursor: null,
      });
    if (req.url === "/v1/submissions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      return reply(202, {
        version: 1,
        id: canary,
        clientMutationId: input.clientMutationId,
      });
    }
    if (req.url.endsWith("/cancel")) return reply(503, { error: canary });
    waiting();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return reply(200, {
      version: 1,
      submission: { outcome: terminal ? "completed" : "accepted" },
      messages: [],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  // Test-only transport capture: exercise the REAL shared SDK/privacy relay/log
  // exporter, redirecting only its Axiom sink. No production sink override added.
  const preload = join(directory, "capture.mjs");
  await writeFile(
    preload,
    `const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => String(input).startsWith('https://api.axiom.co/')
  ? fetch('${url}/sink', { ...init, headers: { 'content-type': 'application/json' } })
  : fetch(input, init);
`,
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", preload, "--import", "tsx", "scripts/host.mjs"],
    {
      cwd: root,
      env: {
        ...process.env,
        COMPUTAH_URL: url,
        COMPUTAH_TOKEN: canary,
        COMPUTAH_OUTBOX: join(directory, "outbox.json"),
        COMPUTAH_AXIOM_INGEST_TOKEN: "synthetic-only",
        COMPUTAH_AXIOM_LOG_DATASET: "synthetic-only",
        COMPUTAH_UI_FILE: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  const exited = once(child, "exit");
  const events = [];
  let ready;
  let cancellation;
  const connected = new Promise((resolve) => {
    ready = resolve;
  });
  const cancelled = new Promise((resolve) => {
    cancellation = resolve;
  });
  for (const stream of [child.stderr]) stream.resume();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "ready") ready();
    if (
      event.type === "status" &&
      event.text.startsWith("Cancellation unknown")
    )
      cancellation();
  });
  await connected;
  child.stdin.write(`${JSON.stringify({ op: "send", text: canary })}\n`);
  await pollStarted;
  child.stdin.write('{"op":"cancel"}\n');
  await cancelled;
  assert.ok(
    !events.some((e) => e.type === "error"),
    "cancel failure must not clear native busy/Stop state",
  );
  assert.equal(events.findLast((e) => e.type === "busy").value, true);
  terminal = true;
  child.stdin.end();
  const [code] = await exited;
  assert.equal(code, 0);
  assert.equal(
    events.findLast((e) => e.type === "result").outcome,
    "completed",
    "EOF must drain active IPC before shutting down telemetry",
  );
  assert.equal(events.findLast((e) => e.type === "busy").value, false);
  const encoded = exported.join("\n");
  assert.ok(
    !encoded.includes(canary),
    "content, principal, signed handle and bearer must not reach sinks",
  );
  const spans = exported
    .flatMap((raw) => JSON.parse(raw).resourceSpans ?? [])
    .flatMap((r) => r.scopeSpans)
    .flatMap((s) => s.spans);
  assert.ok(spans.some((s) => s.name === "computah.native.ipc"));
  const core = spans.filter((s) => s.name === "computah.native.core");
  assert.ok(core.some((s) => s.status.code === 2));
  assert.ok(
    core.some((s) =>
      spans.some(
        (parent) =>
          parent.name === "computah.native.ipc" &&
          s.traceId === parent.traceId &&
          s.parentSpanId === parent.spanId,
      ),
    ),
  );
  assert.ok(
    carriers.every((carrier) =>
      /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/.test(carrier),
    ),
  );
  assert.ok(
    core.some((s) =>
      carriers.some((carrier) => carrier.includes(`${s.traceId}-${s.spanId}`)),
    ),
  );
  assert.ok(
    encoded.includes('"service.name"') && encoded.includes("computah-native"),
  );
  assert.ok(
    exported.some(
      (raw) => raw.includes("native.core") && raw.includes("log.id"),
    ),
    "shared structured logger must export correlated operation outcomes",
  );
});
