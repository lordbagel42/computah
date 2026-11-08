import { timingSafeEqual } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, isAbsolute } from "node:path";
import { traceEvent, traceHttp, traceOperation } from "@computah/observability";
import type { SlackTimingSnapshot, TimingScope } from "./timing.js";

/** Optional host-private UDS only. Its directory is separately provisioned and
 * mounted into core, never the Slack journal/bindings directory.
 */
export async function startTimingBroker(options: {
  socketPath: string;
  token: string;
  read: (requestId: string, scope: TimingScope) => SlackTimingSnapshot | null;
}) {
  if (!isAbsolute(options.socketPath) || options.token.length < 32)
    throw new Error("Invalid timing broker configuration");
  const directory = await lstat(dirname(options.socketPath));
  if (
    !directory.isDirectory() ||
    directory.mode & 0o027 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error("Protected timing socket directory required");
  // Never unlink on startup: a check/probe then unlink races another starter.
  // A crashed service's stale path needs serialized runtime-owner cleanup.
  const old = await lstat(options.socketPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (old) throw new Error("Timing socket path occupied");
  const credential = Buffer.from(`Bearer ${options.token}`);
  let active = 0;
  let window = Date.now();
  let requests = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "close");
    const finish = (status: number, body: unknown = {}) => {
      response.writeHead(status).end(JSON.stringify(body));
    };
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== credential.length ||
      !timingSafeEqual(supplied, credential)
    ) {
      traceEvent("slack.timing", { outcome: "denied" });
      finish(401);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/timing") {
      finish(404);
      return;
    }
    if (Date.now() - window >= 60_000) {
      window = Date.now();
      requests = 0;
    }
    if (active >= 4 || ++requests > 60) {
      traceEvent("slack.timing", { outcome: "error", reason: "capacity" });
      finish(429);
      return;
    }
    active++;
    const deadline = setTimeout(() => {
      finish(408);
      request.destroy();
    }, 2000);
    try {
      await traceOperation("slack.timing", async (span) => {
        if (request.headers["content-type"] !== "application/json") {
          finish(400);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2048) {
            finish(413);
            return;
          }
          chunks.push(chunk);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          finish(400);
          return;
        }
        const record = input as {
          requestId?: unknown;
          scope?: TimingScope;
        } | null;
        const scope = record?.scope;
        if (
          !record ||
          Object.keys(record).sort().join(",") !== "requestId,scope" ||
          typeof record.requestId !== "string" ||
          !/^input:slack:[a-f0-9]{64}$/.test(record.requestId) ||
          !scope ||
          typeof scope !== "object" ||
          Object.keys(scope).sort().join(",") !== "agentId,tenantId,userId" ||
          Object.values(scope).some(
            (value) =>
              typeof value !== "string" || !value || value.length > 256,
          )
        ) {
          finish(400);
          return;
        }
        const timing = options.read(record.requestId, scope);
        if (!timing) {
          span.setAttribute("outcome", "missing");
          finish(404);
          return;
        }
        // Rebuild the positive DTO, even if an internal callback returns extras.
        const payload = JSON.stringify({
          timing: {
            traceparent: timing.traceparent,
            receivedAt: timing.receivedAt,
            senderTs: timing.senderTs,
            admittedAt: timing.admittedAt,
            firstDequeuedAt: timing.firstDequeuedAt,
            state: timing.state,
            receipts: timing.receipts.map((receipt) => ({
              receivedAt: receipt.receivedAt,
              senderTs: receipt.senderTs,
              admittedAt: receipt.admittedAt,
            })),
            phases: timing.phases.map((phase) => ({
              phase: phase.phase,
              attempt: phase.attempt,
              started: phase.started,
              completed: phase.completed,
              outcome: phase.outcome,
            })),
          },
        });
        if (Buffer.byteLength(payload) > 256 * 1024) {
          finish(413);
          return;
        }
        span.setAttribute("outcome", "success");
        response.writeHead(200).end(payload);
      });
    } catch {
      if (!response.headersSent) finish(503);
    } finally {
      clearTimeout(deadline);
      active--;
    }
  });
  traceHttp(server);
  server.on("connection", (socket) => {
    // Absolute lifetime covers partial/slow headers, before HTTP auth exists.
    const deadline = setTimeout(() => socket.destroy(), 2000);
    socket.once("close", () => clearTimeout(deadline));
  });
  server.headersTimeout = 2000;
  server.requestTimeout = 2000;
  server.timeout = 2000;
  server.maxRequestsPerSocket = 1;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await chmod(options.socketPath, 0o660);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
