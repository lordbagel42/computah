import { useMemo, useState } from "react";
import { TimeChart } from "../components/chart.js";
import { Panel } from "../components/rich.js";
import { Input, NativeSelect } from "../components/ui.js";
import { statusOrder } from "../lib.js";
import {
  EventStream,
  Loading,
  PageHeader,
  QueryError,
  useIndex,
} from "./shell.js";

export function ActivityView() {
  const { data, pending, error } = useIndex();
  const [status, setStatus] = useState("all");
  const [actor, setActor] = useState("all");
  const [text, setText] = useState("");
  const events = data?.events ?? [];
  const actors = [...new Set(events.map((e) => e.actor))].sort();
  const list = useMemo(() => {
    const t = text.trim().toLowerCase();
    return events.filter(
      (e) =>
        (status === "all" || e.status === status) &&
        (actor === "all" || e.actor === actor) &&
        (!t || `${e.note} ${e.issue} ${e.title}`.toLowerCase().includes(t)),
    );
  }, [events, status, actor, text]);
  return (
    <>
      <PageHeader crumbs={[["Activity"]]} />
      <QueryError error={error} />
      <div className="space-y-4 p-4 md:p-5">
        <Panel title="History events over time" collapsible={false}>
          <TimeChart
            label="History events over time"
            series={[
              {
                label: "events shown",
                color: "#4b8ef5",
                times: list.map((e) => Date.parse(e.created)),
              },
            ]}
          />
        </Panel>
        <div className="flex flex-wrap gap-2">
          <NativeSelect
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All states</option>
            {statusOrder.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Actor"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
          >
            <option value="all">All actors</option>
            {actors.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </NativeSelect>
          <Input
            aria-label="Filter notes"
            className="max-w-sm"
            placeholder="Filter notes, issue IDs and titles"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Panel
          title="issue_events"
          count={`${list.length}${data && data.totals.events > events.length ? ` of ${data.totals.events}` : ""}`}
          collapsible={false}
        >
          {pending && !data ? (
            <Loading />
          ) : (
            <EventStream events={list} empty="No events match these filters" />
          )}
        </Panel>
      </div>
    </>
  );
}
