import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  context,
  isSpanContextValid,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  type RuntimeLogFields,
  runtimeLog,
  startRuntimeLogging,
} from "./logs.js";

export {
  type RuntimeLogEvent,
  type RuntimeLogFields,
  type RuntimeMetricName,
  type RuntimeMetricSample,
  runtimeLog,
  runtimeMetric,
  startRuntimeLogging,
} from "./logs.js";

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
const services = new Set([
  "backend",
  "slack",
  "bus",
  "native",
  "dashboard",
  "rune-pi",
  "observatory",
]);
const operations = new Set([
  "submit",
  "result",
  "wait",
  "history",
  "cancel",
  "compact",
  "sleep",
  "observe",
  "http",
  "ready",
  "stopped",
  "lifecycle",
  "report",
  "synthetic",
  "model",
  "slack.receive",
  "slack.step",
  "slack.api",
  "slack.core",
  "web.search",
  "web.extract",
  "bus.pump",
  "bus.stream.create",
  "bus.stream.append",
  "bus.replay",
  "bus.admit",
  "bus.receipt",
  "bus.dispatch",
  "slack.job",
  "slack.admit",
  "slack.ack",
  "slack.queue",
  "slack.prepare",
  "slack.submit",
  "slack.wait",
  "slack.delivery",
  "slack.retry",
  "slack.status",
  "slack.recover",
  "slack.finish",
  "slack.finalize",
  "slack.timing",
  "slack.upload",
  "debugshare.capture",
  "sentinel.review",
  "sentinel.enforce",
  "sentinel.cancel",
  "operator.history",
  "dashboard.http",
  "dashboard.core",
  "native.ipc",
  "native.render",
  "native.recovery",
  "native.process",
  "native.core",
  "rune-pi.ipc",
  "rune-pi.render",
  "rune-pi.recovery",
  "rune-pi.process",
  "gmail.bind",
  "gmail.sync",
  "gmail.import",
  "gmail.drain",
  "gmail.authority",
  "gmail.retrieval",
  "axiom.discover",
  "axiom.call",
  "axiom.refresh",
  "axiom.persist",
  "start.failed",
  "logs.export",
  "files.read",
  "files.write",
  "files.edit",
  "observatory.http",
  "observatory.poll",
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
  "web_search",
  "web_extract",
  "ready",
  "denied",
  "not_configured",
  "invalid_input",
  "authorization_required",
  "rate_limited",
  "quota_exceeded",
  "capacity",
  "cancelled",
  "timeout",
  "transport",
  "http",
  "invalid_response",
  "response_too_large",
  "provider_error",
  "not_sent",
  "possibly_sent",
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
  "models",
  "registry",
  "listener",
  "http_drain",
  "registry_drain",
  "client_drain",
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
  "queue",
  "admit",
  "ack",
  "submit",
  "wait",
  "delivery",
  "status",
  "recover",
  "uncertain",
  "ignored",
  "duplicate",
  "accepted",
  "streaming",
  "failed",
  "allow",
  "pause",
  "cancel",
  "review-unavailable",
  "fenced",
  "allowed",
  "settled",
  "monitor",
  "preflight",
  "consistent-with-intent",
  "prompt-injection",
  "privacy-risk",
  "unintended-effect",
  "authority-mismatch",
  "read",
  "edit",
  "unconfigured",
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
  "request.state",
]);
const numberKeys = new Set([
  "attempt",
  "duration.ms",
  "count",
  "duration_ms",
  "bus.queue_ms",
  "bus.ack_ms",
  "bus.attempt",
  "queue.duration_ms",
  "delivery.duration_ms",
  "attempt.duration_ms",
  "receipt.age_ms",
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
    if (
      key === "computah.debugshare.id" &&
      typeof value?.stringValue === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        value.stringValue,
      ) &&
      value.stringValue.length === 36
    )
      return [{ key, value: { stringValue: value.stringValue } }];
    if (stringKeys.has(key) && value && categories.has(value.stringValue ?? ""))
      return [{ key, value: { stringValue: value.stringValue } }];
    if (numberKeys.has(key)) {
      const number = value?.doubleValue ?? Number(value?.intValue);
      if (
        Number.isFinite(number) &&
        number >= 0 &&
        number <= Number.MAX_SAFE_INTEGER
      )
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
export function startObservability(
  service: "backend" | "slack" | "bus" | "native" | "dashboard" | "rune-pi",
) {
  running ??= start(service);
  return running;
}
async function start(service: string) {
  const logs = startRuntimeLogging(
    service as Parameters<typeof startRuntimeLogging>[0],
  );
  const token = process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  if (!token)
    return {
      close: async () => {
        await logs.close();
      },
    };
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
      await logs.close();
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
>(model: string, call: () => T, parent?: Record<string, string>): T {
  if (parent !== undefined)
    return withTraceContext(parent, () => traceModelStream(model, call));
  return trace
    .getTracer("computah")
    .startActiveSpan(`chat ${model}`, {}, context.active(), (span) => {
      const started = performance.now();
      const finish = (outcome: "success" | "error" | "cancelled") => {
        context.with(trace.setSpan(context.active(), span), () =>
          runtimeLog(
            "model.completed",
            {
              operation: "model",
              outcome,
              duration_ms: performance.now() - started,
            },
            outcome === "error" ? "error" : "info",
          ),
        );
        span.end();
      };
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
            span.setAttribute("outcome", message.stopReason);
            finish(
              message.stopReason === "error"
                ? "error"
                : message.stopReason === "aborted"
                  ? "cancelled"
                  : "success",
            );
          },
          () => {
            span.setStatus({ code: SpanStatusCode.ERROR });
            finish("error");
          },
        );
        return stream;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        finish("error");
        throw error;
      }
    });
}
export function traceOperation<T>(
  operation: string,
  body: (span: Span) => Promise<T>,
  parent?: Record<string, string>,
  links: readonly Record<string, string>[] = [],
): Promise<T> {
  if (parent !== undefined)
    return withTraceContext(parent, () =>
      traceOperation(operation, body, undefined, links),
    );
  return trace.getTracer("computah").startActiveSpan(
    `computah.${operation}`,
    {
      links: links.slice(0, 32).flatMap((carrier) => {
        const remote = trace.getSpanContext(traceParent(carrier.traceparent));
        return remote ? [{ context: remote }] : [];
      }),
    },
    context.active(),
    async (span) => {
      const started = performance.now();
      let outcome: RuntimeLogFields["outcome"] = "success";
      let reason: RuntimeLogFields["reason"];
      let effectiveStatus: SpanStatusCode = SpanStatusCode.UNSET;
      // Observe only explicit scalar outcome/status writes, never result objects.
      const observed = new Proxy(span, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "setAttribute")
            return (key: string, value: unknown) => {
              if (key === "outcome" && typeof value === "string") {
                outcome =
                  value === "ready"
                    ? "ready"
                    : value === "cancelled" || value === "aborted"
                      ? "cancelled"
                      : value === "timeout"
                        ? "timeout"
                        : value === "denied"
                          ? "denied"
                          : value === "error" || value === "failed"
                            ? "error"
                            : value === "success" ||
                                value === "stop" ||
                                value === "done"
                              ? "success"
                              : "other";
                reason = value as RuntimeLogFields["reason"];
              }
              target.setAttribute(key, value as string);
              return observed;
            };
          if (key === "setAttributes")
            return (values: Parameters<Span["setAttributes"]>[0]) => {
              for (const [key, value] of Object.entries(values))
                if (value !== undefined) observed.setAttribute(key, value);
              return observed;
            };
          if (key === "setStatus")
            return (status: Parameters<Span["setStatus"]>[0]) => {
              if (
                status.code !== SpanStatusCode.UNSET &&
                effectiveStatus !== SpanStatusCode.OK
              )
                effectiveStatus = status.code;
              target.setStatus(status);
              return observed;
            };
          return typeof value === "function"
            ? (...args: unknown[]) => {
                const result = value.apply(target, args);
                return result === target ? observed : result;
              }
            : value;
        },
      });
      try {
        return await body(observed);
      } catch (error) {
        if (!["cancelled", "timeout"].includes(outcome)) outcome = "error";
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        if (
          [SpanStatusCode.ERROR].includes(effectiveStatus) &&
          ["success", "other"].includes(outcome)
        )
          outcome = "error";
        runtimeLog(
          "operation.completed",
          {
            operation: operation as RuntimeLogFields["operation"],
            outcome,
            reason,
            duration_ms: performance.now() - started,
          },
          outcome === "error" ? "error" : "info",
        );
        span.end();
      }
    },
  );
}
export function traceEvent(
  operation: string,
  values: Record<string, string | number> = {},
) {
  const span = trace.getTracer("computah").startSpan(`computah.${operation}`);
  span.setAttributes(values);
  context.with(trace.setSpan(context.active(), span), () => {
    if (operation === "ready")
      runtimeLog("runtime.ready", { outcome: "ready" });
    else if (operation === "stopped")
      runtimeLog("runtime.stopped", { outcome: "stopped" });
    else if (operation === "start.failed")
      runtimeLog("runtime.start_failed", { outcome: "error" }, "error");
    else if (operation === "report")
      runtimeLog("runtime.report", { outcome: "other" });
  });
  span.end();
}

/** Fixed, content-free lifecycle boundaries also remain visible without export. */
export function traceLifecycle<T>(
  phase:
    | "models"
    | "registry"
    | "listener"
    | "http_drain"
    | "registry_drain"
    | "client_drain",
  body: () => Promise<T>,
): Promise<T> {
  return traceOperation("lifecycle", async (span) => {
    const started = performance.now();
    span.setAttribute("phase", phase);
    console.info(`computah.lifecycle phase=${phase} outcome=started`);
    let outcome = "success";
    try {
      return await body();
    } catch (error) {
      outcome = "error";
      throw error;
    } finally {
      const elapsed = Math.round(performance.now() - started);
      span.setAttributes({ outcome, "duration.ms": elapsed });
      console.info(
        `computah.lifecycle phase=${phase} outcome=${outcome} duration_ms=${elapsed}`,
      );
    }
  });
}

/** IDs only, for trusted internal transports. Never forward baggage or credentials. */
export function currentTraceHeaders(): Record<string, string> {
  const span = trace.getSpanContext(context.active());
  if (!span || !isSpanContextValid(span))
    return { ...durableContext.getStore() };
  return {
    traceparent: `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}`,
  };
}

/** New durable identity, independent of ambient receive/pump spans, even without an SDK. */
export function createTraceCarrier(
  operation: string,
  links: readonly Record<string, string>[] = [],
): Record<string, string> {
  const span = trace.getTracer("computah").startSpan(
    `computah.${operation}`,
    {
      links: links.slice(0, 32).flatMap((carrier) => {
        const remote = trace.getSpanContext(traceParent(carrier.traceparent));
        return remote ? [{ context: remote }] : [];
      }),
    },
    ROOT_CONTEXT,
  );
  const current = span.spanContext();
  span.end();
  return {
    traceparent: isSpanContextValid(current)
      ? `00-${current.traceId}-${current.spanId}-${current.traceFlags.toString(16).padStart(2, "0")}`
      : `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
  };
}

/** Restore IDs only from a durable carrier; never inherit ambient baggage. */
const durableContext = new AsyncLocalStorage<Record<string, string>>();
export function withTraceContext<T>(
  carrier: Record<string, string> | undefined,
  body: () => T,
): T {
  const parent = traceParent(carrier?.traceparent);
  const valid = trace.getSpanContext(parent);
  const clean: Record<string, string> = valid
    ? {
        traceparent: `00-${valid.traceId}-${valid.spanId}-${valid.traceFlags.toString(16).padStart(2, "0")}`,
      }
    : {};
  return durableContext.run(clean, () => context.with(parent, body));
}

/** Retrospective queue timing uses persisted wall-clock boundaries, not dequeue duration. */
export function traceInterval(
  operation: string,
  startTimeMs: number,
  endTimeMs: number,
  parent: Record<string, string>,
  values: Record<string, string | number | boolean> = {},
): void {
  if (
    !Number.isFinite(startTimeMs) ||
    !Number.isFinite(endTimeMs) ||
    startTimeMs < 0 ||
    endTimeMs < startTimeMs ||
    endTimeMs > Number.MAX_SAFE_INTEGER
  )
    return;
  const span = trace.getTracer("computah").startSpan(
    `computah.${operation}`,
    {
      startTime: [
        Math.floor(startTimeMs / 1000),
        Math.round((startTimeMs % 1000) * 1e6),
      ],
      attributes: { ...values, duration_ms: endTimeMs - startTimeMs },
    },
    traceParent(parent.traceparent),
  );
  span.end([
    Math.floor(endTimeMs / 1000),
    Math.round((endTimeMs % 1000) * 1e6),
  ]);
}

/** A carrier is correlation only, never identity/authority. Invalid carriers start roots. */
function traceParent(carrier: unknown) {
  const match =
    typeof carrier === "string" && carrier.length === 55
      ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(carrier)
      : null;
  const remote = match
    ? {
        traceId: match[1],
        spanId: match[2],
        traceFlags: Number.parseInt(match[3], 16),
        isRemote: true,
      }
    : undefined;
  return remote && isSpanContextValid(remote)
    ? trace.setSpanContext(ROOT_CONTEXT, remote)
    : ROOT_CONTEXT;
}

/** Attach before requests arrive; no URL, headers, body or principal enters telemetry. */
export function traceHttp(server: Server) {
  const listeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    // A carrier is correlation only, never identity/authority. Reject duplicates,
    // malformed IDs and all baggage/tracestate; do not inherit an unrelated local span.
    const parent = traceParent(request.headers.traceparent);
    const span = trace.getTracer("computah").startSpan(
      "computah.http",
      {
        attributes: { "http.request.method": request.method ?? "unknown" },
      },
      parent,
    );
    let ended = false;
    const started = performance.now();
    const finish = () => {
      if (ended) return;
      ended = true;
      span.setAttribute("http.response.status_code", response.statusCode);
      if (response.statusCode >= 500 || !response.writableFinished)
        span.setStatus({ code: SpanStatusCode.ERROR });
      context.with(trace.setSpan(parent, span), () =>
        runtimeLog("http.completed", {
          operation: "http",
          status_code: response.statusCode,
          duration_ms: performance.now() - started,
          outcome: !response.writableFinished
            ? "cancelled"
            : response.statusCode >= 500
              ? "error"
              : response.statusCode >= 400
                ? "denied"
                : "success",
        }),
      );
      span.end();
    };
    response.once("finish", finish);
    response.once("close", finish);
    context.with(trace.setSpan(parent, span), () => {
      for (const listener of listeners)
        listener.call(server, request, response);
    });
  });
}
