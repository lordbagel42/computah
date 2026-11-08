import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  currentTraceHeaders,
  runtimeLog,
  traceOperation,
} from "@computah/observability";

/** @param {NodeJS.ProcessEnv} env */
export function readDashboardConfig(env) {
  const origin = new URL(env.COMPUTAH_DASHBOARD_ORIGIN ?? "");
  const core = new URL(env.COMPUTAH_DASHBOARD_CORE_URL ?? "");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const localCore = ["localhost", "127.0.0.1", "[::1]"].includes(core.hostname);
  if (
    (!local && origin.protocol !== "https:") ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== origin.href.replace(/\/$/, "") ||
    origin.username ||
    origin.password ||
    (!localCore && core.protocol !== "https:") ||
    !["http:", "https:"].includes(core.protocol) ||
    core.username ||
    core.password ||
    core.search ||
    core.hash ||
    core.pathname !== "/"
  )
    throw new Error(
      "Dashboard requires an exact HTTPS origin and fixed core origin",
    );
  const password = env.COMPUTAH_DASHBOARD_PASSWORD;
  const coreToken = env.COMPUTAH_DASHBOARD_CORE_TOKEN;
  if (!password || password.length < 32 || !coreToken || coreToken.length < 32)
    throw new Error(
      "Dashboard requires separate server-side secrets of at least 32 characters",
    );
  if (password === coreToken)
    throw new Error("Dashboard password must not be the core credential");
  const port = Number(env.PORT ?? "8790");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid dashboard port");
  const host = env.COMPUTAH_DASHBOARD_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host))
    throw new Error("Invalid dashboard listener host");
  return {
    origin: origin.origin,
    core: core.origin,
    password,
    coreToken,
    secure: origin.protocol === "https:",
    port,
    host,
  };
}

const hash = (/** @type {string} */ value) =>
  createHash("sha256").update(value).digest();
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

/** @param {ReturnType<typeof readDashboardConfig>} config */
export function createDashboardServer(config) {
  /** @type {Map<string, number>} */
  const sessions = new Map();
  /** @type {Map<string, {count: number, until: number}>} */
  const attempts = new Map();
  const cookieName = config.secure
    ? "__Host-computah_operator"
    : "computah_operator_local";
  const cookie = (/** @type {string} */ value, /** @type {number} */ age) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.secure ? "; Secure" : ""}`;
  return createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    const reply = (
      /** @type {number} */ status,
      /** @type {unknown} */ value,
    ) => {
      response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(value));
    };
    try {
      const now = Date.now();
      for (const [key, expiry] of sessions)
        if (expiry <= now) sessions.delete(key);
      for (const [key, value] of attempts)
        if (value.until <= now) attempts.delete(key);
      const url = new URL(request.url ?? "/", config.origin);
      if (request.method === "GET" && url.pathname === "/healthz") {
        reply(200, { ready: true, service: "computah-dashboard" });
        return;
      }
      // Validate the public Host even behind TLS termination; never trust forwarded headers.
      if (request.headers.host !== new URL(config.origin).host) {
        reply(403, { error: "origin-denied" });
        return;
      }
      if (request.method === "POST") {
        if (
          request.headers.origin !== config.origin ||
          request.headers["sec-fetch-site"] === "cross-site"
        ) {
          reply(403, { error: "origin-denied" });
          return;
        }
        if (url.pathname === "/session") {
          const address = request.socket.remoteAddress ?? "unknown";
          const rate = attempts.get(address) ?? {
            count: 0,
            until: now + 15 * 60_000,
          };
          if (
            rate.count >= 10 ||
            (!attempts.has(address) && attempts.size >= 512)
          ) {
            response.setHeader("Retry-After", "900");
            reply(429, { error: "login-rate-limited" });
            return;
          }
          rate.count++;
          attempts.set(address, rate);
          if (
            !request.headers["content-type"]?.startsWith("application/json")
          ) {
            reply(415, { error: "invalid-request" });
            return;
          }
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 2048) {
              reply(413, { error: "invalid-request" });
              return;
            }
          }
          let input;
          try {
            input = JSON.parse(body);
          } catch {
            reply(400, { error: "invalid-request" });
            return;
          }
          if (
            !input ||
            typeof input.password !== "string" ||
            !timingSafeEqual(hash(input.password), hash(config.password))
          ) {
            reply(401, { error: "unauthenticated" });
            return;
          }
          if (sessions.size >= 64) {
            reply(503, { error: "session-capacity" });
            return;
          }
          const token = randomBytes(32).toString("base64url");
          sessions.set(hash(token).toString("hex"), now + 8 * 60 * 60_000);
          response.setHeader("Set-Cookie", cookie(token, 8 * 60 * 60));
          reply(200, { authenticated: true });
          return;
        }
      }
      const rawCookie = (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      const sessionKey = rawCookie ? hash(rawCookie).toString("hex") : "";
      const authenticated = sessions.has(sessionKey);
      if (request.method === "POST" && url.pathname === "/logout") {
        sessions.delete(sessionKey);
        response.setHeader("Set-Cookie", cookie("", 0));
        reply(200, { authenticated: false });
        return;
      }
      if (
        ["/api/snapshot", "/api/history"].includes(url.pathname) &&
        request.method === "GET"
      ) {
        if (!authenticated) {
          reply(401, { error: "unauthenticated" });
          return;
        }
        if (
          [...url.searchParams.keys()].some((key) => key !== "cursor") ||
          url.searchParams.getAll("cursor").length > 1 ||
          (url.searchParams.get("cursor")?.length ?? 0) > 4096
        ) {
          reply(400, { error: "invalid-request" });
          return;
        }
        const upstream = new URL(
          url.pathname === "/api/snapshot"
            ? "/v1/operator/snapshot"
            : "/v1/operator/history",
          config.core,
        );
        const cursor = url.searchParams.get("cursor");
        if (cursor) upstream.searchParams.set("cursor", cursor);
        const result = await traceOperation("dashboard.core", async (span) => {
          const started = performance.now();
          try {
            const result = await fetch(upstream, {
              headers: {
                Authorization: `Bearer ${config.coreToken}`,
                ...currentTraceHeaders(),
              },
              redirect: "error",
              signal: AbortSignal.timeout(20_000),
            });
            span.setAttribute("http.response.status_code", result.status);
            const outcome = result.ok
              ? "success"
              : result.status === 403
                ? "denied"
                : "error";
            span.setAttribute("outcome", outcome);
            runtimeLog("dashboard.core", {
              operation: "dashboard.core",
              outcome,
              status_code: result.status,
              duration_ms: performance.now() - started,
            });
            return result;
          } catch (error) {
            runtimeLog(
              "dashboard.core",
              {
                operation: "dashboard.core",
                outcome: "error",
                reason: "transport",
                duration_ms: performance.now() - started,
              },
              "error",
            );
            throw error;
          }
        });
        if (!result.ok) {
          reply(result.status === 403 ? 403 : 502, {
            error:
              result.status === 403
                ? "operator-access-denied"
                : "core-unavailable",
          });
          return;
        }
        // Only the integration-owned safe projection is forwarded, never arbitrary routes/errors.
        const snapshot = await result.json();
        if (
          !sessions.has(sessionKey) ||
          (sessions.get(sessionKey) ?? 0) <= Date.now()
        ) {
          reply(401, { error: "unauthenticated" });
          return;
        }
        reply(200, snapshot);
        return;
      }
      const asset = assets.get(url.pathname);
      if (request.method === "GET" && asset) {
        response.writeHead(200, { "content-type": asset[1] });
        response.end(
          await readFile(new URL(`../public/${asset[0]}`, import.meta.url)),
        );
        return;
      }
      reply(404, { error: "not-found" });
    } catch {
      if (!response.headersSent) reply(502, { error: "dashboard-unavailable" });
      else response.end();
    }
  });
}
