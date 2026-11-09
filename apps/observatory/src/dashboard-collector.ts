import { createHmac } from "node:crypto";
import { boundedJson, ENDPOINT } from "./collector.ts";
import {
  AGENTS,
  dashboardQuery,
  type Filters,
  MODELS,
  OUTCOMES,
  type Panel,
  PROVIDERS,
  PUBLIC_OPERATIONS,
  SERVICES,
  TOOLS,
} from "./dashboards.ts";
import { readTable } from "./projection.ts";
import { type SafeSpan, Telemetry } from "./telemetry.ts";

export type Cell =
  | string
  | number
  | null
  | { from: number; to: number; count: number }[];
export type PanelData = {
  state: "ready" | "partial" | "unavailable" | "unconfigured" | "busy";
  fetchedAt: number | null;
  start: number;
  end: number;
  rows: Record<string, Cell>[];
  truncated: boolean;
};
const dimensions: Record<string, string[]> = {
  Service: SERVICES,
  Operation: PUBLIC_OPERATIONS,
  Model: MODELS,
  Provider: PROVIDERS,
  Agent: AGENTS,
  Tool: TOOLS,
  Outcome: OUTCOMES,
  Currency: ["USD"],
  Basis: ["base-catalog-estimate-excludes-tier-account-adjustments"],
  RateVersion: ["pi-ai@1.5.0/runtime-model", "pi-ai@1.5.0"],
  GenOperation: [
    "chat",
    "invoke_agent",
    "execute_tool",
    "generate_content",
    "text_completion",
    "embeddings",
  ],
  reply_state: [
    "reply delivered",
    "delivery failed",
    "no successful reply observed",
  ],
};
/** Independent positive schema: even a changed query/upstream envelope cannot
 * publish strings from messages, error text, labels, URLs or raw identifiers.
 */
export function projectPanel(
  panel: Panel,
  rows: Record<string, unknown>[],
  secret: string,
): Record<string, Cell>[] {
  return rows.slice(0, 1000).map((row) =>
    Object.fromEntries(
      panel.columns.map((key) => {
        const value = row[key];
        let cell: Cell = null;
        if (key === "trace_id") {
          if (/^[a-f0-9]{32}$/i.test(String(value)) && secret.length >= 32)
            cell = createHmac("sha256", secret)
              .update(`trace:${String(value).toLowerCase()}`)
              .digest("hex")
              .slice(0, 32);
        } else if (key === "Revision") {
          if (typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value))
            cell = value;
        } else if (
          key === "_time" ||
          key === "Last_span_UTC" ||
          key === "last_span"
        ) {
          if (typeof value === "string" && Number.isFinite(Date.parse(value)))
            cell = new Date(value).toISOString();
        } else if (dimensions[key]) {
          cell =
            typeof value === "string" && dimensions[key].includes(value)
              ? value
              : "other";
        } else if (key === "Context_pct") {
          // Verified Axiom histogram shape. Reconstruct numeric buckets only.
          if (Array.isArray(value))
            cell = value
              .slice(0, 128)
              .flatMap((bucket) =>
                bucket &&
                [bucket.from, bucket.to, bucket.count].every(
                  (v) =>
                    typeof v === "number" &&
                    Number.isFinite(v) &&
                    v >= 0 &&
                    v <= 1e18,
                )
                  ? [{ from: bucket.from, to: bucket.to, count: bucket.count }]
                  : [],
              );
        } else if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= 1e18
        )
          cell = value;
        return [key, cell];
      }),
    ),
  );
}

/** One shared DO owns this bounded cache/budget, never one query per visitor.
 * At most four queries, 64 cache entries, 60 starts/minute and 1,000 rows/panel.
 * No unbounded wait queue: an excess request receives busy and can retry later.
 */
export class DashboardCollector {
  private cache = new Map<
    string,
    { next: number; value: PanelData; pending?: Promise<PanelData> }
  >();
  private inFlight = 0;
  private budgetAt = 0;
  private starts = 0;
  constructor(
    private config: { traces?: string; logs?: string; secret?: string },
    private transport: typeof fetch = fetch,
    private now = Date.now,
    private telemetry = new Telemetry(),
  ) {}
  async get(
    panel: Panel,
    filters: Filters,
    parent?: SafeSpan,
  ): Promise<PanelData> {
    const end = Math.floor(this.now() / 300_000) * 300_000;
    const window =
      filters.window === "24h"
        ? 86400_000
        : filters.window === "1h"
          ? 3600_000
          : 1800_000;
    const empty: PanelData = {
      state: "unconfigured",
      fetchedAt: null,
      start: end - window,
      end,
      rows: [],
      truncated: false,
    };
    const token =
      panel.source === "logs" ? this.config.logs : this.config.traces;
    if (!token || !this.config.secret || this.config.secret.length < 32)
      return empty;
    const key = `${panel.base}:${panel.id}:${JSON.stringify(filters)}`;
    const old = this.cache.get(key);
    if (old?.pending) return old.pending;
    if (old && old.next > this.now()) return old.value;
    if (this.now() - this.budgetAt >= 60_000) {
      this.budgetAt = this.now();
      this.starts = 0;
    }
    if (this.inFlight >= 4 || this.starts >= 60)
      return { ...(old?.value ?? empty), state: "busy" };
    if (!old && this.cache.size >= 64) {
      const victim = [...this.cache].find(([, entry]) => !entry.pending);
      if (!victim) return { ...empty, state: "busy" };
      this.cache.delete(victim[0]);
    }
    const entry = old ?? { next: 0, value: empty };
    this.cache.set(key, entry);
    this.inFlight++;
    this.starts++;
    entry.pending = this.refresh(panel, filters, token, empty, parent)
      .then((value) => {
        entry.value =
          value.state === "unavailable" && old?.value.fetchedAt
            ? { ...old.value, state: "unavailable" }
            : value;
        entry.next =
          this.now() + (value.state === "unavailable" ? 30_000 : 300_000);
        return entry.value;
      })
      .finally(() => {
        this.inFlight--;
        entry.pending = undefined;
      });
    return entry.pending;
  }
  private async refresh(
    panel: Panel,
    filters: Filters,
    token: string,
    empty: PanelData,
    parent?: SafeSpan,
  ): Promise<PanelData> {
    const span = this.telemetry.start("computah.observatory.poll", parent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let outcome: "ready" | "error" | "timeout" = "error";
    try {
      const transport = this.transport;
      const response = await transport(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apl: dashboardQuery(panel, filters),
          startTime: new Date(empty.start).toISOString(),
          endTime: new Date(empty.end).toISOString(),
        }),
      });
      const { rows, partial } = readTable(
        await boundedJson(response, 512 * 1024),
      );
      const projected = projectPanel(panel, rows, this.config.secret ?? "");
      outcome = partial ? "error" : "ready";
      return {
        ...empty,
        state: partial ? "partial" : "ready",
        fetchedAt: this.now(),
        rows: projected,
        truncated: partial,
      };
    } catch {
      outcome = controller.signal.aborted ? "timeout" : "error";
      return { ...empty, state: "unavailable" };
    } finally {
      clearTimeout(timer);
      await span.end(outcome);
    }
  }
}
