import { useEffect, useMemo, useState } from "react";
import { Panel } from "../components/rich.js";
import { Input, Kbd, NativeSelect } from "../components/ui.js";
import { cn, href, ignoreShortcut, isSynthetic, statusOrder } from "../lib.js";
import {
  IssueTable,
  Loading,
  PageHeader,
  QueryError,
  useIndex,
} from "./shell.js";

const sorts = {
  updated: "Recently updated",
  created: "Newest report",
  messages: "Most messages",
  events: "Most history",
} as const;

function useStored<T extends string>(key: string, initial: T) {
  const [v, setV] = useState<T>(
    () => (sessionStorage.getItem(key) as T | null) ?? initial,
  );
  return [
    v,
    (n: T) => {
      sessionStorage.setItem(key, n);
      setV(n);
    },
  ] as const;
}

export function IssuesView() {
  const { data, pending, error } = useIndex();
  const [status, setStatus] = useStored<string>("issues.status", "all");
  const [sort, setSort] = useStored<keyof typeof sorts>(
    "issues.sort",
    "updated",
  );
  const [synthetic, setSynthetic] = useStored<"show" | "hide">(
    "issues.synthetic",
    "show",
  );
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const all = data?.issues ?? [];
  const rows = useMemo(() => {
    const t = text.trim().toLowerCase();
    const list = all.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (synthetic === "show" || !isSynthetic(r)) &&
        (!t ||
          `${r.id} ${r.title} ${r.assignee} ${r.requestedBy} ${r.channel} ${r.lastActor} ${r.captureTrace ?? ""}`
            .toLowerCase()
            .includes(t)),
    );
    const key = {
      updated: (r: (typeof all)[number]) => r.updated,
      created: (r: (typeof all)[number]) => r.created,
      messages: (r: (typeof all)[number]) =>
        String(r.messageCount).padStart(6, "0"),
      events: (r: (typeof all)[number]) =>
        String(r.eventCount).padStart(6, "0"),
    }[sort];
    return [...list].sort((a, b) => key(b).localeCompare(key(a)));
  }, [all, status, sort, synthetic, text]);
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (ignoreShortcut(e)) return;
      if (e.key === "j" || e.key === "ArrowDown")
        setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (e.key === "k" || e.key === "ArrowUp")
        setCursor((c) => Math.max(0, c - 1));
      else if (e.key === "Enter" && rows[cursor])
        location.hash = href.issue(rows[cursor].id);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, [rows, cursor]);
  useEffect(() => {
    document
      .querySelector(`[data-row="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const counts = Object.fromEntries(
    statusOrder.map((s) => [s, all.filter((r) => r.status === s).length]),
  );
  return (
    <>
      <PageHeader crumbs={[["Issues"]]} />
      <QueryError error={error} />
      <div className="space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <fieldset className="flex flex-wrap rounded-md border border-border p-0.5">
            <legend className="sr-only">Status</legend>
            {["all", ...statusOrder].map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={status === s}
                onClick={() => setStatus(s)}
                className={cn(
                  "rounded px-2.5 py-1 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2",
                  status === s && "bg-secondary text-foreground",
                )}
              >
                {s}{" "}
                <span className="text-faint">
                  {s === "all" ? all.length : counts[s]}
                </span>
              </button>
            ))}
          </fieldset>
          <Input
            aria-label="Filter loaded issues"
            placeholder="Filter by ID, title, person, actor, trace…"
            className="w-full sm:w-72"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <NativeSelect
            aria-label="Sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as keyof typeof sorts)}
          >
            {Object.entries(sorts).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <input
              type="checkbox"
              className="accent-[#4b8ef5]"
              checked={synthetic === "show"}
              onChange={(e) => setSynthetic(e.target.checked ? "show" : "hide")}
            />
            Show synthetic checks
          </label>
          <span className="ml-auto hidden items-center gap-1 font-mono text-[11px] text-faint lg:flex">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd> move <Kbd>↵</Kbd> open
          </span>
        </div>
        <Panel
          title="issues"
          count={`${rows.length}${data && data.totals.issues > all.length ? ` of ${data.totals.issues}` : ""}`}
          collapsible={false}
        >
          {pending && !data ? (
            <Loading />
          ) : (
            <IssueTable
              rows={rows}
              selected={cursor}
              empty={
                all.length
                  ? "No issues match these filters"
                  : "No captured reports yet. Send DEBUGSHARE with a short description in an authorized Computah conversation."
              }
            />
          )}
        </Panel>
        {data && data.totals.issues > all.length && (
          <p className="font-mono text-[12px] text-faint">
            The index shows the {all.length} most recently updated issues.
            Search covers all {data.totals.issues}.
          </p>
        )}
      </div>
    </>
  );
}
