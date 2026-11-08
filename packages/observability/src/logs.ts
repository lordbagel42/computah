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
  "correlation_unavailable",
  "time_range_unavailable",
  "target_not_found_or_legacy_or_scan_limit",
  "result_too_large",
  "transport_or_invalid_response",
  "invalid_response",
  "response_too_large",
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
  "files.read",
  "files.write",
  "files.edit",
  "operations.discover",
  "operations.query",
  "operations.timing",
  "slack.receive",
  "slack.step",
  "slack.api",
  "slack.core",
  "slack.delivery",
  "slack.job",
  "slack.admit",
  "slack.queue",
  "slack.prepare",
  "slack.submit",
  "slack.wait",
  "slack.retry",
  "slack.status",
  "slack.ack",
  "slack.recover",
  "slack.finalize",
  "slack.timing",
  "observatory.http",
  "observatory.poll",
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
  "bus.admit",
  "bus.receipt",
  "bus.dispatch",
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
  body: { stringValue: RuntimeLogEvent | "analytics.sample" };
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
  | "rune-pi"
  | "observatory";

// Mirrors the shipped server ANALYTICS_METRICS vocabulary without depending on the app.
const metricNames = [
  "model.requests",
  "model.duration",
  "model.first_output",
  "model.tokens.input",
  "model.tokens.output",
  "model.tokens.cache_read",
  "model.tokens.cache_write",
  "model.tokens.cache_write_1h",
  "model.tokens.reasoning",
  "model.tokens.total",
  "model.cost.reported",
  "model.cost.estimated",
  "model.usage_missing",
  "model.length_limited",
  "task.duration",
  "task.queue_wait",
  "task.active",
  "task.queued",
  "worker.duration",
  "tool.duration",
  "operation.duration",
  "operation.retries",
  "operation.cancellations",
  "slack.admissions",
  "slack.delivery",
  "slack.delivery_duration",
  "slack.rate_limits",
  "slack.retry_after",
  "slack.queue_age",
  "memory.compactions",
  "memory.compaction_duration",
  "memory.context_tokens",
  "runtime.wakes",
  "runtime.reports",
  "runtime.phase_duration",
  "runtime.replays",
  "runtime.resumed_phases",
  "runtime.restart_streak",
] as const;
export type RuntimeMetricName = (typeof metricNames)[number];
export type RuntimeMetricSample = {
  measurements: Partial<{ [K in RuntimeMetricName]: number }>;
  role: "interaction" | "worker" | "slack" | "runtime";
  operation:
    | "submit"
    | "wait"
    | "result"
    | "history"
    | "cancel"
    | "compact"
    | "sleep"
    | "Task"
    | "observe"
    | "unknown";
  outcome:
    | "ok"
    | "error"
    | "aborted"
    | "unknown"
    | "accepted"
    | "duplicate"
    | "ignored"
    | "uncertain"
    | "rate_limited";
  model: "openai-codex/gpt-6.1-terra" | "openai-codex/gpt-6.1-sol" | "unknown";
  provider: "openai-codex" | "unknown";
  sdk: "pi-ai@1.5.0";
  reportedFromProvider?: true;
  rate?: {
    version: "pi-ai@1.5.0/runtime-model";
    currency: "USD";
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h?: number;
    inputTokensAbove?: number;
  };
};
const finiteScalar = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

/** Code-owned categories only. Never pass console text, errors, histories or arbitrary IDs. */
export function createRuntimeLogger(options: {
  service: RuntimeLogService;
  dataset?: string;
  token?: string;
  revision?: string;
  /** Transport injection for tests; production must retain the fixed HTTPS destination. */
  fetch?: typeof globalThis.fetch;
}) {
  const token = options.token ?? process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  const dataset = options.dataset ?? process.env.COMPUTAH_AXIOM_LOG_DATASET;
  const service = options.service;
  const revision = options.revision ?? process.env.COMPUTAH_REVISION;
  const enabled = Boolean(
    token &&
      dataset &&
      dataset !== "computah-prod-traces" &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(dataset) &&
      [
        "backend",
        "slack",
        "bus",
        "native",
        "dashboard",
        "rune-pi",
        "observatory",
      ].includes(service),
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

  function enqueue(
    event: RuntimeLogEvent | "analytics.sample",
    fields: RuntimeLogFields,
    level: "info" | "warn" | "error",
    extra: Attribute[] = [],
  ): string | undefined {
    if (!enabled || closed) return undefined;
    if (
      (event !== "analytics.sample" && !events.includes(event)) ||
      !["info", "warn", "error"].includes(level)
    ) {
      rejected++;
      return undefined;
    }
    if (queue.length >= 512) {
      dropped++;
      return undefined;
    }
    try {
      const attributes: Attribute[] = [...extra];
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
        if (finiteScalar(value))
          attributes.push({ key, value: { doubleValue: value } });
      }
      const resumed = fields.resumed;
      if (typeof resumed === "boolean")
        attributes.push({
          key: "resumed",
          value: { boolValue: resumed },
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

  function emit(
    event: RuntimeLogEvent,
    fields: RuntimeLogFields = {},
    level: "info" | "warn" | "error" = "info",
  ) {
    // Analytics must go through metric's stricter provenance schema, never the generic hook.
    if (!events.includes(event)) {
      if (enabled && !closed) rejected++;
      return undefined;
    }
    return enqueue(event, fields, level);
  }

  function metric(sample: RuntimeMetricSample): string | undefined {
    if (!enabled || closed) return undefined;
    try {
      const attrs: Attribute[] = [];
      const labels = {
        role: ["interaction", "worker", "slack", "runtime"],
        operation: [
          "submit",
          "wait",
          "result",
          "history",
          "cancel",
          "compact",
          "sleep",
          "Task",
          "observe",
          "unknown",
        ],
        outcome: [
          "ok",
          "error",
          "aborted",
          "unknown",
          "accepted",
          "duplicate",
          "ignored",
          "uncertain",
          "rate_limited",
        ],
        model: [
          "openai-codex/gpt-6.1-terra",
          "openai-codex/gpt-6.1-sol",
          "unknown",
        ],
        provider: ["openai-codex", "unknown"],
        sdk: ["pi-ai@1.5.0"],
      } as const;
      for (const key of [
        "role",
        "operation",
        "outcome",
        "model",
        "provider",
        "sdk",
      ] as const) {
        const value = sample[key];
        if (!(labels[key] as readonly string[]).includes(value)) {
          rejected++;
          return undefined;
        }
        attrs.push({ key: `analytics.${key}`, value: { stringValue: value } });
      }
      const knownModel =
        sample.model !== "unknown" && sample.provider === "openai-codex";
      if ((sample.model === "unknown") !== (sample.provider === "unknown")) {
        rejected++;
        return undefined;
      }
      const rate = sample.rate;
      const validRate =
        rate?.version === "pi-ai@1.5.0/runtime-model" &&
        rate.currency === "USD" &&
        [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every(
          finiteScalar,
        ) &&
        (rate.cacheWrite1h === undefined || finiteScalar(rate.cacheWrite1h)) &&
        (rate.inputTokensAbove === undefined ||
          finiteScalar(rate.inputTokensAbove));
      let measurements = 0;
      for (const key of metricNames) {
        const value = sample.measurements[key];
        if (!finiteScalar(value)) continue;
        if (
          key === "model.cost.reported" &&
          (!knownModel || sample.reportedFromProvider !== true)
        )
          continue;
        if (key === "model.cost.estimated" && (!knownModel || !validRate))
          continue;
        attrs.push({ key: `analytics.${key}`, value: { doubleValue: value } });
        measurements++;
        if (key === "model.cost.reported") {
          attrs.push({
            key: "analytics.cost.reported.basis",
            value: { stringValue: "sdk-provider-reported-not-invoice" },
          });
        }
        if (key === "model.cost.estimated" && rate && validRate) {
          attrs.push({
            key: "analytics.cost.estimated.basis",
            value: {
              stringValue:
                "base-catalog-estimate-excludes-tier-account-adjustments",
            },
          });
          attrs.push({
            key: "analytics.rate.version",
            value: { stringValue: "pi-ai@1.5.0/runtime-model" },
          });
          for (const rateKey of [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "cacheWrite1h",
            "inputTokensAbove",
          ] as const) {
            const price = rate[rateKey];
            if (finiteScalar(price))
              attrs.push({
                key: `analytics.rate.${rateKey}`,
                value: { doubleValue: price },
              });
          }
        }
      }
      if (!measurements) {
        rejected++;
        return undefined;
      }
      if (
        attrs.some(
          (attr) =>
            attr.key === "analytics.model.cost.reported" ||
            attr.key === "analytics.model.cost.estimated",
        )
      )
        attrs.push({
          key: "analytics.currency",
          value: { stringValue: "USD" },
        });
      return enqueue("analytics.sample", {}, "info", attrs);
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
                      value: { stringValue: `computah-${service}` },
                    },
                    ...(revision && /^[a-f0-9]{40}$/.test(revision)
                      ? [
                          {
                            key: "service.version",
                            value: { stringValue: revision },
                          },
                        ]
                      : []),
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
    metric,
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

/** Emit one safe scalar observation only after local deduplication and commit. */
export function runtimeMetric(sample: RuntimeMetricSample) {
  return runtime?.metric(sample);
}
