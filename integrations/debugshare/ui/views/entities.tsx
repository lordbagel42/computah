import { MessageSquareText, Waypoints } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CopyButton, Empty, Ext, KV, Panel } from "../components/rich.js";
import { Button, Input } from "../components/ui.js";
import { type Filters, noFilter, useSearch } from "../data.js";
import {
  ago,
  axiom,
  type EntityKind,
  fmtDate,
  href,
  isRealSlack,
  slack,
} from "../lib.js";
import { entities } from "./derive.js";
import {
  EventStream,
  IssueTable,
  Loading,
  MessageStream,
  PageHeader,
  QueryError,
  Unindexed,
  useIndex,
} from "./shell.js";

const meta: Record<
  EntityKind,
  { title: string; noun: string; filter: keyof Filters; about: string }
> = {
  people: {
    title: "People",
    noun: "Slack user",
    filter: "author",
    about:
      "Slack user IDs that requested a report or wrote a captured message. Names are not captured; the tracker stores IDs only.",
  },
  channels: {
    title: "Conversations",
    noun: "Slack conversation",
    filter: "channel",
    about: "Slack channels and DMs where DEBUGSHARE was sent.",
  },
  traces: {
    title: "Traces",
    noun: "Trace",
    filter: "trace",
    about:
      "OpenTelemetry trace IDs retained on reports (receive and capture) or cited in history notes. Spans and logs live in Axiom.",
  },
  submissions: {
    title: "Submissions",
    noun: "Submission handle",
    filter: "submission",
    about:
      "Core submission handles observed in the conversation when the report was captured. They are opaque handles, not task or actor IDs.",
  },
  actors: {
    title: "Actors",
    noun: "Actor",
    filter: "actor",
    about:
      "Names that wrote history events. Attribution is self-declared; Executor separately audits who called the tool.",
  },
};

export function EntityIndex({ kind }: { kind: EntityKind }) {
  const { data, pending, error } = useIndex();
  const [text, setText] = useState("");
  const m = meta[kind];
  const list = data
    ? entities(data, kind).filter((e) =>
        e.value.toLowerCase().includes(text.trim().toLowerCase()),
      )
    : [];
  return (
    <>
      <PageHeader crumbs={[[m.title]]} />
      <QueryError error={error} />
      <div className="space-y-3 p-4 md:p-5">
        <p className="max-w-3xl text-[13px] text-muted-foreground">{m.about}</p>
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) location.hash = href.entity(kind, text.trim());
          }}
        >
          <Input
            aria-label={`Filter or open a ${m.noun}`}
            placeholder={`Filter, or enter an exact ${m.noun.toLowerCase()}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" variant="outline">
            Open
          </Button>
        </form>
        <Panel title={kind} count={list.length} collapsible={false}>
          {pending && !data ? (
            <Loading />
          ) : list.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[11px] text-faint">
                    <th className="px-3 py-2 font-normal">
                      {m.noun.toLowerCase()}
                    </th>
                    <th className="px-3 py-2 text-right font-normal">issues</th>
                    <th className="px-3 py-2 font-normal">first seen</th>
                    <th className="px-3 py-2 font-normal">last seen</th>
                    <th className="px-3 py-2 font-normal">facts</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((e) => (
                    <tr
                      key={e.value}
                      className="relative border-b border-border/70 hover:bg-accent"
                    >
                      <td className="px-3 py-2 font-mono text-[12.5px]">
                        <a
                          href={href.entity(kind, e.value)}
                          className="break-all outline-none after:absolute after:inset-0 focus-visible:underline"
                        >
                          {e.value}
                        </a>
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular">
                        {e.issues.length}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted-foreground">
                        {fmtDate(e.first)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-muted-foreground">
                        {ago(e.last)}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11.5px] text-faint">
                        {summarizeFacts(e.facts)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={`No ${m.title.toLowerCase()} in the loaded index`} />
          )}
        </Panel>
      </div>
    </>
  );
}

function summarizeFacts(facts: [string, string][]) {
  const by = new Map<string, number>();
  for (const [k] of facts) by.set(k, (by.get(k) ?? 0) + 1);
  return [...by]
    .map(([k, n]) =>
      k === "workspace" ? facts.find(([x]) => x === k)?.[1] : `${k} ${n}`,
    )
    .join(" · ");
}

export function EntityView({
  kind,
  value,
}: {
  kind: EntityKind;
  value: string;
}) {
  const m = meta[kind];
  const index = useIndex();
  const { data, pending, error } = useSearch({
    ...noFilter,
    [m.filter]: value,
  });
  const known = index.data
    ? entities(index.data, kind).find((e) => e.value === value)
    : undefined;
  const rows = (data?.issues ?? [])
    .map((id) => index.byId.get(id))
    .filter((r) => r !== undefined);
  const around = rows[0]?.requestedAt ?? known?.first;
  const team = rows.find((r) => isRealSlack(r.team))?.team;
  const actions: ReactNode[] = [];
  if (kind === "people" && team && /^[UW]/.test(value))
    actions.push(
      <Button key="dm" variant="ghost" size="sm" asChild>
        <a href={slack.userApp(team, value)}>
          <MessageSquareText /> Open DM in Slack
        </a>
      </Button>,
    );
  if (kind === "channels" && team)
    actions.push(
      <Button key="ch" variant="ghost" size="sm" asChild>
        <a href={slack.channelApp(team, value)}>
          <MessageSquareText /> Open in Slack
        </a>
      </Button>,
    );
  const spans =
    kind === "traces" && !/^(.)\1+$/.test(value)
      ? axiom.trace(value, around)
      : null;
  if (spans)
    actions.push(
      <Button key="ax" variant="ghost" size="sm" asChild>
        <a href={spans} target="_blank" rel="noreferrer">
          <Waypoints /> Spans in Axiom
        </a>
      </Button>,
    );
  const facts: [ReactNode, ReactNode, string?][] = [
    [m.noun, value, value],
    ["Issues", String(data?.issues.length ?? rows.length)],
  ];
  if (known) {
    facts.push(["First seen", fmtDate(known.first)]);
    facts.push(["Last seen", `${fmtDate(known.last)} · ${ago(known.last)}`]);
  }
  if (kind === "people" && index.data)
    facts.push([
      "Reports requested",
      String(index.data.issues.filter((r) => r.requestedBy === value).length),
    ]);
  if (kind === "traces" && known)
    facts.push([
      "Retained as",
      [...new Set(known.facts.map(([k]) => k))].join(", "),
    ]);
  if (spans)
    facts.push([
      "Axiom",
      <span key="ax" className="flex flex-wrap gap-x-3 font-sans">
        <Ext href={axiom.trace(value, around)}>spans</Ext>
        <Ext href={axiom.logs(value, around)}>logs</Ext>
      </span>,
    ]);
  if (kind === "channels" && team)
    facts.push([
      "Slack",
      <span key="sl" className="flex gap-x-3 font-sans">
        <a
          href={slack.channelApp(team, value)}
          className="text-link hover:underline"
        >
          app
        </a>
        <Ext href={slack.channelWeb(team, value)}>web</Ext>
      </span>,
    ]);
  const showMessages = kind === "people" || kind === "channels";
  const showEvents = kind === "traces" || kind === "actors";
  return (
    <>
      <PageHeader
        crumbs={[[m.title, href.index(kind)], [value]]}
        actions={
          <>
            {actions}
            <CopyButton value={value} label={`Copy ${m.noun.toLowerCase()}`} />
          </>
        }
      />
      <QueryError error={error ?? index.error} />
      <div className="grid gap-4 p-4 md:p-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Panel title="Issues" count={data?.issues.length}>
            {pending && !data ? (
              <Loading />
            ) : (
              <>
                <IssueTable
                  compact
                  rows={rows}
                  empty={`No issue references this ${m.noun.toLowerCase()}`}
                />
                <Unindexed ids={data?.issues ?? []} index={index.byId} />
              </>
            )}
          </Panel>
          {showMessages && (
            <Panel title="Messages" count={data?.messages.length}>
              {data ? (
                <MessageStream messages={data.messages} index={index.byId} />
              ) : (
                <Loading />
              )}
            </Panel>
          )}
          {showEvents && (
            <Panel title="History notes" count={data?.events.length}>
              {data ? <EventStream events={data.events} /> : <Loading />}
            </Panel>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <Panel title={m.noun} collapsible={false}>
            <KV rows={facts} />
            <p className="border-t border-border px-3 py-2 text-[12px] text-faint">
              {m.about}
            </p>
          </Panel>
        </div>
      </div>
    </>
  );
}
