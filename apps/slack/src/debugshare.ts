import { randomUUID } from "node:crypto";

export const isDebugshare = (text: string): boolean =>
  /^\s*DEBUGSHARE(?:\s|$)/u.test(text);

/** Deterministic command recognition; the host, never a model, mints the ID. */
export function debugshareReply(
  text: string,
  requestedBy: string,
  requestedAt: number,
): string | null {
  if (!isDebugshare(text)) return null;
  return `${randomUUID()}\ntime: ${new Date(requestedAt).toISOString()}\nrequested by: ${requestedBy}\namp link: [disabled]`;
}
