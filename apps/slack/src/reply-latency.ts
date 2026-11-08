import type { DatabaseSync } from "node:sqlite";
import {
  runtimeLog,
  runtimeSlackReplyLatency,
  withTraceContext,
} from "@computah/observability";

/** Private receipt facts and bounded telemetry outbox, not a delivery retry queue.
 * Historical receipts have no row: migration cannot infer past answer delivery.
 */
export class ReplyLatency {
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
          `INSERT OR IGNORE INTO reply_latency_outbox(event,phase,observed,confirmed,elapsed)
           SELECT t.event,'confirmed',?,?,max(0,?-t.received) FROM reply_receipts t
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
