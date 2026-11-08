import {
  array,
  boolean,
  type JsonValue,
  json,
  number,
  object,
  string,
} from "apps";

export const TraceSpan = object({
  id: string(),
  parent: string(),
  name: string(),
  service: string(),
  start: number(),
  duration: number(),
  error: boolean(),
  fields: json(),
});
export const TraceResult = object({
  traceId: string(),
  notice: string(),
  partial: boolean(),
  spans: array(TraceSpan),
});

/** Only call with a correlation read from an authenticated, stored issue. */
export async function readTrace(
  fetcher: typeof fetch,
  signal: AbortSignal,
  headers: Record<string, string>,
  traceId: string,
  requestedAt: string,
) {
  if (!/^[a-f0-9]{32}$/u.test(traceId) || /^0+$/u.test(traceId))
    throw new Error("Invalid recorded trace ID");
  const requested = Date.parse(requestedAt);
  if (!Number.isFinite(requested)) throw new Error("Invalid report time");
  let response: Response;
  try {
    response = await fetcher(
      "https://api.axiom.co/v1/datasets/_apl?format=tabular",
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          apl: `['computah-prod-traces'] | where trace_id == '${traceId}' | extend duration_ms=duration / 1ms | sort by _time asc | take 501`,
          startTime: new Date(requested - 86_400_000).toISOString(),
          endTime: new Date(requested + 86_400_000).toISOString(),
        }),
      },
    );
  } catch {
    throw new Error(
      signal.aborted
        ? "Trace query cancelled"
        : "Axiom trace query timed out or could not connect. Retry the load.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Axiom refused trace access. Check the tracker’s read-only Axiom account."
        : "Axiom could not complete the trace query. Retry the load or open Axiom.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Axiom returned no trace response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) break;
      chunks.push(value);
    }
  } catch {
    throw new Error(
      signal.aborted
        ? "Trace query cancelled"
        : "Axiom trace query timed out or could not connect. Retry the load.",
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size > 2_000_000)
    throw new Error(
      "Trace response exceeds the inline viewer’s 2 MB limit. Open Axiom for the full trace.",
    );
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let data: {
    tables?: { fields: { name: string }[]; columns: JsonValue[][] }[];
    status?: { isPartial?: boolean };
  };
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Axiom returned an invalid trace response");
  }
  const table = data?.tables?.[0];
  if (
    !table ||
    data.tables?.length !== 1 ||
    !Array.isArray(table.fields) ||
    !Array.isArray(table.columns) ||
    table.fields.length !== table.columns.length ||
    table.fields.some((field) => !field || typeof field.name !== "string") ||
    table.columns.some(
      (column) =>
        !Array.isArray(column) || column.length !== table.columns[0]?.length,
    ) ||
    (data.status?.isPartial !== undefined &&
      typeof data.status.isPartial !== "boolean")
  )
    throw new Error("Axiom returned an unsupported trace response");
  const fields: string[] = table.fields.map(
    (field: { name: string }) => field.name,
  );
  const count = table.columns[0]?.length ?? 0;
  const spans = new Map<string, ReturnType<typeof TraceSpan.parse>>();
  for (let i = 0; i < Math.min(count, 500); i++) {
    const row = Object.fromEntries(
      fields.map((name, col) => [name, table.columns[col]?.[i]]),
    );
    const start =
      typeof row._time === "string" ? Date.parse(row._time) : Number.NaN;
    if (
      row.trace_id !== traceId ||
      typeof row.span_id !== "string" ||
      !/^[a-f0-9]{16}$/u.test(row.span_id) ||
      /^0+$/u.test(row.span_id) ||
      !Number.isFinite(start) ||
      typeof row.duration_ms !== "number" ||
      !Number.isFinite(row.duration_ms) ||
      row.duration_ms < 0
    )
      throw new Error("Axiom returned invalid trace timing or identity");
    spans.set(row.span_id, {
      id: row.span_id,
      parent:
        typeof row.parent_span_id === "string" &&
        !/^0+$/u.test(row.parent_span_id)
          ? row.parent_span_id
          : "",
      name: typeof row.name === "string" ? row.name : "Unnamed span",
      service:
        typeof row["service.name"] === "string"
          ? row["service.name"]
          : "Unknown service",
      start,
      duration: row.duration_ms,
      error: row.error === true || row["status.code"] === "ERROR",
      fields: row,
    });
  }
  return {
    traceId,
    notice: spans.size
      ? ""
      : "No spans found in the report’s ±1-day window. They may have expired or arrived outside this range; open Axiom to widen it.",
    partial: count > 500 || data.status?.isPartial === true,
    spans: [...spans.values()],
  };
}
