import { randomUUID } from "node:crypto";
import {
  context,
  isSpanContextValid,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const events = [
  "runtime.ready",
  "runtime.stopped",
  "runtime.start_failed",
  "runtime.report",
  "http.completed",
  "model.completed",
  "slack.receive",
  "slack.delivery",
  "bus.delivery",
  "runtime.retry",
  "runtime.cancelled",
  "runtime.recovery",
  "operation.completed",
  "native.ipc",
  "native.render",
  "native.recovery",
  "native.process",
  "native.core",
  "dashboard.http",
  "dashboard.core",
  "rune-pi.ipc",
  "rune-pi.render",
  "rune-pi.recovery",
  "rune-pi.process",
  "bus.pump",
  "bus.stream.create",
  "bus.stream.append",
  "bus.replay",
  "telemetry.synthetic",
] as const;
export type RuntimeLogEvent = (typeof events)[number];
const outcomes = [
  "success",
  "error",
  "cancelled",
  "timeout",
  "denied",
  "queued",
  "retry",
  "ready",
  "stopped",
  "other",
] as const;
const reasons = [
  "transport",
  "http",
  "capacity",
  "rate_limited",
  "invalid_input",
  "not_configured",
  "storage_failed",
  "authorization_required",
  "other",
] as const;
const operations = [
  "submit",
  "result",
  "wait",
  "history",
  "cancel",
  "compact",
  "sleep",
  "observe",
  "http",
  "model",
  "receive",
  "delivery",
  "recovery",
  "export",
  "web.search",
  "web.extract",
  "operator.history",
  "sentinel.review",
  "sentinel.enforce",
  "sentinel.cancel",
  "gmail.bind",
  "gmail.sync",
  "gmail.import",
  "gmail.drain",
  "gmail.authority",
  "gmail.retrieval",
  "native.ipc",
  "native.render",
  "native.recovery",
  "native.process",
  "native.core",
  "dashboard.http",
  "dashboard.core",
  "rune-pi.ipc",
  "rune-pi.render",
  "rune-pi.recovery",
  "rune-pi.process",
  "bus.pump",
  "bus.stream.create",
  "bus.stream.append",
  "bus.replay",
  "other",
] as const;
export type RuntimeLogFields = {
  outcome?: (typeof outcomes)[number];
  reason?: (typeof reasons)[number];
  operation?: (typeof operations)[number];
  attempt?: number;
  count?: number;
  duration_ms?: number;
  status_code?: number;
  resumed?: boolean;
};
type Attribute = {
  key: string;
  value:
    | { stringValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
};
type Record = {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: RuntimeLogEvent };
  attributes: Attribute[];
  traceId?: string;
  spanId?: string;
};
type RuntimeLogService =
  | "backend"
  | "slack"
  | "bus"
  | "native"
  | "dashboard"
  | "rune-pi";

/** Code-owned categories only. Never pass console text, errors, histories or arbitrary IDs. */
export function createRuntimeLogger(options: {
  service: RuntimeLogService;
  dataset?: string;
  token?: string;
  /** Transport injection for tests; production must retain the fixed HTTPS destination. */
  fetch?: typeof globalThis.fetch;
}) {
  const token = options.token ?? process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  const dataset = options.dataset ?? process.env.COMPUTAH_AXIOM_LOG_DATASET;
  const enabled = Boolean(
    token &&
      dataset &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(dataset) &&
      ["backend", "slack", "bus", "native", "dashboard", "rune-pi"].includes(
        options.service,
      ),
  );
  const transport = options.fetch ?? globalThis.fetch;
  const queue: Record[] = [];
  let closed = false;
  let accepted = 0;
  let completed = 0;
  let exported = 0;
  let failed = 0;
  let dropped = 0;
  let rejected = 0;
  let active: Promise<void> | undefined;
  const stats = () => ({
    enabled,
    closed,
    queued: queue.length,
    accepted,
    exported,
    failed,
    dropped,
    rejected,
  });

  function emit(
    event: RuntimeLogEvent,
    fields: RuntimeLogFields = {},
    level: "info" | "warn" | "error" = "info",
  ): string | undefined {
    if (!enabled || closed) return undefined;
    if (!events.includes(event) || !["info", "warn", "error"].includes(level)) {
      rejected++;
      return undefined;
    }
    if (queue.length >= 512) {
      dropped++;
      return undefined;
    }
    try {
      const attributes: Attribute[] = [];
      for (const [key, allowed] of [
        ["outcome", outcomes],
        ["reason", reasons],
        ["operation", operations],
      ] as const) {
        const value = fields[key];
        if (
          typeof value === "string" &&
          (allowed as readonly string[]).includes(value)
        )
          attributes.push({ key, value: { stringValue: value } });
      }
      for (const key of [
        "attempt",
        "count",
        "duration_ms",
        "status_code",
      ] as const) {
        const value = fields[key];
        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= Number.MAX_SAFE_INTEGER
        )
          attributes.push({ key, value: { doubleValue: value } });
      }
      if (typeof fields.resumed === "boolean")
        attributes.push({
          key: "resumed",
          value: { boolValue: fields.resumed },
        });
      const logId = randomUUID();
      attributes.push({ key: "log.id", value: { stringValue: logId } });
      const span = trace.getSpanContext(context.active());
      queue.push({
        timeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
        severityNumber: level === "error" ? 17 : level === "warn" ? 13 : 9,
        severityText: level.toUpperCase(),
        body: { stringValue: event },
        attributes,
        ...(span && isSpanContextValid(span)
          ? { traceId: span.traceId, spanId: span.spanId }
          : {}),
      });
      accepted++;
      return logId;
    } catch {
      rejected++;
      return undefined;
    }
  }

  async function exportBatch(records: Record[]) {
    // Fixed operation and counters only; do not log exporter failures recursively.
    const span = trace.getTracer("computah").startSpan("computah.logs.export", {
      links: records.flatMap((record) =>
        record.traceId && record.spanId
          ? [
              {
                context: {
                  traceId: record.traceId,
                  spanId: record.spanId,
                  traceFlags: 1,
                },
              },
            ]
          : [],
      ),
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, 5000);
      });
      const send = async () => {
        const response = await transport("https://api.axiom.co/v1/logs", {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Axiom-Dataset": dataset ?? "",
          },
          body: JSON.stringify({
            resourceLogs: [
              {
                resource: {
                  attributes: [
                    {
                      key: "service.name",
                      value: { stringValue: `computah-${options.service}` },
                    },
                  ],
                },
                scopeLogs: [
                  { scope: { name: "computah" }, logRecords: records },
                ],
              },
            ],
          }),
          signal: controller.signal,
        });
        // Bound response memory as well as request memory. No response diagnostics are retained.
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("http");
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 4096) throw new Error("response");
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        const text = Buffer.concat(chunks).toString();
        const result = text ? JSON.parse(text) : {};
        const rejected = Number(result.partialSuccess?.rejectedLogRecords ?? 0);
        if (
          !Number.isInteger(rejected) ||
          rejected < 0 ||
          rejected > records.length
        )
          throw new Error("response");
        return rejected;
      };
      const rejectedCount = await Promise.race([send(), timeout]);
      failed += rejectedCount;
      exported += records.length - rejectedCount;
      span.setAttribute("outcome", rejectedCount ? "error" : "success");
      if (rejectedCount) span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      failed += records.length;
      span.setAttribute(
        "outcome",
        controller.signal.aborted ? "timeout" : "error",
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      span.end();
    }
  }

  /** Settle every accepted record before this call; later emissions need a later flush. */
  async function flush() {
    const target = accepted;
    while (completed < target) {
      if (!active) {
        const end = accepted;
        active = (async () => {
          while (completed < end) {
            const batch = queue.slice(0, Math.min(64, end - completed));
            await exportBatch(batch);
            queue.splice(0, batch.length);
            completed += batch.length;
          }
        })().finally(() => {
          active = undefined;
        });
      }
      await active;
    }
    return stats();
  }
  const interval = enabled
    ? setInterval(() => {
        void flush();
      }, 1000)
    : undefined;
  interval?.unref();
  return {
    emit,
    flush,
    stats,
    /** Stop admission immediately, then drain once; failed records are not retried. */
    async close() {
      closed = true;
      if (interval) clearInterval(interval);
      return flush();
    },
  };
}

let runtime: ReturnType<typeof createRuntimeLogger> | undefined;

/** Start once during observability bootstrap, before admitting application work. */
export function startRuntimeLogging(service: RuntimeLogService) {
  runtime ??= createRuntimeLogger({ service });
  return runtime;
}

/** Shared runtime hook; inactive until bootstrap. Correlation is captured at emission. */
export function runtimeLog(
  event: RuntimeLogEvent,
  fields: RuntimeLogFields = {},
  level: "info" | "warn" | "error" = "info",
) {
  return runtime?.emit(event, fields, level);
}
