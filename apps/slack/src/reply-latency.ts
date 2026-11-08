import type { DatabaseSync } from "node:sqlite";
import {
  type ReplyMetricSnapshot,
  registerReplyMetrics,
  runtimeLog,
  runtimeReplyDuration,
  runtimeSlackReplyLatency,
  withTraceContext,
} from "@computah/observability";

/** Private receipt facts and bounded telemetry outbox, not a delivery retry queue.
 * Historical receipts have no row: migration cannot infer past answer delivery.
 */
export class ReplyLatency {
  private unregister = () => {};
  constructor(private readonly db: DatabaseSync) {
    this.optional(() =>
      db.exec(`CREATE TABLE IF NOT EXISTS reply_receipts (
      event TEXT PRIMARY KEY, received INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS reply_latency_outbox (
      event TEXT NOT NULL, phase TEXT NOT NULL, observed INTEGER NOT NULL,
      confirmed INTEGER, elapsed INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(event,phase)
    );
    CREATE INDEX IF NOT EXISTS reply_receipts_pending ON reply_receipts(state,received);
    CREATE INDEX IF NOT EXISTS reply_latency_pending ON reply_latency_outbox(sent,observed);`),
    );
    this.optional(() => {
      const columns = (table: string) =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).map((c) => c.name);
      if (!columns("reply_receipts").includes("metric_outcome"))
        db.exec("ALTER TABLE reply_receipts ADD COLUMN metric_outcome TEXT");
      // Existing confirmed observations are not backfilled on activation.
      if (!columns("reply_latency_outbox").includes("metric_sent"))
        db.exec(
          "ALTER TABLE reply_latency_outbox ADD COLUMN metric_sent INTEGER NOT NULL DEFAULT 1",
        );
      db.exec(`CREATE INDEX IF NOT EXISTS reply_metrics_pending ON reply_latency_outbox(observed,event)
        WHERE phase='confirmed' AND metric_sent=0;
      CREATE TABLE IF NOT EXISTS reply_metric_totals (
        outcome TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS reply_metric_terminal AFTER UPDATE OF state ON reply_receipts
      WHEN OLD.metric_outcome IS NULL AND NEW.state IN ('confirmed','failed','denied','cancelled')
      BEGIN UPDATE reply_receipts SET metric_outcome=CASE NEW.state
        WHEN 'confirmed' THEN 'success' WHEN 'cancelled' THEN 'cancel' ELSE 'error' END WHERE event=NEW.event; END;
      CREATE TRIGGER IF NOT EXISTS reply_metric_count AFTER UPDATE OF metric_outcome ON reply_receipts
      WHEN OLD.metric_outcome IS NULL AND NEW.metric_outcome IS NOT NULL
      BEGIN UPDATE reply_metric_totals SET total=total+1 WHERE outcome=NEW.metric_outcome; END;`);
      const started = Date.now();
      for (const outcome of ["success", "error", "cancel", "uncertain"])
        db.prepare(
          "INSERT OR IGNORE INTO reply_metric_totals(outcome,started) VALUES(?,?)",
        ).run(outcome, started);
      this.unregister = registerReplyMetrics(() => this.snapshot());
    });
  }

  close() {
    this.unregister();
  }

  /** Fresh durable census at every OTel collection, even without ingress/step().
   * Keep the old unanswered diagnostic cohort: uncertainty ends metric pending,
   * but never falsely confirms a reply or suppresses its overdue diagnostic.
   */
  private snapshot(): ReplyMetricSnapshot {
    this.db
      .prepare(`UPDATE reply_receipts SET metric_outcome='uncertain'
      WHERE metric_outcome IS NULL AND state IN ('pending','answer') AND event IN
      (SELECT r.event FROM receipts r JOIN jobs j ON j.id=r.job WHERE j.state='uncertain')`)
      .run();
    const pending = this.db
      .prepare(
        "SELECT count(*) AS n FROM reply_receipts WHERE state IN ('pending','answer') AND metric_outcome IS NULL",
      )
      .get() as { n: number };
    const rows = this.db
      .prepare("SELECT outcome,total,started FROM reply_metric_totals")
      .all() as {
      outcome: keyof ReplyMetricSnapshot["outcomes"];
      total: number;
      started: number;
    }[];
    const outcomes = { success: 0, error: 0, cancel: 0, uncertain: 0 };
    for (const row of rows) outcomes[row.outcome] = row.total;
    return { pending: pending.n, outcomes, startedAtMs: rows[0].started };
  }

  admit(event: string, received: number) {
    this.optional(() =>
      this.db
        .prepare("INSERT INTO reply_receipts(event,received) VALUES(?,?)")
        .run(event, received),
    );
  }

  prune() {
    this.optional(() =>
      this.db.exec(`DELETE FROM reply_latency_outbox WHERE event NOT IN (SELECT event FROM receipts);
      DELETE FROM reply_receipts WHERE event NOT IN (SELECT event FROM receipts);`),
    );
  }

  /** Persist answer qualification before crossing the possibly ambiguous send. */
  answer(job: string) {
    this.optional(() =>
      this.db
        .prepare(
          "UPDATE reply_receipts SET state='answer' WHERE state='pending' AND event IN (SELECT event FROM receipts WHERE job=?)",
        )
        .run(job),
    );
  }

  settle(job: string, outcome: "failed" | "denied" | "cancelled", now: number) {
    this.optional(() => {
      // Preserve a breach between timer ticks before terminal closure removes it
      // from the pending cohort. This is not confirmation of a diagnostic post.
      this.db
        .prepare(`INSERT OR IGNORE INTO reply_latency_outbox(event,phase,observed,elapsed)
      SELECT t.event,'overdue',?,?-t.received FROM reply_receipts t
      JOIN receipts r ON r.event=t.event WHERE r.job=? AND t.state IN ('pending','answer') AND ?-t.received>5000`)
        .run(now, now, job, now);
    });
    this.optional(() => {
      const result = this.db
        .prepare(
          "UPDATE reply_receipts SET state=? WHERE state IN ('pending','answer') AND event IN (SELECT event FROM receipts WHERE job=?)",
        )
        .run(outcome, job);
      if (result.changes)
        runtimeLog("operation.completed", {
          operation: "delivery",
          outcome: outcome === "failed" ? "error" : outcome,
        });
    });
  }

  private optional(body: () => unknown) {
    try {
      body();
    } catch {
      runtimeLog(
        "runtime.report",
        { outcome: "error", reason: "storage_failed" },
        "warn",
      );
    }
  }

  /** Called only after the actual answer's awaited provider post succeeded. */
  confirm(job: string, now: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO reply_latency_outbox(event,phase,observed,confirmed,elapsed,metric_sent)
           SELECT t.event,'confirmed',?,?,max(0,?-t.received),0 FROM reply_receipts t
           JOIN receipts r ON r.event=t.event WHERE r.job=? AND t.state='answer'`,
        )
        .run(now, now, now, job);
      this.db
        .prepare(
          "UPDATE reply_receipts SET state='confirmed' WHERE state='answer' AND event IN (SELECT event FROM receipts WHERE job=?)",
        )
        .run(job);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Independent of core waits. At most 128 new facts/exports per tick, no samples.
   * Queue acceptance is not Axiom ingestion; crash/replay can duplicate exports.
   */
  flush(now: number) {
    // Independent of log queue availability. At most 128 durations enter the
    // bounded SDK aggregation per tick; acceptance is not remote ingestion.
    this.optional(() => {
      for (const row of this.db
        .prepare(
          "SELECT event,elapsed FROM reply_latency_outbox WHERE phase='confirmed' AND metric_sent=0 ORDER BY observed,event LIMIT 128",
        )
        .all() as { event: string; elapsed: number }[]) {
        if (!runtimeReplyDuration(row.elapsed)) break;
        this.db
          .prepare(
            "UPDATE reply_latency_outbox SET metric_sent=1 WHERE event=? AND phase='confirmed'",
          )
          .run(row.event);
      }
    });
    this.db
      .prepare(
        `INSERT OR IGNORE INTO reply_latency_outbox(event,phase,observed,elapsed)
         SELECT event,'overdue',?,?-received FROM reply_receipts t
         WHERE state IN ('pending','answer') AND ?-received>5000
         AND NOT EXISTS (SELECT 1 FROM reply_latency_outbox o WHERE o.event=t.event AND o.phase='overdue')
         ORDER BY received,event LIMIT 128`,
      )
      .run(now, now, now);
    const rows = this.db
      .prepare(
        `SELECT o.*,t.received,j.traceparent FROM reply_latency_outbox o
         JOIN reply_receipts t ON t.event=o.event JOIN receipts r ON r.event=o.event
         LEFT JOIN job_timing j ON j.job=r.job WHERE o.sent=0 ORDER BY o.observed,o.event,o.phase LIMIT 128`,
      )
      .all() as unknown as {
      event: string;
      phase: "overdue" | "confirmed";
      observed: number;
      confirmed: number | null;
      elapsed: number;
      received: number;
      traceparent: string | null;
    }[];
    for (const row of rows) {
      const parent: Record<string, string> = row.traceparent
        ? { traceparent: row.traceparent }
        : {};
      const accepted = withTraceContext(parent, () =>
        runtimeSlackReplyLatency({
          messageId: row.event.slice("slack:".length),
          receivedAtMs: row.received,
          observedAtMs: row.observed,
          ...(row.phase === "confirmed"
            ? {
                phase: "confirmed" as const,
                confirmedAtMs: row.confirmed as number,
              }
            : { phase: "overdue" as const }),
          elapsedMs: row.elapsed,
          thresholdMs: 5000,
        }),
      );
      if (!accepted) return "retry";
      this.db
        .prepare(
          "UPDATE reply_latency_outbox SET sent=1 WHERE event=? AND phase=?",
        )
        .run(row.event, row.phase);
    }
    return rows.length ? "success" : "idle";
  }
}
