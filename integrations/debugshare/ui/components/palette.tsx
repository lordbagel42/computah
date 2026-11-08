import { Command } from "cmdk";
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
import { type ReactNode, useState } from "react";
import { useExplore } from "../data.js";
import {
  cn,
  type EntityKind,
  href,
  isDebugshareId,
  statusDot,
} from "../lib.js";
import { entities } from "../views/derive.js";

const entityIcons: Partial<Record<EntityKind, ReactNode>> = {
  people: <Users />,
  channels: <MessagesSquare />,
  traces: <Waypoints />,
  actors: <UserCog />,
};

/** ⌘K: jump to any page, issue or entity, or search every snapshot. */
export function Palette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data } = useExplore();
  const [q, setQ] = useState("");
  const go = (to: string) => {
    location.hash = to;
    onOpenChange(false);
    setQ("");
  };
  const item =
    "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-secondary-foreground data-[selected=true]:bg-accent data-[selected=true]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";
  const heading =
    "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-faint";
  const trimmed = q.trim();
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search and jump"
      overlayClassName="fixed inset-0 z-40 bg-black/60"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl shadow-black/60"
    >
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 text-muted-foreground" />
        <Command.Input
          value={q}
          onValueChange={setQ}
          placeholder="Jump to an issue, person, trace… or search all snapshots"
          className="h-12 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <Command.List
        className={cn("max-h-[60vh] overflow-y-auto p-1.5", heading)}
      >
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted-foreground">
          No direct match. Press Enter on “Search everything” to scan stored
          text.
        </Command.Empty>
        {trimmed && (
          <Command.Group heading="Search">
            {isDebugshareId(trimmed) && (
              <Command.Item
                value={`open-id ${trimmed}`}
                onSelect={() => go(href.issue(trimmed))}
                className={item}
              >
                <CircleDot /> Open issue{" "}
                <span className="font-mono">{trimmed}</span>
              </Command.Item>
            )}
            <Command.Item
              value={`search-all ${trimmed}`}
              onSelect={() => go(href.search(trimmed))}
              className={item}
            >
              <Search /> Search everything for “{trimmed}”
              <CornerDownLeft className="ml-auto" />
            </Command.Item>
          </Command.Group>
        )}
        <Command.Group heading="Pages">
          {(
            [
              ["Overview", href.overview, <LayoutDashboard key="o" />],
              ["Issues", href.issues, <CircleDot key="i" />],
              ["Activity", href.activity, <Activity key="a" />],
              ["People", href.index("people"), <Users key="p" />],
              [
                "Conversations",
                href.index("channels"),
                <MessagesSquare key="c" />,
              ],
              ["Traces", href.index("traces"), <Waypoints key="t" />],
              ["Actors", href.index("actors"), <UserCog key="ac" />],
              ["Tables: issues", href.tables("issues"), <Table2 key="ti" />],
              [
                "Tables: issue_events",
                href.tables("issue_events"),
                <Table2 key="te" />,
              ],
            ] as const
          ).map(([label, to, icon]) => (
            <Command.Item
              key={label}
              value={`page ${label}`}
              onSelect={() => go(to)}
              className={item}
            >
              {icon}
              {label}
            </Command.Item>
          ))}
        </Command.Group>
        {data && (
          <Command.Group heading="Issues">
            {data.issues.map((r) => (
              <Command.Item
                key={r.id}
                value={`${r.id} ${r.title} ${r.assignee} ${r.requestedBy}`}
                onSelect={() => go(href.issue(r.id))}
                className={item}
              >
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
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {data &&
          (["people", "channels", "traces", "actors"] as EntityKind[]).map(
            (kind) => (
              <Command.Group key={kind} heading={kind}>
                {entities(data, kind)
                  .slice(0, 50)
                  .map((e) => (
                    <Command.Item
                      key={e.value}
                      value={`${kind} ${e.value}`}
                      onSelect={() => go(href.entity(kind, e.value))}
                      className={item}
                    >
                      {entityIcons[kind]}
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
                        {e.value}
                      </span>
                      <span className="font-mono text-[11px] text-faint">
                        {e.issues.length} issue
                        {e.issues.length === 1 ? "" : "s"}
                      </span>
                    </Command.Item>
                  ))}
              </Command.Group>
            ),
          )}
      </Command.List>
      <div className="flex items-center gap-3 border-t border-border px-3 py-2 font-mono text-[11px] text-faint">
        <span>↑↓ move</span>
        <span>↵ open</span>
        <span>esc close</span>
        <span className="ml-auto">/ or ⌘K anywhere</span>
      </div>
    </Command.Dialog>
  );
}
