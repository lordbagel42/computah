<script lang="ts">
import Badge from "./Badge.svelte";
import type { ExploreData } from "./data.js";
import { bytes, href } from "./lib.js";
import Panel from "./Panel.svelte";
import Rich from "./Rich.svelte";

let { data, table }: { data: ExploreData; table: string } = $props();
let name = $derived(table === "issue_events" ? "issue_events" : "issues");
let schema = $derived(
  name === "issues"
    ? [
        ["id", "TEXT", "PRIMARY KEY NOT NULL"],
        ["title", "TEXT", "NOT NULL"],
        ["status", "TEXT", "open · investigating · blocked · resolved"],
        ["assignee", "TEXT", "NOT NULL DEFAULT ''"],
        ["revision", "INTEGER", "NOT NULL DEFAULT 1"],
        ["report", "TEXT", "immutable snapshot JSON"],
        ["created", "TEXT", "NOT NULL"],
        ["updated", "TEXT", "NOT NULL"],
      ]
    : [
        ["id", "TEXT", "PRIMARY KEY NOT NULL"],
        ["issue", "TEXT", "REFERENCES issues(id)"],
        ["status", "TEXT", "NOT NULL"],
        ["actor", "TEXT", "NOT NULL"],
        ["note", "TEXT", "NOT NULL"],
        ["created", "TEXT", "NOT NULL"],
      ],
);
</script>

<nav class="section-nav" aria-label="Database tables">
  <a
    aria-current={name === "issues" ? "page" : undefined}
    href={href.tables("issues")}
    >issues <span class="muted">{data.totals.issues}</span></a
  ><a
    aria-current={name === "issue_events" ? "page" : undefined}
    href={href.tables("issue_events")}
    >issue_events <span class="muted">{data.totals.events}</span></a
  >
</nav>
<div class="stack">
  <Panel title={`${name} · schema`}
    ><div class="table-scroll">
      <table>
        <thead><tr><th>column</th><th>type</th><th>constraints</th></tr></thead
        ><tbody
          >{#each schema as [column, type, constraints]}<tr
              ><td class="mono">{column}</td><td class="mono muted">{type}</td
              ><td class="muted">{constraints}</td></tr
            >{/each}</tbody
        >
      </table>
    </div>
    <p class="panel-note mono text-xs">
      {name === "issues"
        ? "issues_updated ON issues(updated)"
        : "issue_events_issue ON issue_events(issue,created)"}
    </p></Panel
  ><Panel
    title={`${name} · bounded rows`}
    count={name === "issues" ? data.issues.length : data.events.length}
    ><div class="table-scroll">
      <table class="mono">
        <thead
          ><tr
            >{#each schema as [column, type]}<th
                >{column} <span class="muted text-xs">{type}</span></th
              >{/each}</tr
          ></thead
        >
        <tbody>
          {#if name === "issues"}
            {#each data.issues as row}<tr>
                <td><a href={href.issue(row.id)}>{row.id}</a></td>
                <td>{row.title}</td><td><Badge status={row.status} /></td>
                <td
                  >{#if row.assignee}<Rich text={row.assignee} />{:else}<span
                      class="muted">''</span
                    >{/if}</td
                >
                <td>{row.revision}</td>
                <td
                  ><a href={href.issue(row.id, "fields")}
                    >{"{…}"} {bytes(row.bytes)}</a
                  ></td
                >
                <td class="nowrap">{row.created}</td><td class="nowrap"
                  >{row.updated}</td
                >
              </tr>{/each}
          {:else}
            {#each data.events as event}<tr>
                <td>{event.id}</td><td
                  ><a href={href.issue(event.issue, "lifecycle")}
                    >{event.issue}</a
                  ></td
                >
                <td><Badge status={event.status} /></td>
                <td
                  ><a href={href.entity("actors", event.actor)}>{event.actor}</a
                  ></td
                >
                <td><Rich text={event.note} /></td><td class="nowrap"
                  >{event.created}</td
                >
              </tr>{/each}
          {/if}
        </tbody>
      </table>
    </div>
    <p class="panel-note">
      Read-only Cloudflare Durable Object SQLite view through bounded queries:
      newest 500 rows per table. No browser SQL is accepted.
    </p></Panel
  >
</div>
