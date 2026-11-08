import "./style.css";
import {
  Activity,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Fingerprint,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Search,
  ShieldCheck,
  Table2,
  UserCog,
  Users,
  Waypoints,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Palette } from "./components/palette.js";
import { Kbd, Modal, TooltipProvider } from "./components/ui.js";
import { useExplore } from "./data.js";
import { bytes, cn, href, parseRoute, type Route } from "./lib.js";
import { ActivityView } from "./views/activity.js";
import { EntityIndex, EntityView } from "./views/entities.js";
import { IssueView } from "./views/issue.js";
import { IssuesView } from "./views/issues.js";
import { Overview } from "./views/overview.js";
import { SearchView } from "./views/search.js";
import { NotFound } from "./views/shell.js";
import { TablesView } from "./views/tables.js";

function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const change = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  return route;
}

type NavItem = {
  label: string;
  to: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
};
function Nav({
  route,
  collapsed,
  onNavigate,
  onSearch,
}: {
  route: Route;
  collapsed: boolean;
  onNavigate?: () => void;
  onSearch: () => void;
}) {
  const { data } = useExplore();
  const kind =
    route.view === "index" || route.view === "entity" ? route.kind : null;
  const groups: [string, NavItem[]][] = [
    [
      "Core",
      [
        {
          label: "Overview",
          to: href.overview,
          icon: <LayoutDashboard />,
          active: route.view === "overview",
        },
        {
          label: "Issues",
          to: href.issues,
          icon: <CircleDot />,
          active: route.view === "issues" || route.view === "issue",
          count: data?.totals.issues,
        },
        {
          label: "Activity",
          to: href.activity,
          icon: <Activity />,
          active: route.view === "activity",
          count: data?.totals.events,
        },
      ],
    ],
    [
      "Library",
      [
        {
          label: "People",
          to: href.index("people"),
          icon: <Users />,
          active: kind === "people",
        },
        {
          label: "Conversations",
          to: href.index("channels"),
          icon: <MessagesSquare />,
          active: kind === "channels",
        },
        {
          label: "Traces",
          to: href.index("traces"),
          icon: <Waypoints />,
          active: kind === "traces",
        },
        {
          label: "Submissions",
          to: href.index("submissions"),
          icon: <Fingerprint />,
          active: kind === "submissions",
        },
        {
          label: "Actors",
          to: href.index("actors"),
          icon: <UserCog />,
          active: kind === "actors",
        },
        {
          label: "Tables",
          to: href.tables(),
          icon: <Table2 />,
          active: route.view === "tables",
        },
      ],
    ],
  ];
  return (
    <nav aria-label="Explorer" className="flex flex-1 flex-col gap-5 px-2.5">
      <button
        type="button"
        onClick={onSearch}
        className={cn(
          "flex h-8 items-center gap-2 rounded-md border border-border px-2 text-[13px] text-muted-foreground transition-colors hover:border-input hover:text-foreground focus-visible:outline-2",
          collapsed && "justify-center px-0",
        )}
        aria-label="Search and jump"
      >
        <Search className="size-3.5" />
        {!collapsed && (
          <>
            <span className="flex-1 text-left">Search or jump…</span>
            <Kbd>⌘K</Kbd>
          </>
        )}
      </button>
      {groups.map(([label, items]) => (
        <div key={label}>
          {!collapsed && (
            <p className="mb-1 px-2 font-mono text-[11px] uppercase tracking-[0.08em] text-faint">
              {label}
            </p>
          )}
          <ul className="space-y-px">
            {items.map((item) => (
              <li key={item.label}>
                <a
                  href={item.to}
                  onClick={onNavigate}
                  aria-current={item.active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md px-2 text-[14px] text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                    item.active &&
                      "bg-[#222] text-foreground [&_svg]:text-foreground",
                    collapsed && "justify-center px-0",
                  )}
                >
                  {item.icon}
                  {!collapsed && <span className="flex-1">{item.label}</span>}
                  {!collapsed && item.count !== undefined && (
                    <span className="font-mono text-[11px] tabular text-faint">
                      {item.count}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <a
      href={href.overview}
      className="flex items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden="true">
        <ellipse cx="10" cy="5" rx="7" ry="2.6" fill="#e8e8e8" />
        <path
          d="M3 5v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V5"
          fill="none"
          stroke="#e8e8e8"
          strokeWidth="1.6"
        />
        <path
          d="M3 10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"
          fill="none"
          stroke="#4b8ef5"
          strokeWidth="1.6"
        />
      </svg>
      {!collapsed && (
        <span className="text-[15px] font-medium tracking-[-0.01em]">
          Computah <span className="text-muted-foreground">issues</span>
        </span>
      )}
    </a>
  );
}

function Footer({ collapsed }: { collapsed: boolean }) {
  const { data } = useExplore();
  if (collapsed) return null;
  return (
    <div className="m-2.5 space-y-1 rounded-md border border-border px-2.5 py-2 font-mono text-[11px] text-faint">
      <p className="flex items-center gap-1.5 text-muted-foreground">
        <ShieldCheck className="size-3.5" /> Internal · Executor auth
      </p>
      {data && (
        <p className="tabular">
          {data.totals.messages} msgs · {bytes(data.totals.bytes)} stored
        </p>
      )}
    </div>
  );
}

function App() {
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("nav-collapsed") === "1",
  );
  const [mobileNav, setMobileNav] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.(
        "input,textarea,select,[contenteditable]",
      );
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (!typing && e.key === "/") {
        e.preventDefault();
        setPalette(true);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on route change
  useEffect(() => {
    if (route.view !== "issue" || (!route.section && !route.message))
      document.getElementById("main")?.scrollTo({ top: 0 });
  }, [JSON.stringify(route)]);
  const toggle = () => {
    localStorage.setItem("nav-collapsed", collapsed ? "0" : "1");
    setCollapsed(!collapsed);
  };
  let page: ReactNode;
  switch (route.view) {
    case "overview":
      page = <Overview />;
      break;
    case "issues":
      page = <IssuesView />;
      break;
    case "activity":
      page = <ActivityView />;
      break;
    case "search":
      page = <SearchView q={route.q} />;
      break;
    case "tables":
      page = <TablesView table={route.table} />;
      break;
    case "index":
      page = <EntityIndex kind={route.kind} />;
      break;
    case "entity":
      page = (
        <EntityView
          key={`${route.kind}${route.value}`}
          kind={route.kind}
          value={route.value}
        />
      );
      break;
    case "issue":
      page = (
        <IssueView
          key={route.id}
          id={route.id}
          section={route.section}
          message={route.message}
        />
      );
      break;
    default:
      page = <NotFound raw={route.raw} />;
  }
  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full">
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-border bg-sidebar md:flex",
            collapsed ? "w-14" : "w-60",
          )}
        >
          <div
            className={cn(
              "flex h-14 items-center justify-between px-3",
              collapsed && "justify-center px-0",
            )}
          >
            <Brand collapsed={collapsed} />
            {!collapsed && (
              <button
                type="button"
                onClick={toggle}
                aria-label="Collapse navigation"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2"
              >
                <ChevronsLeft className="size-4" />
              </button>
            )}
          </div>
          <Nav
            route={route}
            collapsed={collapsed}
            onSearch={() => setPalette(true)}
          />
          {collapsed && (
            <button
              type="button"
              onClick={toggle}
              aria-label="Expand navigation"
              className="mx-auto mb-3 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2"
            >
              <ChevronsRight className="size-4" />
            </button>
          )}
          <Footer collapsed={collapsed} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 items-center gap-2 border-b border-border px-3 md:hidden">
            <button
              type="button"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
              aria-haspopup="dialog"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent focus-visible:outline-2"
            >
              <Menu className="size-5" />
            </button>
            <Modal
              open={mobileNav}
              onOpenChange={setMobileNav}
              label="Explorer navigation"
              className="inset-y-0 right-auto left-0 m-0 h-full w-72"
            >
              <div className="flex h-full flex-col border-r border-border bg-sidebar py-3">
                <div className="px-4 pb-3">
                  <Brand collapsed={false} />
                </div>
                <Nav
                  route={route}
                  collapsed={false}
                  onNavigate={() => setMobileNav(false)}
                  onSearch={() => {
                    setMobileNav(false);
                    setPalette(true);
                  }}
                />
                <Footer collapsed={false} />
              </div>
            </Modal>
            <Brand collapsed={false} />
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label="Search and jump"
              className="ml-auto rounded p-1.5 text-muted-foreground hover:bg-accent focus-visible:outline-2"
            >
              <Search className="size-5" />
            </button>
          </div>
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            {page}
          </main>
        </div>
      </div>
      <Palette open={palette} onOpenChange={setPalette} />
    </TooltipProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
createRoot(root).render(<App />);
