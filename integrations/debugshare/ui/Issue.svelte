<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import Badge from "./Badge.svelte";
import Copy from "./Copy.svelte";
import type { InspectionData, Row } from "./data.js";
import { tool } from "./data.js";
import JsonTree from "./JsonTree.svelte";
import {
  absolute,
  axiom,
  bytes,
  fmtDate,
  href,
  isRealSlack,
  slack,
  slackDate,
  statusOrder,
  tokenize,
} from "./lib.js";
import Panel from "./Panel.svelte";
import Rich from "./Rich.svelte";
import Trace from "./Trace.svelte";

let {
  data,
  rows,
  section,
  message,
  onupdate,
}: {
  data: InspectionData;
  rows: readonly Row[];
  section?: string;
  message?: string;
  onupdate: () => void;
} = $props();
let report = $derived(data.report);
let issue = $derived(data.issue);
// Keep the draft at its original revision until explicitly reconciled.
let statusDraft = $state(untrack(() => data.issue.status));
let assignee = $state(untrack(() => data.issue.assignee));
let revision = $state(untrack(() => data.issue.revision));
let actor = $state("");
let note = $state("");
let saving = $state(false);
let saved = $state(false);
let error = $state("");
let fieldFilter = $state("");
let messageFilter = $state("");
let oldest = $state(true);
let real = $derived(isRealSlack(report.source.team));
let capture = $derived(
  axiom.trace(report.capture?.traceId ?? "", report.requestedAt),
);
let transport = $derived(
  axiom.trace(report.transport?.traceId ?? "", report.requestedAt),
);
let at = $derived(rows.findIndex((r) => r.id === issue.id));
let messages = $derived(
  report.messages
    .filter(
      (m) =>
        !messageFilter ||
        `${m.author} ${m.text}`
          .toLowerCase()
          .includes(messageFilter.toLowerCase()),
    )
    .toSorted((a, b) =>
      oldest ? Number(a.ts) - Number(b.ts) : Number(b.ts) - Number(a.ts),
    ),
);
let links = $derived([
  ...new Map(
    [
      ...report.messages.map((m) => m.text),
      ...data.events.map((e) => e.note),
      ...report.activity,
    ]
      .flatMap((t) => tokenize(t, report.requestedAt))
      .filter((t) => t.kind === "link")
      .map((t) => [t.href, t]),
  ).values(),
]);
onMount(() => {
  actor = localStorage.getItem("actor") ?? "";
});
$effect(() => {
  const target = message ? `message-${message}` : section;
  if (target)
    void tick().then(() => {
      const el = document.getElementById(target);
      el?.scrollIntoView({ block: "start" });
      if (el) el.dataset.flash = "true";
    });
});
async function save(event: SubmitEvent) {
  event.preventDefault();
  if (saving) return;
  saving = true;
  saved = false;
  error = "";
  try {
    const result = await tool<InspectionData["issue"]>("updateIssue", {
      id: issue.id,
      expectedRevision: revision,
      status: statusDraft,
      assignee,
      actor,
      note,
    });
    revision = result.revision;
    localStorage.setItem("actor", actor.trim());
    note = "";
    saved = true;
    onupdate();
  } catch (failure) {
    error =
      failure instanceof Error
        ? failure.message
        : "Update failed. Refresh and check saved state before retrying.";
  } finally {
    saving = false;
  }
}
</script>

<div class="issue-heading">
  <div>
    <div class="flex flex-wrap items-center gap-2">
      <Badge status={issue.status} /><span class="mono muted break-all"
        >{issue.id}</span
      ><Copy value={issue.id} label="Copy issue ID" />
    </div>
    <h1>{issue.title}</h1>
    <div class="muted flex flex-wrap gap-2 text-xs">
      <span>Reported {fmtDate(report.requestedAt)}</span><span
        >by <a href={href.entity("people", report.requestedBy)}
          >{report.requestedBy}</a
        ></span
      ><span>· revision {issue.revision}</span>
    </div>
  </div>
  <div class="flex gap-1">
    <button
      class="button"
      aria-label="Previous issue (k)"
      disabled={at <= 0}
      onclick={() => {
        if (at > 0) location.hash = href.issue(rows[at - 1].id);
      }}>‹</button
    ><button
      class="button"
      aria-label="Next issue (j)"
      disabled={at < 0 || at >= rows.length - 1}
      onclick={() => {
        if (at >= 0 && at < rows.length - 1)
          location.hash = href.issue(rows[at + 1].id);
      }}>›</button
    ><Copy value={absolute(href.issue(issue.id))} label="Copy issue link" />
  </div>
</div>
<nav class="section-nav" aria-label="Sections">
  {#each ["conversation", "lifecycle", "traces", "fields", "update", "correlation", "related"] as name}<a
      href={href.issue(issue.id, name)}
      >{name[0].toUpperCase() + name.slice(1)}</a
    >{/each}
</nav>
<div class="issue-grid">
  {#if real && (capture || transport)}<div class="wide">
      <Panel title="Traces" id="traces" collapsible={false}
        >{#if capture}<Trace
            id={issue.id}
            correlation="capture"
            label={capture === transport
              ? "Capture & Slack transport"
              : "Capture"}
          />{/if}{#if transport && transport !== capture}<Trace
            id={issue.id}
            correlation="transport"
            label="Slack transport"
          />{/if}
        <p class="panel-note">
          The DEBUGSHARE command’s recorded traces, not the earlier
          conversation. Queried within ±1 day of this report; use Correlation
          links to widen the range in Axiom.
        </p></Panel
      >
    </div>{/if}
  <div class="stack">
    <Panel title="Conversation" id="conversation" count={report.messages.length}
      >{#snippet actions()}<button
          class="text-button"
          onclick={() => (oldest = !oldest)}
          >{oldest ? "Oldest first" : "Newest first"}</button
        >{/snippet}
      <div class="toolbar">
        <input
          aria-label="Filter messages"
          placeholder="Filter captured messages…"
          bind:value={messageFilter}
        />
      </div>
      {#each messages as m (`${m.author}:${m.ts}`)}<article
          id={`message-${m.ts}`}
          class="message"
          class:highlight={message === m.ts}
        >
          <header>
            <a class="mono" href={href.entity("people", m.author)}>{m.author}</a
            ><a
              class="muted mono text-xs"
              title={fmtDate(slackDate(m.ts))}
              href={href.message(issue.id, m.ts)}
              >{fmtDate(slackDate(m.ts)).slice(5)}</a
            ><Copy
              value={absolute(href.message(issue.id, m.ts))}
              label="Copy message link"
            /><Copy value={m.text} label="Copy text" />
          </header>
          <p class="whitespace-pre-wrap">
            <Rich text={m.text} around={report.requestedAt} />
          </p>
          {#if rows.filter((r) => r.id !== issue.id && r.channel === report.source.channel).length}<span
              class="muted text-xs"
              >Captured context · {report.source.channel}</span
            >{/if}
        </article>{/each}{#if !messages.length}<p class="empty">
          No captured messages match this filter.
        </p>{/if}
    </Panel>
    <Panel title="Lifecycle" id="lifecycle" count={data.events.length}
      ><div class="p-3">
        <p class="muted text-xs">
          Report captured {fmtDate(report.requestedAt)} · requested by
          <a href={href.entity("people", report.requestedBy)}
            >{report.requestedBy}</a
          >
        </p>
      </div>
      {#each data.events as event}<article class="message">
          <header>
            <a class="mono" href={href.entity("actors", event.actor)}
              >{event.actor}</a
            ><Badge status={event.status} /><time
              class="muted mono text-xs"
              datetime={event.created}>{fmtDate(event.created)}</time
            >
          </header>
          <p class="whitespace-pre-wrap">
            <Rich text={event.note} around={event.created} />
          </p>
        </article>{/each}{#if !data.events.length}<p class="empty">
          No investigation updates yet.
        </p>{/if}</Panel
    >
    <Panel title="Fields" id="fields"
      >{#snippet actions()}<Copy
          value={JSON.stringify(report, null, 2)}
          label="Copy snapshot JSON"
        />{/snippet}
      <div class="toolbar">
        <input
          aria-label="Filter fields"
          placeholder="Filter fields or values…"
          bind:value={fieldFilter}
        />
      </div>
      {#each Object.entries(report) as [name, value]}<JsonTree
          {name}
          {value}
          path={`$.${name}`}
          filter={fieldFilter}
        />{/each}</Panel
    >
    <Panel title="Update" id="update" collapsible={false}
      ><form class="update-form" onsubmit={save}>
        {#if issue.revision > revision && !saving}<div
            role="status"
            class="warning"
          >
            Someone saved revision {issue.revision} while you were editing. Your draft
            is kept and cannot overwrite it.<button
              type="button"
              class="button mt-2"
              onclick={() => {
                statusDraft = issue.status;
                assignee = issue.assignee;
                revision = issue.revision;
              }}>Load latest state</button
            >
          </div>{/if}
        <div class="form-grid">
          <label
            >State<select bind:value={statusDraft}
              >{#each statusOrder as s}<option value={s}>{s}</option
                >{/each}</select
            ></label
          ><label
            >Assigned to<input
              bind:value={assignee}
              maxlength="200"
              placeholder="Unassigned"
            /></label
          >
        </div>
        <label
          >Updated by<input
            required
            bind:value={actor}
            maxlength="200"
            placeholder="Your name or agent"
          /></label
        ><label
          >Evidence note<textarea
            required
            bind:value={note}
            maxlength="20000"
            rows="4"
            placeholder="What changed, what evidence supports it, and what remains?"
          ></textarea></label
        >
        <p class="muted text-xs">
          Declared attribution, not proof of identity. Resolved is not proof of
          a deployed repair.
        </p>
        {#if error}<p class="error" role="alert">{error}</p>{/if}{#if saved}<p
            class="success"
            role="status"
          >
            Saved revision {revision}.
          </p>{/if}<button
          class="button primary"
          disabled={saving ||
            !note.trim() ||
            !actor.trim() ||
            issue.revision > revision}
          >{saving ? "Saving…" : "Save update"}</button
        >
      </form></Panel
    >
  </div>
  <div class="stack">
    <Panel title="Issue" collapsible={false}
      ><dl class="kv">
        <dt>ID</dt>
        <dd class="break-all">{issue.id}</dd>
        <dt>Status</dt>
        <dd><Badge status={issue.status} /></dd>
        <dt>Revision</dt>
        <dd>{issue.revision}</dd>
        <dt>Assignee</dt>
        <dd><Rich text={issue.assignee || "unassigned"} /></dd>
        <dt>Created</dt>
        <dd>{fmtDate(issue.created)}</dd>
        <dt>Updated</dt>
        <dd>{fmtDate(issue.updated)}</dd>
      </dl></Panel
    >
    <Panel title="Correlation" id="correlation"
      ><div class="p-3 space-y-3">
        {#each [["Capture", report.capture], ["Slack transport", report.transport]] as [label, correlation]}<div
          >
            <p class="muted text-xs mb-1">{label}</p>
            {#if correlation && typeof correlation !== "string"}<a
                class="mono break-all"
                href={href.entity("traces", correlation.traceId)}
                >{correlation.traceId}</a
              >
              <div class="flex flex-wrap gap-3 text-xs mt-1">
                {#if real && axiom.trace(correlation.traceId, report.requestedAt)}<a
                    href={axiom.trace(correlation.traceId, report.requestedAt)}
                    target="_blank"
                    rel="noreferrer">Spans ↗</a
                  ><a
                    href={axiom.logs(correlation.traceId, report.requestedAt)}
                    target="_blank"
                    rel="noreferrer">Logs ↗</a
                  ><a
                    href={axiom.span(correlation.spanId, report.requestedAt)}
                    target="_blank"
                    rel="noreferrer">Span ↗</a
                  >{/if}
              </div>{:else}<p class="muted text-xs">
                Not recorded by this report.
              </p>{/if}
          </div>{/each}{#if real && axiom.issue(issue.id, report.requestedAt)}<a
            href={axiom.issue(issue.id, report.requestedAt)}
            target="_blank"
            rel="noreferrer">Open issue capture in Axiom ↗</a
          >{/if}
        <p class="muted text-xs">
          Identifiers are recorded evidence, never guessed from timestamps.
          Axiom authenticates separately.
        </p>
      </div></Panel
    >
    <Panel title="Source"
      ><dl class="kv">
        <dt>Workspace</dt>
        <dd>{report.source.team}</dd>
        <dt>Conversation</dt>
        <dd>
          <a href={href.entity("channels", report.source.channel)}
            >{report.source.channel}</a
          >{#if real}<div class="flex gap-3 text-xs mt-1">
              <a
                href={slack.channelApp(
                  report.source.team,
                  report.source.channel,
                )}>Slack app ↗</a
              ><a
                href={slack.channelWeb(
                  report.source.team,
                  report.source.channel,
                )}
                target="_blank"
                rel="noreferrer">Slack web ↗</a
              >
            </div>{/if}
        </dd>
        <dt>Command</dt>
        <dd>
          <a href={href.message(issue.id, report.source.message)}
            >{report.source.message}</a
          >
        </dd>
        <dt>Thread</dt>
        <dd>{String(report.source.thread ?? "not recorded")}</dd>
      </dl></Panel
    >
    <Panel title="Snapshot"
      ><dl class="kv">
        <dt>Storage</dt>
        <dd>{bytes(data.snapshot.bytes)}</dd>
        <dt>SHA-256</dt>
        <dd class="break-all">
          {data.snapshot.sha256}<Copy value={data.snapshot.sha256} />
        </dd>
        <dt>Tenant</dt>
        <dd>{report.scope.tenantId}</dd>
        <dt>User</dt>
        <dd>{report.scope.userId}</dd>
        <dt>Agent</dt>
        <dd>{report.scope.agentId}</dd>
        <dt>Participants</dt>
        <dd>
          {#each report.participants as person}<a
              class="block"
              href={href.entity("people", person)}>{person}</a
            >{/each}
        </dd>
      </dl></Panel
    >
    <Panel title="Related" id="related" count={data.related.length}
      >{#each data.related as related}<a
          class="entity-row flex-col items-start"
          href={href.issue(related.id)}
          ><span>{related.title}</span><span class="muted text-xs"
            >{related.reasons.join(" · ")}</span
          ></a
        >{/each}{#if !data.related.length}<p class="empty">
          No related issues recorded.
        </p>{/if}</Panel
    >
    <Panel title="Evidence links" count={links.length} open={false}
      >{#each links as link}<a
          class="entity-row mono break-all"
          href={link.href}
          target={link.external ? "_blank" : undefined}
          rel={link.external ? "noreferrer" : undefined}
          >{link.prefix ?? ""}{link.text}</a
        >{/each}</Panel
    >
    <Panel title="Message activity" count={report.activity.length}
      >{#each report.activity as activity}<p class="panel-note">
          <Rich text={activity} around={report.requestedAt} />
        </p>{/each}</Panel
    >
    <Panel title="Capture notes" count={report.limitations.length}
      >{#each report.limitations as limitation}<p class="panel-note">
          <Rich text={limitation} around={report.requestedAt} />
        </p>{/each}</Panel
    >
    <Panel title="Submission handles" count={report.submissions.length}
      >{#each report.submissions as submission}<a
          class="entity-row mono break-all"
          href={href.entity("submissions", submission)}>{submission}</a
        >{/each}{#if !report.submissions.length}<p class="empty">
          No handles observed.
        </p>{/if}</Panel
    >
  </div>
</div>
