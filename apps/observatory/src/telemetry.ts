import { randomBytes } from "node:crypto";

export type SafeSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: "computah.observatory.http" | "computah.observatory.poll";
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status?: { code: number };
  attributes?: (
    | {
        key: "outcome";
        value: {
          stringValue:
            | "ready"
            | "not_configured"
            | "error"
            | "timeout"
            | "cancelled";
        };
      }
    | { key: "telemetry.dropped"; value: { intValue: string } }
  )[];
};
export type TraceScope = {
  span: SafeSpan;
  end(
    outcome: "ready" | "not_configured" | "error" | "timeout" | "cancelled",
  ): Promise<void>;
};
/** Tiny positive-schema OTLP exporter for the edge runtime; no request data or exception can enter. */
export class Telemetry {
  private inFlight = 0;
  private window = 0;
  private exported = 0;
  private dropped = 0;
  constructor(
    private token?: string,
    private transport: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  start(name: SafeSpan["name"], parent?: SafeSpan): TraceScope {
    const span: SafeSpan = {
      traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    };
    return {
      span,
      end: async (outcome) => {
        span.endTimeUnixNano = String(BigInt(Date.now()) * 1_000_000n);
        span.status = {
          code: ["error", "timeout", "cancelled"].includes(outcome) ? 2 : 1,
        };
        span.attributes = [{ key: "outcome", value: { stringValue: outcome } }];
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
          const response = await this.transport(
            "https://api.axiom.co/v1/traces",
            {
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
                          value: { stringValue: "computah-observatory" },
                        },
                      ],
                    },
                    scopeSpans: [
                      { scope: { name: "computah" }, spans: [span] },
                    ],
                  },
                ],
              }),
            },
          );
          await response.body?.cancel();
        } catch {
          // Fail open; export failure never recursively emits another trace or leaks destination text.
        } finally {
          this.inFlight--;
        }
      },
    };
  }
}
