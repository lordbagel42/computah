import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SlackTimingSnapshot } from "../src/timing.js";
import { startTimingBroker } from "../src/timing-broker.js";

test("private timing UDS authenticates, bounds requests and projects no content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computah-timing-"));
  const socketPath = join(directory, "timing.sock");
  const token = "synthetic-timing-token-not-a-secret";
  const scope = { tenantId: "test", userId: "owner", agentId: "agent" };
  const requestId = `input:slack:${"a".repeat(64)}`;
  const timing: SlackTimingSnapshot & { content: string } = {
    traceparent: `00-${"b".repeat(32)}-${"c".repeat(16)}-01`,
    receivedAt: 100,
    senderTs: "1.234",
    admittedAt: 102,
    firstDequeuedAt: null,
    state: "queued",
    receipts: [],
    phases: [],
    content: "must-never-leak",
  };
  let reads = 0;
  const options = {
    socketPath,
    token,
    read: (id: string, candidate: typeof scope) => {
      reads++;
      return id === requestId &&
        JSON.stringify(candidate) === JSON.stringify(scope)
        ? timing
        : null;
    },
  };
  const broker = await startTimingBroker(options);
  const call = (body: unknown, credential = token) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: "/v1/timing",
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (part) => {
            raw += part;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0, body: raw }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o660);
    assert.equal((await call({ requestId, scope }, "wrong")).status, 401);
    assert.equal(reads, 0);
    assert.equal(
      (await call({ requestId, scope: { ...scope, userId: "foreign" } }))
        .status,
      404,
    );
    assert.equal(
      (await call({ requestId: timing.traceparent, scope })).status,
      400,
    );
    assert.equal(
      (await call({ requestId, scope, path: "/private.sqlite" })).status,
      400,
    );
    assert.equal(
      (await call({ requestId, scope, extra: "x".repeat(3000) })).status,
      413,
    );
    const result = await call({ requestId, scope });
    assert.equal(result.status, 200);
    assert.ok(!result.body.includes("must-never-leak"));
    assert.ok(!result.body.includes("owner"));
    assert.equal(JSON.parse(result.body).timing.firstDequeuedAt, null);
    await assert.rejects(startTimingBroker(options), /occupied/);
    const connected = Date.now();
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      const deadline = setTimeout(() => {
        socket.destroy();
        reject(new Error("partial headers exceeded absolute deadline"));
      }, 3000);
      const fragments = [1000, 1500].map((ms) =>
        setTimeout(() => socket.write("a"), ms),
      );
      socket.once("connect", () =>
        socket.write("POST /v1/timing HTTP/1.1\r\nX-Fragment: "),
      );
      socket.once("error", reject);
      socket.once("close", () => {
        clearTimeout(deadline);
        for (const timer of fragments) clearTimeout(timer);
        resolve();
      });
    });
    assert.ok(Date.now() - connected < 3000);
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const req = request({
        socketPath,
        path: "/v1/timing",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });
      const deadline = setTimeout(() => {
        req.destroy();
        reject(new Error("broker request exceeded deadline"));
      }, 3000);
      const finish = () => {
        clearTimeout(deadline);
        req.destroy();
        resolve();
      };
      req.once("error", finish);
      req.once("response", (response) => {
        assert.equal(response.statusCode, 408);
        response.resume();
        finish();
      });
      req.write("{"); // Authenticated but deliberately incomplete request body.
    });
    assert.ok(Date.now() - started < 3000);
    for (let index = 0; index < 60; index++) await call({ requestId, scope });
    assert.equal((await call({ requestId, scope })).status, 429);
  } finally {
    await broker.close();
  }
  const stale = spawnSync(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))",
    socketPath,
  ]);
  assert.equal(stale.status, 0);
  await assert.rejects(startTimingBroker(options), /occupied/);
  await unlink(socketPath); // Explicit cleanup of this test's stopped child only.
  const restarted = await startTimingBroker(options);
  assert.equal((await call({ requestId, scope })).status, 200);
  await restarted.close();
  // Graceful close releases the pathname, and arbitrary existing files survive.
  await writeFile(socketPath, "not a socket");
  await assert.rejects(startTimingBroker(options), /occupied/);
  await rm(directory, { recursive: true });
});
