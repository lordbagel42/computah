import type { Infer } from "apps";
import type { TraceSpan } from "../traces.js";

export function traceRows(spans: readonly Infer<typeof TraceSpan>[]) {
  const ids = new Set(spans.map((span) => span.id));
  const children = new Map<string, Infer<typeof TraceSpan>[]>();
  for (const span of spans) {
    const parent = ids.has(span.parent) ? span.parent : "";
    const siblings = children.get(parent) ?? [];
    siblings.push(span);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const rows: {
    span: (typeof spans)[number];
    depth: number;
    missingParent: boolean;
  }[] = [];
  const visit = (span: (typeof spans)[number], depth: number) => {
    if (seen.has(span.id)) return;
    seen.add(span.id);
    rows.push({
      span,
      depth,
      missingParent: !!span.parent && !ids.has(span.parent),
    });
    for (const child of children.get(span.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get("") ?? []) visit(root, 0);
  // Cycles and disconnected components remain inspectable, never invented roots.
  for (const span of spans) visit(span, 0);
  return rows;
}
