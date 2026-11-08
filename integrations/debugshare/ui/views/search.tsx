import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Panel } from "../components/rich.js";
import { Button, Input } from "../components/ui.js";
import { noFilter, useSearch } from "../data.js";
import { href, isDebugshareId } from "../lib.js";
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

export function SearchView({ q }: { q: string }) {
  const [value, setValue] = useState(q);
  useEffect(() => setValue(q), [q]);
  const index = useIndex();
  const { data, pending, error } = useSearch({ ...noFilter, text: q });
  const rows = (data?.issues ?? [])
    .map((id) => index.byId.get(id))
    .filter((r) => r !== undefined);
  return (
    <>
      <PageHeader
        crumbs={[["Search", href.search("")], ...(q ? [[q] as [string]] : [])]}
      />
      <QueryError error={error} />
      <div className="space-y-4 p-4 md:p-5">
        <form
          className="flex max-w-2xl gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            location.hash = href.search(value.trim());
          }}
        >
          <Input
            autoFocus={!q}
            aria-label="Search everything"
            placeholder="Text, IDs, trace IDs, Slack IDs, submission handles…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="submit">
            <Search /> Search
          </Button>
        </form>
        {q && isDebugshareId(q.trim()) && (
          <p className="text-[13px]">
            <a
              href={href.issue(q.trim())}
              className="font-mono text-link hover:underline"
            >
              Open {q.trim()} directly
            </a>
          </p>
        )}
        {!q ? (
          <p className="max-w-2xl text-[13px] text-muted-foreground">
            Search scans every stored snapshot (all fields, including message
            text, submission handles and trace IDs), issue titles and assignees,
            and every history note. Matches are case-insensitive substrings.
          </p>
        ) : pending && !data ? (
          <Loading />
        ) : data ? (
          <>
            <Panel title="Issues" count={data.issues.length}>
              <IssueTable rows={rows} empty="No issue matches" />
              <Unindexed ids={data.issues} index={index.byId} />
            </Panel>
            <Panel title="Messages" count={data.messages.length}>
              <MessageStream messages={data.messages} index={index.byId} />
            </Panel>
            <Panel title="History notes" count={data.events.length}>
              <EventStream
                events={data.events}
                empty="No history note matches"
              />
            </Panel>
          </>
        ) : null}
      </div>
    </>
  );
}
