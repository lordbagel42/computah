import type { HrTime } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  AggregationType,
  createAllowListAttributesProcessor,
  DataPointType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { currentTraceHeaders, traceOperation } from "./index.js";
import { runtimeLog } from "./logs.js";

export const replyMetricOutcomes = [
  "success",
  "error",
  "cancel",
  "uncertain",
] as const;
export type ReplyMetricOutcome = (typeof replyMetricOutcomes)[number];
export type ReplyMetricSnapshot = {
  pending: number;
  startedAtMs: number;
  outcomes: Record<ReplyMetricOutcome, number>;
};
// Equal-width explicit buckets: Axiom does not support exponential histograms.
// Include the 5s deadline and the full five-minute adapter wait; overflow is +Inf.
export const replyLatencyBounds = Array.from(
  { length: 60 },
  (_, i) => (i + 1) * 5000,
);
const names = {
  latency: "computah.slack.reply.latency",
  pending: "computah.slack.reply.pending",
  outcomes: "computah.slack.reply.outcomes",
} as const;
const scalar = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER;
const nano = (t: HrTime) =>
  (BigInt(t[0]) * 1_000_000_000n + BigInt(t[1])).toString();

/** The metrics equivalent of sanitizeTraces: reconstruct, never forward SDK
 * attributes/resources/scopes/exemplars. Even foreign instruments cannot escape.
 */
export function sanitizeMetrics(input: ResourceMetrics, startedAtMs?: number) {
  const metrics: Record<string, unknown>[] = [];
  for (const scope of input.scopeMetrics.slice(0, 8)) {
    for (const metric of scope.metrics.slice(0, 16)) {
      const name = metric.descriptor.name;
      const points: Record<string, unknown>[] = [];
      for (const point of metric.dataPoints.slice(0, 4)) {
        if (point.attributes["otel.metric.overflow"] === true) continue;
        const timing = {
          startTimeUnixNano: nano(point.startTime),
          timeUnixNano: nano(point.endTime),
          attributes: [] as { key: string; value: { stringValue: string } }[],
        };
        if (
          name === names.latency &&
          metric.dataPointType === DataPointType.HISTOGRAM &&
          metric.aggregationTemporality === AggregationTemporality.DELTA
        ) {
          const value = point.value;
          if (
            typeof value !== "object" ||
            !("buckets" in value) ||
            !scalar(value.count) ||
            !scalar(value.sum) ||
            !scalar(value.min) ||
            !scalar(value.max) ||
            value.buckets.boundaries.length !== replyLatencyBounds.length ||
            !value.buckets.boundaries.every(
              (v, i) => v === replyLatencyBounds[i],
            ) ||
            value.buckets.counts.length !== replyLatencyBounds.length + 1 ||
            !value.buckets.counts.every(scalar)
          )
            continue;
          points.push({
            ...timing,
            count: String(value.count),
            sum: value.sum,
            min: value.min,
            max: value.max,
            explicitBounds: replyLatencyBounds,
            bucketCounts: value.buckets.counts.map(String),
          });
        } else if (
          name === names.pending &&
          metric.dataPointType === DataPointType.GAUGE &&
          scalar(point.value) &&
          scalar(startedAtMs)
        ) {
          points.push({ ...timing, asDouble: point.value });
        } else if (
          name === names.outcomes &&
          metric.dataPointType === DataPointType.SUM &&
          metric.isMonotonic &&
          scalar(point.value) &&
          scalar(startedAtMs)
        ) {
          const outcome = replyMetricOutcomes.find(
            (v) => v === point.attributes.outcome,
          );
          if (!outcome) continue;
          points.push({
            ...timing,
            startTimeUnixNano: (
              BigInt(Math.floor(startedAtMs)) * 1_000_000n
            ).toString(),
            asDouble: point.value,
            attributes: [{ key: "outcome", value: { stringValue: outcome } }],
          });
        }
      }
      if (!points.length) continue;
      if (name === names.latency)
        metrics.push({
          name,
          unit: "ms",
          histogram: { dataPoints: points, aggregationTemporality: 1 },
        });
      else if (name === names.pending)
        metrics.push({ name, unit: "{reply}", gauge: { dataPoints: points } });
      else if (name === names.outcomes)
        metrics.push({
          name,
          unit: "{reply}",
          sum: {
            dataPoints: points,
            aggregationTemporality: 2,
            isMonotonic: true,
          },
        });
    }
  }
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "computah-slack" } },
          ],
        },
        scopeMetrics: [{ scope: { name: "computah.reply" }, metrics }],
      },
    ],
  };
}

/** One bounded request, no retry/backlog, no ambient OTLP configuration. */
class AxiomMetricExporter implements PushMetricExporter {
  private pending?: Promise<void>;
  private closed = false;
  constructor(
    private token: string,
    private dataset: string,
    private epoch: () => number | undefined,
    private collection: () => Record<string, string>,
  ) {}
  selectAggregationTemporality(instrument: InstrumentType) {
    // Delta keeps the first real reply queryable without a fabricated baseline.
    return instrument === InstrumentType.HISTOGRAM
      ? AggregationTemporality.DELTA
      : AggregationTemporality.CUMULATIVE;
  }
  export(
    data: ResourceMetrics,
    done: Parameters<PushMetricExporter["export"]>[1],
  ) {
    if (this.closed || this.pending) {
      if (this.pending)
        runtimeLog(
          "runtime.report",
          { operation: "export", outcome: "error", reason: "capacity" },
          "warn",
        );
      done({ code: 1 });
      return;
    }
    const work = traceOperation(
      "metrics.export",
      async (span) => {
        try {
          const body = JSON.stringify(sanitizeMetrics(data, this.epoch()));
          if (Buffer.byteLength(body) > 128 * 1024)
            throw new Error("Metric capacity");
          const response = await fetch(
            "https://us-east-1.aws.edge.axiom.co/v1/metrics",
            {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(5000),
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${this.token}`,
                "x-axiom-metrics-dataset": this.dataset,
              },
              body,
            },
          );
          // Bounded response read, including OTLP partial rejection (HTTP 200 alone
          // is not ingestion success). Never log provider response text.
          let size = 0;
          const chunks: Uint8Array[] = [];
          if (response.body)
            for await (const chunk of response.body) {
              size += chunk.length;
              if (size > 8192) throw new Error("Metric response capacity");
              chunks.push(chunk);
            }
          const result = JSON.parse(
            Buffer.concat(chunks).toString() || "{}",
          ) as {
            partialSuccess?: {
              rejectedDataPoints?: string | number;
              errorMessage?: string;
            };
            partial_success?: {
              rejected_data_points?: string | number;
              error_message?: string;
            };
          };
          if (
            !response.ok ||
            Number(
              result.partialSuccess?.rejectedDataPoints ??
                result.partial_success?.rejected_data_points ??
                0,
            ) !== 0 ||
            result.partialSuccess?.errorMessage ||
            result.partial_success?.error_message
          )
            throw new Error("Metric export rejected");
          done({ code: 0 });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError")
            span.setAttribute("outcome", "cancelled");
          if (error instanceof Error && error.name === "TimeoutError")
            span.setAttribute("outcome", "timeout");
          done({ code: 1 });
          throw new Error("Metric export failed");
        }
      },
      {},
      [this.collection()],
    );
    this.pending = work
      .catch(() => {})
      .finally(() => {
        this.pending = undefined;
      });
  }
  async forceFlush() {
    await this.pending;
  }
  async shutdown() {
    this.closed = true;
    await this.forceFlush();
  }
}

let source: (() => ReplyMetricSnapshot) | undefined;
let record: ((ms: number) => void) | undefined;
/** A single private durable journal owns the process's reply census. */
export function registerReplyMetrics(read: () => ReplyMetricSnapshot) {
  if (!record) return () => {};
  if (source) throw new Error("Reply metrics source already registered");
  source = read;
  return () => {
    if (source === read) source = undefined;
  };
}
export function runtimeReplyDuration(ms: number) {
  if (!record || !scalar(ms)) return false;
  record(ms);
  return true;
}

export function startRuntimeMetrics(service: string) {
  const token = process.env.COMPUTAH_AXIOM_INGEST_TOKEN;
  const dataset = process.env.COMPUTAH_AXIOM_METRIC_DATASET;
  if (service !== "slack" || !token || dataset !== "computah-prod-metrics")
    return { close: async () => {} };
  let epoch: number | undefined;
  let collection: Record<string, string> = {};
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ "service.name": "computah-slack" }),
    views: [
      {
        instrumentName: names.latency,
        attributesProcessors: [createAllowListAttributesProcessor([])],
        // SDK reserves one cardinality slot for its overflow series.
        aggregationCardinalityLimit: 2,
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          // Axiom quantile interpolation requires min, max AND sum.
          options: { boundaries: replyLatencyBounds, recordMinMax: true },
        },
      },
      {
        instrumentName: names.pending,
        attributesProcessors: [createAllowListAttributesProcessor([])],
        aggregationCardinalityLimit: 2,
      },
      {
        instrumentName: names.outcomes,
        attributesProcessors: [createAllowListAttributesProcessor(["outcome"])],
        aggregationCardinalityLimit: 5,
      },
    ],
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new AxiomMetricExporter(
          token,
          dataset,
          () => epoch,
          () => collection,
        ),
        exportIntervalMillis: 10000,
        exportTimeoutMillis: 7000,
      }),
    ],
  });
  const meter = provider.getMeter("computah.reply");
  const duration = meter.createHistogram(names.latency, { unit: "ms" });
  record = (ms) => duration.record(ms);
  const pending = meter.createObservableGauge(names.pending, {
    unit: "{reply}",
  });
  const outcomes = meter.createObservableCounter(names.outcomes, {
    unit: "{reply}",
  });
  meter.addBatchObservableCallback(
    async (observer) => {
      // SDK observable storage can retain previous values after callback failure.
      // Only a successful CURRENT census authorizes exporting gauge/counter data.
      epoch = undefined;
      collection = {};
      if (!source) return; // Unknown/unavailable is not an invented zero.
      await traceOperation("metrics.collect", async () => {
        collection = currentTraceHeaders();
        const snapshot = source?.();
        if (!snapshot) return;
        epoch = snapshot.startedAtMs;
        observer.observe(pending, snapshot.pending);
        for (const outcome of replyMetricOutcomes)
          observer.observe(outcomes, snapshot.outcomes[outcome], { outcome });
      });
    },
    [pending, outcomes],
  );
  return {
    close: async () => {
      record = undefined;
      await provider.shutdown().catch(() => {
        runtimeLog(
          "operation.completed",
          { operation: "export", outcome: "error" },
          "warn",
        );
      });
    },
  };
}
