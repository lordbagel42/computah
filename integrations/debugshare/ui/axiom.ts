/** Deep link only: Axiom authenticates the viewer; no telemetry credentials reach this app. */
const traceIdPattern = /^[a-f0-9]{32}$/u;
const spanIdPattern = /^[a-f0-9]{16}$/u;
const issueIdPattern =
  /^(?:computah_bug_[a-z0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;

function query(apl: string, requestedAt: string): string | null {
  const requested = Date.parse(requestedAt);
  const start = new Date(requested - 86_400_000);
  const end = new Date(requested + 86_400_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return null;
  const url = new URL("https://app.axiom.co/bagel-w3ue/query");
  url.searchParams.set(
    "initForm",
    JSON.stringify({
      apl,
      queryOptions: {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      },
    }),
  );
  return url.href;
}
const valid = (value: string | undefined, pattern: RegExp): value is string =>
  !!value && pattern.test(value) && !/^0+$/u.test(value);

export function axiomTraceUrl(
  traceId: string | undefined,
  requestedAt: string,
): string | null {
  if (!valid(traceId, traceIdPattern)) return null;
  return query(
    `['computah-prod-traces'] | where trace_id == '${traceId}' | sort by _time asc`,
    requestedAt,
  );
}

/** Bounded private logs carrying the same trace ID. */
export function axiomLogsUrl(
  traceId: string | undefined,
  requestedAt: string,
): string | null {
  if (!valid(traceId, traceIdPattern)) return null;
  return query(
    `['computah-prod-logs'] | where trace_id == '${traceId}' | sort by _time asc`,
    requestedAt,
  );
}

export function axiomSpanUrl(
  spanId: string | undefined,
  requestedAt: string,
): string | null {
  if (!valid(spanId, spanIdPattern)) return null;
  return query(
    `['computah-prod-traces'] | where span_id == '${spanId}'`,
    requestedAt,
  );
}

/** Capture spans carry the issue ID as `computah.debugshare.id`. */
export function axiomIssueUrl(
  issueId: string | undefined,
  requestedAt: string,
): string | null {
  if (!valid(issueId, issueIdPattern)) return null;
  return query(
    `['computah-prod-traces'] | where tostring(['attributes.custom']['computah.debugshare.id']) == '${issueId}' | sort by _time asc`,
    requestedAt,
  );
}
