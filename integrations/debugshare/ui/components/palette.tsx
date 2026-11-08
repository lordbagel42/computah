import {
  Activity,
  CircleDot,
  CornerDownLeft,
  LayoutDashboard,
  MessagesSquare,
  Search,
  Table2,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useExplore } from "../data.js";
import {
  cn,
  type EntityKind,
  href,
  isDebugshareId,
  statusDot,
} from "../lib.js";
import { entities } from "../views/derive.js";
import { Modal } from "./ui.js";

const entityIcons: Partial<Record<EntityKind, ReactNode>> = {
  people: <Users />,
  channels: <MessagesSquare />,
  traces: <Waypoints />,
  actors: <UserCog />,
};

type Item = { key: string; text: string; to: string; node: ReactNode };
type Group = { heading: string; items: Item[] };

const matches = (text: string, q: string) => {
  const t = text.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/u)
    .every((w) => t.includes(w));
};

/** ⌘K: jump to any page, issue or entity, or search every snapshot. */
export function Palette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      label="Search and jump"
      className="top-[12vh] mx-auto mb-auto w-[min(640px,calc(100vw-1.5rem))]"
    >
      <PaletteBody close={() => onOpenChange(false)} />
    </Modal>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const { data } = useExplore();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const trimmed = q.trim();
  const go = (to: string) => {
    location.hash = to;
    close();
  };
  const groups = useMemo<Group[]>(() => {
    const all: Group[] = [];
    if (trimmed)
      all.push({
        heading: "Search",
        items: [
          ...(isDebugshareId(trimmed)
            ? [
                {
                  key: "open-id",
                  text: "",
                  to: href.issue(trimmed),
                  node: (
                    <>
                      <CircleDot /> Open issue{" "}
                      <span className="font-mono">{trimmed}</span>
                    </>
                  ),
                },
              ]
            : []),
          {
            key: "search-all",
            text: "",
            to: href.search(trimmed),
            node: (
              <>
                <Search /> Search everything for “{trimmed}”
                <CornerDownLeft className="ml-auto" />
              </>
            ),
          },
        ],
      });
    const pages: [string, string, ReactNode][] = [
      ["Overview", href.overview, <LayoutDashboard key="o" />],
      ["Issues", href.issues, <CircleDot key="i" />],
      ["Activity", href.activity, <Activity key="a" />],
      ["People", href.index("people"), <Users key="p" />],
      ["Conversations", href.index("channels"), <MessagesSquare key="c" />],
      ["Traces", href.index("traces"), <Waypoints key="t" />],
      ["Actors", href.index("actors"), <UserCog key="ac" />],
      ["Tables: issues", href.tables("issues"), <Table2 key="ti" />],
      [
        "Tables: issue_events",
        href.tables("issue_events"),
        <Table2 key="te" />,
      ],
    ];
    all.push({
      heading: "Pages",
      items: pages.map(([label, to, icon]) => ({
        key: `page:${label}`,
        text: label,
        to,
        node: (
          <>
            {icon}
            {label}
          </>
        ),
      })),
    });
    if (data) {
      all.push({
        heading: "Issues",
        items: data.issues.map((r) => ({
          key: `issue:${r.id}`,
          text: `${r.id} ${r.title} ${r.assignee} ${r.requestedBy}`,
          to: href.issue(r.id),
          node: (
            <>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  statusDot[r.status],
                )}
              />
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="font-mono text-[11px] text-faint">
                {r.id.slice(0, 20)}
              </span>
            </>
          ),
        })),
      });
      for (const kind of [
        "people",
        "channels",
        "traces",
        "actors",
      ] as EntityKind[])
        all.push({
          heading: kind,
          items: entities(data, kind)
            .slice(0, 50)
            .map((e) => ({
              key: `${kind}:${e.value}`,
              text: `${kind} ${e.value}`,
              to: href.entity(kind, e.value),
              node: (
                <>
                  {entityIcons[kind]}
                  <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                    {e.value}
                  </span>
                  <span className="font-mono text-[11px] text-faint">
                    {e.issues.length} issue
                    {e.issues.length === 1 ? "" : "s"}
                  </span>
                </>
              ),
            })),
        });
    }
    return all
      .map((g) => ({
        ...g,
        items: g.items
          .filter((i) => !trimmed || !i.text || matches(i.text, trimmed))
          .slice(0, 100),
      }))
      .filter((g) => g.items.length);
  }, [data, trimmed]);
  const flat = groups.flatMap((g) => g.items);
  const current = flat[Math.min(active, flat.length - 1)];
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query restarts selection at the top.
  useEffect(() => setActive(0), [trimmed]);
  useEffect(() => {
    if (current)
      document
        .getElementById(`${id}-${current.key}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [current, id]);
  const onKeyDown = (e: KeyboardEvent) => {
    const last = flat.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" && current) go(current.to);
    else return;
    e.preventDefault();
  };
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-popover shadow-2xl shadow-black/60">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted-foreground" aria-hidden />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to take typed input immediately.
          autoFocus
          role="combobox"
          aria-label="Search and jump"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={current ? `${id}-${current.key}` : undefined}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to an issue, person, trace… or search all snapshots"
          className="h-12 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Results"
        className="max-h-[60vh] overflow-y-auto p-1.5"
      >
        {!flat.length && (
          <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
            No direct match.
          </p>
        )}
        {groups.map((g) => (
          // biome-ignore lint/a11y/useSemanticElements: ARIA listbox groups are role="group"; a fieldset is not a valid listbox child.
          <div
            key={g.heading}
            role="group"
            aria-labelledby={`${id}-h-${g.heading}`}
          >
            <div
              id={`${id}-h-${g.heading}`}
              className="px-2 pt-3 pb-1 font-mono text-[11px] text-faint uppercase tracking-[0.08em]"
            >
              {g.heading}
            </div>
            {g.items.map((i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input via aria-activedescendant.
              <div
                key={i.key}
                id={`${id}-${i.key}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === current}
                data-selected={i === current}
                onMouseMove={() => setActive(flat.indexOf(i))}
                onClick={() => go(i.to)}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-secondary-foreground data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
              >
                {i.node}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-3 py-2 font-mono text-[11px] text-faint">
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>esc close</span>
        <span className="ml-auto">/ or ⌘K anywhere</span>
      </div>
    </div>
  );
}
