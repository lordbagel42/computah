import type { ReactNode } from "react";
import {
  KV,
  Panel,
  RichText,
  StatusBadge,
  TypeBadge,
} from "../components/rich.js";
import { bytes, cn, fmtDate, href } from "../lib.js";
import { Loading, PageHeader, QueryError, useIndex } from "./shell.js";

// Mirrors migrations/0001_issues.sql (immutable migration).
const schema = {
  issues: {
    rowsKey: "issues",
    columns: [
      ["id", "TEXT", "PRIMARY KEY NOT NULL"],
      ["title", "TEXT", "NOT NULL"],
      [
        "status",
        "TEXT",
        "NOT NULL CHECK(status IN ('open','investigating','blocked','resolved'))",
      ],
      ["assignee", "TEXT", "NOT NULL DEFAULT ''"],
      ["revision", "INTEGER", "NOT NULL DEFAULT 1"],
      ["report", "TEXT", "NOT NULL · immutable snapshot JSON"],
      ["created", "TEXT", "NOT NULL"],
      ["updated", "TEXT", "NOT NULL"],
    ],
    indexes: ["issues_updated ON issues(updated)"],
  },
  issue_events: {
    rowsKey: "events",
    columns: [
      ["id", "TEXT", "PRIMARY KEY NOT NULL"],
      ["issue", "TEXT", "NOT NULL REFERENCES issues(id)"],
      ["status", "TEXT", "NOT NULL"],
      ["actor", "TEXT", "NOT NULL"],
      ["note", "TEXT", "NOT NULL"],
      ["created", "TEXT", "NOT NULL"],
    ],
    indexes: ["issue_events_issue ON issue_events(issue,created)"],
  },
} as const;
type Table = keyof typeof schema;

export function TablesView({ table }: { table: string }) {
  const { data, pending, error } = useIndex();
  const name: Table = table === "issue_events" ? "issue_events" : "issues";
  const def = schema[name];
  return (
    <>
      <PageHeader crumbs={[["Tables", href.tables()], [name]]} />
      <QueryError error={error} />
      <div className="flex gap-1 border-b border-border px-4 md:px-5">
        {(Object.keys(schema) as Table[]).map((t) => (
          <a
            key={t}
            href={href.tables(t)}
            aria-current={t === name ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 border-transparent px-2 py-2.5 font-mono text-[12.5px] text-muted-foreground hover:text-foreground",
              t === name && "border-primary text-foreground",
            )}
          >
            {t}
            <span className="ml-1.5 text-faint">
              {data
                ? t === "issues"
                  ? data.totals.issues
                  : data.totals.events
                : ""}
            </span>
          </a>
        ))}
      </div>
      <div className="grid gap-4 p-4 md:p-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title="Rows"
          count={
            data
              ? `${name === "issues" ? data.issues.length : data.events.length} of ${name === "issues" ? data.totals.issues : data.totals.events}`
              : undefined
          }
          collapsible={false}
          className="min-w-0"
        >
          {pending && !data ? (
            <Loading />
          ) : data ? (
            <div className="max-h-[calc(100vh-12rem)] overflow-auto">
              <table className="w-max min-w-full border-collapse font-mono text-[12px]">
                <thead className="sticky top-0 z-10 bg-panel-head">
                  <tr className="border-b border-border text-left text-[11px] text-faint">
                    {def.columns.map(([c, t]) => (
                      <th
                        key={c}
                        className="whitespace-nowrap border-r border-border/70 px-3 py-2 font-normal last:border-r-0"
                      >
                        {c} <span className="text-[10px] opacity-70">{t}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {name === "issues"
                    ? data.issues.map((r) => (
                        <tr
                          key={r.id}
                          className="border-b border-border/70 align-top hover:bg-accent"
                        >
                          <Cell>
                            <a
                              href={href.issue(r.id)}
                              className="text-link hover:underline"
                            >
                              {r.id}
                            </a>
                          </Cell>
                          <Cell wide>{r.title}</Cell>
                          <Cell>
                            <StatusBadge status={r.status} />
                          </Cell>
                          <Cell>
                            {r.assignee ? (
                              <RichText text={r.assignee} />
                            ) : (
                              <Null />
                            )}
                          </Cell>
                          <Cell>{r.revision}</Cell>
                          <Cell>
                            <a
                              href={href.issue(r.id, "fields")}
                              className="text-link hover:underline"
                            >
                              {"{…}"} {bytes(r.bytes)}
                            </a>
                          </Cell>
                          <Cell>{r.created}</Cell>
                          <Cell>{r.updated}</Cell>
                        </tr>
                      ))
                    : data.events.map((e) => (
                        <tr
                          key={e.id}
                          className="border-b border-border/70 align-top hover:bg-accent"
                        >
                          <Cell>{e.id}</Cell>
                          <Cell>
                            <a
                              href={href.issue(e.issue, "lifecycle")}
                              className="text-link hover:underline"
                              title={e.title}
                            >
                              {e.issue}
                            </a>
                          </Cell>
                          <Cell>
                            <StatusBadge status={e.status} />
                          </Cell>
                          <Cell>
                            <a
                              href={href.entity("actors", e.actor)}
                              className="hover:underline"
                            >
                              {e.actor}
                            </a>
                          </Cell>
                          <Cell wide>
                            <span className="line-clamp-3" title={e.note}>
                              <RichText text={e.note} around={e.created} />
                            </span>
                          </Cell>
                          <Cell>{e.created}</Cell>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>
        <div className="min-w-0 space-y-4">
          <Panel title="Fields" count={def.columns.length}>
            <ul className="divide-y divide-border/70">
              {def.columns.map(([c, t, rule]) => (
                <li key={c} className="flex items-start gap-2.5 px-3 py-2">
                  <TypeBadge type={t === "INTEGER" ? "number" : "string"} />
                  <span className="min-w-0">
                    <span className="block font-mono text-[12.5px]">{c}</span>
                    <span className="block font-mono text-[11px] text-faint">
                      {rule}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Table">
            <KV
              rows={[
                ["Name", name],
                ["Engine", "Executor app SQLite"],
                ["Indexes", def.indexes.join("; ")],
                ["Migration", "0001_issues.sql"],
                ...(data && name === "issues"
                  ? ([["Snapshot bytes", bytes(data.totals.bytes)]] as [
                      string,
                      string,
                    ][])
                  : []),
                ...(data && name === "issue_events" && data.events.length
                  ? ([["Newest row", fmtDate(data.events[0].created)]] as [
                      string,
                      string,
                    ][])
                  : []),
              ]}
            />
            <p className="border-t border-border px-3 py-2 text-[12px] text-faint">
              Read-only view through the app's bounded queries: newest 500 rows
              per table. No raw SQL is accepted from the browser.
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Cell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <td
      className={cn(
        "border-r border-border/70 px-3 py-1.5 last:border-r-0",
        wide
          ? "min-w-[18rem] max-w-[34rem] whitespace-normal"
          : "whitespace-nowrap",
      )}
    >
      {children}
    </td>
  );
}
const Null = () => <span className="text-faint">''</span>;
