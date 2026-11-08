import {
  LIMIT,
  type PublicSpan,
  project,
  readTable,
  WINDOW_MS,
} from "./projection.ts";
import { type SafeSpan, Telemetry } from "./telemetry.ts";

export type Snapshot = {
  state: "live" | "unconfigured" | "disconnected";
  fetchedAt: number | null;
  windowMs: number;
  limit: number;
  truncated: boolean;
  spans: PublicSpan[];
};
export const DIAGNOSTIC_QUERY = `['computah-prod-traces'] | where _time > ago(15m) and ['service.name'] != 'computah-observatory' | project _time,trace_id,span_id,parent_span_id,name,['service.name'],duration_ms=duration/1ms,['status.code'],error,links=column_ifexists('links',dynamic([])) | order by _time desc | take ${LIMIT + 1}`;
export const QUERY = DIAGNOSTIC_QUERY.replace(
  " | project",
  " and (isnull(name) or name != 'computah.logs.export') | project",
);

/** Two fixed query modes only, never client-supplied APL or identifiers. */
export function includeExporter(url: URL): boolean | null {
  if (!url.search) return false;
  return url.search === "?includeExporter=1" ? true : null;
}
export const ENDPOINT =
  "https://us-east-1.aws.edge.axiom.co/v1/query/_apl?format=tabular";

export async function boundedJson(
  response: Response,
  limit = 2 * 1024 * 1024,
): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Query unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Query limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/** One per Durable Object, not per visitor. Polls only on demand, with global single-flight/backoff. */
export class Collector {
  snapshot: Snapshot = {
    state: "unconfigured",
    fetchedAt: null,
    windowMs: WINDOW_MS,
    limit: LIMIT,
    truncated: false,
    spans: [],
  };
  private next = 0;
  private failures = 0;
  private pending?: Promise<Snapshot>;
  constructor(
    private config: {
      token?: string;
      secret?: string;
      includeExporter?: boolean;
    },
    private transport: typeof fetch = fetch,
    private now = Date.now,
    private telemetry = new Telemetry(),
  ) {}

  get(parent?: SafeSpan): Promise<Snapshot> {
    if (
      !this.config.token ||
      !this.config.secret ||
      this.config.secret.length < 32
    )
      return Promise.resolve(this.snapshot);
    if (this.pending) return this.pending;
    if (this.now() < this.next) return Promise.resolve(this.snapshot);
    this.pending = this.refresh(parent).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async refresh(parent?: SafeSpan): Promise<Snapshot> {
    const trace = this.telemetry.start("computah.observatory.poll", parent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const end = this.now();
    try {
      // Native Workers fetch rejects a Collector instance as its receiver.
      const transport = this.transport;
      const response = await transport(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apl: this.config.includeExporter ? DIAGNOSTIC_QUERY : QUERY,
          startTime: new Date(end - WINDOW_MS).toISOString(),
          endTime: new Date(end).toISOString(),
        }),
      });
      const { rows, partial } = readTable(await boundedJson(response));
      const spans = project(rows, this.config.secret as string);
      this.snapshot = {
        state: "live",
        fetchedAt: this.now(),
        windowMs: WINDOW_MS,
        limit: LIMIT,
        truncated: partial || rows.length !== spans.length,
        spans,
      };
      this.failures = 0;
    } catch {
      // No upstream error strings, bodies, URLs or credentials cross the public boundary.
      this.failures++;
      this.snapshot = { ...this.snapshot, state: "disconnected" };
    } finally {
      clearTimeout(timer);
      this.next =
        this.now() + Math.min(30_000, 5000 * 2 ** Math.min(this.failures, 3));
      await trace.end(
        this.snapshot.state === "live"
          ? "ready"
          : controller.signal.aborted
            ? "timeout"
            : "error",
      );
    }
    return this.snapshot;
  }
}
