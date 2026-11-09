import { z } from "zod";
import { isDebugshareId } from "./ids.js";
import {
  explore,
  getIssue,
  getIssueTrace,
  inspectIssue,
  search,
  updateIssue,
} from "./index.js";
import type { Context } from "./operations.js";

const id = z
  .string()
  .refine(isDebugshareId, "Exact current or legacy report ID required");
const term = z.string().max(200).default("");
const listInput = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  after: z.string().max(300).default(""),
  text: term,
  status: z
    .enum(["", "open", "investigating", "blocked", "resolved"])
    .default(""),
  assignee: term,
  requestedBy: term,
  team: term,
  channel: term,
  tenantId: term,
  userId: term,
  agentId: term,
  trace: term,
  submission: term,
});
const historyInput = z.object({
  id,
  after: z.string().max(300).default(""),
  limit: z.number().int().min(1).max(100).default(50),
});
const updateInput = z.object({
  id,
  expectedRevision: z.number().int().min(1),
  status: z.enum(["open", "investigating", "blocked", "resolved"]),
  assignee: z.string().max(200),
  actor: z.string().trim().min(1).max(200),
  note: z.string().trim().min(1).max(4000),
});
const noteInput = z.object({
  id,
  expectedRevision: z.number().int().min(1),
  actor: z.string().trim().min(1).max(200),
  note: z.string().trim().min(1).max(4000),
});
const searchInput = z.object({
  text: term,
  author: term,
  channel: term,
  submission: term,
  trace: term,
  actor: term,
});
const decodeCursor = (cursor: string) => {
  if (!cursor) return ["", ""];
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    parsed.some((s) => typeof s !== "string" || s.length > 100)
  )
    throw new Error("Invalid cursor");
  return parsed as [string, string];
};
const cursor = (time: string, key: string) =>
  Buffer.from(JSON.stringify([time, key])).toString("base64url");

async function listPage(ctx: Context, raw: unknown) {
  const f = listInput.parse(raw);
  const [updated, key] = decodeCursor(f.after);
  const rows = ctx.sql
    .exec<{
      id: string;
      title: string;
      status: string;
      assignee: string;
      revision: number;
      created: string;
      updated: string;
    }>(
      `SELECT id,title,status,assignee,revision,created,updated FROM issues WHERE
    (?1='' OR (updated<?1 OR (updated=?1 AND id>?2)))
    AND (?3='' OR instr(lower(id||' '||title||' '||assignee||' '||report),lower(?3))>0)
    AND (?4='' OR status=?4) AND (?5='' OR assignee=?5)
    AND (?6='' OR json_extract(report,'$.requestedBy')=?6)
    AND (?7='' OR json_extract(report,'$.source.team')=?7)
    AND (?8='' OR json_extract(report,'$.source.channel')=?8)
    AND (?9='' OR json_extract(report,'$.scope.tenantId')=?9)
    AND (?10='' OR json_extract(report,'$.scope.userId')=?10)
    AND (?11='' OR json_extract(report,'$.scope.agentId')=?11)
    AND (?12='' OR json_extract(report,'$.capture.traceId')=?12 OR json_extract(report,'$.transport.traceId')=?12)
    AND (?13='' OR EXISTS(SELECT 1 FROM json_each(report,'$.submissions') s WHERE s.value=?13))
    ORDER BY updated DESC,id LIMIT ?14`,
      updated,
      key,
      f.text,
      f.status,
      f.assignee,
      f.requestedBy,
      f.team,
      f.channel,
      f.tenantId,
      f.userId,
      f.agentId,
      f.trace,
      f.submission,
      f.limit + 1,
    )
    .toArray();
  const page = rows.slice(0, f.limit);
  const last = page.at(-1);
  return {
    issues: page,
    next: rows.length > f.limit && last ? cursor(last.updated, last.id) : "",
  };
}
async function historyPage(ctx: Context, raw: unknown) {
  const input = historyInput.parse(raw);
  // Exact lookup proves existence; cursors never grant issue access.
  await getIssue.invoke(ctx, { id: input.id });
  const [created, key] = decodeCursor(input.after);
  const rows = ctx.sql
    .exec<{
      id: string;
      status: string;
      actor: string;
      note: string;
      created: string;
    }>(
      "SELECT id,status,actor,note,created FROM issue_events WHERE issue=?1 AND (?2='' OR created>?2 OR (created=?2 AND id>?3)) ORDER BY created,id LIMIT ?4",
      input.id,
      created,
      key,
      input.limit + 1,
    )
    .toArray();
  const events = rows.slice(0, input.limit);
  const last = events.at(-1);
  return {
    events,
    next:
      rows.length > input.limit && last ? cursor(last.created, last.id) : "",
  };
}

/** Fixed tool catalog shared by MCP and HTTP; filters narrow results, never grant authority. */
export const catalog = {
  explore_issues: {
    description:
      "Bounded explorer overview: latest 500 issue projections, latest 500 investigation events, exact stored issue/event/message/byte totals. Scope filters are navigation, never authorization.",
    schema: z.object({}),
    scope: "issues:read",
    run: (ctx: Context, input: unknown) => explore.invoke(ctx, input),
  },
  search_evidence: {
    description:
      "Search immutable message evidence and history notes, with exact author/channel/submission/trace/actor filters; deduplicated overlapping messages and explicit bounded result collections.",
    schema: searchInput,
    scope: "issues:read",
    run: (ctx: Context, input: unknown) =>
      search.invoke(ctx, searchInput.parse(input)),
  },
  list_issues: {
    description:
      "Paginated issue summaries with exact status/assignee/requester/workspace/location/scope/trace/submission filters and bounded text search. Cursor ordering is updated descending then ID; concurrent edits can move records.",
    schema: listInput,
    scope: "issues:read",
    run: listPage,
  },
  get_issue: {
    description:
      "Exact immutable report with requester, audience, capture metadata and bounded lifecycle history; legacy UUIDs supported.",
    schema: z.object({ id }),
    scope: "issues:read",
    run: (ctx: Context, input: unknown) => getIssue.invoke(ctx, input),
  },
  inspect_issue: {
    description:
      "Immutable snapshot byte length/hash, full bounded report, history and related records with evidence reasons.",
    schema: z.object({ id }),
    scope: "issues:read",
    run: (ctx: Context, input: unknown) => inspectIssue.invoke(ctx, input),
  },
  issue_history: {
    description:
      "Paginate immutable investigation events oldest first, retaining IDs, attribution, status and timestamps.",
    schema: historyInput,
    scope: "issues:read",
    run: historyPage,
  },
  update_issue: {
    description:
      "Revision-checked investigation status, assignment and evidence update. Reopen explicitly with open. Resolved does not prove deployment. Actor is declared attribution.",
    schema: updateInput,
    scope: "issues:write",
    run: (ctx: Context, input: unknown) =>
      updateIssue.invoke(ctx, updateInput.parse(input)),
  },
  add_issue_note: {
    description:
      "Append evidence without changing current status/assignee. Requires exact expectedRevision and increments revision atomically.",
    schema: noteInput,
    scope: "issues:write",
    run: async (ctx: Context, raw: unknown) => {
      const input = noteInput.parse(raw);
      const detail = await getIssue.invoke(ctx, { id: input.id });
      return updateIssue.invoke(ctx, {
        ...input,
        status: detail.issue.status,
        assignee: detail.issue.assignee,
      });
    },
  },
  get_issue_trace: {
    description:
      "Private read-only Axiom query of only an existing issue's stored capture/transport correlation. No arbitrary trace ID, dataset or SQL/APL. Bounded 500 spans/2MB/15s.",
    schema: z.object({ id, correlation: z.enum(["capture", "transport"]) }),
    scope: "traces:read",
    run: (ctx: Context, input: unknown) => getIssueTrace.invoke(ctx, input),
  },
};
