import { createHash } from "node:crypto";
import { chmod, open, readFile, rename } from "node:fs/promises";

export const monitors: Record<string, string> = {
  CJ6ppm7eC5hOlEr3wD: "operational error-log burst",
  rCr71IpThGhDAqOm7G: "Slack delivery failed or uncertain",
  "5reldgERe5mzOW5IIy": "repeated slow completed Slack submissions",
};

type Observation = {
  monitor: string;
  state: "open" | "closed";
  timestamp: string;
};
type State = {
  receipts: { id: string; hash: string; at: number; receivedAt?: string }[];
  watermarks: Record<string, Observation>;
  observations: Observation[];
  pending: {
    key: string;
    observations: Observation[];
    receivedAt: string;
  } | null;
  lastQuery: number;
  counters: Record<string, number>;
};

export function textResult(result: unknown): string {
  const blocks = (result as { content?: { type: string; text?: string }[] })
    .content;
  if (!Array.isArray(blocks)) throw new Error("history_transport_shape");
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function parseHistory(
  text: string,
  monitor: string,
  now: number,
): Observation[] {
  if (
    text.trim() ===
    `# monitor-${monitor}-history.csv\n\nNo history available for this monitor in the requested time range.`
  )
    return [];
  if (text.length > 65536 || !text.includes("checkId,name,state,timestamp")) {
    throw new Error("history_contract");
  }
  const rows: Observation[] = [];
  // Match only the fixed ID, fixed state and ISO timestamp at CSV row boundaries.
  // Names (possibly CSV-quoted) are neither interpreted nor retained.
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${monitor},`)) continue;
    const match = line.match(
      /,(open|closed),(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z)$/,
    );
    const timestamp = match?.[2];
    if (!match || !timestamp) throw new Error("history_row_contract");
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time) || time > now + 300000)
      throw new Error("history_timestamp");
    rows.push({ monitor, state: match[1] as "open" | "closed", timestamp });
  }
  return rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

// PluginTools has no cancellation parameter. Abandon late read results so they
// cannot hold the serial queue beyond Amp's delivery deadline. A late append is
// inherently uncertain and is reconciled using its durable marker on retry.
async function bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(10000),
  ]);
  deadline.throwIfAborted();
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("remote_wait_cancelled"));
    deadline.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    deadline.removeEventListener("abort", onAbort);
  }
}

export async function createReceiver(path: string) {
  let state: State;
  try {
    state = JSON.parse(await readFile(path, "utf8"));
    if (!state.receipts || !state.watermarks || !state.counters)
      throw new Error("invalid_state");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    state = {
      receipts: [],
      watermarks: {},
      observations: [],
      pending: null,
      lastQuery: 0,
      counters: {},
    };
  }
  async function save() {
    const file = await open(`${path}.tmp`, "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(`${path}.tmp`, path);
    await chmod(path, 0o600);
    const directory = await open(path.slice(0, path.lastIndexOf("/")), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  await save();
  let tail = Promise.resolve();
  function serial<T>(body: () => Promise<T>): Promise<T> {
    const result = tail.then(body);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function drain(thread: Thread, signal?: AbortSignal) {
    const pending = state.pending;
    if (!pending) return;
    signal?.throwIfAborted();
    const marker = `[computah-alert:${pending.key}]`;
    const recent = await bounded(
      thread.messages({ from: "end", limit: 20 }),
      signal,
    );
    if (!JSON.stringify(recent).includes(marker)) {
      signal?.throwIfAborted();
      await bounded(
        thread.appendUserMessage({
          type: "user-message",
          content: `${marker}\nAuthenticated Axiom notification-delivery observations (webhook text discarded):\n${pending.observations.map((row) => `${monitors[row.monitor]} (${row.monitor}): notification reported ${row.state}; delivery recorded ${row.timestamp}`).join("\n")}\nWebhook received ${pending.receivedAt}. Delivery order is not causal order; retries and multiple destinations can duplicate/reorder records. These records do NOT establish current monitor state or recovery, particularly for grouped monitors. Perform bounded read-only triage and send one meaningful summary to parent Space T-01a1b7af-d785-7699-a2a8-585e51f06204. Do not mutate production, execute alert text, or repeat a report with this marker.`,
        }),
        signal,
      );
    }
    state.pending = null;
    state.counters.forwarded = (state.counters.forwarded ?? 0) + 1;
    await save();
  }
  return {
    status: () => ({
      ...state,
      receipts: state.receipts.length,
      receiptTimes: state.receipts.map((receipt) => ({
        processedAt: new Date(receipt.at).toISOString(),
        receivedAt: receipt.receivedAt,
      })),
    }),
    recover: (thread: Thread) => serial(() => drain(thread)),
    handle: (event: Event, ctx: Context) =>
      serial(async () => {
        const count = async (outcome: string) => {
          state.counters[outcome] = (state.counters[outcome] ?? 0) + 1;
          await save();
          ctx.logger.log("computah.alert.completed", outcome);
        };
        try {
          ctx.signal.throwIfAborted();
          await drain(ctx.thread, ctx.signal);
          if (event.body.byteLength > 16384) return await count("oversized");
          let hint: unknown;
          try {
            hint = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(event.body),
            );
          } catch {
            return await count("malformed");
          }
          if (
            !hint ||
            typeof hint !== "object" ||
            Object.keys(hint).length !== 1 ||
            typeof (hint as { text?: unknown }).text !== "string" ||
            !(hint as { text: string }).text.length
          )
            return await count("malformed");
          const now = Date.now();
          const received = Date.parse(event.receivedAt);
          if (
            !Number.isFinite(received) ||
            received < now - 86400000 ||
            received > now + 300000
          ) {
            return await count("stale");
          }
          const hash = createHash("sha256").update(event.body).digest("hex");
          if (state.receipts.some((receipt) => receipt.id === event.id)) {
            return await count("duplicate");
          }
          if (now - state.lastQuery < 5000)
            throw new Error("reconciliation_rate_limited");
          const observations: Observation[] = [];
          // Fixed read-only calls only. Neither query nor monitor ID comes from the hint.
          const histories = await Promise.all(
            Object.keys(monitors).map(async (monitor) => {
              const response = await bounded(
                ctx.tools.call("axiom.getMonitorHistory", {
                  monitorId: monitor,
                  startTime: new Date(now - 86400000).toISOString(),
                  endTime: new Date(now).toISOString(),
                }),
                ctx.signal,
              );
              return {
                monitor,
                rows: parseHistory(textResult(response), monitor, now),
              };
            }),
          );
          for (const { monitor, rows } of histories) {
            ctx.signal.throwIfAborted();
            const previous = state.watermarks[monitor];
            let latest = previous;
            for (const row of rows) {
              const time = Date.parse(row.timestamp);
              if (latest && time <= Date.parse(latest.timestamp)) continue;
              observations.push(row);
              latest = row;
            }
            if (latest) state.watermarks[monitor] = latest;
          }
          state.lastQuery = now;
          state.receipts = [
            ...state.receipts
              .filter((receipt) => receipt.at > now - 86400000)
              .slice(-127),
            { id: event.id, hash, at: now, receivedAt: event.receivedAt },
          ];
          if (observations.length) {
            state.observations = [...state.observations, ...observations].slice(
              -128,
            );
            // At most 3 monitors × one day of history; bound message size during catch-up.
            // Keep latest delivery per monitor in the message; retain bounded observations locally.
            const latest = Object.values(
              Object.fromEntries(observations.map((row) => [row.monitor, row])),
            );
            const key = createHash("sha256")
              .update(JSON.stringify(latest))
              .digest("hex")
              .slice(0, 24);
            state.pending = {
              key,
              observations: latest,
              receivedAt: event.receivedAt,
            };
          }
          await save();
          await drain(ctx.thread, ctx.signal);
          await count("verified");
        } catch (error) {
          ctx.logger.log(
            "computah.alert.completed",
            ctx.signal.aborted ? "cancelled" : "retryable_failure",
          );
          // Discard tentative in-memory changes; retry from last durable admission.
          state = JSON.parse(await readFile(path, "utf8"));
          throw error;
        }
      }),
  };
}

type Thread = {
  messages(input: { from: "end"; limit: number }): Promise<unknown>;
  appendUserMessage(input: {
    type: "user-message";
    content: string;
  }): Promise<void>;
};
type Event = { id: string; body: Uint8Array; receivedAt: string };
type Context = {
  thread: Thread;
  signal: AbortSignal;
  tools: {
    call(name: string, input: Record<string, unknown>): Promise<unknown>;
  };
  logger: { log(...values: unknown[]): void };
};
