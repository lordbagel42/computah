import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Link2,
  MessageSquareText,
  Waypoints,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Summary } from "../../schema.js";
import { TimeChart } from "../components/chart.js";
import {
  CopyButton,
  Empty,
  Ext,
  KV,
  Panel,
  RichText,
  StatusBadge,
  TypeBadge,
} from "../components/rich.js";
import {
  Badge,
  Button,
  Input,
  NativeSelect,
  Textarea,
  Tooltip,
} from "../components/ui.js";
import {
  client,
  type InspectionData,
  type Row,
  updateRef,
  useInspection,
} from "../data.js";
import {
  absolute,
  ago,
  axiom,
  bytes,
  cn,
  duration,
  fmtDate,
  fmtTime,
  href,
  ignoreShortcut,
  isRealSlack,
  slack,
  slackDate,
  statusOrder,
  tokenize,
} from "../lib.js";
import { TraceViewer } from "../trace-viewer.js";
import { Loading, PageHeader, QueryError, useIndex } from "./shell.js";

type Report = InspectionData["report"];
type Issue = InspectionData["issue"];

const sections = [
  ["conversation", "Conversation"],
  ["lifecycle", "Lifecycle"],
  ["traces", "Traces"],
  ["fields", "Fields"],
  ["update", "Update"],
  ["correlation", "Correlation"],
  ["related", "Related"],
] as const;

export function IssueView({
  id,
  section,
  message,
}: {
  id: string;
  section?: string;
  message?: string;
}) {
  const { data, pending, error } = useInspection(id);
  const index = useIndex();
  const rows = index.data?.issues ?? [];
  const at = rows.findIndex((r) => r.id === id);
  const prev = at > 0 ? rows[at - 1] : undefined;
  const next = at >= 0 && at < rows.length - 1 ? rows[at + 1] : undefined;
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (ignoreShortcut(e)) return;
      if (e.key === "k" && prev) location.hash = href.issue(prev.id);
      else if (e.key === "j" && next) location.hash = href.issue(next.id);
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [prev, next]);
  // Deep links: #<id>/<section> and #<id>/m/<ts>.
  useEffect(() => {
    if (!data) return;
    const target = message
      ? document.getElementById(`m-${message}`)
      : section
        ? document.getElementById(section)
        : null;
    if (!target) return;
    target.scrollIntoView({ block: message ? "center" : "start" });
    if (message) {
      target.dataset.flash = "false";
      requestAnimationFrame(() => {
        target.dataset.flash = "true";
      });
    }
  }, [data, section, message]);

  const crumbs: [string, string?][] = [["Issues", href.issues], [id]];
  if (!data)
    return (
      <>
        <PageHeader crumbs={crumbs} />
        {pending ? (
          <Loading rows={10} />
        ) : (
          <div className="mx-auto max-w-xl p-6">
            <p className="text-[15px]">Report unavailable</p>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {error ?? "Resolving the exact issue ID."} Older identifier-only
              UUIDs cannot recover context that was never stored.
            </p>
          </div>
        )}
      </>
    );
  const { issue, report, events, snapshot, related } = data;
  const real = isRealSlack(report.source.team);
  const row = rows.find((r) => r.id === id);
  const axiomIssue = axiom.issue(issue.id, report.requestedAt);
  const captureTrace = axiom.trace(
    report.capture?.traceId ?? "",
    report.requestedAt,
  );
  const transportTrace = axiom.trace(
    report.transport?.traceId ?? "",
    report.requestedAt,
  );
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        actions={
          <>
            <Tooltip content={prev ? `Previous: ${prev.title}` : "First issue"}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous issue (k)"
                disabled={!prev}
                onClick={() => {
                  if (prev) location.hash = href.issue(prev.id);
                }}
              >
                <ArrowUp />
              </Button>
            </Tooltip>
            <Tooltip content={next ? `Next: ${next.title}` : "Last issue"}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next issue (j)"
                disabled={!next}
                onClick={() => {
                  if (next) location.hash = href.issue(next.id);
                }}
              >
                <ArrowDown />
              </Button>
            </Tooltip>
            {real && (
              <Button variant="ghost" size="sm" asChild>
                <a
                  href={slack.channelApp(
                    report.source.team,
                    report.source.channel,
                  )}
                >
                  <MessageSquareText /> Open in Slack
                </a>
              </Button>
            )}
            {report.capture && real && axiomIssue && (
              <Button variant="ghost" size="sm" asChild>
                <a href={axiomIssue} target="_blank" rel="noreferrer">
                  <Waypoints /> Open in Axiom
                </a>
              </Button>
            )}
            <CopyLink value={absolute(href.issue(issue.id))} />
          </>
        }
      />
      <QueryError error={error} />
      <div className="border-b border-border px-4 pb-0 pt-4 md:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={issue.status} />
          {!real && <Badge variant="outline">synthetic</Badge>}
          <Badge variant="outline">
            {issue.id.startsWith("computah_bug_")
              ? "computah_bug ID"
              : "legacy UUID"}
          </Badge>
          <span className="flex items-center font-mono text-[12px] text-muted-foreground">
            {issue.id}
            <CopyButton value={issue.id} label="Copy issue ID" />
          </span>
        </div>
        <h1 className="mt-2 max-w-4xl text-balance text-[22px] font-medium leading-snug tracking-[-0.015em]">
          {issue.title}
        </h1>
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[12px] text-muted-foreground">
          <span>
            requested by{" "}
            <a
              href={href.entity("people", report.requestedBy)}
              className="text-foreground hover:underline"
            >
              {report.requestedBy}
            </a>
          </span>
          <span>
            {fmtDate(report.requestedAt)} · {ago(report.requestedAt)}
          </span>
          <span>rev {issue.revision}</span>
          <span>updated {ago(issue.updated)}</span>
          {issue.assignee && (
            <span>
              assigned <RichText text={issue.assignee} />
            </span>
          )}
        </p>
        <nav
          aria-label="Sections"
          className="-mx-1 mt-3 flex gap-1 overflow-x-auto"
        >
          {sections.map(([key, label]) => (
            <a
              key={key}
              href={href.issue(issue.id, key)}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 border-transparent px-2 py-2 font-mono text-[12px] text-muted-foreground hover:text-foreground",
                section === key && "border-primary text-foreground",
              )}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
      <div className="grid gap-4 p-4 md:p-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        {real && (captureTrace || transportTrace) && (
          <div className="min-w-0 xl:col-span-2">
            <Panel
              id="traces"
              title="Traces"
              collapsible={false}
              className="scroll-mt-20"
            >
              {captureTrace && (
                <TraceViewer
                  key={`${report.id}:capture`}
                  id={report.id}
                  correlation="capture"
                  label={
                    captureTrace === transportTrace
                      ? "Capture & Slack transport"
                      : "Capture"
                  }
                />
              )}
              {transportTrace && transportTrace !== captureTrace && (
                <TraceViewer
                  key={`${report.id}:transport`}
                  id={report.id}
                  correlation="transport"
                  label="Slack transport"
                />
              )}
              <p className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
                The DEBUGSHARE command’s recorded traces, not the earlier
                conversation. Queried within ±1 day of this report; use the
                Correlation links to widen the range in Axiom.
              </p>
            </Panel>
          </div>
        )}
        <div className="min-w-0 space-y-4">
          <Conversation report={report} rows={rows} message={message} />
          <Lifecycle issue={issue} report={report} events={events} />
          <Fields report={report} />
          <Resolution key={issue.id} issue={issue} />
        </div>
        <div className="min-w-0 space-y-4">
          <Panel title="Issue" collapsible={false}>
            <KV
              rows={[
                ["ID", issue.id, issue.id],
                ["Status", <StatusBadge key="s" status={issue.status} />],
                ["Revision", String(issue.revision)],
                [
                  "Assignee",
                  issue.assignee ? (
                    <RichText key="a" text={issue.assignee} />
                  ) : (
                    "unassigned"
                  ),
                ],
                ["Created", fmtDate(issue.created), issue.created],
                ["Updated", fmtDate(issue.updated), issue.updated],
                ["Link", `#${issue.id}`, absolute(href.issue(issue.id))],
              ]}
            />
          </Panel>
          <Panel title="Message activity" count={report.messages.length}>
            <TimeChart
              label="Captured messages over time"
              buckets={36}
              width={400}
              height={140}
              series={participantsSeries(report)}
            />
          </Panel>
          <Correlation report={report} row={row} />
          <Panel title="Source">
            <KV
              rows={[
                ["Workspace", report.source.team, report.source.team],
                [
                  "Conversation",
                  <a
                    key="c"
                    href={href.entity("channels", report.source.channel)}
                    className="text-link hover:underline"
                  >
                    {report.source.channel}
                  </a>,
                  report.source.channel,
                ],
                [
                  "Command message",
                  <a
                    key="m"
                    href={href.message(issue.id, report.source.message)}
                    className="text-link hover:underline"
                  >
                    {report.source.message}
                  </a>,
                  report.source.message,
                ],
                [
                  "Thread",
                  typeof report.source.thread === "string"
                    ? report.source.thread
                    : "top level",
                ],
                ["Tenant", report.scope.tenantId],
                ["User", report.scope.userId],
                ["Agent", report.scope.agentId],
                ...(real
                  ? ([
                      [
                        "Slack",
                        <span key="sl" className="flex flex-wrap gap-x-3">
                          <a
                            className="text-link hover:underline"
                            href={slack.channelApp(
                              report.source.team,
                              report.source.channel,
                            )}
                          >
                            app
                          </a>
                          <Ext
                            href={slack.channelWeb(
                              report.source.team,
                              report.source.channel,
                            )}
                          >
                            web
                          </Ext>
                        </span>,
                      ],
                    ] as [ReactNode, ReactNode][])
                  : []),
              ]}
            />
          </Panel>
          <Panel title="Snapshot">
            <KV
              rows={[
                ["Stored size", bytes(snapshot.bytes)],
                ["SHA-256", snapshot.sha256, snapshot.sha256],
                [
                  "Immutability",
                  "exact re-import is a no-op; a changed snapshot under this ID is rejected",
                ],
                ["Messages", String(report.messages.length)],
                [
                  "Participants",
                  <span key="p" className="flex flex-wrap gap-x-2">
                    {report.participants.map((p) => (
                      <a
                        key={p}
                        href={href.entity("people", p)}
                        className="text-link hover:underline"
                      >
                        {p}
                      </a>
                    ))}
                  </span>,
                ],
                ["Submission handles", String(report.submissions.length)],
              ]}
            />
          </Panel>
          <Related related={related} />
          <Evidence report={report} events={events} />
          <Panel
            title="Capture notes"
            count={report.activity.length + report.limitations.length}
          >
            <div className="space-y-3 p-3 text-[13px]">
              <List title="Activity" items={report.activity} />
              <List title="Limitations" items={report.limitations} />
            </div>
          </Panel>
          <Panel
            title="Submission handles"
            count={report.submissions.length}
            defaultOpen={report.submissions.length <= 8}
          >
            {report.submissions.length ? (
              <ul className="divide-y divide-border/70">
                {report.submissions.map((s) => (
                  <li
                    key={s}
                    className="group flex items-center justify-between gap-2 px-3 py-1.5"
                  >
                    <a
                      href={href.entity("submissions", s)}
                      className="min-w-0 truncate font-mono text-[12px] text-secondary-foreground hover:text-link hover:underline"
                    >
                      {s}
                    </a>
                    <CopyButton
                      value={s}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No submission handle at this location" />
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function CopyLink({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() =>
        navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      <Link2 /> {done ? "Copied" : "Copy link"}
    </Button>
  );
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <p className="mb-1 font-mono text-[11px] text-faint">{title}</p>
      {items.length ? (
        <ul className="list-disc space-y-1 pl-4 text-secondary-foreground marker:text-faint">
          {items.map((t) => (
            <li key={t}>
              <RichText text={t} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-faint">None recorded</p>
      )}
    </div>
  );
}

const palette = ["#4b8ef5", "#e8e8e8", "#f0b14a", "#46c37b", "#c084fc"];
function participantsSeries(report: Report) {
  const authors = [...new Set(report.messages.map((m) => m.author))];
  return authors.slice(0, 5).map((a, i) => ({
    label: a === report.requestedBy ? `${a} (requester)` : a,
    color: palette[i],
    times: report.messages
      .filter((m) => m.author === a)
      .map((m) => slackDate(m.ts)?.getTime() ?? Number.NaN),
  }));
}

function Conversation({
  report,
  rows,
  message,
}: {
  report: Report;
  rows: readonly Row[];
  message?: string;
}) {
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const opened = new Map(
    rows
      .filter((r) => r.channel === report.source.channel && r.id !== report.id)
      .map((r) => [r.message, r]),
  );
  const list = report.messages.map((m, i) => {
    const d = slackDate(m.ts);
    const prev = i > 0 ? report.messages[i - 1] : undefined;
    const pd = prev ? slackDate(prev.ts) : null;
    return { m, d, gap: d && pd ? d.getTime() - pd.getTime() : null, prev };
  });
  if (order === "desc") list.reverse();
  return (
    <Panel
      id="conversation"
      title="Conversation"
      count={report.messages.length}
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOrder(order === "asc" ? "desc" : "asc")}
        >
          {order === "asc" ? "Oldest first" : "Newest first"}
        </Button>
      }
    >
      <p className="border-b border-border px-3 py-2 text-[12px] text-faint">
        Bounded snapshot captured at the command location: one page, up to 20
        earlier messages. Not a complete archive.
      </p>
      <ol>
        {list.map(({ m, d, gap, prev }) => {
          const origin = m.ts === report.source.message;
          const other = opened.get(m.ts);
          const slow =
            gap !== null && gap >= 5000 && prev && prev.author !== m.author;
          return (
            <li
              key={m.ts}
              id={`m-${m.ts}`}
              className={cn(
                "group scroll-mt-28 border-b border-border/70 px-3 py-2 last:border-b-0",
                origin && "bg-primary/[0.07]",
                message === m.ts &&
                  "outline outline-1 -outline-offset-1 outline-primary/60",
              )}
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
                <a
                  href={href.entity("people", m.author)}
                  className="text-[12.5px] text-foreground hover:underline"
                >
                  {m.author}
                </a>
                {m.author === report.requestedBy && (
                  <span className="text-faint">requester</span>
                )}
                <Tooltip
                  content={
                    d
                      ? `${d.toISOString()} · Slack ts ${m.ts}`
                      : `Slack ts ${m.ts}`
                  }
                >
                  <span className="tabular">
                    {d ? `${fmtDate(d).slice(5, 10)} ${fmtTime(d)}` : m.ts}
                  </span>
                </Tooltip>
                {gap !== null && (
                  <Tooltip
                    content={
                      slow
                        ? "≥ 5 s after a message from a different author (5,000 ms is the reply-latency monitor threshold)"
                        : "Time since the previous captured message"
                    }
                  >
                    <span
                      className={cn(
                        "tabular",
                        slow ? "text-amber-300" : "text-faint",
                      )}
                    >
                      +{duration(gap)}
                    </span>
                  </Tooltip>
                )}
                {origin && (
                  <Badge variant="accent">DEBUGSHARE · this report</Badge>
                )}
                {other && (
                  <a href={href.issue(other.id)} title={other.title}>
                    <Badge variant="outline" className="hover:text-foreground">
                      opened {other.id.slice(0, 18)}…
                    </Badge>
                  </a>
                )}
                <span className="ml-auto flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <CopyButton
                    value={absolute(href.message(report.id, m.ts))}
                    label="Copy message link"
                  />
                  <CopyButton value={m.text} label="Copy text" />
                </span>
              </div>
              <p className="mt-0.5 max-w-[80ch] text-[13.5px] leading-snug text-secondary-foreground">
                <RichText text={m.text} around={report.requestedAt} />
              </p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function Lifecycle({
  issue,
  report,
  events,
}: {
  issue: Issue;
  report: Report;
  events: InspectionData["events"];
}) {
  const requested = Date.parse(report.requestedAt);
  const indexed = events.find((e) => e.actor === "capture");
  const first = events.find((e) => e.actor !== "capture");
  const resolved =
    issue.status === "resolved"
      ? [...events].reverse().find((e) => e.status === "resolved")
      : undefined;
  const statuses = events.map((e) => e.status);
  const path = statuses.filter((s, i) => i === 0 || s !== statuses[i - 1]);
  const since = (at?: string) =>
    at ? duration(Date.parse(at) - requested) : "—";
  return (
    <Panel id="lifecycle" title="Lifecycle" count={events.length}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2.5">
        {path.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the status path is positional and may repeat a status
          <span key={`${s}${i}`} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight className="size-3 text-faint" />}
            <StatusBadge status={s} />
          </span>
        ))}
      </div>
      <KV
        rows={[
          [
            "Snapshot indexed",
            indexed
              ? `${since(indexed.created)} after request`
              : "no capture event",
          ],
          [
            "First response",
            first
              ? `${since(first.created)} after request · ${first.actor}`
              : "none yet",
          ],
          [
            issue.status === "resolved" ? "Resolved" : "Open for",
            resolved
              ? `${since(resolved.created)} after request · ${fmtDate(resolved.created)}`
              : duration(Date.now() - requested),
          ],
        ]}
      />
      <ol className="relative border-t border-border px-3 py-3">
        <Step
          time={report.requestedAt}
          dot="bg-foreground"
          head={
            <>
              <a
                href={href.entity("people", report.requestedBy)}
                className="text-foreground hover:underline"
              >
                {report.requestedBy}
              </a>{" "}
              sent DEBUGSHARE
            </>
          }
        >
          <a
            href={href.message(report.id, report.source.message)}
            className="text-link hover:underline"
          >
            command message {report.source.message}
          </a>
        </Step>
        {events.map((e, i) => {
          const prior = i > 0 ? events[i - 1].status : undefined;
          return (
            <Step
              key={e.id}
              time={e.created}
              sinceStart={since(e.created)}
              dot={
                {
                  open: "bg-sky-400",
                  investigating: "bg-amber-400",
                  blocked: "bg-rose-400",
                  resolved: "bg-emerald-400",
                }[e.status] ?? "bg-faint"
              }
              head={
                <>
                  <a
                    href={href.entity("actors", e.actor)}
                    className="text-foreground hover:underline"
                  >
                    {e.actor}
                  </a>{" "}
                  {prior && prior !== e.status ? (
                    <>
                      moved <StatusBadge status={prior} /> →{" "}
                      <StatusBadge status={e.status} />
                    </>
                  ) : (
                    <>
                      noted <StatusBadge status={e.status} />
                    </>
                  )}
                </>
              }
            >
              <RichText text={e.note} around={e.created} />
            </Step>
          );
        })}
      </ol>
      {events.length >= 200 && (
        <p className="px-3 pb-3 font-mono text-[11px] text-faint">
          Showing the earliest 200 history entries.
        </p>
      )}
    </Panel>
  );
}

function Step({
  time,
  sinceStart,
  dot,
  head,
  children,
}: {
  time: string;
  sinceStart?: string;
  dot: string;
  head: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="relative grid gap-x-3 pb-4 pl-5 last:pb-0 sm:grid-cols-[9.5rem_1fr] sm:pl-0">
      <span
        className="absolute left-[5px] top-2 bottom-0 w-px bg-border sm:left-[calc(9.5rem+0.375rem)]"
        aria-hidden="true"
      />
      <span
        className={cn(
          "absolute left-0.5 top-1.5 size-2 rounded-full ring-4 ring-panel sm:left-[calc(9.5rem+0.125rem)]",
          dot,
        )}
        aria-hidden="true"
      />
      <div className="font-mono text-[11.5px] tabular text-muted-foreground">
        <Tooltip content={time}>
          <span>{fmtDate(time)}</span>
        </Tooltip>
        {sinceStart && <div className="text-faint">+{sinceStart}</div>}
      </div>
      <div className="min-w-0 sm:pl-5">
        <p className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
          {head}
        </p>
        <p className="mt-1 max-w-[80ch] text-[13px] leading-relaxed text-secondary-foreground">
          {children}
        </p>
      </div>
    </li>
  );
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const typeOf = (v: Json) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
function Fields({ report }: { report: Report }) {
  const [filter, setFilter] = useState("");
  const json = report as unknown as Json;
  const flat = useMemo(() => {
    const out: { path: string; value: Json }[] = [];
    const walk = (v: Json, path: string) => {
      out.push({ path, value: v });
      if (Array.isArray(v))
        for (const [i, x] of v.entries()) walk(x, `${path}[${i}]`);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(json, "$");
    return out;
  }, [json]);
  const f = filter.trim().toLowerCase();
  return (
    <Panel
      id="fields"
      title="Fields"
      count={flat.length - 1}
      actions={
        <CopyButton
          value={JSON.stringify(report, null, 2)}
          label="Copy snapshot JSON"
        />
      }
    >
      <div className="border-b border-border p-2">
        <Input
          aria-label="Filter fields"
          placeholder="Filter paths and values, e.g. capture or messages[3]"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {f ? (
        <ul className="max-h-[32rem] overflow-y-auto">
          {flat
            .filter(
              ({ path, value }) =>
                path.toLowerCase().includes(f) ||
                (typeof value !== "object" &&
                  String(value).toLowerCase().includes(f)),
            )
            .slice(0, 300)
            .map(({ path, value }) => (
              <FieldRow
                key={path}
                name={path}
                value={value}
                depth={0}
                path={path}
              />
            ))}
        </ul>
      ) : (
        <ul className="max-h-[40rem] overflow-y-auto">
          {Object.entries(json as Record<string, Json>).map(([k, v]) => (
            <FieldRow key={k} name={k} value={v} depth={0} path={`$.${k}`} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function FieldRow({
  name,
  value,
  depth,
  path,
}: {
  name: string;
  value: Json;
  depth: number;
  path: string;
}) {
  const t = typeOf(value);
  const nested = t === "array" || t === "object";
  const [open, setOpen] = useState(false);
  const size = Array.isArray(value)
    ? value.length
    : value && typeof value === "object"
      ? Object.keys(value).length
      : 0;
  const preview = nested
    ? t === "array"
      ? `${size} item${size === 1 ? "" : "s"}`
      : `{ ${Object.keys(value as object)
          .slice(0, 4)
          .join(", ")}${size > 4 ? ", …" : ""} }`
    : t === "string"
      ? (value as string)
      : String(value);
  return (
    <li>
      <div
        className="group grid grid-cols-[minmax(10rem,38%)_1fr_auto] items-start gap-2 border-b border-border/70 py-1.5 pr-2 hover:bg-accent"
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
      >
        <button
          type="button"
          disabled={!nested}
          aria-expanded={nested ? open : undefined}
          onClick={() => setOpen(!open)}
          title={path}
          className="flex min-w-0 items-center gap-2 text-left font-mono text-[12.5px] text-foreground outline-none focus-visible:underline disabled:cursor-default"
        >
          {nested ? (
            open ? (
              <ChevronDown className="size-3 shrink-0 text-faint" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-faint" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <TypeBadge type={t} />
          <span className="truncate">{name}</span>
        </button>
        <span
          className={cn(
            "min-w-0 py-0.5 font-mono text-[12px]",
            nested
              ? "text-faint"
              : "line-clamp-3 break-all text-secondary-foreground",
          )}
        >
          {nested ? preview : <RichText text={preview} />}
        </span>
        <CopyButton
          value={nested ? JSON.stringify(value, null, 2) : String(value)}
          label={`Copy ${path}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      </div>
      {nested && open && (
        <ul>
          {(Array.isArray(value)
            ? value.map((v, i) => [`[${i}]`, v] as const)
            : Object.entries(value as Record<string, Json>)
          ).map(([k, v]) => (
            <FieldRow
              key={k}
              name={k}
              value={v}
              depth={depth + 1}
              path={k.startsWith("[") ? `${path}${k}` : `${path}.${k}`}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Correlation({ report, row }: { report: Report; row?: Row }) {
  const real = isRealSlack(report.source.team);
  const around = report.requestedAt;
  const traceRow = (
    label: string,
    trace: string,
    span: string,
  ): [ReactNode, ReactNode][] => [
    [
      `${label} trace`,
      <span key="t" className="flex flex-col gap-1">
        <a
          href={href.entity("traces", trace)}
          className="text-link hover:underline"
        >
          {trace}
        </a>
        {real ? (
          <span className="flex flex-wrap gap-x-3 font-sans text-[12px]">
            <Ext href={axiom.trace(trace, around)}>spans</Ext>
            <Ext href={axiom.logs(trace, around)}>logs</Ext>
          </span>
        ) : (
          <span className="font-sans text-[12px] text-faint">
            synthetic: not exported
          </span>
        )}
      </span>,
    ],
    [
      `${label} span`,
      real ? (
        <Ext key="s" href={axiom.span(span, around)}>
          {span}
        </Ext>
      ) : (
        span
      ),
    ],
  ];
  const rows: [ReactNode, ReactNode, string?][] = [
    ...(report.capture
      ? traceRow("Capture", report.capture.traceId, report.capture.spanId)
      : []),
    ...(report.transport
      ? [
          ...traceRow(
            "Receive",
            report.transport.traceId,
            report.transport.spanId,
          ),
          [
            "Request ID",
            report.transport.requestId,
            report.transport.requestId,
          ] as [ReactNode, ReactNode, string],
        ]
      : []),
  ];
  return (
    <Panel id="correlation" title="Correlation">
      {rows.length ? (
        <KV rows={rows} />
      ) : (
        <Empty title="No trace correlation retained">
          Reports captured before trace correlation, and operator imports, have
          no receive or capture span.
        </Empty>
      )}
      {report.capture && real && (
        <p className="border-t border-border px-3 py-2 text-[12px] text-faint">
          Axiom links open the private{" "}
          <span className="font-mono">computah-prod-traces</span> and{" "}
          <span className="font-mono">-logs</span> datasets (sign-in required,
          30-day retention). The capture span carries{" "}
          <span className="font-mono">computah.debugshare.id</span>
          {row && row.transportTrace === row.captureTrace
            ? "; capture and receive share one trace."
            : "."}
        </p>
      )}
    </Panel>
  );
}

function Related({ related }: { related: InspectionData["related"] }) {
  return (
    <Panel id="related" title="Related" count={related.length}>
      {related.length ? (
        <ul className="divide-y divide-border/70">
          {related.map((r) => (
            <li key={r.id}>
              <a
                href={href.issue(r.id)}
                className="block px-3 py-2.5 hover:bg-accent"
              >
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="line-clamp-1 text-[13px]">{r.title}</span>
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {r.reasons.map((x) => (
                    <Badge key={x} variant="outline">
                      {x}
                    </Badge>
                  ))}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No related issues">
          Nothing shares this conversation, its messages, submission handles or
          traces, and no stored text mentions it.
        </Empty>
      )}
    </Panel>
  );
}

const evidenceLabels: Record<string, string> = {
  axiom: "Axiom",
  commit: "Commits",
  amp: "Amp threads",
  url: "Links",
  trace: "Traces",
  issue: "Issues",
};
function Evidence({
  report,
  events,
}: {
  report: Report;
  events: InspectionData["events"];
}) {
  const found = new Map<
    string,
    {
      type: string;
      text: string;
      href: string;
      external: boolean;
      where: string;
    }
  >();
  const scan = (text: string, where: string) => {
    for (const t of tokenize(text))
      if (
        t.kind === "link" &&
        evidenceLabels[t.type] &&
        !(t.type === "issue" && t.href === href.issue(report.id))
      )
        if (!found.has(t.href)) found.set(t.href, { ...t, where });
  };
  for (const e of events) scan(e.note, `${e.actor} · ${fmtDate(e.created)}`);
  for (const m of report.messages) scan(m.text, `message ${m.ts}`);
  const groups = Object.keys(evidenceLabels)
    .map(
      (type) =>
        [type, [...found.values()].filter((f) => f.type === type)] as const,
    )
    .filter(([, items]) => items.length);
  return (
    <Panel
      title="Evidence links"
      count={found.size}
      defaultOpen={found.size > 0}
    >
      {groups.length ? (
        <div className="divide-y divide-border">
          {groups.map(([type, items]) => (
            <div key={type} className="px-3 py-2">
              <p className="mb-1 font-mono text-[11px] text-faint">
                {evidenceLabels[type]}
              </p>
              <ul className="space-y-1">
                {items.map((f) => (
                  <li key={f.href} className="min-w-0 text-[12.5px]">
                    {f.external ? (
                      <Ext href={f.href} className="break-all font-mono">
                        {f.text.replace(/^https?:\/\//, "")}
                      </Ext>
                    ) : (
                      <a
                        href={f.href}
                        className="break-all font-mono text-link hover:underline"
                      >
                        {f.text}
                      </a>
                    )}
                    <span className="ml-2 font-mono text-[11px] text-faint">
                      {f.where}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <Empty title="No links in notes or messages" />
      )}
    </Panel>
  );
}

function Resolution({ issue }: { issue: Issue }) {
  const [status, setStatus] = useState(issue.status);
  const [assignee, setAssignee] = useState(issue.assignee);
  const [revision, setRevision] = useState(issue.revision);
  const [actor, setActor] = useState(() => localStorage.getItem("actor") ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const stale = issue.revision > revision && !saving;
  return (
    <Panel id="update" title="Update" collapsible={false}>
      <form
        className="space-y-3 p-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError("");
          setSaved(false);
          try {
            const result = await client.mutate(
              updateRef,
              {
                id: issue.id,
                expectedRevision: revision,
                status,
                assignee,
                actor,
                note,
              },
              Summary,
            );
            localStorage.setItem("actor", actor.trim());
            setRevision(result.revision);
            setNote("");
            setSaved(true);
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "Update failed. Refresh and check the saved state before retrying.",
            );
          } finally {
            setSaving(false);
          }
        }}
      >
        {stale && (
          <div
            role="status"
            className="rounded-md border border-amber-400/30 bg-amber-400/10 p-3 text-[13px] text-amber-100"
          >
            <p>
              Someone saved revision {issue.revision} while you were editing.
              Your draft is kept but cannot overwrite it. Copy any evidence you
              want to keep, then load the latest state.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                setRevision(issue.revision);
                setStatus(issue.status);
                setAssignee(issue.assignee);
                setNote("");
                setError("");
              }}
            >
              Discard draft and load latest
            </Button>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <label
            htmlFor="upd-state"
            className="grid gap-1 text-[12px] text-muted-foreground"
          >
            State
            <NativeSelect
              id="upd-state"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {statusOrder.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </NativeSelect>
          </label>
          <label
            htmlFor="upd-assignee"
            className="grid gap-1 text-[12px] text-muted-foreground"
          >
            Assigned to
            <Input
              id="upd-assignee"
              value={assignee}
              maxLength={200}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="Agent, thread or operator"
            />
          </label>
          <label
            htmlFor="upd-actor"
            className="grid gap-1 text-[12px] text-muted-foreground"
          >
            Updated by
            <Input
              id="upd-actor"
              required
              value={actor}
              maxLength={200}
              onChange={(e) => setActor(e.target.value)}
              placeholder="Declared attribution"
            />
          </label>
        </div>
        <label
          htmlFor="upd-note"
          className="grid gap-1 text-[12px] text-muted-foreground"
        >
          Evidence note
          <Textarea
            id="upd-note"
            required
            maxLength={4000}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What changed, and what evidence supports this state? Trace IDs, commits and thread IDs become links."
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[11.5px] text-faint">
            rev {revision} · revision-checked write · attribution is
            self-declared · {note.length}/4000
          </p>
          <Button
            type="submit"
            disabled={saving || stale || !actor.trim() || !note.trim()}
          >
            {saving ? "Saving…" : "Save update"}
          </Button>
        </div>
        {saved && !error && (
          <p role="status" className="text-[13px] text-emerald-300">
            Saved as revision {revision}. History updated in Lifecycle.
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200"
          >
            {error}
          </p>
        )}
      </form>
    </Panel>
  );
}
