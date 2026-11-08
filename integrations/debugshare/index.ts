import {
  array,
  defineApp,
  defineProvider,
  type Infer,
  type MutationContext,
  mutation,
  number,
  object,
  plain,
  type QueryContext,
  query,
  router,
  secrets,
  string,
  type Webhook,
  type WebhookContext,
} from "apps";
import { debugshareIdPattern, isDebugshareId } from "./ids.js";
import {
  Detail,
  Explore,
  type FeedEvent,
  type IndexRow,
  Inspection,
  Report,
  SearchInput,
  SearchResult,
  Summary,
  statuses,
} from "./schema.js";

// This account identifies the uploader, not an upstream API credential.
// The webhook's separate generated signing secret is the only upload authority.
const source = defineProvider({
  name: "Computah diagnostic source",
  auth: {
    source: secrets({
      label: "Source reference",
      fields: object({ reference: plain(string({ minLength: 1 })) }),
    }),
  },
});
const requirements = { app: { accounts: { sources: source.many() } } };
type Read = QueryContext<typeof requirements>;
type Write = MutationContext<typeof requirements>;
type IssueRow = Infer<typeof Summary> & { report: string };
type ReportData = Infer<typeof Report>;

function validateReport(value: ReportData) {
  if (
    !isDebugshareId(value.id) ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    value.messages.length > 21 ||
    value.participants.length > 21 ||
    value.submissions.length > 20 ||
    value.activity.length > 100 ||
    value.limitations.length > 100 ||
    JSON.stringify(value).length > 150_000 ||
    (value.source.thread !== null && typeof value.source.thread !== "string")
  )
    throw new Error("Invalid bounded diagnostic report");
  if (value.messages.some((m) => m.text.length > 20_000))
    throw new Error("Diagnostic message too large");
  for (const span of [value.transport, value.capture])
    if (
      span &&
      (!/^[a-f0-9]{32}$/.test(span.traceId) ||
        /^0+$/.test(span.traceId) ||
        !/^[a-f0-9]{16}$/.test(span.spanId) ||
        /^0+$/.test(span.spanId))
    )
      throw new Error("Invalid diagnostic trace correlation");
}

function receive(sql: Write["sql"], report: ReportData) {
  validateReport(report);
  return sql.transaction(() => {
    const prior = sql
      .exec<IssueRow>("SELECT * FROM issues WHERE id=?", report.id)
      .toArray()[0];
    const body = JSON.stringify(report);
    if (prior) {
      if (prior.report !== body)
        throw new Error(
          "Issue ID already belongs to a different immutable snapshot",
        );
      return { id: prior.id };
    }
    const now = new Date().toISOString();
    const command =
      report.messages.find((m) => m.ts === report.source.message)?.text ??
      "DEBUGSHARE";
    const title =
      command
        .replace(/^\s*DEBUGSHARE\s*/u, "")
        .trim()
        .slice(0, 140) || `Report from ${report.source.channel}`;
    sql.exec(
      "INSERT INTO issues(id,title,status,report,created,updated) VALUES(?,?,'open',?,?,?)",
      report.id,
      title,
      body,
      report.requestedAt,
      now,
    );
    sql.exec(
      "INSERT INTO issue_events VALUES(?,?,'open','capture','Durable conversation snapshot indexed',?)",
      crypto.randomUUID(),
      report.id,
      now,
    );
    return { id: report.id };
  });
}

export const listIssues = query(
  {
    description:
      "List the latest 100 internal DEBUGSHARE issues for authorized operators",
    input: object({}),
    output: array(Summary),
  },
  async ({ sql }: Read) =>
    sql
      .exec<IssueRow>(
        "SELECT id,title,status,assignee,revision,created,updated FROM issues ORDER BY updated DESC,id LIMIT 100",
      )
      .toArray(),
);
export const getIssue = query(
  {
    description:
      "Resolve an exact DEBUGSHARE issue ID (including legacy UUIDs) to its immutable conversation snapshot and resolution history",
    input: object({ id: string() }),
    output: Detail,
  },
  async ({ sql }: Read, { id }) => {
    if (!isDebugshareId(id)) throw new Error("Invalid issue ID");
    const row = sql
      .exec<IssueRow>("SELECT * FROM issues WHERE id=?", id)
      .toArray()[0];
    if (!row)
      throw new Error(
        "No captured report for that issue ID. Older identifier-only DEBUGSHAREs have no retained context.",
      );
    return {
      issue: row,
      report: Report.parse(JSON.parse(row.report)),
      events: sql
        .exec<{
          id: string;
          status: string;
          actor: string;
          note: string;
          created: string;
        }>(
          "SELECT id,status,actor,note,created FROM issue_events WHERE issue=? ORDER BY created,id LIMIT 200",
          id,
        )
        .toArray(),
    };
  },
);
// Explorer reads. All are bounded, read-only and covered by the same Executor
// app access as getIssue; none returns more than one full snapshot.
const indexSql = `SELECT id,title,status,assignee,revision,created,updated,
  length(CAST(report AS BLOB)) AS bytes,
  json_extract(report,'$.requestedAt') AS requestedAt,
  json_extract(report,'$.requestedBy') AS requestedBy,
  json_extract(report,'$.source.team') AS team,
  json_extract(report,'$.source.channel') AS channel,
  json_extract(report,'$.source.message') AS message,
  json_extract(report,'$.source.thread') AS thread,
  json_extract(report,'$.scope.tenantId') AS tenantId,
  json_extract(report,'$.scope.userId') AS userId,
  json_extract(report,'$.scope.agentId') AS agentId,
  json_extract(report,'$.transport.requestId') AS requestId,
  json_extract(report,'$.transport.traceId') AS transportTrace,
  json_extract(report,'$.transport.spanId') AS transportSpan,
  json_extract(report,'$.capture.traceId') AS captureTrace,
  json_extract(report,'$.capture.spanId') AS captureSpan,
  json_extract(report,'$.participants') AS participants,
  json_extract(report,'$.submissions') AS submissions,
  json_array_length(report,'$.messages') AS messageCount,
  json_array_length(report,'$.submissions') AS submissionCount,
  json_array_length(report,'$.activity') AS activityCount,
  json_array_length(report,'$.limitations') AS limitationCount,
  (SELECT count(*) FROM issue_events e WHERE e.issue=issues.id) AS eventCount,
  (SELECT min(created) FROM issue_events e WHERE e.issue=issues.id AND e.actor<>'capture') AS firstResponse,
  (SELECT actor FROM issue_events e WHERE e.issue=issues.id ORDER BY created DESC,id DESC LIMIT 1) AS lastActor,
  (SELECT substr(note,1,280) FROM issue_events e WHERE e.issue=issues.id ORDER BY created DESC,id DESC LIMIT 1) AS lastNote
  FROM issues ORDER BY updated DESC,id LIMIT 500`;
const feedSql = `SELECT e.id,e.issue,i.title,e.status,e.actor,e.note,e.created
  FROM issue_events e JOIN issues i ON i.id=e.issue`;
type FeedRow = Infer<typeof FeedEvent>;

export const explore = query(
  {
    description:
      "Explorer index: up to 500 newest-updated issues with extracted report metadata (source, scope, trace correlation, counts, latest event), the 500 newest history events and table totals",
    input: object({}),
    output: Explore,
  },
  async ({ sql }: Read) => {
    const issues = sql
      .exec<Record<string, string | number | null>>(indexSql)
      .toArray()
      .map((row) => ({
        ...row,
        participants: JSON.parse(String(row.participants ?? "[]")),
        submissions: JSON.parse(String(row.submissions ?? "[]")),
        lastActor: row.lastActor ?? "",
        lastNote: row.lastNote ?? "",
      }));
    const totals = sql
      .exec<{ issues: number; messages: number; bytes: number }>(
        "SELECT count(*) AS issues, coalesce(sum(json_array_length(report,'$.messages')),0) AS messages, coalesce(sum(length(CAST(report AS BLOB))),0) AS bytes FROM issues",
      )
      .one();
    const events = sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM issue_events")
      .one().n;
    return {
      issues: issues as unknown as Infer<typeof IndexRow>[],
      events: sql
        .exec<FeedRow>(`${feedSql} ORDER BY e.created DESC,e.id LIMIT 500`)
        .toArray(),
      totals: { ...totals, events },
    };
  },
);

export const search = query(
  {
    description:
      "Search stored reports and history. text matches issue IDs, titles, assignees, full snapshot JSON, message text and event notes (case-insensitive); author/channel/submission/trace/actor are exact filters. Empty strings mean no filter. Messages are deduplicated across overlapping snapshots (max 200).",
    input: SearchInput,
    output: SearchResult,
  },
  async ({ sql }: Read, input) => {
    const f = {
      text: input.text.trim(),
      author: input.author.trim(),
      channel: input.channel.trim(),
      submission: input.submission.trim(),
      trace: input.trace.trim(),
      actor: input.actor.trim(),
    };
    if (Object.values(f).some((v) => v.length > 200))
      throw new Error("Search terms are limited to 200 characters");
    if (!Object.values(f).some(Boolean))
      return { issues: [], messages: [], events: [] };
    const text = f.text.toLowerCase() || null;
    const issues = sql
      .exec<{ id: string }>(
        `SELECT id FROM issues WHERE
          (?1 IS NULL OR instr(lower(id||' '||title||' '||assignee||' '||report),?1)>0)
          AND (?2='' OR EXISTS(SELECT 1 FROM json_each(report,'$.participants') p WHERE p.value=?2))
          AND (?3='' OR json_extract(report,'$.source.channel')=?3)
          AND (?4='' OR EXISTS(SELECT 1 FROM json_each(report,'$.submissions') s WHERE s.value=?4))
          AND (?5='' OR json_extract(report,'$.capture.traceId')=?5 OR json_extract(report,'$.transport.traceId')=?5
               OR EXISTS(SELECT 1 FROM issue_events e WHERE e.issue=issues.id AND instr(e.note,?5)>0))
          AND (?6='' OR EXISTS(SELECT 1 FROM issue_events e WHERE e.issue=issues.id AND e.actor=?6))
          ORDER BY updated DESC,id LIMIT 500`,
        text,
        f.author,
        f.channel,
        f.submission,
        f.trace,
        f.actor,
      )
      .toArray()
      .map((row) => row.id);
    const messages = new Map<
      string,
      {
        channel: string;
        ts: string;
        author: string;
        text: string;
        issues: string[];
      }
    >();
    if (!f.submission && !f.trace && !f.actor)
      for (const row of sql
        .exec<{
          issue: string;
          channel: string;
          ts: string;
          author: string;
          text: string;
        }>(
          `SELECT i.id AS issue, json_extract(i.report,'$.source.channel') AS channel,
            json_extract(m.value,'$.ts') AS ts, json_extract(m.value,'$.author') AS author,
            substr(json_extract(m.value,'$.text'),1,4000) AS text
          FROM issues i, json_each(i.report,'$.messages') m
          WHERE (?1 IS NULL OR instr(lower(json_extract(m.value,'$.text')),?1)>0)
            AND (?2='' OR json_extract(m.value,'$.author')=?2)
            AND (?3='' OR json_extract(i.report,'$.source.channel')=?3)
          ORDER BY ts DESC LIMIT 1000`,
          text,
          f.author,
          f.channel,
        )
        .toArray()) {
        const key = `${row.channel}\u0000${row.ts}`;
        const seen = messages.get(key);
        if (seen) seen.issues.push(row.issue);
        else if (messages.size < 200)
          messages.set(key, {
            channel: row.channel,
            ts: row.ts,
            author: row.author,
            text: row.text,
            issues: [row.issue],
          });
      }
    const events =
      f.author || f.channel || f.submission
        ? []
        : sql
            .exec<FeedRow>(
              `${feedSql} WHERE (?1 IS NULL OR instr(lower(e.note||' '||e.actor),?1)>0)
                AND (?2='' OR instr(e.note,?2)>0) AND (?3='' OR e.actor=?3)
                ORDER BY e.created DESC,e.id LIMIT 200`,
              text,
              f.trace,
              f.actor,
            )
            .toArray();
    return { issues, messages: [...messages.values()], events };
  },
);

export const inspectIssue = query(
  {
    description:
      "getIssue plus snapshot provenance (stored byte size and SHA-256 of the immutable stored JSON) and related issues with explicit reasons: same conversation, shared captured messages or submission handles, same trace, or exact ID mentions",
    input: object({ id: string() }),
    output: Inspection,
  },
  async ({ sql }: Read, { id }) => {
    if (!isDebugshareId(id)) throw new Error("Invalid issue ID");
    const row = sql
      .exec<IssueRow>("SELECT * FROM issues WHERE id=?", id)
      .toArray()[0];
    if (!row)
      throw new Error(
        "No captured report for that issue ID. Older identifier-only DEBUGSHAREs have no retained context.",
      );
    const report = Report.parse(JSON.parse(row.report));
    const bytes = new TextEncoder().encode(row.report);
    const sha256 = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const reasons = new Map<string, string[]>();
    const add = (other: string, reason: string) => {
      if (other === id) return;
      reasons.set(other, [...(reasons.get(other) ?? []), reason]);
    };
    const thread =
      typeof report.source.thread === "string" ? report.source.thread : null;
    for (const r of sql
      .exec<{ id: string }>(
        `SELECT id FROM issues WHERE id<>?1 AND json_extract(report,'$.source.team')=?2
          AND json_extract(report,'$.source.channel')=?3 AND json_extract(report,'$.source.thread') IS ?4 LIMIT 100`,
        id,
        report.source.team,
        report.source.channel,
        thread,
      )
      .toArray())
      add(r.id, "same conversation");
    const counted = (label: string, query: string, ...params: string[]) => {
      if (params.at(-1) === "[]") return;
      for (const r of sql
        .exec<{ id: string; n: number }>(query, id, ...params)
        .toArray())
        add(r.id, `${r.n} shared ${label}${r.n === 1 ? "" : "s"}`);
    };
    counted(
      "captured message",
      `SELECT i.id, count(*) AS n FROM issues i, json_each(i.report,'$.messages') m
        WHERE i.id<>?1 AND json_extract(i.report,'$.source.channel')=?2
          AND json_extract(m.value,'$.ts') IN (SELECT value FROM json_each(?3))
        GROUP BY i.id LIMIT 100`,
      report.source.channel,
      JSON.stringify(report.messages.map((m) => m.ts)),
    );
    counted(
      "submission handle",
      `SELECT i.id, count(*) AS n FROM issues i, json_each(i.report,'$.submissions') s
        WHERE i.id<>?1 AND s.value IN (SELECT value FROM json_each(?2))
        GROUP BY i.id LIMIT 100`,
      JSON.stringify(report.submissions),
    );
    const traces = [report.capture?.traceId, report.transport?.traceId].filter(
      (t): t is string => Boolean(t),
    );
    for (const trace of new Set(traces))
      for (const r of sql
        .exec<{ id: string }>(
          `SELECT id FROM issues WHERE id<>?1 AND (json_extract(report,'$.capture.traceId')=?2
            OR json_extract(report,'$.transport.traceId')=?2) LIMIT 100`,
          id,
          trace,
        )
        .toArray())
        add(r.id, "same trace");
    for (const r of sql
      .exec<{ id: string }>(
        `SELECT id FROM issues WHERE id<>?1 AND instr(report,?1)>0
          UNION SELECT issue AS id FROM issue_events WHERE issue<>?1 AND instr(note,?1)>0 LIMIT 100`,
        id,
      )
      .toArray())
      add(r.id, "mentions this issue");
    const pattern = new RegExp(debugshareIdPattern, "gu");
    const mentioned = new Set(
      [
        ...row.report.matchAll(pattern),
        ...sql
          .exec<{ note: string }>(
            "SELECT note FROM issue_events WHERE issue=? LIMIT 200",
            id,
          )
          .toArray()
          .flatMap((e) => [...e.note.matchAll(pattern)]),
      ].map((m) => m[0]),
    );
    mentioned.delete(id);
    const known = mentioned.size
      ? sql
          .exec<{ id: string }>(
            "SELECT id FROM issues WHERE id IN (SELECT value FROM json_each(?))",
            JSON.stringify([...mentioned].slice(0, 100)),
          )
          .toArray()
      : [];
    for (const r of known) add(r.id, "mentioned here");
    const summaries = reasons.size
      ? sql
          .exec<{
            id: string;
            title: string;
            status: string;
            created: string;
          }>(
            "SELECT id,title,status,created FROM issues WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created DESC",
            JSON.stringify([...reasons.keys()]),
          )
          .toArray()
      : [];
    return {
      issue: {
        id: row.id,
        title: row.title,
        status: row.status,
        assignee: row.assignee,
        revision: row.revision,
        created: row.created,
        updated: row.updated,
      },
      report,
      events: sql
        .exec<{
          id: string;
          status: string;
          actor: string;
          note: string;
          created: string;
        }>(
          "SELECT id,status,actor,note,created FROM issue_events WHERE issue=? ORDER BY created,id LIMIT 200",
          id,
        )
        .toArray(),
      snapshot: { bytes: bytes.byteLength, sha256 },
      related: summaries.map((s) => ({
        ...s,
        reasons: reasons.get(s.id) ?? [],
      })),
    };
  },
);

export const receiveIssue = mutation(
  {
    description:
      "Import one bounded diagnostic report as an authorized operator. Repeating the same issue ID and snapshot is idempotent; conflicts never overwrite it.",
    input: Report,
    output: object({ id: string() }),
  },
  async ({ sql }: Write, report) => receive(sql, report),
);
export const updateIssue = mutation(
  {
    description:
      "Track investigation, blocked, resolved or reopened state with a concise evidence note. Requires current revision; actor is declared attribution, not authenticated identity.",
    input: object({
      id: string(),
      expectedRevision: number(),
      status: string(),
      assignee: string(),
      actor: string(),
      note: string(),
    }),
    output: Summary,
  },
  async ({ sql }: Write, input) => {
    if (
      !isDebugshareId(input.id) ||
      !statuses.includes(input.status as (typeof statuses)[number]) ||
      !input.actor.trim() ||
      !input.note.trim() ||
      input.note.length > 4000 ||
      input.actor.length > 200 ||
      input.assignee.length > 200
    )
      throw new Error(
        "Choose a valid state and provide bounded actor attribution and an evidence note",
      );
    return sql.transaction(() => {
      const row = sql
        .exec<IssueRow>("SELECT * FROM issues WHERE id=?", input.id)
        .toArray()[0];
      if (!row) throw new Error("Issue not found");
      if (row.revision !== input.expectedRevision)
        throw new Error(
          "Issue changed. Refresh before updating; nothing was overwritten.",
        );
      const now = new Date().toISOString();
      sql.exec(
        "UPDATE issues SET status=?,assignee=?,revision=revision+1,updated=? WHERE id=? AND revision=?",
        input.status,
        input.assignee,
        now,
        input.id,
        input.expectedRevision,
      );
      sql.exec(
        "INSERT INTO issue_events VALUES(?,?,?,?,?,?)",
        crypto.randomUUID(),
        input.id,
        input.status,
        input.actor.trim(),
        input.note.trim(),
        now,
      );
      return sql
        .exec<IssueRow>(
          "SELECT id,title,status,assignee,revision,created,updated FROM issues WHERE id=?",
          input.id,
        )
        .one();
    });
  },
);

const config = object({
  team: string(),
  tenantId: string(),
  userId: string(),
  agentId: string(),
});
const empty = object({});
const capture = {
  account: { app: "sources" },
  config,
  state: empty,
  setup: {
    instructions:
      "Copy callback URL and generated signing secret directly into the protected Slack runtime environment, never into chat. Configure COMPUTAH_DEBUGSHARE_INGEST_URL and COMPUTAH_DEBUGSHARE_SIGNING_SECRET. Pin this subscription to exactly one trusted Slack/core scope. Set COMPUTAH_DEBUGSHARE_REPORT_URL to the authenticated app URL.",
    signingSecret: "executor",
  },
  async handle(ctx, { request, secret, config }) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const timestamp = request.headers.get("x-computah-timestamp") ?? "";
    const signature = request.headers.get("x-computah-signature") ?? "";
    if (
      !/^\d{13}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp)) > 300_000 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return new Response(null, { status: 401 });
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 450_000) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder().decode(bytes);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(signature.match(/../g) ?? [], (s) =>
        Number.parseInt(s, 16),
      ),
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    if (!valid) return new Response(null, { status: 401 });
    try {
      const report = Report.parse(JSON.parse(body));
      if (
        report.source.team !== config.team ||
        report.scope.tenantId !== config.tenantId ||
        report.scope.userId !== config.userId ||
        report.scope.agentId !== config.agentId
      )
        return new Response(null, { status: 403 });
      return Response.json(receive(ctx.sql, report));
    } catch {
      return Response.json(
        { error: "Invalid report or conflicting immutable issue ID" },
        { status: 409 },
      );
    }
  },
} satisfies Webhook<
  WebhookContext<typeof requirements, "app">,
  typeof config,
  typeof empty
>;

export default defineApp(requirements, {
  tools: router(
    {
      listIssues,
      getIssue,
      explore,
      search,
      inspectIssue,
      receiveIssue,
      updateIssue,
    },
    {
      instructions:
        "Use exact DEBUGSHARE issue ID lookup (new computah_bug_ IDs or legacy UUIDs). explore, search and inspectIssue are bounded read-only views for cross-issue navigation. Reports show actual bounded messages and location. Use updateIssue with current revision and concise investigation evidence; do not claim repair from status alone. Actor attribution is self-declared; Executor authenticates callers and controls app access. Never insert credentials or hidden model reasoning. This app is an operator boundary, not a multi-tenant public service.",
    },
  ),
  webhooks: { capture },
});
