import type { ExploreData, Row } from "../data.js";
import { type EntityKind, tokenize } from "../lib.js";

export type Entity = {
  kind: EntityKind;
  value: string;
  issues: string[];
  first: string;
  last: string;
  facts: [string, string][];
};

/** Every entity the index can name, with the issues that reference it. */
export function entities(data: ExploreData, kind: EntityKind): Entity[] {
  const map = new Map<string, Entity>();
  const touch = (
    value: string,
    issue: string,
    at: string,
    fact?: [string, string],
  ) => {
    let e = map.get(value);
    if (!e) {
      e = { kind, value, issues: [], first: at, last: at, facts: [] };
      map.set(value, e);
    }
    if (!e.issues.includes(issue)) e.issues.push(issue);
    if (at < e.first) e.first = at;
    if (at > e.last) e.last = at;
    if (fact && !e.facts.some(([k, v]) => k === fact[0] && v === fact[1]))
      e.facts.push(fact);
  };
  const rows = data.issues;
  if (kind === "people")
    for (const r of rows) {
      for (const p of r.participants) touch(p, r.id, r.requestedAt);
      touch(r.requestedBy, r.id, r.requestedAt, ["requested", r.id]);
    }
  if (kind === "channels")
    for (const r of rows)
      touch(r.channel, r.id, r.requestedAt, ["workspace", r.team]);
  if (kind === "submissions")
    for (const r of rows)
      for (const s of r.submissions) touch(s, r.id, r.requestedAt);
  if (kind === "traces") {
    for (const r of rows) {
      if (typeof r.captureTrace === "string")
        touch(r.captureTrace, r.id, r.requestedAt, ["capture", r.id]);
      if (typeof r.transportTrace === "string")
        touch(r.transportTrace, r.id, r.requestedAt, ["receive", r.id]);
    }
    for (const e of data.events)
      for (const t of tokenize(e.note))
        if (t.kind === "link" && t.type === "trace")
          touch(t.text, e.issue, e.created, ["noted by", e.actor]);
  }
  if (kind === "actors")
    for (const e of data.events) touch(e.actor, e.issue, e.created);
  return [...map.values()].sort(
    (a, b) => b.issues.length - a.issues.length || b.last.localeCompare(a.last),
  );
}

export const requesterOf = (rows: Row[], user: string) =>
  rows.filter((r) => r.requestedBy === user).length;
