import { DurableObject } from "cloudflare:workers";
import { timingSafeEqual } from "node:crypto";
import { boundedJson, Collector, includeExporter } from "./collector.ts";
import { DashboardCollector } from "./dashboard-collector.ts";
import {
  AGENTS,
  DASHBOARDS,
  MODELS,
  PROVIDERS,
  PUBLIC_OPERATIONS,
  parseDashboard,
  SERVICES,
  TOOLS,
} from "./dashboards.ts";
import { FeedStream, LiveProjection } from "./stream.ts";
import { type SafeSpan, Telemetry } from "./telemetry.ts";

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
  private live = new LiveProjection();
  private streams = [new FeedStream(), new FeedStream()];
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing?: Promise<void>;
  private watchParent?: SafeSpan;
  private telemetry = new Telemetry(this.env.COMPUTAH_AXIOM_INGEST_TOKEN);
  private dashboards = new DashboardCollector(
    {
      traces: this.env.COMPUTAH_AXIOM_QUERY_TOKEN,
      logs: this.env.COMPUTAH_AXIOM_DASHBOARD_LOGS_TOKEN,
      secret: this.env.PUBLIC_ID_SECRET,
    },
    fetch,
    Date.now,
    this.telemetry,
  );
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
  private publish() {
    [this.collector, this.diagnostics].forEach((collector, index) => {
      const stream = this.streams[index];
      stream.publish(this.live.merge(collector.snapshot, index === 1));
      stream.status({
        state: collector.snapshot.state,
        fetchedAt: collector.snapshot.fetchedAt,
        source:
          this.live.lastReceivedAt &&
          Date.now() - this.live.lastReceivedAt < 15_000
            ? "runtime-push"
            : "axiom-history",
        lastLiveAt: this.live.lastReceivedAt,
      });
    });
  }
  private refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await Promise.all(
        [this.collector, this.diagnostics].map((collector, index) =>
          this.streams[index].readers
            ? collector.get(this.watchParent)
            : Promise.resolve(),
        ),
      );
      this.publish();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }
  private schedule() {
    if (!this.streams.some((stream) => stream.readers)) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.watchParent = undefined;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ctx.waitUntil(this.refresh().finally(() => this.schedule()));
    }, 5000);
  }
  async fetch(request: Request): Promise<Response> {
    const carrier =
      request.method === "POST"
        ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-01$/.exec(
            request.headers.get("traceparent") ?? "",
          )
        : null;
    const parent =
      carrier && !/^0+$/.test(carrier[1]) && !/^0+$/.test(carrier[2])
        ? {
            traceId: carrier[1],
            spanId: carrier[2],
            name: "computah.observatory.http" as const,
            startTimeUnixNano: "0",
          }
        : undefined;
    const trace = this.telemetry.start("computah.observatory.http", parent);
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/dashboards/")) {
        const parts = url.pathname.split("/");
        const selection = parseDashboard(
          new URL(`/api/dashboards/${parts[3]}${url.search}`, url),
        );
        const panel = selection?.dashboard.panels.find(
          (item) => item.id === parts[4] && item.kind !== "private",
        );
        if (!selection || parts.length > 5 || (parts.length === 5 && !panel)) {
          this.ctx.waitUntil(trace.end("error"));
          return new Response("Unknown dashboard, panel or filters", {
            status: 400,
          });
        }
        if (panel) {
          const data = await this.dashboards.get(
            panel,
            selection.filters,
            trace.span,
          );
          this.ctx.waitUntil(
            trace.end(
              request.signal.aborted
                ? "cancelled"
                : data.state === "ready"
                  ? "ready"
                  : data.state === "unconfigured"
                    ? "not_configured"
                    : "error",
            ),
          );
          return Response.json(data);
        }
        this.ctx.waitUntil(trace.end("ready"));
        return Response.json({
          ...selection.dashboard,
          panels: selection.dashboard.panels.map(
            ({ query: _query, base: _base, ...item }) => item,
          ),
          selected: selection.filters,
          pages: DASHBOARDS.map(({ id, title }) => ({ id, title })),
          options: {
            service: SERVICES,
            model: MODELS,
            provider: PROVIDERS,
            agent: AGENTS,
            tool: TOOLS,
            operation: PUBLIC_OPERATIONS,
            status: ["error", "success"],
          },
          refreshMs: 300_000,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/ingest") {
        try {
          const body = await boundedJson(
            new Response(request.body),
            128 * 1024,
          );
          const accepted = this.live.accept(body, this.env.PUBLIC_ID_SECRET);
          this.publish();
          this.ctx.waitUntil(trace.end("ready"));
          return Response.json(
            { accepted },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch {
          this.ctx.waitUntil(trace.end("error"));
          return new Response("Invalid batch", { status: 400 });
        }
      }
      const collector =
        includeExporter(url) === true ? this.diagnostics : this.collector;
      const snapshot = await collector.get(trace.span);
      if (url.pathname === "/api/stream") {
        this.publish();
        const stream = this.streams[collector === this.diagnostics ? 1 : 0];
        const response = stream.connect(
          request.headers.get("Last-Event-ID"),
          request.signal,
          () => {
            this.ctx.waitUntil(trace.end("cancelled"));
            this.schedule();
          },
        );
        if (!response.ok) this.ctx.waitUntil(trace.end("error"));
        else this.watchParent ??= trace.span;
        this.schedule();
        return response;
      }
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
      return Response.json(
        this.live.merge(snapshot, collector === this.diagnostics),
        {
          headers: { "Cache-Control": "no-store" },
        },
      );
    } catch (error) {
      this.ctx.waitUntil(trace.end("error"));
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ingest = url.pathname === "/api/ingest";
    const dashboardApi = url.pathname.startsWith("/api/dashboards/");
    if (ingest) {
      const expected = env.OBSERVATORY_LIVE_TOKEN;
      const actual = request.headers.get("Authorization") ?? "";
      const wanted = `Bearer ${expected}`;
      if (
        !expected ||
        expected.length < 32 ||
        Buffer.byteLength(actual) !== Buffer.byteLength(wanted) ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(wanted))
      )
        return new Response("Unauthorized", { status: 401, headers });
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !(ingest && request.method === "POST")
    )
      return new Response("Method not allowed", { status: 405, headers });
    if (
      url.search &&
      !dashboardApi &&
      (!["/api/traces", "/api/stream"].includes(url.pathname) ||
        includeExporter(url) === null)
    )
      return new Response("Query parameters are not supported", {
        status: 400,
        headers,
      });
    let response: Response;
    if (
      dashboardApi ||
      ["/api/traces", "/api/stream", "/api/ingest"].includes(url.pathname)
    ) {
      if (request.method === "HEAD" && !dashboardApi)
        return new Response(null, { headers });
      try {
        response = await env.TRACES.getByName("public-feed-v1").fetch(
          new Request(
            `https://feed.internal${url.pathname}${url.search}`,
            request,
          ),
        );
      } catch {
        response = Response.json(
          dashboardApi
            ? {
                state: "unavailable",
                fetchedAt: null,
                rows: [],
                truncated: false,
              }
            : {
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
    } else if (
      DASHBOARDS.some((item) => url.pathname === `/dashboards/${item.id}`)
    ) {
      response = await env.ASSETS.fetch(
        new Request(new URL("/dashboards.html", url), request),
      );
    } else {
      response = await env.ASSETS.fetch(request);
    }
    const result = new Response(
      request.method === "HEAD" ? null : response.body,
      response,
    );
    for (const [key, value] of Object.entries(headers))
      result.headers.set(key, value);
    if (url.pathname.startsWith("/api/"))
      result.headers.set(
        "Cache-Control",
        url.pathname === "/api/stream" ? "no-store, no-transform" : "no-store",
      );
    return result;
  },
};
