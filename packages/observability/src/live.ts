import type { Context } from "@opentelemetry/api";
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { runtimeLog } from "./logs.js";

/** Positive-schema, best-effort live timing. Independent of settled OTLP export. */
export class LiveSpanProcessor implements SpanProcessor {
  private active = new Map<string, { span: ReadableSpan; revision: number }>();
  private queued = new Map<string, Record<string, unknown>>();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private dropped = 0;
  private nextFlush = 0;
  private failures = 0;
  constructor(
    private service: string,
    private safeName: (name: string) => string,
    private config = {
      url: process.env.OBSERVATORY_LIVE_URL,
      token: process.env.OBSERVATORY_LIVE_TOKEN,
    },
    private transport: typeof fetch = fetch,
  ) {
    if (!config.url || !config.token) return;
    try {
      const url = new URL(config.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return;
    } catch {
      return;
    }
    this.timer = setInterval(() => {
      if (this.closed) return;
      for (const item of this.active.values()) this.record(item, false);
      void this.flush();
    }, 5000);
    this.timer.unref();
  }
  onStart(span: Span, _parentContext: Context): void {
    if (!this.timer || this.closed) return;
    if (this.active.size >= 512) {
      this.drop();
      return;
    }
    const item = { span: span as ReadableSpan, revision: 0 };
    this.active.set(span.spanContext().spanId, item);
    this.record(item, false);
  }
  onEnd(span: ReadableSpan): void {
    if (!this.timer || this.closed) return;
    const item = this.active.get(span.spanContext().spanId) ?? {
      span,
      revision: 0,
    };
    item.span = span;
    this.active.delete(span.spanContext().spanId);
    this.record(item, true);
  }
  private drop() {
    this.dropped = Math.min(1_000_000, this.dropped + 1);
  }
  private record(
    item: { span: ReadableSpan; revision: number },
    ended: boolean,
  ) {
    const span = item.span;
    // Exporter diagnostics never feed their own live delivery logging.
    if (span.name === "computah.logs.export") return;
    const context = span.spanContext();
    const key = `${context.traceId}:${context.spanId}`;
    if (!this.queued.has(key) && this.queued.size >= 1024) {
      this.drop();
      return;
    }
    const start = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
    const observed = Date.now();
    this.queued.set(key, {
      trace_id: context.traceId,
      span_id: context.spanId,
      parent_span_id: span.parentSpanContext?.spanId ?? null,
      links: span.links.slice(0, 32).map((link) => ({
        trace_id: link.context.traceId,
        span_id: link.context.spanId,
      })),
      name: this.safeName(span.name),
      "service.name": `computah-${this.service}`,
      _time: new Date(start).toISOString(),
      duration_ms: ended
        ? span.duration[0] * 1000 + span.duration[1] / 1e6
        : Math.max(0, observed - start),
      "status.code": ended
        ? span.status.code === 2
          ? "ERROR"
          : span.status.code === 1
            ? "OK"
            : "UNSET"
        : "UNSET",
      lifecycle: ended ? "ended" : "active",
      revision: ++item.revision,
      observed_at: observed,
    });
  }
  private flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.queued.size || !this.timer) return Promise.resolve();
    if (Date.now() < this.nextFlush) return Promise.resolve();
    // Prune before selecting a batch: the receiver rejects observations older
    // than 30 seconds. Leave room for the two-second transport deadline.
    for (const [key, record] of this.queued) {
      if (Date.now() - (record.observed_at as number) > 25_000) {
        this.queued.delete(key);
        this.drop();
      }
    }
    if (!this.queued.size) return Promise.resolve();
    const batch: [string, Record<string, unknown>][] = [];
    let bytes = 256;
    for (const entry of this.queued) {
      const size = Buffer.byteLength(JSON.stringify(entry[1])) + 1;
      if (batch.length >= 128 || bytes + size > 120 * 1024) break;
      batch.push(entry);
      bytes += size;
    }
    for (const [key] of batch) this.queued.delete(key);
    this.pending = Promise.resolve().then(async () => {
      let ok = false;
      try {
        const transport = this.transport;
        const body = JSON.stringify({
          version: 1,
          records: batch.map(([, record]) => record),
          dropped: this.dropped,
        });
        this.nextFlush = Date.now() + 5000;
        const response = await transport(this.config.url as string, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.token}`,
            traceparent: `00-${batch[0][1].trace_id}-${batch[0][1].span_id}-01`,
          },
          body,
          signal: AbortSignal.timeout(2000),
          redirect: "error",
        });
        await response.body?.cancel();
        ok = response.ok;
      } catch {
        // Delivery is best effort; retain recent records for bounded retry.
      } finally {
        if (ok) {
          this.failures = 0;
        } else {
          this.failures = Math.min(6, this.failures + 1);
          this.nextFlush =
            Date.now() + Math.min(300_000, 5000 * 2 ** this.failures);
          for (const [key, record] of batch) {
            // A newer end/active revision queued during transport wins.
            if (this.queued.has(key)) continue;
            if (this.queued.size >= 1024) this.drop();
            else this.queued.set(key, record);
          }
        }
        runtimeLog("operation.completed", {
          operation: "export",
          outcome: ok ? "success" : "error",
          reason: ok ? undefined : "transport",
          count: batch.length,
        });
        this.pending = undefined;
      }
    });
    return this.pending;
  }
  async forceFlush(): Promise<void> {
    await this.pending;
    // SDK flush/shutdown must not bypass the process request budget or backoff.
    await this.flush();
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.forceFlush();
    clearInterval(this.timer);
    this.timer = undefined;
    this.active.clear();
    this.queued.clear();
  }
}
