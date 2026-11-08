import { createServer, type Server } from "node:http";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";

type Json = {
  [key: string]: unknown;
  resourceSpans?: Json[];
  scopeSpans?: Json[];
  spans?: Json[];
  events?: Json[];
  links?: Json[];
  key?: string;
  kind?: number;
  status?: { code?: number; message?: string };
  value?: {
    stringValue?: string;
    doubleValue?: number;
    intValue?: string;
    boolValue?: boolean;
  };
};
const services = new Set(["backend", "slack", "bus"]);
const operations = new Set([
  "submit",
  "result",
  "history",
  "cancel",
  "compact",
  "sleep",
  "observe",
  "http",
  "ready",
  "stopped",
  "report",
  "synthetic",
  "model",
  "slack.receive",
  "slack.step",
  "slack.api",
  "slack.core",
  "start.failed",
]);
const categories = new Set([
  "input",
  "write",
  "continue",
  "run",
  "abort",
  "done",
  "unanswered",
  "queued",
  "placed",
  "waiting",
  "sleeping",
  "faulted",
  "aborted",
  "success",
  "error",
  "stop",
  "length",
  "toolUse",
  "Task",
  "interaction",
  "worker",
  "primary",
  "priority",
  "fast",
  "default",
  "auto",
  "missing",
  "other",
  "request",
  "response",
  "tier",
  "terminal",
  "created",
  "completed",
  "provider-error",
  "reasoning-not-allowed",
  "openai-codex",
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "openai-codex/gpt-6.1-terra",
  "openai-codex/gpt-6.1-sol",
  "chat",
  "invoke_agent",
  "pi",
  "storage_failed",
  "task_faulted",
  "task_interrupted",
  "migration_failed",
  "task_outdated",
  "task_error",
  "extension_error",
  "host_error",
  "listener_error",
  "threw",
  "restart_limit",
  "interrupted",
  "missing_task",
  "task_too_old",
  "pi.generation",
  "pi.tool",
  "pi.compaction",
  "computah.cancel",
  "computah.task",
  "prepare",
  "poll",
  "tools",
  "drain",
  "retry",
  "finish",
  "call",
  "execute",
  "select",
  "summarize",
  "sdk_unverified",
  "GET",
  "POST",
  "DELETE",
  "PUT",
  "PATCH",
  "OPTIONS",
  "HEAD",
  "unknown",
]);
const stringKeys = new Set([
  "submission.type",
  "status",
  "result",
  "task.name",
  "phase",
  "kind",
  "outcome",
  "tool.name",
  "type",
  "reason",
  "extension",
  "entry.kind",
  "gen_ai.operation.name",
  "gen_ai.agent.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "model",
  "http.request.method",
  "event",
  "requested",
  "tier",
  "stage",
  "computah.usage.source",
]);
const numberKeys = new Set([
  "attempt",
  "status",
  "http.response.status_code",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "usage.input",
  "usage.output",
  "usage.cache_read",
  "usage.cache_write",
  "status.code",
]);
function name(value: unknown): string {
  if (typeof value !== "string") return "runtime.operation";
  if (value.startsWith("computah.") && operations.has(value.slice(9)))
    return value;
  if (
    /^pi\.durable\.(submit|phase|entry|submission|report|checkpoint|replay)$/.test(
      value,
    )
  )
    return value;
  if (/^(chat (gpt-6.1-terra|gpt-6.1-sol)|invoke_agent pi)$/.test(value))
    return value;
  if (
    /^(interaction|worker)\/(admit|awaitCancellation|sleep|harness\.(root|submission)|submission\.(wait|status)|conversation\.(entries|configure)|pi\.wake)$/.test(
      value,
    )
  )
    return value;
  // Preserve timing/relationships even for unrecognized vendor operations, never their dynamic name.
  return "runtime.operation";
}
function attributes(input: unknown): Json[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap<Json>((entry: Json) => {
    const key = entry?.key ?? "";
    const value = entry?.value;
    if (stringKeys.has(key) && value && categories.has(value.stringValue ?? ""))
      return [{ key, value: { stringValue: value.stringValue } }];
    if (numberKeys.has(key)) {
      const number = value?.doubleValue ?? Number(value?.intValue);
      if (Number.isFinite(number) && number >= 0)
        return [{ key, value: { doubleValue: number } }];
    }
    if (key === "resumed" && typeof value?.boolValue === "boolean")
      return [{ key, value: { boolValue: value.boolValue } }];
    return [];
  });
}
const id = (value: unknown, length: number) =>
  typeof value === "string" &&
  new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value)
    ? value
    : undefined;
const time = (value: unknown) =>
  typeof value === "string" && /^\d{1,20}$/.test(value) ? value : "0";

/** Rebuild OTLP from a positive schema; never forward unknown fields, resources or diagnostics. */
export function sanitizeTraces(
  body: Json,
  service: string,
  revision?: string,
): Json {
  return {
    resourceSpans: (Array.isArray(body.resourceSpans)
      ? body.resourceSpans
      : []
    ).map((resource: Json) => ({
      resource: {
        attributes: [
          {
            key: "service.name",
            value: {
              stringValue: `computah-${services.has(service) ? service : "backend"}`,
            },
          },
          ...(revision && /^[a-f0-9]{40}$/.test(revision)
            ? [{ key: "service.version", value: { stringValue: revision } }]
            : []),
        ],
      },
      scopeSpans: (Array.isArray(resource.scopeSpans)
        ? resource.scopeSpans
        : []
      ).map((scope: Json) => ({
        scope: { name: "computah" },
        spans: (Array.isArray(scope.spans) ? scope.spans : [])
          .filter((span: Json) => id(span.traceId, 32) && id(span.spanId, 16))
          .map((span: Json) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(id(span.parentSpanId, 16)
              ? { parentSpanId: span.parentSpanId }
              : {}),
            name: name(span.name),
            kind:
              typeof span.kind === "number" &&
              Number.isInteger(span.kind) &&
              span.kind >= 0 &&
              span.kind <= 5
                ? span.kind
                : 1,
            startTimeUnixNano: time(span.startTimeUnixNano),
            endTimeUnixNano: time(span.endTimeUnixNano),
            attributes: attributes(span.attributes),
            status: {
              code:
                span.status?.code === 2 ? 2 : span.status?.code === 1 ? 1 : 0,
            },
            events: (Array.isArray(span.events) ? span.events : []).map(
              (event: Json) => ({
                name: name(event.name),
                timeUnixNano: time(event.timeUnixNano),
                attributes: attributes(event.attributes),
              }),
            ),
            links: (Array.isArray(span.links) ? span.links : [])
              .filter(
                (link: Json) => id(link.traceId, 32) && id(link.spanId, 16),
              )
              .map((link: Json) => ({
                traceId: link.traceId,
                spanId: link.spanId,
              })),
          })),
      })),
    })),
  };
}

let running: Promise<{ close(): Promise<void> }> | undefined;
/** Start before loading the runtime: Rust and JS export through the same loopback privacy boundary. */
export function startObservability(service: "backend" | "slack" | "bus") {
  running ??= start(service);
  return running;
}
async function start(service: string) {
  const token = process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  if (!token) return { close: async () => {} };
  const [
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { AlwaysOnSampler, BatchSpanProcessor },
    { NodeTracerProvider },
  ] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/sdk-trace-node"),
  ]);
  const dataset = "computah-prod-traces";
  let active = 0;
  let closing = false;
  const pending = new Set<Promise<void>>();
  const receiver: Server = createServer((request, response) => {
    if (closing || active >= 8) {
      response.writeHead(503).end();
      return;
    }
    if (
      request.method !== "POST" ||
      request.url !== "/v1/traces" ||
      !request.headers["content-type"]?.includes("application/json")
    ) {
      response.writeHead(415).end();
      return;
    }
    active++;
    const work = (async () => {
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const body = sanitizeTraces(
          JSON.parse(Buffer.concat(chunks).toString()),
          service,
          process.env.COMPUTAH_REVISION,
        );
        const result = await fetch("https://api.axiom.co/v1/traces", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Axiom-Dataset": dataset,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        await result.body?.cancel();
        response
          .writeHead(result.ok ? 200 : 503, {
            "content-type": "application/json",
          })
          .end("{}");
        if (!result.ok) console.warn("computah.telemetry.export_failed");
      } catch {
        response.writeHead(503).end();
        console.warn("computah.telemetry.export_failed");
      } finally {
        active--;
      }
    })();
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  receiver.requestTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(0, "127.0.0.1", resolve);
  });
  receiver.unref();
  const address = receiver.address();
  if (!address || typeof address === "string")
    throw new Error("Telemetry listener unavailable");
  const endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
  // Do not let ambient OTLP credentials or resource identities bypass the relay.
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
  process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = "";
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "";
  process.env.OTEL_TRACES_EXPORTER = "otlp";
  process.env.OTEL_TRACES_SAMPLER = "always_on";
  process.env.OTEL_SERVICE_NAME = `computah-${service}`;
  process.env.OTEL_SDK_DISABLED = "false";
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    resource: resourceFromAttributes({ "service.name": `computah-${service}` }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: endpoint,
          headers: {},
          timeoutMillis: 7000,
        }),
        {
          maxQueueSize: 4096,
          maxExportBatchSize: 256,
          scheduledDelayMillis: 1000,
          exportTimeoutMillis: 8000,
        },
      ),
    ],
  });
  provider.register();
  return {
    close: async () => {
      await provider.shutdown().catch(() => {
        console.warn("computah.telemetry.flush_failed");
      });
      closing = true;
      receiver.close();
      await Promise.allSettled([...pending]);
      receiver.closeAllConnections();
    },
  };
}

export function traceModelStream<
  T extends {
    result(): Promise<{
      stopReason: string;
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
    }>;
  },
>(model: string, call: () => T): T {
  return trace
    .getTracer("computah")
    .startActiveSpan(`chat ${model}`, (span) => {
      span.setAttribute("gen_ai.request.model", model);
      try {
        const stream = call();
        void stream.result().then(
          (message) => {
            if (message.usage) {
              span.setAttributes({
                "usage.input": message.usage.input,
                "usage.output": message.usage.output,
                "usage.cache_read": message.usage.cacheRead,
                "usage.cache_write": message.usage.cacheWrite,
                "computah.usage.source": "sdk_unverified",
              });
            }
            if (message.stopReason === "error")
              span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
          },
          () => {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
          },
        );
        return stream;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      }
    });
}
export function traceOperation<T>(
  operation: string,
  body: () => Promise<T>,
): Promise<T> {
  return trace
    .getTracer("computah")
    .startActiveSpan(`computah.${operation}`, async (span) => {
      try {
        return await body();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}
export function traceEvent(
  operation: string,
  values: Record<string, string | number> = {},
) {
  const span = trace.getTracer("computah").startSpan(`computah.${operation}`);
  span.setAttributes(values);
  span.end();
}
/** Attach before requests arrive; no URL, headers, body or principal enters telemetry. */
export function traceHttp(server: Server) {
  const listeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    const span = trace.getTracer("computah").startSpan("computah.http", {
      attributes: { "http.request.method": request.method ?? "unknown" },
    });
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      span.setAttribute("http.response.status_code", response.statusCode);
      if (response.statusCode >= 500 || !response.writableFinished)
        span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    };
    response.once("finish", finish);
    response.once("close", finish);
    context.with(trace.setSpan(context.active(), span), () => {
      for (const listener of listeners)
        listener.call(server, request, response);
    });
  });
}
