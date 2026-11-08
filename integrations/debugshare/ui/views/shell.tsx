import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Empty, RichText, StatusBadge } from "../components/rich.js";
import { Button, Input, Skeleton, Tooltip } from "../components/ui.js";
import type { ExploreData, Row, SearchData } from "../data.js";
import { useExplore } from "../data.js";
import {
  ago,
  cn,
  fmtDate,
  fmtTime,
  href,
  isDebugshareId,
  isSynthetic,
  slackDate,
} from "../lib.js";

export function PageHeader({
  crumbs,
  actions,
}: {
  crumbs: [string, string?][];
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur md:px-5">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1.5 text-[15px]">
          {crumbs.map(([label, to], i) => (
            <Fragment key={label}>
              {i > 0 && <span className="text-faint">/</span>}
              <li
                className={cn(
                  "min-w-0 truncate",
                  i === crumbs.length - 1
                    ? "font-mono text-[14px] text-foreground"
                    : "text-secondary-foreground",
                )}
              >
                {to ? (
                  <a
                    href={to}
                    className="hover:text-foreground hover:underline"
                  >
                    {label}
                  </a>
                ) : (
                  label
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>
      {actions && (
        <div className="flex flex-wrap items-center gap-1">{actions}</div>
      )}
    </header>
  );
}

export function NotFound({ raw }: { raw: string }) {
  const [value, setValue] = useState(raw);
  return (
    <>
      <PageHeader crumbs={[["Lookup"]]} />
      <div className="mx-auto max-w-xl p-6">
        <p className="text-[15px]">
          <span className="font-mono">{raw}</span> is not an issue ID or page.
        </p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Issue IDs are <span className="font-mono">computah_bug_</span> plus 24
          lowercase letters or digits, or a legacy lowercase UUID. Search looks
          through every stored snapshot instead.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            location.hash = isDebugshareId(v) ? v : href.search(v).slice(1);
          }}
        >
          <Input
            aria-label="Issue ID or search text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit">Open</Button>
        </form>
      </div>
    </>
  );
}

export function Loading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className="h-7" />
      ))}
    </div>
  );
}

export function QueryError({ error }: { error?: string }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[13px] text-rose-200"
    >
      Refresh failed; showing the last loaded data. {error}
    </p>
  );
}

export function useIndex() {
  const q = useExplore();
  const byId = new Map((q.data?.issues ?? []).map((r) => [r.id, r]));
  return { ...q, byId };
}

export function IssueLink({ id, row }: { id: string; row?: Row }) {
  return (
    <a
      href={href.issue(id)}
      className="font-mono text-[12px] text-link hover:underline"
      title={row?.title}
    >
      {id}
    </a>
  );
}

/** Dense dataset-style issue table. */
export function IssueTable({
  rows,
  selected,
  empty = "No issues",
  compact = false,
}: {
  rows: readonly Row[];
  selected?: number;
  empty?: string;
  compact?: boolean;
}) {
  if (!rows.length) return <Empty title={empty} />;
  return (
    <>
      <ul className="divide-y divide-border/70 md:hidden">
        {rows.map((r, i) => (
          <li key={r.id} className={cn(selected === i && "bg-accent")}>
            <a
              href={href.issue(r.id)}
              className="block px-3 py-2.5 active:bg-accent"
            >
              <span className="flex items-start gap-2">
                <StatusBadge status={r.status} className="mt-px shrink-0" />
                <span className="line-clamp-2 text-[13.5px] text-foreground">
                  {r.title}
                </span>
              </span>
              <span className="mt-1 block truncate font-mono text-[11px] text-faint">
                {r.id}
              </span>
              <span className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
                <span>{r.messageCount} msgs</span>
                <span>{r.eventCount} events</span>
                <span>updated {ago(r.updated)}</span>
                {isSynthetic(r) && <span>synthetic</span>}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table
          className={cn(
            "w-full border-collapse text-[13px]",
            compact ? "min-w-[520px]" : "min-w-[860px]",
          )}
        >
          <thead>
            <tr className="border-b border-border text-left font-mono text-[11px] text-faint">
              <th className="px-3 py-2 font-normal">status</th>
              <th className="px-3 py-2 font-normal">title</th>
              {!compact && (
                <th className="px-3 py-2 font-normal">requested by</th>
              )}
              <th className="px-3 py-2 text-right font-normal">msgs</th>
              <th className="px-3 py-2 text-right font-normal">events</th>
              {!compact && <th className="px-3 py-2 font-normal">trace</th>}
              {!compact && <th className="px-3 py-2 font-normal">created</th>}
              <th className="px-3 py-2 font-normal">updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.id}
                data-row={i}
                aria-selected={selected === i || undefined}
                className={cn(
                  "group relative border-b border-border/70 transition-colors hover:bg-accent",
                  selected === i && "bg-accent",
                )}
              >
                <td className="px-3 py-2 align-top">
                  <StatusBadge status={r.status} />
                </td>
                <td className="max-w-[30rem] px-3 py-2 align-top">
                  <a
                    href={href.issue(r.id)}
                    className="line-clamp-1 text-foreground outline-none after:absolute after:inset-0 focus-visible:underline"
                  >
                    {r.title}
                  </a>
                  <span className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-faint">
                    {r.id}
                    {isSynthetic(r) && (
                      <span className="rounded border border-border px-1 text-[10px] text-muted-foreground">
                        synthetic
                      </span>
                    )}
                    {r.assignee && (
                      <span className="truncate">→ {r.assignee}</span>
                    )}
                  </span>
                </td>
                {!compact && (
                  <td className="px-3 py-2 align-top font-mono text-[12px] text-secondary-foreground">
                    {r.requestedBy}
                  </td>
                )}
                <td className="px-3 py-2 text-right align-top font-mono tabular text-secondary-foreground">
                  {r.messageCount}
                </td>
                <td className="px-3 py-2 text-right align-top font-mono tabular text-secondary-foreground">
                  {r.eventCount}
                </td>
                {!compact && (
                  <td className="px-3 py-2 align-top font-mono text-[12px] text-muted-foreground">
                    {r.captureTrace ? String(r.captureTrace).slice(0, 8) : "—"}
                  </td>
                )}
                {!compact && (
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[12px] tabular text-muted-foreground">
                    <Tooltip content={fmtDate(r.created)}>
                      <span>{ago(r.created)}</span>
                    </Tooltip>
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[12px] tabular text-muted-foreground">
                  <Tooltip content={fmtDate(r.updated)}>
                    <span>{ago(r.updated)}</span>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** History events as a log stream. */
export function EventStream({
  events,
  showIssue = true,
  empty = "No history events",
}: {
  events: ExploreData["events"];
  showIssue?: boolean;
  empty?: string;
}) {
  if (!events.length) return <Empty title={empty} />;
  return (
    <ol className="divide-y divide-border/70">
      {events.map((e) => (
        <li
          key={e.id}
          className="grid gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[9.5rem_1fr]"
        >
          <div className="flex items-center gap-2 font-mono text-[11.5px] tabular text-muted-foreground sm:flex-col sm:items-start sm:gap-1">
            <Tooltip content={e.created}>
              <span>{fmtDate(e.created)}</span>
            </Tooltip>
            <StatusBadge status={e.status} />
          </div>
          <div className="min-w-0 text-[13px]">
            <p className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
              <a
                href={href.entity("actors", e.actor)}
                className="font-medium text-foreground hover:underline"
              >
                {e.actor}
              </a>
              {showIssue && (
                <a
                  href={href.issue(e.issue)}
                  className="min-w-0 truncate text-[12px] hover:text-foreground hover:underline"
                >
                  on <span className="font-mono">{e.issue}</span> · {e.title}
                </a>
              )}
            </p>
            <p className="mt-1 leading-relaxed text-secondary-foreground">
              <RichText text={e.note} around={e.created} />
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Deduplicated messages from search, each pointing at every snapshot holding it. */
export function MessageStream({
  messages,
  index,
}: {
  messages: SearchData["messages"];
  index: Map<string, Row>;
}) {
  if (!messages.length) return <Empty title="No captured messages match" />;
  return (
    <ol className="divide-y divide-border/70">
      {messages.map((m) => {
        const d = slackDate(m.ts);
        return (
          <li key={`${m.channel}${m.ts}`} className="px-3 py-2.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11.5px] text-muted-foreground">
              <a
                href={href.entity("people", m.author)}
                className="text-foreground hover:underline"
              >
                {m.author}
              </a>
              <span>in</span>
              <a
                href={href.entity("channels", m.channel)}
                className="hover:text-foreground hover:underline"
              >
                {m.channel}
              </a>
              <span className="tabular">
                {d ? `${fmtDate(d).slice(0, 10)} ${fmtTime(d)}` : m.ts}
              </span>
              <span className="text-faint">·</span>
              {m.issues.map((id) => (
                <a
                  key={id}
                  href={href.message(id, m.ts)}
                  title={index.get(id)?.title}
                  className="inline-flex items-center gap-0.5 text-link hover:underline"
                >
                  {id.slice(0, 18)}…
                  <ArrowUpRight className="size-3" />
                </a>
              ))}
            </div>
            <p className="mt-1 leading-relaxed text-secondary-foreground">
              <RichText text={m.text} />
            </p>
          </li>
        );
      })}
    </ol>
  );
}

export function StatStrip({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 font-mono text-[12px]">
      {items.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-1.5">
          <dt className="text-faint">{k}</dt>
          <dd className="tabular text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function More({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      className="inline-flex items-center gap-0.5 font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
    >
      {children}
      <ChevronRight className="size-3" />
    </a>
  );
}

/** Matches outside the 500-row index still get a link, never silently dropped. */
export function Unindexed({
  ids,
  index,
}: {
  ids: readonly string[];
  index: Map<string, Row>;
}) {
  const missing = ids.filter((id) => !index.has(id));
  if (!missing.length) return null;
  return (
    <div className="border-t border-border px-3 py-2.5 text-[12px] text-muted-foreground">
      <p className="mb-1 font-mono text-[11px] text-faint">
        {missing.length} older match{missing.length === 1 ? "" : "es"} outside
        the loaded index
      </p>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {missing.map((id) => (
          <li key={id}>
            <IssueLink id={id} />
          </li>
        ))}
      </ul>
    </div>
  );
}
