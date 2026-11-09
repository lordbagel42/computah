<script lang="ts">
import Activity from "./Activity.svelte";
import Badge from "./Badge.svelte";
import type { ExploreData } from "./data.js";
import IssueTable from "./IssueTable.svelte";
import {
  bytes,
  duration,
  fmtDate,
  href,
  statusFill,
  statusOrder,
} from "./lib.js";
import Panel from "./Panel.svelte";
import { entities } from "./views/derive.js";

let { data }: { data: ExploreData } = $props();
let queue = $derived(data.issues.filter((r) => r.status !== "resolved"));
let responses = $derived(
  data.issues
    .filter((r) => typeof r.firstResponse === "string")
    .map((r) => Date.parse(String(r.firstResponse)) - Date.parse(r.created))
    .toSorted((a, b) => a - b),
);
let days = $derived.by(() => {
  const map = new Map<string, { reports: number; events: number }>();
  for (const issue of data.issues) {
    const d = issue.created.slice(0, 10);
    const v = map.get(d) ?? { reports: 0, events: 0 };
    v.reports++;
    map.set(d, v);
  }
  for (const event of data.events) {
    const d = event.created.slice(0, 10);
    const v = map.get(d) ?? { reports: 0, events: 0 };
    v.events++;
    map.set(d, v);
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).slice(-30);
});
let max = $derived(
  Math.max(1, ...days.flatMap(([, d]) => [d.reports, d.events])),
);
</script>

<div class="overview-grid">
  <div class="stack">
    <Panel title="Open work" count={queue.length}
      >{#snippet actions()}<a href={href.issues}>all issues ›</a
        >{/snippet}<IssueTable rows={queue} compact /></Panel
    >
    <Panel title="Activity"
      >{#snippet actions()}<a href={href.activity}>full history ›</a>{/snippet}
      <div class="chart-wrap">
        <div class="chart-key">
          <span class="text-blue-400">━</span> history events {data.events
            .length}<span>━</span> reports {data.issues.length}
        </div>
        <div
          class="bar-chart"
          role="img"
          aria-label={`Daily report and history counts. ${days.map(([d, v]) => `${d}: ${v.reports} reports, ${v.events} events`).join("; ")}`}
        >
          {#each days as [day, d]}<div
              class="chart-day"
              title={`${day}: ${d.reports} reports, ${d.events} events`}
            >
              <div class="chart-bars">
                <div
                  class="report-bar"
                  style:height={`${(d.reports / max) * 100}%`}
                ></div>
                <div
                  class="event-bar"
                  style:height={`${(d.events / max) * 100}%`}
                ></div>
              </div>
              <span>{day.slice(5)}</span>
            </div>{/each}
        </div>
      </div>
      <Activity events={data.events.slice(0, 5)} /></Panel
    >
  </div>
  <div class="stack">
    <Panel title="Database"
      ><dl class="kv">
        <dt>issues</dt>
        <dd>{data.totals.issues} rows</dd>
        <dt>issue_events</dt>
        <dd>{data.totals.events} rows</dd>
        <dt>Captured messages</dt>
        <dd>{data.totals.messages} (with overlap)</dd>
        <dt>Snapshot storage</dt>
        <dd>{bytes(data.totals.bytes)}</dd>
        <dt>Oldest report</dt>
        <dd>{fmtDate(data.issues.map((r) => r.created).sort()[0])}</dd>
        <dt>Newest report</dt>
        <dd>
          {fmtDate(
            data.issues
              .map((r) => r.created)
              .sort()
              .at(-1),
          )}
        </dd>
        <dt>Median first response</dt>
        <dd>
          {responses.length
            ? `${duration(responses[Math.floor(responses.length / 2)])} (${responses.length} of ${data.issues.length})`
            : "no responses yet"}
        </dd>
      </dl></Panel
    >
    <Panel title="Status"
      ><div class="status-bar">
        {#each statusOrder as status}<span
            style:background={statusFill[status]}
            style:flex={data.issues.filter((r) => r.status === status).length}
          ></span>{/each}
      </div>
      <div class="status-grid">
        {#each statusOrder as status}<a href={href.issues}
            ><Badge {status} /><span class="mono"
              >{data.issues.filter((r) => r.status === status).length}</span
            ></a
          >{/each}
      </div></Panel
    >
    {#each ["people", "channels", "actors"] as kind}<Panel
        title={kind === "channels"
          ? "Conversations"
          : kind[0].toUpperCase() + kind.slice(1)}
        count={entities(data, kind as "people" | "channels" | "actors").length}
        >{#snippet actions()}<a
            href={href.index(kind as "people" | "channels" | "actors")}
            >index ›</a
          >{/snippet}{#each entities(data, kind as "people" | "channels" | "actors").slice(0, 5) as entity}<a
            class="entity-row"
            href={href.entity(entity.kind, entity.value)}
            ><span class="mono break-all">{entity.value}</span><span
              class="muted nowrap text-xs">{entity.issues.length} issues</span
            ></a
          >{/each}</Panel
      >{/each}
  </div>
</div>
