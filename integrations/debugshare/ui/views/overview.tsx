import { StatusBar, TimeChart } from "../components/chart.js";
import { KV, Panel, StatusBadge } from "../components/rich.js";
import {
  ago,
  bytes,
  duration,
  fmtDate,
  href,
  statusFill,
  statusOrder,
} from "../lib.js";
import { entities } from "./derive.js";
import {
  EventStream,
  IssueTable,
  Loading,
  More,
  PageHeader,
  QueryError,
  useIndex,
} from "./shell.js";

export function Overview() {
  const { data, pending, error } = useIndex();
  if (!data)
    return (
      <>
        <PageHeader crumbs={[["Overview"]]} />
        <QueryError error={error} />
        {pending && <Loading />}
      </>
    );
  const rows = data.issues;
  const counts = statusOrder.map(
    (s) => [s, rows.filter((r) => r.status === s).length] as [string, number],
  );
  const queue = rows.filter((r) => r.status !== "resolved");
  const responded = rows.filter((r) => typeof r.firstResponse === "string");
  const responseTimes = responded
    .map((r) => Date.parse(String(r.firstResponse)) - Date.parse(r.created))
    .sort((a, b) => a - b);
  const median = responseTimes.length
    ? responseTimes[Math.floor(responseTimes.length / 2)]
    : null;
  const created = rows.map((r) => r.created).sort();
  const people = entities(data, "people").slice(0, 6);
  const channels = entities(data, "channels").slice(0, 6);
  const actors = entities(data, "actors").slice(0, 6);
  return (
    <>
      <PageHeader crumbs={[["Overview"]]} />
      <QueryError error={error} />
      <div className="grid gap-4 p-4 md:p-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-4">
          <Panel
            title="Open work"
            count={queue.length}
            actions={<More to={href.issues}>all issues</More>}
          >
            <IssueTable
              compact
              rows={queue}
              empty="Every captured issue is resolved"
            />
          </Panel>
          <Panel
            title="Activity"
            actions={<More to={href.activity}>full history</More>}
          >
            <TimeChart
              label="Reports and history events over time"
              series={[
                {
                  label: "history events",
                  color: "#4b8ef5",
                  times: data.events.map((e) => Date.parse(e.created)),
                },
                {
                  label: "reports",
                  color: "#e8e8e8",
                  times: rows.map((r) => Date.parse(r.requestedAt)),
                },
              ]}
            />
            <div className="border-t border-border">
              <EventStream events={data.events.slice(0, 8)} />
            </div>
          </Panel>
        </div>
        <div className="min-w-0 space-y-4">
          <Panel title="Database">
            <KV
              rows={[
                [
                  "issues",
                  <a
                    key="i"
                    href={href.tables("issues")}
                    className="hover:underline"
                  >
                    {data.totals.issues} rows
                  </a>,
                ],
                [
                  "issue_events",
                  <a
                    key="e"
                    href={href.tables("issue_events")}
                    className="hover:underline"
                  >
                    {data.totals.events} rows
                  </a>,
                ],
                ["Captured messages", `${data.totals.messages} (with overlap)`],
                ["Snapshot storage", bytes(data.totals.bytes)],
                ["Oldest report", fmtDate(created[0])],
                [
                  "Newest report",
                  `${fmtDate(created.at(-1))} · ${ago(created.at(-1) ?? "")}`,
                ],
                [
                  "Median first response",
                  median === null
                    ? "no responses yet"
                    : `${duration(median)} (${responded.length} of ${rows.length})`,
                ],
              ]}
            />
          </Panel>
          <Panel title="Status">
            <div className="space-y-3 p-3">
              <StatusBar counts={counts} colors={statusFill} />
              <ul className="grid grid-cols-2 gap-2">
                {counts.map(([s, n]) => (
                  <li
                    key={s}
                    className="flex items-center justify-between rounded-md border border-border px-2.5 py-2"
                  >
                    <StatusBadge status={s} />
                    <span className="font-mono text-[13px] tabular">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Panel>
          {(
            [
              ["People", "people", people],
              ["Conversations", "channels", channels],
              ["Actors", "actors", actors],
            ] as const
          ).map(([title, kind, list]) => (
            <Panel
              key={kind}
              title={title}
              count={entities(data, kind).length}
              actions={<More to={href.index(kind)}>index</More>}
            >
              <ul className="divide-y divide-border/70">
                {list.map((e) => (
                  <li key={e.value}>
                    <a
                      href={href.entity(kind, e.value)}
                      className="flex items-center justify-between gap-3 px-3 py-2 font-mono text-[12.5px] hover:bg-accent"
                    >
                      <span className="truncate">{e.value}</span>
                      <span className="shrink-0 text-[11px] text-faint">
                        {e.issues.length} issue
                        {e.issues.length === 1 ? "" : "s"} · {ago(e.last)}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      </div>
    </>
  );
}
