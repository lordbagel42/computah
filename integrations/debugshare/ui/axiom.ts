/** Deep link only: Axiom authenticates the viewer; no telemetry credentials reach this app. */
export function axiomTraceUrl(
  traceId: string | undefined,
  requestedAt: string,
): string | null {
  if (!traceId || !/^[a-f0-9]{32}$/u.test(traceId) || /^0+$/u.test(traceId))
    return null;
  const requested = Date.parse(requestedAt);
  const start = new Date(requested - 86_400_000);
  const end = new Date(requested + 86_400_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return null;
  const url = new URL("https://app.axiom.co/bagel-w3ue/query");
  url.searchParams.set(
    "initForm",
    JSON.stringify({
      apl: `['computah-prod-traces'] | where trace_id == '${traceId}' | sort by _time asc`,
      queryOptions: {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      },
    }),
  );
  return url.href;
}
