/** Commands are anchored user input, never model/context fragments. */
export const isStop = (text: string) => /^stop(?: current)?[.!]?$/i.test(text);

export class CoreDenied extends Error {
  constructor() {
    super("Core operation denied");
  }
}

export type Progress = "interaction" | "worker" | null;

export type StreamEnd = "completed" | "cancelled" | "failed" | "unknown";
export interface StreamUpdate {
  channel: string;
  thread: string;
  phase: Exclude<Progress, null>;
  ts?: string;
  terminal?: StreamEnd;
}
export interface ProgressStream {
  state: "starting" | "open" | "uncertain" | "closing" | "closed";
  phase: Exclude<Progress, null>;
  ts?: string;
  next: number;
  attempts: number;
  terminal?: StreamEnd;
}

/** Fixed phase cards, never streamed answer envelopes, tool arguments or labels. */
export function taskUpdates(phase: Exclude<Progress, null>, end?: StreamEnd) {
  const status = !end
    ? ("in_progress" as const)
    : end === "completed"
      ? ("complete" as const)
      : ("error" as const);
  const title =
    end === "unknown"
      ? "Observation ended; work may still be running"
      : end === "cancelled"
        ? "Core confirmed cancellation; external effects are not rolled back"
        : end === "failed"
          ? "Core reported failure"
          : end === "completed"
            ? "Core finished; answer delivery is separate"
            : "On it.";
  return [
    { type: "task_update" as const, id: "interaction", title, status },
    ...(phase === "worker"
      ? [
          {
            type: "task_update" as const,
            id: "worker",
            title: "Linked Worker phase",
            status,
          },
        ]
      : []),
  ];
}

/** Read only the first bounded current snapshot; text and worker labels never
 * leave this boundary. SSE sequence numbers are not replay cursors. */
export async function readProgress(
  response: Response,
  submission: string,
): Promise<Progress> {
  if (!response.ok || !response.body)
    throw new Error("Observation unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (buffer.length <= 128_000) {
      const part = await reader.read();
      if (part.done) return null;
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 128_000) throw new Error("Observation too large");
      const end = buffer.indexOf("\n\n");
      if (end < 0) continue;
      const frame = buffer.slice(0, end);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) {
        buffer = buffer.slice(end + 2);
        continue;
      }
      const value = JSON.parse(data);
      if (value.submissionId !== submission || value.kind !== "resync")
        return null;
      if (!Array.isArray(value.observations)) return null;
      const active = value.observations.filter(
        (item: Record<string, unknown>) =>
          item &&
          item.submissionId === submission &&
          ["generating", "delegating"].includes(String(item.phase)),
      );
      return active.some(
        (item: Record<string, unknown>) => item.source === "worker",
      )
        ? "worker"
        : active.some(
              (item: Record<string, unknown>) => item.source === "interaction",
            )
          ? "interaction"
          : null;
    }
    throw new Error("Observation too large");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
