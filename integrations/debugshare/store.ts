import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type { Infer } from "apps";
import { catalog } from "./catalog.js";
import { isDebugshareId } from "./ids.js";
import {
  explore,
  getIssue,
  getIssueTrace,
  inspectIssue,
  listIssues,
  receive,
  search,
  updateIssue,
  validateReport,
} from "./index.js";
import migration from "./migrations/0001_issues.sql";
import type { Context, Sql } from "./operations.js";
import { Event, Report, Summary } from "./schema.js";
import { type CapturePolicy, captureScopeAllowed } from "./scope.js";
import { boundedBody, equalSecret, signedCapture } from "./security.js";
import { Telemetry, traceParent } from "./telemetry.js";

const tools: Record<
  string,
  { invoke(context: Context, input: unknown): Promise<unknown> }
> = {
  explore,
  getIssue,
  getIssueTrace,
  inspectIssue,
  listIssues,
  search,
  updateIssue,
};
export const failure = (status: number) =>
  Response.json(
    {
      error:
        status === 401
          ? "Authentication required"
          : status === 403
            ? "Access denied"
            : status === 404
              ? "Not found"
              : "Invalid request or conflicting revision/snapshot",
    },
    { status },
  );
type Issue = Infer<typeof Summary> & { report: string };
type Notice = {
  issue: string;
  version: number;
  acknowledged: string;
  state: string;
  attempts: number;
  next: number;
  parent: string;
};

/** The fixed all-scopes operator tracker is one coordination atom, not a public tenant portal. */
export class IssueTracker extends DurableObject<Env> {
  private sql: Sql = {
    exec: <T extends Record<string, unknown>>(
      statement: string,
      ...bindings: (string | number | null)[]
    ) => {
      const rows = this.ctx.storage.sql.exec(statement, ...bindings);
      return {
        toArray: () => rows.toArray() as T[],
        one: () => rows.one() as T,
      };
    },
    transaction: <T>(body: () => T) => this.ctx.storage.transactionSync(body),
  };
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY)",
      );
      if (
        !this.ctx.storage.sql
          .exec("SELECT version FROM schema_versions WHERE version=1")
          .toArray().length
      ) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(migration);
          this.ctx.storage.sql.exec(
            "CREATE TABLE issue_notices(issue TEXT PRIMARY KEY REFERENCES issues(id),version INTEGER NOT NULL DEFAULT 1,acknowledged TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next INTEGER NOT NULL DEFAULT 0,parent TEXT NOT NULL DEFAULT '')",
          );
          this.ctx.storage.sql.exec("INSERT INTO schema_versions VALUES(1)");
        });
      }
      if (
        !this.ctx.storage.sql
          .exec("SELECT version FROM schema_versions WHERE version=2")
          .toArray().length
      ) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "ALTER TABLE issue_notices ADD COLUMN pending TEXT NOT NULL DEFAULT ''",
          );
          this.ctx.storage.sql.exec(
            "ALTER TABLE issue_notices ADD COLUMN accepted TEXT NOT NULL DEFAULT ''",
          );
          this.ctx.storage.sql.exec("INSERT INTO schema_versions VALUES(2)");
        });
      }
      if (
        this.sql
          .exec(
            "SELECT issue FROM issue_notices WHERE acknowledged='' AND state<>'held' LIMIT 1",
          )
          .toArray().length
      )
        await this.armBy(Date.now() + 1000);
    });
  }
  private context(request: Request): Context {
    return {
      sql: this.sql,
      signal: request.signal,
      fetch,
      traceToken: this.env.AXIOM_TRACE_READ_TOKEN,
    };
  }
  private notice(id: string) {
    return this.sql
      .exec<Notice>(
        "SELECT n.* FROM issue_notices n JOIN issues i ON i.id=n.issue WHERE n.issue=? AND n.version=1",
        id,
      )
      .toArray()[0];
  }
  private async armBy(time: number) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > time)
      await this.ctx.storage.setAlarm(time);
  }
  private async ingest(report: Infer<typeof Report>, parent: string) {
    await this.armBy(Date.now() + 1000);
    return this.sql.transaction(() => {
      const result = receive(this.sql, report);
      this.sql.exec(
        "INSERT OR IGNORE INTO issue_notices(issue,parent,pending) VALUES(?,?,?)",
        report.id,
        parent,
        new Date().toISOString(),
      );
      return result;
    });
  }
  private importRecords(input: unknown) {
    if (
      !input ||
      typeof input !== "object" ||
      !("issues" in input) ||
      !Array.isArray(input.issues) ||
      input.issues.length > 100
    )
      throw new Error("Invalid import");
    const rows = input.issues;
    return this.sql.transaction(() => {
      for (const value of rows) {
        const issue = Summary.parse(value.issue);
        const report = Report.parse(value.report);
        validateReport(report);
        if (
          issue.id !== report.id ||
          !Number.isInteger(issue.revision) ||
          issue.revision < 1 ||
          !Array.isArray(value.events) ||
          value.events.length > 200
        )
          throw new Error("Invalid import row");
        const raw = value.rawReport ?? value.snapshot?.rawReport;
        if (
          typeof raw !== "string" ||
          JSON.stringify(Report.parse(JSON.parse(raw))) !==
            JSON.stringify(report) ||
          createHash("sha256").update(raw).digest("hex") !==
            value.snapshot.sha256 ||
          new TextEncoder().encode(raw).length !== value.snapshot.bytes
        )
          throw new Error("Snapshot provenance mismatch");
        const prior = this.sql
          .exec<Issue>("SELECT * FROM issues WHERE id=?", issue.id)
          .toArray()[0];
        const notice = this.notice(issue.id);
        if (notice && notice.state !== "held")
          throw new Error("Migration cannot replace a live notice");
        if (
          prior &&
          Object.entries({ ...issue, report: raw }).some(
            ([key, field]) => prior[key as keyof Issue] !== field,
          )
        )
          throw new Error("Migration cannot overwrite live records");
        if (!prior)
          this.sql.exec(
            "INSERT INTO issues(id,title,status,assignee,revision,report,created,updated) VALUES(?,?,?,?,?,?,?,?)",
            issue.id,
            issue.title,
            issue.status,
            issue.assignee,
            issue.revision,
            raw,
            issue.created,
            issue.updated,
          );
        for (const entry of value.events) {
          if ("issue" in entry && entry.issue !== issue.id)
            throw new Error("Event belongs to another issue");
          const event = Event.parse(entry);
          const existing = this.sql
            .exec<Record<string, string>>(
              "SELECT * FROM issue_events WHERE id=?",
              event.id,
            )
            .toArray()[0];
          if (
            existing &&
            (existing.issue !== issue.id ||
              Object.entries(event).some(
                ([key, field]) => existing[key] !== field,
              ))
          )
            throw new Error("Event conflict");
          if (!existing)
            this.sql.exec(
              "INSERT INTO issue_events VALUES(?,?,?,?,?,?)",
              event.id,
              issue.id,
              event.status,
              event.actor,
              event.note,
              event.created,
            );
        }
        const count = this.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM issue_events WHERE issue=?",
            issue.id,
          )
          .one().n;
        if (
          count !== value.events.length ||
          new Set(value.events.map((entry: { id: string }) => entry.id))
            .size !== count
        )
          throw new Error("Incomplete history");
        // Historic records never dispatch, including later duplicate capture retries.
        this.sql.exec(
          "INSERT OR IGNORE INTO issue_notices(issue,state) VALUES(?,'held')",
          issue.id,
        );
      }
      return { imported: rows.length };
    });
  }
  async fetch(request: Request) {
    const span = new Telemetry(this.env.AXIOM_TELEMETRY_TOKEN).start(
      new URL(request.url).pathname === "/api/reconcile"
        ? "computah.debugshare.reconcile"
        : "computah.debugshare.store",
      traceParent(request.headers.get("traceparent")),
    );
    const traced = new Request(request);
    traced.headers.set(
      "traceparent",
      `00-${span.span.traceId}-${span.span.spanId}-01`,
    );
    try {
      const response = await this.handle(traced);
      this.ctx.waitUntil(
        span.end(
          response.ok
            ? "success"
            : response.status === 401 || response.status === 403
              ? "denied"
              : "error",
        ),
      );
      return response;
    } catch {
      this.ctx.waitUntil(
        span.end(request.signal.aborted ? "cancelled" : "error"),
      );
      return failure(409);
    }
  }
  private async handle(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/capture" && request.method === "POST") {
      // Keep pending host captures local until source reconciliation completes.
      if (String(this.env.CAPTURE_ENABLED) !== "true") return failure(503);
      const body = await boundedBody(request, 450_000);
      if (
        !this.env.CAPTURE_SIGNING_SECRET ||
        !signedCapture(
          body,
          request.headers.get("x-computah-timestamp") ?? "",
          request.headers.get("x-computah-signature") ?? "",
          this.env.CAPTURE_SIGNING_SECRET,
        )
      )
        return failure(401);
      const policy: CapturePolicy = JSON.parse(this.env.CAPTURE_POLICY);
      const report = Report.parse(JSON.parse(body));
      if (!policy.enrollment || !captureScopeAllowed(report, policy))
        return failure(403);
      return Response.json(
        await this.ingest(report, request.headers.get("traceparent") ?? ""),
      );
    }
    const noticeMatch = url.pathname.match(
      /^\/api\/issue-notices\/([^/]+)(\/ack)?$/,
    );
    if (noticeMatch) {
      if (
        !equalSecret(
          request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          this.env.NOTICE_TOKEN,
        )
      )
        return failure(401);
      const id = noticeMatch[1];
      if (!isDebugshareId(id)) return failure(404);
      const notice = this.notice(id);
      if (!notice || notice.state === "held") return failure(404);
      if (noticeMatch[2]) {
        if (request.method !== "POST") return failure(405);
        this.sql.exec(
          "UPDATE issue_notices SET acknowledged=CASE WHEN acknowledged='' THEN ? ELSE acknowledged END,state='acknowledged' WHERE issue=? AND version=1",
          new Date().toISOString(),
          id,
        );
      } else if (request.method !== "GET") return failure(405);
      return Response.json({
        issue: id,
        version: 1,
        acknowledged: this.notice(id)?.acknowledged ?? "",
      });
    }
    if (url.pathname.startsWith("/api/migration/")) {
      if (
        !equalSecret(
          request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
          this.env.MIGRATION_TOKEN,
        )
      )
        return failure(401);
      if (url.pathname === "/api/migration/import" && request.method === "POST")
        return Response.json(
          this.importRecords(JSON.parse(await boundedBody(request, 8_000_000))),
        );
      if (
        url.pathname === "/api/migration/export" &&
        request.method === "GET"
      ) {
        const rows = this.sql
          .exec<Issue>("SELECT * FROM issues ORDER BY id LIMIT 101")
          .toArray();
        if (rows.length > 100)
          throw new Error("Export exceeds bounded issue contract");
        const issues = rows.map(({ report, ...issue }) => {
          const events = this.sql
            .exec(
              "SELECT id,status,actor,note,created FROM issue_events WHERE issue=? ORDER BY created,id LIMIT 201",
              issue.id,
            )
            .toArray();
          if (events.length > 200)
            throw new Error("Export exceeds bounded history contract");
          return {
            issue,
            rawReport: report,
            report: JSON.parse(report),
            snapshot: {
              bytes: new TextEncoder().encode(report).length,
              sha256: createHash("sha256").update(report).digest("hex"),
            },
            events,
          };
        });
        return Response.json({
          bookmark: await this.ctx.storage.getCurrentBookmark(),
          issues,
          notices: this.sql
            .exec("SELECT * FROM issue_notices ORDER BY issue LIMIT 100")
            .toArray(),
        });
      }
      return failure(404);
    }
    if (request.headers.get("x-debug-operator") !== "authorized")
      return failure(401);
    if (url.pathname === "/api/reconcile" && request.method === "POST") {
      const input = JSON.parse(await boundedBody(request, 4096));
      if (
        !Array.isArray(input.ids) ||
        input.ids.length > 20 ||
        input.ids.some((id: unknown) => !isDebugshareId(id))
      )
        return failure(400);
      await this.armBy(Date.now() + 1000);
      for (const id of input.ids)
        this.sql.exec(
          "UPDATE issue_notices SET state='pending',next=0 WHERE issue=? AND acknowledged='' AND state<>'held'",
          id,
        );
      return Response.json({ queued: input.ids.length });
    }
    const name = url.pathname.match(/^\/api\/tools\/([a-zA-Z_]+)$/)?.[1];
    if (request.method !== "POST" || !name) return failure(404);
    if (
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return failure(415);
    const input = JSON.parse(await boundedBody(request, 450_000));
    if (Object.hasOwn(catalog, name))
      return Response.json(
        await catalog[name as keyof typeof catalog].run(
          this.context(request),
          input,
        ),
      );
    if (!Object.hasOwn(tools, name)) return failure(404);
    return Response.json(
      await tools[name].invoke(this.context(request), input),
    );
  }
  async alarm() {
    if (
      String(this.env.NOTICE_DELIVERY_ENABLED) !== "true" ||
      !this.env.NOTICE_CALLBACK_URL
    )
      return;
    // Durable recovery intent before SQL and outbound I/O; not platform retry exhaustion.
    await this.armBy(Date.now() + 60_000);
    const telemetry = new Telemetry(this.env.AXIOM_TELEMETRY_TOKEN);
    const rows = this.sql
      .exec<Notice>(
        "SELECT * FROM issue_notices WHERE acknowledged='' AND state IN ('pending','accepted') AND next<=? ORDER BY next,issue LIMIT 10",
        Date.now(),
      )
      .toArray();
    for (const row of rows) {
      if (this.notice(row.issue)?.acknowledged) continue;
      const attempts = row.attempts + 1;
      const next =
        Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(attempts, 12));
      await this.armBy(next);
      this.sql.exec(
        "UPDATE issue_notices SET attempts=?,next=? WHERE issue=? AND acknowledged=''",
        attempts,
        next,
        row.issue,
      );
      const span = telemetry.start(
        "computah.debugshare.notice",
        traceParent(row.parent),
      );
      try {
        const callback = new URL(this.env.NOTICE_CALLBACK_URL);
        if (callback.protocol !== "https:") throw new Error("Invalid callback");
        const response = await fetch(callback, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `debugshare:${row.issue}:v1`,
            traceparent: `00-${span.span.traceId}-${span.span.spanId}-01`,
          },
          body: JSON.stringify({ id: row.issue, version: 1 }),
        });
        await response.body?.cancel();
        if (response.ok)
          this.sql.exec(
            "UPDATE issue_notices SET state='accepted',accepted=CASE WHEN accepted='' THEN ? ELSE accepted END WHERE issue=? AND acknowledged=''",
            new Date().toISOString(),
            row.issue,
          );
        this.ctx.waitUntil(span.end(response.ok ? "queued" : "retry"));
      } catch {
        this.ctx.waitUntil(span.end("retry"));
      }
    }
    // Synchronous derivation includes captures/ACKs received during outbound I/O.
    const next = this.sql
      .exec<{ next: number | null }>(
        "SELECT min(next) AS next FROM issue_notices WHERE acknowledged='' AND state IN ('pending','accepted')",
      )
      .one().next;
    if (next !== null)
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
    else await this.ctx.storage.deleteAlarm();
  }
}
