import { DurableObject } from "cloudflare:workers";
import { Collector, includeExporter } from "./collector.ts";
import { Telemetry } from "./telemetry.ts";

const headers = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Strict-Transport-Security": "max-age=31536000",
};

// One coordination atom bounds each of two fixed query modes, never per visitor.
// Only the sanitized bounded snapshot is held in memory; nothing private is persisted.
export class PublicTraceFeed extends DurableObject<Env> {
  private telemetry = new Telemetry(this.env.COMPUTAH_AXIOM_INGEST_TOKEN);
  private collector = new Collector(
    {
      token: this.env.COMPUTAH_AXIOM_QUERY_TOKEN,
      secret: this.env.PUBLIC_ID_SECRET,
    },
    fetch,
    Date.now,
    this.telemetry,
  );
  private diagnostics = new Collector(
    {
      token: this.env.COMPUTAH_AXIOM_QUERY_TOKEN,
      secret: this.env.PUBLIC_ID_SECRET,
      includeExporter: true,
    },
    fetch,
    Date.now,
    this.telemetry,
  );
  async fetch(request: Request): Promise<Response> {
    const trace = this.telemetry.start("computah.observatory.http");
    try {
      const collector =
        includeExporter(new URL(request.url)) === true
          ? this.diagnostics
          : this.collector;
      const snapshot = await collector.get(trace.span);
      this.ctx.waitUntil(
        trace.end(
          request.signal.aborted
            ? "cancelled"
            : snapshot.state === "live"
              ? "ready"
              : snapshot.state === "unconfigured"
                ? "not_configured"
                : "error",
        ),
      );
      return Response.json(snapshot, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      this.ctx.waitUntil(trace.end("error"));
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405, headers });
    if (
      url.search &&
      (url.pathname !== "/api/traces" || includeExporter(url) === null)
    )
      return new Response("Query parameters are not supported", {
        status: 400,
        headers,
      });
    let response: Response;
    if (url.pathname === "/api/traces") {
      try {
        response = await env.TRACES.getByName("public-feed-v1").fetch(
          `https://feed.internal/${url.search}`,
          { signal: request.signal },
        );
      } catch {
        response = Response.json(
          {
            state: "disconnected",
            fetchedAt: null,
            windowMs: 900000,
            limit: 1000,
            truncated: false,
            spans: [],
          },
          { status: 503 },
        );
      }
    } else {
      response = await env.ASSETS.fetch(request);
    }
    const result = new Response(
      request.method === "HEAD" ? null : response.body,
      response,
    );
    for (const [key, value] of Object.entries(headers))
      result.headers.set(key, value);
    if (url.pathname === "/api/traces")
      result.headers.set("Cache-Control", "no-store");
    return result;
  },
};
