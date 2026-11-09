<script lang="ts">
import {
  Activity as ActivityIcon,
  ChevronsLeft,
  ChevronsRight,
  CircleDot,
  Database,
  Fingerprint,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  Table2,
  UserCog,
  Users,
  Waypoints,
  X,
} from "lucide-svelte";
import { onMount, tick } from "svelte";
import Activity from "./Activity.svelte";
import { authClient } from "./auth-client.js";
import {
  type ExploreData,
  type InspectionData,
  noFilter,
  type SearchData,
  tool,
} from "./data.js";
import Issue from "./Issue.svelte";
import IssueTable from "./IssueTable.svelte";
import Library from "./Library.svelte";
import Login from "./Login.svelte";
import {
  bytes,
  href,
  ignoreShortcut,
  isSynthetic,
  parseRoute,
  type Route,
  statusOrder,
} from "./lib.js";
import Overview from "./Overview.svelte";
import Palette from "./Palette.svelte";
import Panel from "./Panel.svelte";
import Rich from "./Rich.svelte";
import Tables from "./Tables.svelte";

let session = $state<"checking" | "login" | "ready" | "error">("checking");
let sessionError = $state("");
let signingOut = $state(false);
let route = $state<Route>({ view: "overview" });
let collapsed = $state(false);
let mobileNav = $state(false);
let palette = $state(false);
let drawer = $state<HTMLDialogElement>();
let index = $state<ExploreData>();
let inspection = $state<InspectionData>();
let search = $state<SearchData>();
let refresh = $state(0);
let indexPending = $state(false);
let detailPending = $state(false);
let searchPending = $state(false);
let error = $state("");
let text = $state("");
let status = $state("all");
let sort = $state("updated");
let synthetic = $state("show");
let cursor = $state(0);
let searchText = $state("");
let eventActor = $state("");
let eventStatus = $state("all");
let sessionController: AbortController;
async function checkSession() {
  sessionController?.abort();
  const current = new AbortController();
  sessionController = current;
  session = "checking";
  sessionError = "";
  try {
    const response = await fetch("/api/auth/get-session", {
      credentials: "same-origin",
      cache: "no-store",
      signal: current.signal,
    });
    if (current.signal.aborted) return;
    if (response.status === 401) {
      session = "login";
      return;
    }
    if (!response.ok) throw new Error("Session check failed");
    const value = (await response.json()) as { user?: unknown } | null;
    if (!current.signal.aborted) session = value?.user ? "ready" : "login";
  } catch {
    if (!current.signal.aborted) {
      session = "error";
      sessionError =
        "Could not check your session. Check your connection and retry.";
    }
  }
}
function clearData() {
  index = undefined;
  inspection = undefined;
  search = undefined;
  palette = false;
  mobileNav = false;
  error = "";
}
async function signOut() {
  if (signingOut) return;
  signingOut = true;
  try {
    const result = await authClient.signOut();
    if (result.error) throw new Error();
    clearData();
    session = "login";
  } catch {
    sessionError = "Sign out failed. Your session may still be active. Retry.";
  } finally {
    signingOut = false;
  }
}
function changeRoute() {
  const next = parseRoute(location.hash);
  route = next;
  mobileNav = false;
  cursor = 0;
  searchText = next.view === "search" ? next.q : "";
  if (next.view !== "issue" || (!next.section && !next.message))
    document.getElementById("main")?.scrollTo({ top: 0 });
}
function keys(event: KeyboardEvent) {
  const typing = (event.target as HTMLElement)?.closest?.(
    "input,textarea,select,[contenteditable]",
  );
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    palette = !palette;
    return;
  }
  if (!typing && event.key === "/") {
    event.preventDefault();
    palette = true;
    return;
  }
  if (palette || mobileNav || ignoreShortcut(event)) return;
  if (route.view === "issues") {
    if (event.key === "j" || event.key === "ArrowDown") {
      cursor = Math.min(filtered.length - 1, cursor + 1);
      event.preventDefault();
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      cursor = Math.max(0, cursor - 1);
      event.preventDefault();
    }
    if (event.key === "Enter" && filtered[cursor])
      location.hash = href.issue(filtered[cursor].id);
    void tick().then(() =>
      document
        .querySelector(`[data-row="${cursor}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  } else if (
    route.view === "issue" &&
    (event.key === "j" || event.key === "k")
  ) {
    const at =
      index?.issues.findIndex(
        (r) => route.view === "issue" && r.id === route.id,
      ) ?? -1;
    const row = index?.issues[at + (event.key === "j" ? 1 : -1)];
    if (at >= 0 && row) location.hash = href.issue(row.id);
  }
}
onMount(() => {
  changeRoute();
  collapsed = localStorage.getItem("nav-collapsed") === "1";
  status = sessionStorage.getItem("issues.status") ?? "all";
  sort = sessionStorage.getItem("issues.sort") ?? "updated";
  synthetic = sessionStorage.getItem("issues.synthetic") ?? "show";
  void checkSession();
  const expired = () => {
    clearData();
    void checkSession();
  };
  addEventListener("hashchange", changeRoute);
  addEventListener("keydown", keys);
  addEventListener("session-expired", expired);
  return () => {
    sessionController?.abort();
    removeEventListener("hashchange", changeRoute);
    removeEventListener("keydown", keys);
    removeEventListener("session-expired", expired);
  };
});
$effect(() => {
  if (!drawer) return;
  if (mobileNav) drawer.showModal();
  else drawer.close();
});
$effect(() => {
  if (session !== "ready") return;
  void refresh;
  const controller = new AbortController();
  indexPending = true;
  error = "";
  void tool<ExploreData>("explore", {}, controller.signal)
    .then((data) => {
      if (!controller.signal.aborted) index = data;
    })
    .catch((failure) => {
      if (!controller.signal.aborted) error = failure.message;
    })
    .finally(() => {
      if (!controller.signal.aborted) indexPending = false;
    });
  return () => controller.abort();
});
let issueId = $derived(route.view === "issue" ? route.id : "");
$effect(() => {
  if (session !== "ready" || !issueId) return;
  void refresh;
  const controller = new AbortController();
  detailPending = true;
  void tool<InspectionData>("inspectIssue", { id: issueId }, controller.signal)
    .then((data) => {
      if (!controller.signal.aborted) inspection = data;
    })
    .catch((failure) => {
      if (!controller.signal.aborted) error = failure.message;
    })
    .finally(() => {
      if (!controller.signal.aborted) detailPending = false;
    });
  return () => controller.abort();
});
let searchKey = $derived(
  route.view === "search"
    ? JSON.stringify({ ...noFilter, text: route.q })
    : route.view === "entity"
      ? JSON.stringify({
          ...noFilter,
          [{
            people: "author",
            channels: "channel",
            traces: "trace",
            submissions: "submission",
            actors: "actor",
          }[route.kind]]: route.value,
        })
      : "",
);
$effect(() => {
  if (session !== "ready" || !searchKey) {
    search = undefined;
    return;
  }
  void refresh;
  const controller = new AbortController();
  search = undefined;
  searchPending = true;
  void tool<SearchData>("search", JSON.parse(searchKey), controller.signal)
    .then((data) => {
      if (!controller.signal.aborted) search = data;
    })
    .catch((failure) => {
      if (!controller.signal.aborted) error = failure.message;
    })
    .finally(() => {
      if (!controller.signal.aborted) searchPending = false;
    });
  return () => controller.abort();
});
let filtered = $derived(
  (index?.issues ?? [])
    .filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (synthetic !== "hide" || !isSynthetic(r)) &&
        `${r.id} ${r.title} ${r.assignee} ${r.requestedBy} ${r.channel} ${r.lastActor} ${r.captureTrace ?? ""}`
          .toLowerCase()
          .includes(text.toLowerCase()),
    )
    .toSorted((a, b) =>
      sort === "messages"
        ? b.messageCount - a.messageCount
        : sort === "events"
          ? b.eventCount - a.eventCount
          : sort === "created"
            ? b.created.localeCompare(a.created)
            : b.updated.localeCompare(a.updated),
    ),
);
let navigation = $derived([
  {
    label: "Overview",
    to: href.overview,
    icon: LayoutDashboard,
    active: route.view === "overview",
  },
  {
    label: "Issues",
    to: href.issues,
    icon: CircleDot,
    active: route.view === "issues" || route.view === "issue",
    count: index?.totals.issues,
  },
  {
    label: "Activity",
    to: href.activity,
    icon: ActivityIcon,
    active: route.view === "activity",
    count: index?.totals.events,
  },
  {
    label: "People",
    to: href.index("people"),
    icon: Users,
    active:
      (route.view === "index" || route.view === "entity") &&
      route.kind === "people",
  },
  {
    label: "Conversations",
    to: href.index("channels"),
    icon: MessagesSquare,
    active:
      (route.view === "index" || route.view === "entity") &&
      route.kind === "channels",
  },
  {
    label: "Traces",
    to: href.index("traces"),
    icon: Waypoints,
    active:
      (route.view === "index" || route.view === "entity") &&
      route.kind === "traces",
  },
  {
    label: "Submissions",
    to: href.index("submissions"),
    icon: Fingerprint,
    active:
      (route.view === "index" || route.view === "entity") &&
      route.kind === "submissions",
  },
  {
    label: "Actors",
    to: href.index("actors"),
    icon: UserCog,
    active:
      (route.view === "index" || route.view === "entity") &&
      route.kind === "actors",
  },
  {
    label: "Tables",
    to: href.tables(),
    icon: Table2,
    active: route.view === "tables",
  },
]);
let title = $derived(
  route.view === "issue"
    ? "Issues"
    : route.view === "index" || route.view === "entity"
      ? route.kind
      : route.view === "unknown"
        ? "Not found"
        : route.view[0].toUpperCase() + route.view.slice(1),
);
</script>

{#snippet brand(compact: boolean)}<a class="brand" href={href.overview}
    ><Database size={20} />{#if !compact}<span
        >Computah <span class="muted">issues</span></span
      >{/if}</a
  >{/snippet}
{#snippet nav(compact: boolean)}<nav class="explorer-nav" aria-label="Explorer">
    <button
      class="nav-search"
      class:compact
      onclick={() => {
        palette = true;
        mobileNav = false;
      }}
      aria-label="Search and jump"
      ><Search size={16} />{#if !compact}<span>Search or jump…</span><kbd
          >⌘K</kbd
        >{/if}</button
    >{#each navigation as item, i}{#if !compact && (i === 0 || i === 3)}<p
          class="nav-group"
        >
          {i === 0 ? "Core" : "Library"}
        </p>{/if}<a
        class:active={item.active}
        class:compact
        aria-current={item.active ? "page" : undefined}
        href={item.to}
        title={compact ? item.label : undefined}
        onclick={() => (mobileNav = false)}
        ><item.icon size={17} />{#if !compact}<span>{item.label}</span
          >{#if item.count !== undefined}<span class="nav-count"
              >{item.count}</span
            >{/if}{/if}</a
      >{/each}
  </nav>{/snippet}
{#if session === "checking" || session === "error"}<main class="auth-screen">
    <section class="auth-form">
      <h1>Computah issues</h1>
      {#if session === "checking"}<p class="muted" role="status">
          Checking your operator session…
        </p>{:else}<p role="alert" class="error">{sessionError}</p>
        <button class="button" onclick={() => void checkSession()}
          >Retry session check</button
        >{/if}
    </section>
  </main>
{:else if session === "login"}<Login onsuccess={() => void checkSession()} />
{:else}<div class="explorer-shell">
    <aside class="sidebar" class:collapsed>
      <div class="sidebar-brand">
        {@render brand(collapsed)}<button
          class="icon-button"
          onclick={() => {
            collapsed = !collapsed;
            localStorage.setItem("nav-collapsed", collapsed ? "1" : "0");
          }}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          >{#if collapsed}<ChevronsRight size={16} />{:else}<ChevronsLeft
              size={16}
            />{/if}</button
        >
      </div>
      {@render nav(collapsed)}
      <div class="sidebar-footer">
        {#if !collapsed}<p>
            <ShieldCheck size={14} />Internal · Secure session
          </p>
          {#if index}<p class="mono text-xs muted">
              {index.totals.messages} msgs · {bytes(index.totals.bytes)} stored
            </p>{/if}{/if}<button
          class="text-button"
          onclick={signOut}
          disabled={signingOut}
          aria-label="Sign out"
          ><LogOut size={14} />{#if !collapsed}{signingOut
              ? "Signing out…"
              : "Sign out"}{/if}</button
        >
      </div>
    </aside>
    <div class="workspace">
      <header class="mobile-header">
        <button
          class="icon-button"
          aria-label="Open navigation"
          aria-haspopup="dialog"
          onclick={() => (mobileNav = true)}><Menu size={20} /></button
        >{@render brand(false)}<button
          class="icon-button ml-auto"
          aria-label="Search and jump"
          onclick={() => (palette = true)}><Search size={18} /></button
        >
      </header>
      <div class="page-header">
        <nav aria-label="Breadcrumb">
          <a href={route.view === "issue" ? href.issues : href.overview}
            >{title}</a
          >{#if route.view === "entity"}<span class="muted">
              / {route.value}</span
            >{/if}{#if route.view === "tables"}<span class="muted">
              / {route.table}</span
            >{/if}
        </nav>
        <button
          class="icon-button"
          disabled={indexPending || detailPending || searchPending}
          aria-label="Refresh data"
          title="Refresh data"
          onclick={() => refresh++}><RefreshCw size={15} /></button
        >
      </div>
      <main id="main" class="main-content">
        {#if error}<div class="error-banner" role="alert">
            Refresh failed; the last loaded data may be shown. {error}<button
              class="button"
              onclick={() => refresh++}>Retry</button
            >
          </div>{/if}{#if sessionError}<p class="error-banner" role="alert">
            {sessionError}
          </p>{/if}
        {#if route.view === "issue"}{#if inspection?.issue.id === route.id}{#key route.id}<Issue
                data={inspection}
                rows={index?.issues ?? []}
                section={route.section}
                message={route.message}
                onupdate={() => refresh++}
              />{/key}{:else if detailPending}<p class="empty" role="status">
              Loading exact report…
            </p>{:else}<div class="empty">
              <h1>Report unavailable</h1>
              <p>
                {error ||
                  "The exact issue ID could not be resolved. Older identifier-only UUIDs cannot recover context that was never stored."}
              </p>
            </div>{/if}
        {:else if route.view === "unknown"}<div class="empty">
            <h1>Page not found</h1>
            <p class="mono">{route.raw}</p>
            <a href={href.overview}>Return to overview</a>
          </div>
        {:else if index}<div class="page-content">
            {#if route.view === "overview"}<Overview data={index} />
            {:else if route.view === "issues"}<div class="stack">
                <div class="toolbar">
                  <fieldset class="status-tabs">
                    <legend class="sr-only">Status</legend
                    >{#each ["all", ...statusOrder] as s}<button
                        class:active={status === s}
                        onclick={() => {
                          status = s;
                          cursor = 0;
                          sessionStorage.setItem("issues.status", s);
                        }}
                        >{s}<span
                          >{s === "all"
                            ? index.issues.length
                            : index.issues.filter((r) => r.status === s)
                                .length}</span
                        ></button
                      >{/each}
                  </fieldset>
                  <input
                    aria-label="Filter issues"
                    placeholder="Filter issues…"
                    bind:value={text}
                    oninput={() => (cursor = 0)}
                  /><select
                    aria-label="Sort issues"
                    bind:value={sort}
                    onchange={() => sessionStorage.setItem("issues.sort", sort)}
                    ><option value="updated">Recently updated</option><option
                      value="created">Newest report</option
                    ><option value="messages">Most messages</option><option
                      value="events">Most history</option
                    ></select
                  ><select
                    aria-label="Synthetic reports"
                    bind:value={synthetic}
                    onchange={() =>
                      sessionStorage.setItem("issues.synthetic", synthetic)}
                    ><option value="show">Show synthetic</option><option
                      value="hide">Hide synthetic</option
                    ></select
                  >
                </div>
                <Panel title="Issues" count={filtered.length}
                  ><IssueTable rows={filtered} {cursor} /></Panel
                >
                <p class="muted text-xs mono">
                  j / k to move · Enter to open · bounded to 500 issues
                </p>
              </div>
            {:else if route.view === "activity"}<div class="stack">
                <div class="toolbar">
                  <input
                    aria-label="Filter activity"
                    placeholder="Filter notes and issues…"
                    bind:value={text}
                  /><input
                    aria-label="Filter actor"
                    placeholder="Actor…"
                    bind:value={eventActor}
                  /><select
                    aria-label="Activity status"
                    bind:value={eventStatus}
                    ><option value="all">All states</option
                    >{#each statusOrder as s}<option value={s}>{s}</option
                      >{/each}</select
                  >
                </div>
                <Panel title="Activity"
                  ><Activity
                    events={index.events.filter(
                      (e) =>
                        (eventStatus === "all" || e.status === eventStatus) &&
                        (!eventActor ||
                          e.actor
                            .toLowerCase()
                            .includes(eventActor.toLowerCase())) &&
                        `${e.note} ${e.title} ${e.issue}`
                          .toLowerCase()
                          .includes(text.toLowerCase()),
                    )}
                  /></Panel
                >
              </div>
            {:else if route.view === "tables"}<Tables
                data={index}
                table={route.table}
              />
            {:else if route.view === "index" || route.view === "entity"}{#key `${route.kind}:${route.view === "entity" ? route.value : ""}`}<Library
                  data={index}
                  kind={route.kind}
                  value={route.view === "entity" ? route.value : undefined}
                  {search}
                  pending={searchPending}
                />{/key}
            {:else if route.view === "search"}<div class="stack">
                <form
                  class="toolbar"
                  onsubmit={(event) => {
                    event.preventDefault();
                    location.hash = href.search(searchText);
                  }}
                >
                  <input
                    class="flex-1"
                    aria-label="Search captured context"
                    placeholder="Search all captured context…"
                    bind:value={searchText}
                  /><button class="button" type="submit">Search</button>
                </form>
                <p class="muted text-xs">
                  Search covers stored snapshot text, identifiers and evidence
                  notes. Up to 200 deduplicated messages.
                </p>
                {#if searchPending}<p role="status" class="panel-note">
                    Searching captured context…
                  </p>{/if}<Panel
                  title="Issues"
                  count={search?.issues.length ?? 0}
                  ><IssueTable
                    rows={index.issues.filter((r) =>
                      search?.issues.includes(r.id),
                    )}
                  />
                  {#each search?.issues.filter((id) => !index?.issues.some((row) => row.id === id)) ?? [] as id}
                    <a class="entity-row mono" href={href.issue(id)}
                      >{id} → exact report</a
                    >
                  {/each}</Panel
                ><Panel
                  title="Captured messages"
                  count={search?.messages.length ?? 0}
                  >{#each search?.messages ?? [] as m}<article class="message">
                      <header>
                        <a class="mono" href={href.entity("people", m.author)}
                          >{m.author}</a
                        ><a
                          class="mono muted"
                          href={href.entity("channels", m.channel)}
                          >{m.channel}</a
                        >
                      </header>
                      <p class="whitespace-pre-wrap"><Rich text={m.text} /></p>
                      {#each m.issues as id}<a
                          class="mono text-xs block mt-2"
                          href={href.message(id, m.ts)}>{id} → message</a
                        >{/each}
                    </article>{/each}{#if !searchPending && !search?.messages.length}<p
                      class="empty"
                    >
                      No captured messages match.
                    </p>{/if}</Panel
                ><Panel title="Activity" count={search?.events.length ?? 0}
                  ><Activity events={search?.events ?? []} /></Panel
                >
              </div>{/if}
          </div>{:else if indexPending}<p class="empty" role="status">
            Loading explorer index…
          </p>{/if}
      </main>
    </div>
  </div>
  <dialog
    bind:this={drawer}
    class="nav-drawer"
    aria-label="Explorer navigation"
    onclose={() => (mobileNav = false)}
    oncancel={() => (mobileNav = false)}
  >
    <div class="sidebar-brand">
      {@render brand(false)}<button
        class="icon-button"
        aria-label="Close navigation"
        onclick={() => (mobileNav = false)}><X size={18} /></button
      >
    </div>
    {@render nav(false)}
    <div class="sidebar-footer">
      <button class="text-button" onclick={signOut} disabled={signingOut}
        ><LogOut size={14} /> Sign out</button
      >
    </div>
  </dialog>
  <Palette bind:open={palette} rows={index?.issues ?? []} />
{/if}
