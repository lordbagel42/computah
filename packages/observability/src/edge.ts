import { randomBytes } from "node:crypto";
import {
  createRuntimeLogger,
  type RuntimeLogFields,
  runtimeLog,
} from "./logs.js";

export type EdgeTelemetryOptions = {
  /** Explicit ingest credentials only. Defaults to the constructor's ingest token. */
  logsToken?: string;
  /** Defaults to computah-prod-logs; an empty string disables log export. */
  logsDataset?: string;
};

export type EdgeOutcome =
  | "ready"
  | "not_configured"
  | "error"
  | "timeout"
  | "cancelled"
  | "success"
  | "denied"
  | "queued"
  | "retry";

export type SafeSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name:
    | "computah.observatory.http"
    | "computah.observatory.poll"
    | "computah.debugshare.http"
    | "computah.debugshare.store"
    | "computah.debugshare.notice"
    | "computah.debugshare.auth"
    | "computah.debugshare.mcp"
    | "computah.debugshare.reconcile";
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status?: { code: number };
  attributes?: (
    | {
        key: "outcome";
        value: {
          stringValue: EdgeOutcome;
        };
      }
    | { key: "telemetry.dropped"; value: { intValue: string } }
  )[];
};
export type TraceScope = {
  span: SafeSpan;
  end(outcome: EdgeOutcome): Promise<void>;
};

const operations = {
  "computah.observatory.http": "observatory.http",
  "computah.observatory.poll": "observatory.poll",
  "computah.debugshare.http": "debugshare.http",
  "computah.debugshare.store": "debugshare.store",
  "computah.debugshare.notice": "debugshare.notice",
  "computah.debugshare.auth": "debugshare.auth",
  "computah.debugshare.mcp": "debugshare.mcp",
  "computah.debugshare.reconcile": "debugshare.reconcile",
} as const satisfies Record<SafeSpan["name"], RuntimeLogFields["operation"]>;

const outcomes: Record<
  EdgeOutcome,
  NonNullable<RuntimeLogFields["outcome"]>
> = {
  ready: "success",
  not_configured: "denied",
  error: "error",
  timeout: "timeout",
  cancelled: "cancelled",
  success: "success",
  denied: "denied",
  queued: "queued",
  retry: "retry",
};
/** Tiny positive-schema OTLP exporter for the edge runtime; no request data or exception can enter. */
export class Telemetry {
  private inFlight = 0;
  private window = 0;
  private exported = 0;
  private dropped = 0;
  private logger?: ReturnType<typeof createRuntimeLogger>;
  /** DEBUGSHARE logs use the shared bounded logger, isolated to this instance. */
  constructor(
    private token?: string,
    private transport: typeof fetch = fetch,
    private now = Date.now,
    private options: EdgeTelemetryOptions = {},
  ) {}
  start(name: SafeSpan["name"], parent?: SafeSpan): TraceScope {
    if (!Object.hasOwn(operations, name)) throw new Error("invalid_operation");
    const debugshare = name.startsWith("computah.debugshare.");
    if (debugshare) {
      this.logger ??= createRuntimeLogger({
        service: "debugshare",
        token: this.options.logsToken ?? this.token ?? "",
        dataset: this.options.logsDataset ?? "computah-prod-logs",
        revision: "",
        contentEnabled: false,
        autoFlush: false,
        fetch: this.transport,
      });
    }
    const logger = debugshare ? this.logger : undefined;
    const validParent =
      parent &&
      /^[a-f0-9]{32}$/.test(parent.traceId) &&
      !/^0+$/.test(parent.traceId) &&
      /^[a-f0-9]{16}$/.test(parent.spanId) &&
      !/^0+$/.test(parent.spanId)
        ? parent
        : undefined;
    const span: SafeSpan = {
      traceId: validParent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      ...(validParent ? { parentSpanId: validParent.spanId } : {}),
      name,
      startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    };
    // Export a captured positive schema, not the caller-mutable reference.
    const captured = { ...span };
    return {
      span,
      end: async (outcome) => {
        if (!Object.hasOwn(outcomes, outcome)) outcome = "error";
        // DEBUGSHARE never uses the process-global bootstrap or ambient tokens.
        // Observatory retains its existing opt-in runtime hook unchanged.
        const emit = debugshare ? logger?.emit : runtimeLog;
        emit?.(
          "operation.completed",
          {
            operation: operations[name],
            outcome: outcomes[outcome],
            ...(outcome === "not_configured"
              ? { reason: "not_configured" as const }
              : {}),
          },
          ["ready", "success", "queued"].includes(outcome) ? "info" : "warn",
          { traceId: captured.traceId, spanId: captured.spanId, traceFlags: 1 },
        );
        try {
          span.endTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
          span.status = {
            code: ["ready", "success", "queued", "retry"].includes(outcome)
              ? 1
              : 2,
          };
          span.attributes = [
            { key: "outcome", value: { stringValue: outcome } },
          ];
          if (!this.token) return;
          if (this.now() - this.window >= 5000) {
            this.window = this.now();
            this.exported = 0;
          }
          if (this.inFlight >= 4 || this.exported >= 8) {
            this.dropped = Math.min(1_000_000, this.dropped + 1);
            return;
          }
          span.attributes.push({
            key: "telemetry.dropped",
            value: { intValue: String(this.dropped) },
          });
          this.dropped = 0;
          this.exported++;
          this.inFlight++;
          try {
            const transport = this.transport;
            const response = await transport("https://api.axiom.co/v1/traces", {
              method: "POST",
              signal: AbortSignal.timeout(2000),
              headers: {
                Authorization: `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "X-Axiom-Dataset": "computah-prod-traces",
              },
              body: JSON.stringify({
                resourceSpans: [
                  {
                    resource: {
                      attributes: [
                        {
                          key: "service.name",
                          value: {
                            stringValue: name.startsWith("computah.debugshare.")
                              ? "computah-debugshare"
                              : "computah-observatory",
                          },
                        },
                      ],
                    },
                    scopeSpans: [
                      {
                        scope: { name: "computah" },
                        spans: [
                          {
                            ...captured,
                            endTimeUnixNano: span.endTimeUnixNano,
                            status: span.status,
                            attributes: span.attributes,
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
            });
            await response.body?.cancel();
          } catch {
            // Fail open; export failure never recursively emits another trace or leaks destination text.
          } finally {
            this.inFlight--;
          }
        } finally {
          // Includes disabled/dropped trace exports. The shared logger serializes
          // concurrent flushes, bounds its queue, times out and never retries.
          await logger?.flush().catch(() => {});
        }
      },
    };
  }
}
