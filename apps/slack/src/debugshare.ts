import { randomUUID } from "node:crypto";

export const isDebugshare = (text: string): boolean =>
  /^\s*DEBUGSHARE(?:\s|$)/u.test(text);

/** Deterministic command recognition; the host, never a model, mints the ID. */
export function debugshareReply(text: string): string | null {
  if (!isDebugshare(text)) return null;
  return `DEBUGSHARE ${randomUUID()}\nidentifier only. no diagnostics collected or shared, and no investigation or thread started. this identifier is not a diagnostics lookup key.`;
}
