import { createHmac } from "node:crypto";

export const WINDOW_MS = 15 * 60_000;
export const LIMIT = 1000;
const operations = new Set([
  "submit",
  "result",
  "wait",
  "history",
  "cancel",
  "compact",
  "sleep",
  "observe",
  "http",
  "ready",
  "stopped",
  "report",
  "synthetic",
  "model",
  "slack.receive",
  "slack.step",
  "slack.api",
  "slack.core",
  "web.search",
  "web.extract",
  "start.failed",
  "bus.pump",
  "bus.stream.create",
  "bus.stream.append",
  "bus.replay",
  "native.ipc",
  "native.render",
  "native.recovery",
  "native.process",
  "native.core",
  "observatory.poll",
]);
const services = new Set([
  "computah-backend",
  "computah-slack",
  "computah-bus",
  "computah-native",
  "computah-dashboard",
  "computah-rune-pi",
  "computah-observatory",
]);
function operation(value: unknown) {
  if (typeof value !== "string") return "runtime.operation";
  if (value.startsWith("computah.") && operations.has(value.slice(9)))
    return value;
  if (
    /^pi\.durable\.(submit|phase|entry|submission|report|checkpoint|replay)$/.test(
      value,
    )
  )
    return value;
  if (/^(chat (gpt-6.1-terra|gpt-6.1-sol)|invoke_agent pi)$/.test(value))
    return value;
  if (
    /^(interaction|worker)\/(admit|awaitCancellation|sleep|harness\.(root|submission)|submission\.(wait|status)|conversation\.(entries|configure)|pi\.wake)$/.test(
      value,
    )
  )
    return value;
  return "runtime.operation";
}
const validId = (value: unknown, length: number): value is string =>
  typeof value === "string" &&
  new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value) &&
  !/^0+$/.test(value);
type Row = Record<string, unknown>;
export type PublicSpan = {
  id: string;
  traceId: string;
  parentId: string | null;
  parentState: "root" | "present" | "missing";
  links: { id: string; traceId: string; present: boolean }[];
  name: string;
  service: string;
  start: number;
  durationMs: number;
  status: "ok" | "error" | "unset";
};

/** Independent public boundary. No attributes, resources, error text or raw IDs survive. */
export function project(rows: Row[], secret: string): PublicSpan[] {
  if (secret.length < 32)
    throw new Error("Public identifier secret not configured");
  const opaque = (kind: string, value: string) =>
    createHmac("sha256", secret)
      .update(`${kind}:${value.toLowerCase()}`)
      .digest("hex")
      .slice(0, 32);
  const result = new Map<string, PublicSpan>();
  for (const row of rows.slice(0, LIMIT)) {
    const trace = row.trace_id;
    const span = row.span_id;
    const start = typeof row._time === "string" ? Date.parse(row._time) : NaN;
    const durationMs = row.duration_ms;
    if (
      !validId(trace, 32) ||
      !validId(span, 16) ||
      !Number.isFinite(start) ||
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      durationMs > 7 * 86400_000
    )
      continue;
    const parent = row.parent_span_id;
    const id = opaque("span", `${trace}:${span}`);
    const parentId = validId(parent, 16)
      ? opaque("span", `${trace}:${parent}`)
      : null;
    // A malformed/nonempty parent means an unknown causal link, not a new root.
    const hasParent =
      parent !== null &&
      parent !== undefined &&
      parent !== "" &&
      !/^0+$/.test(String(parent));
    const links = (
      Array.isArray(row.links) ? row.links.slice(0, 32) : []
    ).flatMap((value: unknown) => {
      if (!value || typeof value !== "object") return [];
      const link = value as Row;
      if (!validId(link.trace_id, 32) || !validId(link.span_id, 16)) return [];
      return [
        {
          id: opaque("span", `${link.trace_id}:${link.span_id}`),
          traceId: opaque("trace", link.trace_id),
          present: false,
        },
      ];
    });
    result.set(id, {
      id,
      traceId: opaque("trace", trace),
      parentId,
      parentState: hasParent ? "missing" : "root",
      links,
      name: operation(row.name),
      service:
        typeof row["service.name"] === "string" &&
        services.has(row["service.name"] as string)
          ? (row["service.name"] as string)
          : "runtime",
      start,
      durationMs,
      status:
        row["status.code"] === "ERROR" || row.error === true
          ? "error"
          : row["status.code"] === "OK"
            ? "ok"
            : "unset",
    });
  }
  for (const span of result.values()) {
    if (span.parentId && span.parentId !== span.id && result.has(span.parentId))
      span.parentState = "present";
    for (const link of span.links) link.present = result.has(link.id);
  }
  return [...result.values()].sort((a, b) => b.start - a.start);
}

/** Reject malformed/partial envelopes rather than quietly claiming an empty live window. */
export function readTable(body: unknown): { rows: Row[]; partial: boolean } {
  if (!body || typeof body !== "object")
    throw new Error("Invalid query result");
  const value = body as {
    status?: { isPartial?: unknown };
    tables?: { fields?: { name?: unknown }[]; columns?: unknown[][] }[];
  };
  if (
    typeof value.status?.isPartial !== "boolean" ||
    !Array.isArray(value.tables)
  )
    throw new Error("Invalid query result");
  const rows: Row[] = [];
  for (const table of value.tables) {
    if (
      !Array.isArray(table.fields) ||
      !Array.isArray(table.columns) ||
      table.fields.length !== table.columns.length
    )
      throw new Error("Invalid table");
    const count = table.columns[0]?.length ?? 0;
    if (
      table.columns.some(
        (column) => !Array.isArray(column) || column.length !== count,
      ) ||
      table.fields.some((field) => typeof field.name !== "string")
    )
      throw new Error("Invalid columns");
    for (let index = 0; index < count && rows.length <= LIMIT; index++) {
      rows.push(
        Object.fromEntries(
          table.fields.map((field, column) => [
            field.name,
            table.columns?.[column]?.[index],
          ]),
        ),
      );
    }
  }
  return { rows, partial: value.status.isPartial || rows.length > LIMIT };
}
