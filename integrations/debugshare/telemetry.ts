import type { SafeSpan } from "../../packages/observability/src/edge.js";

/**
 * new Telemetry(ingestToken, fetch?, Date.now?, { logsToken?, logsDataset? }).
 * DEBUGSHARE defaults to that explicit ingest token and computah-prod-logs;
 * logsToken supports a dedicated ingest credential, "" disables logs. No ambient
 * bindings/query credentials or content lane are used. Await end() (or include
 * its promise in the owner's durable waitUntil) to settle both spans and logs.
 */
export {
  type EdgeOutcome,
  type EdgeTelemetryOptions,
  type SafeSpan,
  Telemetry,
  type TraceScope,
} from "../../packages/observability/src/edge.js";

/** Trusted transport or durable IDs only, never identity/authority or payload content. */
export function traceParent(value: unknown): SafeSpan | undefined {
  const match =
    typeof value === "string" && value.length === 55
      ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value)
      : null;
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
    return undefined;
  return {
    traceId: match[1],
    spanId: match[2],
    name: "computah.debugshare.http",
    startTimeUnixNano: "0",
  };
}
