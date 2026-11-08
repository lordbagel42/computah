import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  BusOutput,
  type BusReceipt,
  BusSendRequest,
} from "@computah/contracts";
import { traceOperation } from "@computah/observability";
import { Schema } from "effect";
import { actor, setup, UserError } from "rivetkit";
import { type Client, createClient } from "rivetkit/client";
import { db, type RawAccess } from "rivetkit/db";

export type BusScope = {
  tenantId: string;
  userId: string;
  agentId: string;
  audience: string;
};
export type {
  BusOutput,
  BusReceipt,
  BusSendRequest,
} from "@computah/contracts";
export type BusStatus = BusReceipt["status"];
export type BusDispatch = (
  scope: BusScope,
  input: BusSendRequest,
) => Promise<{
  submissionId: string;
  status: Exclude<BusStatus, "queued" | "submitted">;
  text: string | null;
}>;
export const busScopeKey = (scope: BusScope) =>
  JSON.stringify([scope.tenantId, scope.userId, scope.agentId, scope.audience]);
export const busStreamPath = (scope: BusScope) =>
  `/v1/stream/${createHash("sha256").update(busScopeKey(scope)).digest("hex")}`;

export function createBus(options: {
  secret: string;
  streamBaseUrl: string;
  authorize(
    scope: BusScope,
    capability: "task.send" | "history.read",
  ): boolean | Promise<boolean>;
  dispatch?: BusDispatch;
}) {
  if (Buffer.byteLength(options.secret) < 32)
    throw new Error("COMPUTAH_BUS_SECRET too short");
  const mac = (value: string) =>
    createHmac("sha256", options.secret).update(value).digest("base64url");
  const seal = (scope: BusScope, mutation: string) => {
    const encoded = Buffer.from(mutation).toString("base64url");
    return `${encoded}.${mac(JSON.stringify([busScopeKey(scope), encoded]))}`;
  };
  const permit = async (
    scope: BusScope,
    capability: "task.send" | "history.read",
  ) => {
    if (!(await options.authorize(scope, capability)))
      throw new UserError("forbidden");
  };
  const receipt = (row: Record<string, unknown>): BusReceipt =>
    JSON.parse(String(row.receipt));
  const scopeOf = (key: string[]): BusScope => ({
    tenantId: key[0],
    userId: key[1],
    agentId: key[2],
    audience: key[3],
  });
  const pump = async (
    c: {
      key: string[];
      actorId: string;
      db: RawAccess;
      vars: { pumping: boolean };
      abortSignal: AbortSignal;
    },
    phase: "input" | "prepare" | "poll",
  ) =>
    traceOperation("bus.pump", async (span) => {
      span.setAttribute("phase", phase);
      if (c.vars.pumping) {
        span.setAttribute("outcome", "waiting");
        return;
      }
      c.vars.pumping = true;
      try {
        const scope = scopeOf(c.key);
        if (options.dispatch && (await options.authorize(scope, "task.send"))) {
          const queued = await c.db.execute(
            "SELECT mutation, text, receipt FROM receipts WHERE status = 'queued' ORDER BY rowid LIMIT 1",
          );
          if (queued[0]) {
            const old = receipt(queued[0]);
            // Dispatch must reconcile this stable ID, including a lost admission/result response.
            const result = await options.dispatch(scope, {
              text: String(queued[0].text),
              clientMutationId: `bus:${createHash("sha256").update(old.id).digest("hex")}`,
            });
            await permit(scope, "task.send");
            const next: BusReceipt = {
              ...old,
              status: result.status,
              submissionId: result.submissionId,
            };
            await c.db.transaction(
              async (tx) => {
                await tx.execute(
                  "UPDATE receipts SET status = ?, receipt = ? WHERE mutation = ?",
                  next.status,
                  JSON.stringify(next),
                  old.clientMutationId,
                );
                await tx.execute(
                  "INSERT INTO outbox(payload) VALUES (?)",
                  JSON.stringify(
                    Schema.decodeUnknownSync(BusOutput)({
                      version: 1,
                      receipt: next,
                      text: result.status === "completed" ? result.text : null,
                    }),
                  ),
                );
              },
              { name: "bus.complete" },
            );
          }
        }
        await permit(scope, "history.read");
        const url = new URL(busStreamPath(scope), options.streamBaseUrl);
        await traceOperation("bus.stream.create", async (attempt) => {
          const signal = AbortSignal.any([
            c.abortSignal,
            AbortSignal.timeout(5000),
          ]);
          attempt.setAttribute("http.request.method", "PUT");
          try {
            const created = await fetch(url, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              signal,
            });
            attempt.setAttribute("http.response.status_code", created.status);
            await created.body?.cancel();
            if (![201, 200, 204].includes(created.status))
              throw new Error("stream unavailable");
            attempt.setAttribute("outcome", "success");
          } catch (error) {
            attempt.setAttribute(
              "outcome",
              c.abortSignal.aborted
                ? "cancelled"
                : signal.aborted
                  ? "timeout"
                  : "error",
            );
            throw error;
          }
        });
        const rows = await c.db.execute(
          "SELECT seq, payload FROM outbox WHERE sent = 0 ORDER BY seq LIMIT 32",
        );
        for (const row of rows) {
          await permit(scope, "history.read");
          await traceOperation("bus.stream.append", async (attempt) => {
            const signal = AbortSignal.any([
              c.abortSignal,
              AbortSignal.timeout(5000),
            ]);
            attempt.setAttribute("http.request.method", "POST");
            try {
              const result = await fetch(url, {
                method: "POST",
                body: String(row.payload),
                headers: {
                  "content-type": "application/json",
                  "Producer-Id": c.actorId,
                  "Producer-Epoch": "0",
                  "Producer-Seq": String(Number(row.seq) - 1),
                },
                signal,
              });
              attempt.setAttribute("http.response.status_code", result.status);
              await result.body?.cancel();
              if (!result.ok) throw new Error("stream append unavailable");
              await c.db.execute(
                "UPDATE outbox SET sent = 1 WHERE seq = ?",
                row.seq,
              );
              attempt.setAttribute("outcome", "success");
            } catch (error) {
              attempt.setAttribute(
                "outcome",
                c.abortSignal.aborted
                  ? "cancelled"
                  : signal.aborted
                    ? "timeout"
                    : "error",
              );
              throw error;
            }
          });
        }
        span.setAttribute("outcome", "success");
      } catch (error) {
        span.setAttribute(
          "outcome",
          c.abortSignal.aborted
            ? "cancelled"
            : error instanceof Error && error.name === "TimeoutError"
              ? "timeout"
              : error instanceof UserError && error.message === "forbidden"
                ? "denied"
                : "error",
        );
        throw error;
      } finally {
        c.vars.pumping = false;
      }
    });
  const bus = actor({
    db: db({
      onMigrate: async (database) => {
        await database.execute(
          "CREATE TABLE IF NOT EXISTS receipts(mutation TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT NOT NULL)",
        );
        await database.execute(
          "CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)",
        );
      },
    }),
    createVars: () => ({ pumping: false }),
    onBeforeConnect(c, params: { token?: string }) {
      const expected = Buffer.from(mac(JSON.stringify(c.key)));
      const actual = Buffer.from(params?.token ?? "");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new UserError("forbidden");
    },
    onWake: async (c) => {
      // Native durable cron covers restart/disconnect and the SQL/append commit gap.
      await c.cron.every({
        name: "publish",
        interval: 5000,
        action: "pump",
        maxHistory: 0,
      });
      c.waitUntil(pump(c, "prepare").catch(() => {}));
    },
    actions: {
      admit: async (c, input: BusSendRequest) => {
        const scope = scopeOf(c.key);
        await permit(scope, "task.send");
        try {
          input = Schema.decodeUnknownSync(BusSendRequest, {
            onExcessProperty: "error",
          })(input);
        } catch {
          throw new UserError("invalid-request");
        }
        const accepted = await c.db.transaction(
          async (tx) => {
            const existing = await tx.execute(
              "SELECT text, receipt FROM receipts WHERE mutation = ?",
              input.clientMutationId,
            );
            if (existing[0]) {
              if (existing[0].text !== input.text)
                throw new UserError("conflict");
              return receipt(existing[0]);
            }
            const result: BusReceipt = {
              version: 1,
              id: seal(scope, input.clientMutationId),
              clientMutationId: input.clientMutationId,
              status: "queued",
              submissionId: null,
            };
            await tx.execute(
              "INSERT INTO receipts(mutation, text, status, receipt) VALUES (?, ?, 'queued', ?)",
              input.clientMutationId,
              input.text,
              JSON.stringify(result),
            );
            await tx.execute(
              "INSERT INTO outbox(payload) VALUES (?)",
              JSON.stringify({
                version: 1,
                receipt: result,
                text: null,
              } satisfies BusOutput),
            );
            return result;
          },
          { name: "bus.admit" },
        );
        c.waitUntil(pump(c, "input").catch(() => {}));
        return accepted;
      },
      receipt: async (c, id: string) => {
        const scope = scopeOf(c.key);
        await permit(scope, "history.read");
        if (typeof id !== "string" || id.length > 1000)
          throw new UserError("invalid-request");
        const [encoded, signature, extra] = id.split(".");
        if (
          !encoded ||
          extra !== undefined ||
          seal(scope, Buffer.from(encoded, "base64url").toString()) !==
            `${encoded}.${signature}`
        )
          throw new UserError("forbidden");
        const rows = await c.db.execute(
          "SELECT receipt FROM receipts WHERE mutation = ?",
          Buffer.from(encoded, "base64url").toString(),
        );
        if (!rows[0]) throw new UserError("not-found");
        return receipt(rows[0]);
      },
      pump: async (c) => {
        await pump(c, "poll");
      },
    },
  });
  const registry = setup({
    use: { bus },
    // A fresh managed engine bootstraps only its default namespace. HOME is
    // dedicated to this bus process; never point it at the old backend engine.
    namespace: "default",
    node: { poolName: "computah-bus" },
    startEngine: true,
    engineHost: "127.0.0.1",
    startServices: false,
  });
  const attach = (client: Client<typeof registry>) => (scope: BusScope) =>
    client.bus.getOrCreate(
      [scope.tenantId, scope.userId, scope.agentId, scope.audience],
      {
        params: {
          token: mac(
            JSON.stringify([
              scope.tenantId,
              scope.userId,
              scope.agentId,
              scope.audience,
            ]),
          ),
        },
      },
    );
  return {
    registry,
    attach,
    streamBaseUrl: options.streamBaseUrl,
    authorize: options.authorize,
  };
}

export type Bus = ReturnType<typeof createBus>;
export function createBusClient(bus: Bus) {
  const config = bus.registry.parseConfig();
  return createClient<typeof bus.registry>({
    endpoint: config.endpoint,
    namespace: config.namespace,
    token: config.token,
    poolName: config.node.poolName,
    headers: config.headers,
  });
}
