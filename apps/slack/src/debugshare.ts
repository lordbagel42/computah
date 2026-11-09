import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DebugshareId } from "../../../packages/contracts/src/debugshare.js";

/** 24 unbiased base-36 draws: ~124 bits, independent of time, origin and credentials. */
export const createDebugshareId = (): DebugshareId =>
  `computah_bug_${Array.from({ length: 24 }, () => randomInt(36).toString(36)).join("")}` as DebugshareId;

export const isDebugshare = (text: string): boolean =>
  /^\s*DEBUGSHARE(?:\s|$)/u.test(text);

/** Deterministic command recognition; the host, never a model, mints the ID. */
export function debugshareReply(
  text: string,
  requestedBy: string,
  requestedAt: number,
  id: string = createDebugshareId(),
  reportUrl?: string,
): string | null {
  if (!isDebugshare(text)) return null;
  return `${id}\ntime: ${new Date(requestedAt).toISOString()}\nrequested by: ${requestedBy}\namp link: [disabled]${reportUrl ? `\nreport: ${reportUrl} (internal)` : ""}`;
}

export interface DebugReport {
  id: string;
  requestedAt: string;
  requestedBy: string;
  source: {
    team: string;
    channel: string;
    message: string;
    thread: string | null;
  };
  scope: { tenantId: string; userId: string; agentId: string };
  /** The command's transport receipt, not evidence of a core submission. */
  transport?: { requestId: string; traceId: string; spanId: string };
  capture?: { traceId: string; spanId: string };
  messages: { author: string; ts: string; text: string }[];
  participants: string[];
  submissions: string[];
  activity: string[];
  limitations: string[];
}

/** Known credentials plus common credential formats; not a universal secret detector. */
export function redactDiagnostic(
  text: string,
  secrets: readonly string[],
): string {
  let safe = text;
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(secret, "[redacted]");
  return safe
    .replace(
      /\b(?:slack1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|xox[baprs]-[\w-]+|sk-[\w-]{12,}|gh[pousr]_[\w]{16,})\b/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[\w.+/-]+=*/gi, "Bearer [redacted]");
}

export const serializeDiagnostic = (
  report: DebugReport,
  secrets: readonly string[],
) =>
  JSON.stringify(report, (_key, value: unknown) =>
    typeof value === "string" ? redactDiagnostic(value, secrets) : value,
  );

/** Same SQLite transaction as Slack admission: the ID is never an unindexed receipt. */
export function initializeDebugshares(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS debugshares (
    id TEXT PRIMARY KEY, job TEXT UNIQUE NOT NULL, source TEXT UNIQUE NOT NULL,
    report TEXT NOT NULL,
    captured INTEGER NOT NULL DEFAULT 0, url TEXT,
    next_attempt INTEGER NOT NULL DEFAULT 0
  );`);
}

export function readDebugshare(db: DatabaseSync, job: string) {
  const row = db
    .prepare("SELECT report,captured,url FROM debugshares WHERE job=?")
    .get(job) as
    | { report: string; captured: number; url: string | null }
    | undefined;
  return row
    ? { ...row, report: JSON.parse(row.report) as DebugReport }
    : undefined;
}
