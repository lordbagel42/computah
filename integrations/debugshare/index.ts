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
import { Detail, Report, Summary, statuses } from "./schema.js";

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
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function validateReport(value: ReportData) {
  if (
    !uuid.test(value.id) ||
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
          "UUID already belongs to a different immutable snapshot",
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
      "Resolve an exact DEBUGSHARE UUID to its immutable conversation snapshot and resolution history",
    input: object({ id: string() }),
    output: Detail,
  },
  async ({ sql }: Read, { id }) => {
    const row = sql
      .exec<IssueRow>("SELECT * FROM issues WHERE id=?", id)
      .toArray()[0];
    if (!row)
      throw new Error(
        "No captured report for that UUID. Older identifier-only DEBUGSHAREs have no retained context.",
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
export const receiveIssue = mutation(
  {
    description:
      "Import one bounded diagnostic report as an authorized operator. Repeating the same UUID and snapshot is idempotent; conflicts never overwrite it.",
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
        { error: "Invalid report or conflicting immutable UUID" },
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
    { listIssues, getIssue, receiveIssue, updateIssue },
    {
      instructions:
        "Use exact DEBUGSHARE UUID lookup. Reports show actual bounded messages and location. Use updateIssue with current revision and concise investigation evidence; do not claim repair from status alone. Actor attribution is self-declared; Executor authenticates callers and controls app access. Never insert credentials or hidden model reasoning. This app is an operator boundary, not a multi-tenant public service.",
    },
  ),
  webhooks: { capture },
});
