import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { Client } from "rivetkit/client";
import { type Bus, type BusScope, busScopeKey, busStreamPath } from "./bus.js";

export type BusPrincipal = BusScope & {
  tokenHash: string;
  capabilities: ("task.send" | "history.read")[];
};
export const busTokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function createBusHttp(
  bus: Bus,
  client: Client<Bus["registry"]>,
  principals: Map<string, BusPrincipal>,
) {
  return createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", "http://computah.invalid");
      if (request.method === "GET" && url.pathname === "/healthz") {
        reply(200, { ready: true, mode: "bus-only", dispatch: "disabled" });
        return;
      }
      const token = /^Bearer (\S+)$/i.exec(
        request.headers.authorization ?? "",
      )?.[1];
      const principal = token ? principals.get(busTokenHash(token)) : undefined;
      if (!principal) {
        reply(401, { code: "unauthenticated" });
        return;
      }
      const scope: BusScope = {
        tenantId: principal.tenantId,
        userId: principal.userId,
        agentId: principal.agentId,
        audience: principal.audience,
      };
      const permit = async (capability: "history.read" | "task.send") => {
        const allowed = await bus.authorize(scope, capability);
        if (
          principals.get(principal.tokenHash) !== principal ||
          !principal.capabilities.includes(capability) ||
          !allowed
        )
          throw new Error("forbidden");
      };
      if (
        url.pathname === "/v1/bus/stream" &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        await permit("history.read");
        if (
          [...url.searchParams.keys()].some(
            (key) => !["offset", "live", "cursor"].includes(key),
          ) ||
          (url.searchParams.has("live") &&
            !["sse", "long-poll"].includes(url.searchParams.get("live") ?? ""))
        ) {
          reply(400, { code: "invalid-request" });
          return;
        }
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        const target = new URL(busStreamPath(scope), bus.streamBaseUrl);
        target.search = url.search;
        const upstream = await fetch(target, {
          method: request.method,
          signal: controller.signal,
          redirect: "error",
        });
        await permit("history.read");
        const headers: Record<string, string> = { "cache-control": "no-store" };
        for (const name of [
          "content-type",
          "stream-next-offset",
          "stream-up-to-date",
          "stream-closed",
          "stream-cursor",
        ]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(upstream.status, headers);
        if (upstream.body)
          for await (const chunk of Readable.fromWeb(
            upstream.body as Parameters<typeof Readable.fromWeb>[0],
          )) {
            await permit("history.read");
            if (!response.write(chunk))
              await once(response, "drain", { signal: controller.signal });
            if (response.destroyed) break;
          }
        response.end();
        return;
      }
      const session = bus.attach(client)(scope);
      if (request.method === "POST" && url.pathname === "/v1/bus/receipts") {
        await permit("task.send");
        if (!request.headers["content-type"]?.startsWith("application/json")) {
          reply(415, { code: "invalid-request" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 410000) throw new Error("invalid-request");
          chunks.push(Buffer.from(chunk));
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Error("invalid-request");
        }
        await permit("task.send");
        const receipt = await session.admit(
          input as { text: string; clientMutationId: string },
        );
        await permit("task.send");
        reply(202, receipt);
        return;
      }
      const match = /^\/v1\/bus\/receipts\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        await permit("history.read");
        const receipt = await session.receipt(decodeURIComponent(match[1]));
        await permit("history.read");
        reply(200, receipt);
        return;
      }
      reply(404, { code: "not-found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : "";
      const code = [
        "forbidden",
        "conflict",
        "invalid-request",
        "not-found",
      ].find((code) => message.includes(code));
      reply(
        code === "forbidden"
          ? 403
          : code === "conflict"
            ? 409
            : code === "invalid-request"
              ? 400
              : code === "not-found"
                ? 404
                : 503,
        { code: code ?? "unavailable" },
      );
    }
  });
}

export function busAuthorizer(principals: Map<string, BusPrincipal>) {
  return (scope: BusScope, capability: "history.read" | "task.send") =>
    [...principals.values()].some(
      (p) =>
        busScopeKey(p) === busScopeKey(scope) &&
        p.capabilities.includes(capability),
    );
}
