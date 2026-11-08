import { DatabaseSync } from "node:sqlite";
import { traceInterval } from "@computah/observability";

export interface TimingScope {
  tenantId: string;
  userId: string;
  agentId: string;
}

export interface SlackTimingSnapshot {
  traceparent: string | null;
  receivedAt: number | null;
  senderTs: string | null;
  admittedAt: number | null;
  firstDequeuedAt: number | null;
  state: string;
  receipts: {
    receivedAt: number | null;
    senderTs: string | null;
    admittedAt: number | null;
  }[];
  phases: {
    phase: string;
    attempt: number;
    started: number;
    completed: number | null;
    outcome: string | null;
  }[];
}

/** Host-only reader. Scope must come from the authorized native request, never
 * model arguments or a trace header. Opening this does not resume/repair jobs.
 */
export function readTimingSnapshot(
  path: string,
  requestId: string,
  scope: TimingScope,
): SlackTimingSnapshot | null {
  const started = Date.now();
  const db = new DatabaseSync(path, { readOnly: true, timeout: 250 });
  try {
    db.exec("BEGIN");
    const result = projectTiming(db, requestId, scope);
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
    traceInterval("slack.timing", started, Date.now(), {});
  }
}

/** Same positive projection for the running adapter and read-only host reader. */
export function projectTiming(
  db: DatabaseSync,
  requestId: string,
  scope: TimingScope,
): SlackTimingSnapshot | null {
  if (!/^input:slack:[a-f0-9]{64}$/.test(requestId)) return null;
  const id = requestId.slice("input:".length);
  const job = db.prepare("SELECT binding,state FROM jobs WHERE id=?").get(id) as
    | { binding: string; state: string }
    | undefined;
  if (!job) return null;
  const binding = JSON.parse(job.binding) as string[];
  if (
    binding[2] !== scope.tenantId ||
    binding[3] !== scope.userId ||
    binding[4] !== scope.agentId
  )
    return null;
  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const timing = tables.has("job_timing")
    ? (db
        .prepare(
          "SELECT traceparent,received,sender_ts,admitted,dequeued FROM job_timing WHERE job=?",
        )
        .get(id) as
        | {
            traceparent: string | null;
            received: number | null;
            sender_ts: string | null;
            admitted: number | null;
            dequeued: number | null;
          }
        | undefined)
    : undefined;
  const carrier = timing?.traceparent;
  const phases = tables.has("job_phases")
    ? (db
        .prepare(
          "SELECT phase,attempt,started,completed,outcome FROM job_phases WHERE job=? ORDER BY started,rowid LIMIT 2049",
        )
        .all(id) as SlackTimingSnapshot["phases"])
    : [];
  if (phases.length > 2048) throw new Error("Timing snapshot exceeds bound");
  return {
    traceparent:
      carrier &&
      /^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-0[01]$/.test(carrier)
        ? carrier
        : null,
    receivedAt: timing?.received ?? null,
    senderTs: timing?.sender_ts ?? null,
    admittedAt: timing?.admitted ?? null,
    firstDequeuedAt: timing?.dequeued ?? null,
    state: job.state,
    receipts: tables.has("receipt_timing")
      ? (db
          .prepare(
            "SELECT t.received AS receivedAt,t.sender_ts AS senderTs,t.admitted AS admittedAt FROM receipts r LEFT JOIN receipt_timing t ON t.event=r.event WHERE r.job=? ORDER BY r.rowid",
          )
          .all(id) as SlackTimingSnapshot["receipts"])
      : [],
    phases,
  };
}
