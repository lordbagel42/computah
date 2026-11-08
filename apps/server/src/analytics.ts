import { createHmac, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RuntimeMetricSample } from "@computah/observability";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Models,
  Usage,
} from "@earendil-works/pi-ai";
import type { Harness, UsageState } from "@earendil-works/pi-durable";
import type {
  StoredSpan,
  TelemetryMetrics,
} from "@earendil-works/pi-telemetry";

/** Fixed vocabulary: neither content nor caller-controlled names become labels. */
export const ANALYTICS_METRICS = {
  "model.requests": "{request}",
  "model.duration": "ms",
  "model.first_output": "ms",
  "model.tokens.input": "{token}",
  "model.tokens.output": "{token}",
  "model.tokens.cache_read": "{token}",
  "model.tokens.cache_write": "{token}",
  "model.tokens.cache_write_1h": "{token}",
  "model.tokens.reasoning": "{token}",
  "model.tokens.total": "{token}",
  "model.cost.reported": "USD",
  "model.cost.estimated": "USD",
  "model.usage_missing": "{request}",
  "model.length_limited": "{request}",
  "task.duration": "ms",
  "task.queue_wait": "ms",
  "task.active": "{task}",
  "task.queued": "{task}",
  "worker.duration": "ms",
  "tool.duration": "ms",
  "operation.duration": "ms",
  "operation.retries": "{attempt}",
  "operation.cancellations": "{request}",
  "slack.admissions": "{event}",
  "slack.delivery": "{attempt}",
  "slack.delivery_duration": "ms",
  "slack.rate_limits": "{response}",
  "slack.retry_after": "ms",
  "slack.queue_age": "ms",
  "memory.compactions": "{attempt}",
  "memory.compaction_duration": "ms",
  "memory.context_tokens": "{token}",
  "runtime.wakes": "{activation}",
  "runtime.reports": "{report}",
  "runtime.phase_duration": "ms",
  "runtime.replays": "{replay}",
  "runtime.resumed_phases": "{phase}",
  "runtime.restart_streak": "{restart}",
} as const;

type Metric = keyof typeof ANALYTICS_METRICS;
export type AnalyticsOutcome =
  | "ok"
  | "error"
  | "aborted"
  | "unknown"
  | "accepted"
  | "duplicate"
  | "ignored"
  | "uncertain"
  | "rate_limited";

export interface AnalyticsDimensions {
  role?: "interaction" | "worker" | "slack" | "runtime";
  operation?:
    | "submit"
    | "wait"
    | "result"
    | "history"
    | "cancel"
    | "compact"
    | "sleep"
    | "Task"
    | "observe";
  /** Must be a member of the operator-configured provider/model allowlist. */
  model?: string;
  outcome?: AnalyticsOutcome;
}

/** Operator-only receipt correlation, never a metric dimension or grouping key. */
export interface AnalyticsCorrelation {
  principal?: readonly [tenant: string, user: string, agent: string];
  task?: string;
}

export interface RateCard {
  /** Operator supplied, immutable identifier, e.g. pi-ai-1.5.0/catalog-date. */
  version: string;
  currency: "USD";
  /** Prices per million tokens, not per token. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  /** Selected long-context tier, if any; strict greater-than threshold. */
  inputTokensAbove?: number;
}

export interface AnalyticsOptions {
  path: string;
  /** Stable private HMAC key; rotation deliberately breaks historical correlation. */
  secret: string;
  models: readonly string[];
  /** Optional existing backend; this module never creates an exporter. */
  metrics?: TelemetryMetrics;
  /** Existing sanitized operational sink. No IDs/correlation or cumulative snapshots. */
  onObservation?: (observation: RuntimeMetricSample) => void;
  now?: () => number;
}

const HOUR = 3_600_000;
const RETENTION = 7 * 24 * HOUR;
const MAX_EVENTS = 50_000;
const MAX_SERIES = 10_000;
const MAX_LEDGERS = 5000;
const outcomes = new Set<AnalyticsOutcome>([
  "ok",
  "error",
  "aborted",
  "unknown",
  "accepted",
  "duplicate",
  "ignored",
  "uncertain",
  "rate_limited",
]);
const finite = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
// SDK-initialized zero usage is indistinguishable from missing provider usage.
const hasUsage = (usage: Usage) =>
  usage.cost.totalFromProvider === true ||
  [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.reasoning ?? 0,
    usage.cacheWrite1h ?? 0,
  ].some((value) => finite(value) && value > 0);
const validRate = (rate: RateCard | undefined): rate is RateCard =>
  !!rate &&
  /^[a-zA-Z0-9@./:_-]{1,100}$/.test(rate.version) &&
  rate.currency === "USD" &&
  [rate.input, rate.output, rate.cacheRead, rate.cacheWrite].every(finite) &&
  (rate.cacheWrite1h === undefined || finite(rate.cacheWrite1h)) &&
  (rate.inputTokensAbove === undefined || finite(rate.inputTokensAbove));

/**
 * Private single-writer projection, not a tracing backend or a billing ledger.
 * Accepts scalar measurements only. Retries have distinct attempt IDs; a replay
 * of the same observation ID is ignored in the same transaction as its rollup.
 */
export class OperationalAnalytics {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly models: Set<string>;
  private readonly counters = new Map<
    string,
    ReturnType<TelemetryMetrics["counter"]>
  >();
  private readonly histograms = new Map<
    string,
    ReturnType<TelemetryMetrics["histogram"]>
  >();

  constructor(private readonly options: AnalyticsOptions) {
    if (Buffer.byteLength(options.secret) < 32 || options.models.length > 100)
      throw new Error("Invalid analytics configuration");
    this.now = options.now ?? Date.now;
    this.models = new Set(options.models);
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS analytics_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_rollups (
        hour INTEGER NOT NULL, metric TEXT NOT NULL, dimensions TEXT NOT NULL,
        count INTEGER NOT NULL, sum REAL NOT NULL, min REAL NOT NULL, max REAL NOT NULL,
        PRIMARY KEY(hour, metric, dimensions));
      CREATE TABLE IF NOT EXISTS analytics_ledgers (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, dimensions TEXT NOT NULL, usage TEXT NOT NULL, correlation TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS analytics_events_at ON analytics_events(at);
      CREATE INDEX IF NOT EXISTS analytics_ledgers_at ON analytics_ledgers(at);
      CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO analytics_meta VALUES ('dropped',0),('export_failures',0);`);
    this.prune();
  }

  private hash(value: unknown) {
    return createHmac("sha256", this.options.secret)
      .update("computah.analytics.v1\0")
      .update(JSON.stringify(value))
      .digest("hex")
      .slice(0, 32);
  }

  private dimensions(input: AnalyticsDimensions) {
    return {
      role: ["interaction", "worker", "slack", "runtime"].includes(
        input.role ?? "",
      )
        ? input.role
        : "runtime",
      model:
        input.model && this.models.has(input.model) ? input.model : "unknown",
      provider:
        input.model && this.models.has(input.model)
          ? input.model.split("/")[0]
          : "unknown",
      outcome:
        input.outcome && outcomes.has(input.outcome)
          ? input.outcome
          : "unknown",
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
      ].includes(input.operation ?? "")
        ? input.operation
        : "unknown",
    };
  }

  private correlation(input?: AnalyticsCorrelation) {
    return input
      ? {
          ...(input.principal ? { principal: this.hash(input.principal) } : {}),
          ...(input.task ? { task: this.hash(input.task) } : {}),
        }
      : null;
  }

  private metadata(input?: {
    correlation?: AnalyticsCorrelation;
    rate?: RateCard;
  }) {
    return {
      correlation: this.correlation(input?.correlation),
      ...(validRate(input?.rate)
        ? {
            rate: {
              version: input.rate.version,
              currency: input.rate.currency,
              input: input.rate.input,
              output: input.rate.output,
              cacheRead: input.rate.cacheRead,
              cacheWrite: input.rate.cacheWrite,
              ...(input.rate.cacheWrite1h === undefined
                ? {}
                : { cacheWrite1h: input.rate.cacheWrite1h }),
              ...(input.rate.inputTokensAbove === undefined
                ? {}
                : { inputTokensAbove: input.rate.inputTokensAbove }),
            },
          }
        : {}),
    };
  }

  private increment(key: "dropped" | "export_failures") {
    this.db
      .prepare("UPDATE analytics_meta SET value=value+1 WHERE key=?")
      .run(key);
  }

  private prune() {
    const before = this.now() - RETENTION;
    this.db.prepare("DELETE FROM analytics_events WHERE at < ?").run(before);
    // Retain the entire boundary hour, never expose a partial hour as complete.
    this.db
      .prepare("DELETE FROM analytics_rollups WHERE hour < ?")
      .run(Math.floor(before / HOUR) * HOUR);
    this.db.prepare("DELETE FROM analytics_ledgers WHERE at < ?").run(before);
  }

  record(
    id: string,
    dimensions: AnalyticsDimensions,
    values: Partial<Record<Metric, number>>,
    receipt?: {
      correlation?: AnalyticsCorrelation;
      rate?: RateCard;
      reportedFromProvider?: true;
    },
  ): boolean {
    this.prune();
    const at = this.now();
    const hour = Math.floor(at / HOUR) * HOUR;
    const key = this.hash(id);
    const labels = this.dimensions(dimensions);
    const serialized = JSON.stringify(labels);
    const measurements = Object.entries(values).filter(
      (pair): pair is [Metric, number] =>
        Object.hasOwn(ANALYTICS_METRICS, pair[0]) && finite(pair[1]),
    );
    if (!measurements.length) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db.prepare("SELECT 1 FROM analytics_events WHERE id=?").get(key)
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      const count = (table: string) =>
        (
          this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n;
      const newSeries = measurements.filter(
        ([metric]) =>
          !this.db
            .prepare(
              "SELECT 1 FROM analytics_rollups WHERE hour=? AND metric=? AND dimensions=?",
            )
            .get(hour, metric, serialized),
      ).length;
      if (
        count("analytics_events") >= MAX_EVENTS ||
        count("analytics_rollups") + newSeries > MAX_SERIES
      ) {
        this.increment("dropped");
        this.db.exec("COMMIT");
        return false;
      }
      this.db.prepare("INSERT INTO analytics_events VALUES (?,?,?)").run(
        key,
        at,
        JSON.stringify({
          dimensions: labels,
          values: Object.fromEntries(measurements),
          metadata: this.metadata(receipt),
        }),
      );
      const insert =
        this.db.prepare(`INSERT INTO analytics_rollups VALUES (?,?,?,1,?,?,?)
        ON CONFLICT(hour,metric,dimensions) DO UPDATE SET
        count=count+1, sum=sum+excluded.sum, min=min(min,excluded.min), max=max(max,excluded.max)`);
      for (const [metric, value] of measurements)
        insert.run(hour, metric, serialized, value, value, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    try {
      // The local catalog may include explicitly configured synthetic/custom
      // models. The shared remote schema has a stricter closed production catalog.
      const model =
        labels.model === "openai-codex/gpt-6.1-terra" ||
        labels.model === "openai-codex/gpt-6.1-sol"
          ? labels.model
          : "unknown";
      this.options.onObservation?.({
        measurements: Object.fromEntries(measurements),
        role: labels.role as RuntimeMetricSample["role"],
        operation: labels.operation as RuntimeMetricSample["operation"],
        outcome: labels.outcome as RuntimeMetricSample["outcome"],
        model,
        provider: model === "unknown" ? "unknown" : "openai-codex",
        sdk: "pi-ai@1.5.0",
        ...(receipt?.reportedFromProvider
          ? { reportedFromProvider: true }
          : {}),
        ...(validRate(receipt?.rate) &&
        receipt.rate.version === "pi-ai@1.5.0/runtime-model"
          ? {
              rate: {
                version: "pi-ai@1.5.0/runtime-model",
                currency: "USD",
                input: receipt.rate.input,
                output: receipt.rate.output,
                cacheRead: receipt.rate.cacheRead,
                cacheWrite: receipt.rate.cacheWrite,
                ...(receipt.rate.cacheWrite1h === undefined
                  ? {}
                  : { cacheWrite1h: receipt.rate.cacheWrite1h }),
                ...(receipt.rate.inputTokensAbove === undefined
                  ? {}
                  : { inputTokensAbove: receipt.rate.inputTokensAbove }),
              },
            }
          : {}),
      });
    } catch {
      this.increment("export_failures");
    }
    // Local commit and remote delivery are deliberately not claimed atomic.
    // Never export principal/task IDs, including their pseudonyms.
    for (const [metric, value] of measurements) {
      try {
        const attributes = {
          role: labels.role,
          model: labels.model,
          provider: labels.provider,
          outcome: labels.outcome,
          operation: labels.operation,
        };
        if (
          ANALYTICS_METRICS[metric] === "ms" ||
          metric.endsWith(".active") ||
          metric.endsWith(".queued") ||
          metric === "memory.context_tokens" ||
          metric === "runtime.restart_streak"
        ) {
          let instrument = this.histograms.get(metric);
          if (!instrument && this.options.metrics) {
            instrument = this.options.metrics.histogram(`computah.${metric}`, {
              unit: ANALYTICS_METRICS[metric],
            });
            this.histograms.set(metric, instrument);
          }
          instrument?.record(value, attributes);
        } else {
          let instrument = this.counters.get(metric);
          if (!instrument && this.options.metrics) {
            instrument = this.options.metrics.counter(`computah.${metric}`, {
              unit: ANALYTICS_METRICS[metric],
            });
            this.counters.set(metric, instrument);
          }
          instrument?.add(value, attributes);
        }
      } catch {
        this.increment("export_failures");
      }
    }
    return true;
  }

  /** Each actual provider attempt gets its own ID, including failed attempts. */
  modelAttempt(
    id: string,
    dimensions: AnalyticsDimensions,
    observation: {
      durationMs: number;
      firstOutputMs?: number;
      /** Undefined means unavailable, not zero. Pending/deferred polls have no usage. */
      usage?: Usage;
      rate?: RateCard;
    },
    correlation?: AnalyticsCorrelation,
  ) {
    const { usage, rate } = observation;
    const values: Partial<Record<Metric, number>> = {
      "model.requests": 1,
      "model.duration": observation.durationMs,
      ...(observation.firstOutputMs === undefined
        ? {}
        : { "model.first_output": observation.firstOutputMs }),
    };
    if (!usage || !hasUsage(usage)) values["model.usage_missing"] = 1;
    else {
      Object.assign(values, {
        "model.tokens.input": usage.input,
        "model.tokens.output": usage.output,
        "model.tokens.cache_read": usage.cacheRead,
        "model.tokens.cache_write": usage.cacheWrite,
        "model.tokens.cache_write_1h": usage.cacheWrite1h,
        "model.tokens.reasoning": usage.reasoning,
        "model.tokens.total": usage.totalTokens,
      });
      if (usage.cost.totalFromProvider === true)
        values["model.cost.reported"] = usage.cost.total;
      else if (
        validRate(rate) &&
        (usage.cacheWrite1h ?? 0) <= usage.cacheWrite &&
        (!(usage.cacheWrite1h ?? 0) || rate.cacheWrite1h !== undefined)
      )
        values["model.cost.estimated"] =
          (usage.input * rate.input +
            usage.output * rate.output +
            usage.cacheRead * rate.cacheRead +
            (usage.cacheWrite - (usage.cacheWrite1h ?? 0)) * rate.cacheWrite +
            (usage.cacheWrite1h ?? 0) * (rate.cacheWrite1h ?? 0)) /
          1_000_000;
    }
    // Monetary sums may combine rate cards in one currency. Rates remain
    // receipt metadata, never per-rate metric labels or grouping keys.
    return this.record(id, dimensions, values, {
      rate,
      correlation,
      ...(usage?.cost.totalFromProvider === true
        ? { reportedFromProvider: true }
        : {}),
    });
  }

  /** Replace a cumulative Pi ledger, never add it again on refresh/recovery. */
  replaceUsage(
    actor: string,
    dimensions: AnalyticsDimensions,
    state: UsageState,
    observedAt = this.now(),
    correlation?: AnalyticsCorrelation,
  ) {
    this.prune();
    const id = this.hash(actor);
    if (
      !this.db.prepare("SELECT 1 FROM analytics_ledgers WHERE id=?").get(id) &&
      (
        this.db
          .prepare("SELECT count(*) AS n FROM analytics_ledgers")
          .get() as { n: number }
      ).n >= MAX_LEDGERS
    ) {
      this.increment("dropped");
      return false;
    }
    // Copy only finite scalar usage; no tool names, histories or unbounded model keys.
    const usage = Object.entries(state.models)
      .filter(([model]) => this.models.has(model))
      .map(([model, value]) => {
        const known = hasUsage(value);
        return {
          model,
          input: known && finite(value.input) ? value.input : null,
          output: known && finite(value.output) ? value.output : null,
          cacheRead: known && finite(value.cacheRead) ? value.cacheRead : null,
          cacheWrite:
            known && finite(value.cacheWrite) ? value.cacheWrite : null,
          cacheWrite1h:
            known && finite(value.cacheWrite1h) ? value.cacheWrite1h : null,
          reasoning: known && finite(value.reasoning) ? value.reasoning : null,
          totalTokens:
            known && finite(value.totalTokens) ? value.totalTokens : null,
          cost: {
            amount: known && finite(value.cost.total) ? value.cost.total : null,
            currency: "USD",
            basis: "sdk-cumulative-mixed-or-estimated",
            rateVersion: "pi-ai@1.5.0; per-request rate unavailable",
          },
        };
      });
    this.db
      .prepare(`INSERT INTO analytics_ledgers VALUES (?,?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET at=excluded.at, dimensions=excluded.dimensions, usage=excluded.usage, correlation=excluded.correlation WHERE excluded.at >= at`)
      .run(
        id,
        observedAt,
        JSON.stringify(this.dimensions(dimensions)),
        JSON.stringify(usage),
        JSON.stringify(this.correlation(correlation)),
      );
    return true;
  }

  /** Read only native metadata/usage, never transcript or context content. */
  async captureHarness(
    actor: string,
    dimensions: AnalyticsDimensions,
    harness: Harness,
    correlation?: AnalyticsCorrelation,
  ) {
    const observedAt = this.now();
    try {
      const usage = await harness.usage(BACKGROUND_CONTEXT);
      this.replaceUsage(actor, dimensions, usage, observedAt, correlation);
      const inspection = await harness.inspect(BACKGROUND_CONTEXT);
      const active = inspection.tasks.filter(
        (task) => task.state.kind === "running",
      ).length;
      const queued = inspection.submissions.filter(
        (submission) => submission.status === "queued",
      ).length;
      this.record(
        `sample:${actor}:${Math.floor(observedAt / 60_000)}:${active}:${queued}`,
        dimensions,
        {
          "task.active": active,
          "task.queued": queued,
        },
        { correlation },
      );
    } catch {
      // Collection cannot fail a native task. The projection remains stale/unknown.
      try {
        this.increment("dropped");
      } catch {
        /* Store may be unavailable. */
      }
    }
  }

  /** Serialized committed metadata only; folded short-lived tasks can be missed. */
  async watchHarness(
    actor: string,
    dimensions: AnalyticsDimensions,
    harness: Harness,
    correlation?: AnalyticsCorrelation,
  ) {
    const watch = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
    let previous = watch.value;
    let pending = Promise.resolve();
    try {
      this.record(`wake:${actor}:${randomUUID()}`, dimensions, {
        "runtime.wakes": 1,
      });
    } catch {
      /* Recovery cannot depend on a projection. */
    }
    await this.captureHarness(actor, dimensions, harness, correlation);
    watch.start(async (call) => {
      pending = (async () => {
        try {
          if (call.kind !== "value") {
            this.increment("dropped");
            return;
          }
          const removed = Object.values(previous.tasks).filter(
            (task) => !call.value.tasks[String(task.id)],
          );
          previous = call.value;
          for (const removedTask of removed) {
            const task = await harness.getTask(
              removedTask.id,
              BACKGROUND_CONTEXT,
            );
            if (task?.state.status !== "terminal") continue;
            this.settledTask(
              actor,
              dimensions,
              {
                id: task.id,
                startedAt: task.startedAt,
                endedAt: task.endedAt,
                restarts: task.restarts,
                outcome:
                  task.state.outcome.status === "completed"
                    ? "ok"
                    : task.state.outcome.status === "aborted"
                      ? "aborted"
                      : task.state.outcome.status === "faulted"
                        ? "error"
                        : "unknown",
              },
              correlation,
            );
          }
          // Task graph publishes committed changes, unlike precommit answer hooks.
          await this.captureHarness(actor, dimensions, harness, correlation);
        } catch {
          try {
            this.increment("dropped");
          } catch {
            /* Fail open, including shutdown. */
          }
        }
      })();
      await pending;
    });
    return {
      closed: watch.closed,
      stop: async () => {
        await watch.stop();
        await pending;
      },
    };
  }

  /** Scalar durable receipts; callers must not pass task inputs/checkpoints/results. */
  settledTask(
    actor: string,
    dimensions: AnalyticsDimensions,
    task: {
      id: number;
      startedAt?: number;
      endedAt?: number;
      restarts?: number;
      outcome: AnalyticsOutcome;
    },
    correlation?: AnalyticsCorrelation,
  ) {
    if (
      task.startedAt === undefined ||
      task.endedAt === undefined ||
      task.endedAt < task.startedAt
    )
      return false;
    return this.record(
      `task:${actor}:${task.id}:${task.endedAt}`,
      { ...dimensions, outcome: task.outcome },
      {
        "task.duration": task.endedAt - task.startedAt,
        ...(task.restarts === undefined
          ? {}
          : { "runtime.restart_streak": task.restarts }),
      },
      { correlation: { ...correlation, task: `${actor}:${task.id}` } },
    );
  }

  /**
   * Optional existing backend hook. Only durable Pi spans are consumed; model
   * spans are deliberately ignored to avoid counting observeModels twice.
   * Span attributes/errors/events are never persisted or exported wholesale.
   */
  consumeSpan(span: StoredSpan, dimensions: AnalyticsDimensions = {}) {
    if (span.name !== "pi.durable.phase" && span.name !== "pi.durable.submit")
      return false;
    const aborted = span.attributes.outcome === "aborted";
    const outcome = aborted
      ? "aborted"
      : span.status.status === "error"
        ? "error"
        : "ok";
    const values: Partial<Record<Metric, number>> = {
      ...(span.name === "pi.durable.phase"
        ? {
            "runtime.phase_duration": span.endedMs - span.startedMs,
            "runtime.resumed_phases": span.attributes.resumed === true ? 1 : 0,
          }
        : {}),
      "runtime.replays": span.events.filter(
        (event) => event.name === "pi.durable.replay",
      ).length,
      "runtime.reports": span.events.filter(
        (event) => event.name === "pi.durable.report",
      ).length,
    };
    return this.record(
      `span:${span.traceId}:${span.id}`,
      { ...dimensions, outcome },
      values,
    );
  }

  /** Times one actual invocation, not a logical admission or a durable task. */
  async measure<T>(
    dimensions: AnalyticsDimensions,
    body: () => Promise<T>,
    correlation?: AnalyticsCorrelation,
  ): Promise<T> {
    const start = performance.now();
    let outcome: AnalyticsOutcome = "ok";
    try {
      return await body();
    } catch (error) {
      outcome =
        error instanceof Error && error.name === "AbortError"
          ? "aborted"
          : "error";
      throw error;
    } finally {
      try {
        this.record(
          `operation:${randomUUID()}`,
          { ...dimensions, outcome },
          {
            "operation.duration": performance.now() - start,
            ...(dimensions.operation === "Task"
              ? { "tool.duration": performance.now() - start }
              : {}),
            ...(dimensions.operation === "compact"
              ? {
                  "memory.compaction_duration": performance.now() - start,
                  "memory.compactions": 1,
                }
              : {}),
            ...(dimensions.operation === "cancel"
              ? { "operation.cancellations": 1 }
              : {}),
          },
          { correlation },
        );
      } catch {
        /* Observability cannot change operation success or cancellation. */
      }
    }
  }

  /** Separate bounded operator evidence; not included in generic metric rows. */
  receipts(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new Error("Invalid receipt limit");
    this.prune();
    const rows = this.db
      .prepare(
        "SELECT id,at,details FROM analytics_events ORDER BY at DESC,id LIMIT ?",
      )
      .all(limit) as unknown as { id: string; at: number; details: string }[];
    return rows.map(({ details, ...row }) => ({
      ...row,
      ...JSON.parse(details),
    }));
  }

  /** Operator-only; authentication/authorization belong to the caller. */
  snapshot() {
    this.prune();
    const rows = this.db
      .prepare(
        "SELECT * FROM analytics_rollups ORDER BY hour,metric,dimensions",
      )
      .all() as unknown as {
      hour: number;
      metric: Metric;
      dimensions: string;
      count: number;
      sum: number;
      min: number;
      max: number;
    }[];
    const ledgers = this.db
      .prepare("SELECT * FROM analytics_ledgers ORDER BY id")
      .all() as unknown as {
      id: string;
      at: number;
      dimensions: string;
      usage: string;
      correlation: string;
    }[];
    return {
      version: 1,
      generatedAt: this.now(),
      retentionMs: RETENTION,
      deduplicationWindowMs: RETENTION,
      limits: { events: MAX_EVENTS, series: MAX_SERIES, ledgers: MAX_LEDGERS },
      diagnostics: Object.fromEntries(
        (
          this.db.prepare("SELECT key,value FROM analytics_meta").all() as {
            key: string;
            value: number;
          }[]
        ).map(({ key, value }) => [key, value]),
      ),
      rollups: rows.map(({ dimensions, ...row }) => ({
        ...row,
        dimensions: JSON.parse(dimensions),
        unit: ANALYTICS_METRICS[row.metric],
        mean: row.sum / row.count,
      })),
      usage: ledgers.map(({ dimensions, usage, correlation, ...row }) => ({
        ...row,
        dimensions: JSON.parse(dimensions),
        models: JSON.parse(usage),
        correlation: JSON.parse(correlation),
      })),
      coverage: {
        rollups:
          "Observed attempts only; not a complete billing ledger. Missing rows are unknown, not zero.",
        usage:
          "Latest cumulative Pi ledger per observed actor, allowlisted models only; includes compaction attempts, no time-window attribution. Snapshots can be stale.",
        cost: "USD provider-reported totals only when explicitly flagged per request; not reconciled invoices. Estimates require a supplied rate card; runtime-model rates are base catalog prices excluding service-tier/account adjustments. Pi cumulative totals may mix both.",
        quality:
          "Operational outcomes only; answer correctness and user satisfaction are not inferred.",
        unavailable: [
          "provider invoice reconciliation",
          "subscription entitlement cost",
          "unreported reasoning tokens",
          "cache savings",
          "host compute/image/deploy cost",
        ],
      },
    };
  }

  close() {
    this.db.close();
  }
}

/**
 * Observe only scalar usage and event kinds on the caller's own iterator.
 * Never create a second consumer, forward/copy message payloads, inspect auth,
 * change request options, or interfere with cancellation. No new tracing stack.
 * The custom configured ModelRuntime is supported, as well as default Models.
 */
export function observeModels<T extends Models>(
  runtime: T,
  analytics: OperationalAnalytics,
): T {
  function attempt(
    model: Parameters<Models["streamSimple"]>[0],
    call: () => AssistantMessageEventStream,
  ): AssistantMessageEventStream;
  function attempt(
    model: Parameters<Models["streamSimple"]>[0],
    call: () => Promise<AssistantMessage>,
  ): Promise<AssistantMessage>;
  function attempt(
    model: Parameters<Models["streamSimple"]>[0],
    call: () => AssistantMessageEventStream | Promise<AssistantMessage>,
  ): AssistantMessageEventStream | Promise<AssistantMessage> {
    const id = `model:${randomUUID()}`;
    const start = performance.now();
    let firstOutputMs: number | undefined;
    const record = (outcome: AnalyticsOutcome, usage?: Usage) => {
      // Telemetry is best-effort and must never fail generation/cancellation.
      try {
        // Match Pi 1.5.0 calculateCost: highest strictly exceeded input tier,
        // with 1h cache writes priced at twice that tier's input rate.
        const inputTokens = usage
          ? usage.input + usage.cacheRead + usage.cacheWrite
          : 0;
        let rates = model.cost;
        let inputTokensAbove = -1;
        for (const tier of model.cost.tiers ?? []) {
          if (
            inputTokens > tier.inputTokensAbove &&
            tier.inputTokensAbove > inputTokensAbove
          ) {
            rates = tier;
            inputTokensAbove = tier.inputTokensAbove;
          }
        }
        analytics.modelAttempt(
          id,
          { model: `${model.provider}/${model.id}`, outcome },
          {
            durationMs: performance.now() - start,
            usage,
            rate: {
              input: rates.input,
              output: rates.output,
              cacheRead: rates.cacheRead,
              cacheWrite: rates.cacheWrite,
              cacheWrite1h: rates.input * 2,
              ...(inputTokensAbove < 0 ? {} : { inputTokensAbove }),
              version: "pi-ai@1.5.0/runtime-model",
              currency: "USD",
            },
          },
        );
      } catch {
        /* Native Pi usage remains authoritative after a local sink failure. */
      }
    };
    let stream: AssistantMessageEventStream | Promise<AssistantMessage>;
    try {
      stream = call();
    } catch (error) {
      record("error");
      throw error;
    }
    const terminal = "result" in stream ? stream.result() : stream;
    void terminal.then(
      (message) => {
        record(
          message.stopReason === "error"
            ? "error"
            : message.stopReason === "aborted"
              ? "aborted"
              : message.stopReason === "pending" ||
                  message.stopReason === "deferred"
                ? "unknown"
                : "ok",
          message.stopReason === "pending" ||
            message.stopReason === "deferred" ||
            !hasUsage(message.usage)
            ? undefined
            : message.usage,
        );
        if (message.stopReason === "length") {
          try {
            analytics.record(
              `${id}:length`,
              { model: `${model.provider}/${model.id}`, outcome: "ok" },
              { "model.length_limited": 1 },
            );
          } catch {
            /* Best effort. */
          }
        }
      },
      () => record("error"),
    );
    // Preserve completion-specific behavior in supplied wrappers (priority,
    // checkpoint policy, etc.); do not replace completion with our own stream.
    if (!("result" in stream)) return stream;
    return new Proxy(stream, {
      get(target, name) {
        if (name === Symbol.asyncIterator)
          return () => {
            const iterator = target[Symbol.asyncIterator]();
            return {
              async next() {
                const result = await iterator.next();
                if (
                  !result.done &&
                  firstOutputMs === undefined &&
                  ["text_delta", "thinking_delta", "toolcall_delta"].includes(
                    result.value.type,
                  )
                ) {
                  firstOutputMs = performance.now() - start;
                  try {
                    analytics.record(
                      `${id}:first-output`,
                      { model: `${model.provider}/${model.id}` },
                      { "model.first_output": firstOutputMs },
                    );
                  } catch {
                    /* Observing output must never change its delivery. */
                  }
                }
                return result;
              },
              return: iterator.return?.bind(iterator),
              throw: iterator.throw?.bind(iterator),
            };
          };
        const value = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const streamSimple: Models["streamSimple"] = (model, context, options) =>
    attempt(model, () => runtime.streamSimple(model, context, options));
  const stream: Models["stream"] = (model, context, options) =>
    attempt(model, () => runtime.stream(model, context, options));
  const streamDeferred: Models["streamDeferred"] = (model, handle, options) =>
    attempt(model, () => runtime.streamDeferred(model, handle, options));
  const methods: Partial<Models> = {
    streamSimple,
    stream,
    streamDeferred,
    completeSimple: (model, context, options) =>
      attempt(model, () => runtime.completeSimple(model, context, options)),
    complete: (model, context, options) =>
      attempt(model, () => runtime.complete(model, context, options)),
    fetchDeferred: (model, handle, options) =>
      attempt(model, () => runtime.fetchDeferred(model, handle, options)),
  };
  return new Proxy(runtime, {
    get(target, name) {
      const observed = methods[name as keyof Models];
      if (observed) return observed;
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
