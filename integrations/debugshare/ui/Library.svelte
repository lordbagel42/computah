<script lang="ts">
import Activity from "./Activity.svelte";
import type { ExploreData, SearchData } from "./data.js";
import IssueTable from "./IssueTable.svelte";
import { axiom, bytes, type EntityKind, fmtDate, href } from "./lib.js";
import Panel from "./Panel.svelte";
import Rich from "./Rich.svelte";
import { entities } from "./views/derive.js";

let {
  data,
  kind,
  value,
  search,
  pending = false,
}: {
  data: ExploreData;
  kind: EntityKind;
  value?: string;
  search?: SearchData;
  pending?: boolean;
} = $props();
let filter = $state("");
let list = $derived(
  entities(data, kind).filter(
    (e) => !filter || e.value.toLowerCase().includes(filter.toLowerCase()),
  ),
);
let selected = $derived(
  value ? entities(data, kind).find((e) => e.value === value) : undefined,
);
let related = $derived(
  data.issues.filter(
    (r) => selected?.issues.includes(r.id) || search?.issues.includes(r.id),
  ),
);
</script>

{#if !value}<Panel
    title={kind === "channels" ? "Conversations" : kind}
    count={list.length}
    ><div class="toolbar">
      <input
        aria-label="Filter entities"
        placeholder="Filter identifiers…"
        bind:value={filter}
      />
    </div>
    <div class="table-scroll">
      <table>
        <thead
          ><tr
            ><th>identifier</th><th>issues</th><th>first seen</th><th
              >last seen</th
            ></tr
          ></thead
        ><tbody
          >{#each list as e}<tr
              ><td
                ><a class="mono" href={href.entity(kind, e.value)}>{e.value}</a
                ></td
              ><td class="numeric">{e.issues.length}</td><td
                class="mono muted nowrap">{fmtDate(e.first)}</td
              ><td class="mono muted nowrap">{fmtDate(e.last)}</td></tr
            >{/each}</tbody
        >
      </table>
      {#if !list.length}<p class="empty">
          No {kind} recorded in the bounded index.
        </p>{/if}
    </div></Panel
  >
{:else}<div class="stack">
    <Panel title={value} collapsible={false}
      ><dl class="kv">
        <dt>Kind</dt>
        <dd>{kind}</dd>
        <dt>Issues</dt>
        <dd>{related.length}</dd>
        <dt>First seen</dt>
        <dd>{fmtDate(selected?.first)}</dd>
        <dt>Last seen</dt>
        <dd>{fmtDate(selected?.last)}</dd>
        {#each selected?.facts ?? [] as [label, fact]}<dt>{label}</dt>
          <dd><Rich text={fact} /></dd>{/each}
      </dl>
      {#if kind === "traces" && selected}{@const traceLink = axiom.trace(
          value,
          selected.first,
        )}{#if traceLink}<p class="panel-note">
            <a href={traceLink} target="_blank" rel="noreferrer"
              >Open trace in Axiom ↗</a
            >
            ·
            <a
              href={axiom.logs(value, selected.first)}
              target="_blank"
              rel="noreferrer">Logs ↗</a
            >
          </p>{/if}{/if}</Panel
    ><Panel title="Related issues" count={related.length}
      ><IssueTable rows={related} />
      {#each search?.issues.filter((id) => !data.issues.some((row) => row.id === id)) ?? [] as id}
        <a class="entity-row mono" href={href.issue(id)}>{id} → exact report</a>
      {/each}</Panel
    >
    <Panel title="Captured messages" count={search?.messages.length ?? 0}
      >{#if pending}<p role="status" class="panel-note">
          Searching captured context…
        </p>{/if}{#each search?.messages ?? [] as message}<article
          class="message"
        >
          <header>
            <a class="mono" href={href.entity("people", message.author)}
              >{message.author}</a
            ><a
              class="mono muted"
              href={href.entity("channels", message.channel)}
              >{message.channel}</a
            >
          </header>
          <p class="whitespace-pre-wrap"><Rich text={message.text} /></p>
          <div class="flex flex-wrap gap-3 mt-2 text-xs">
            {#each message.issues as id}<a href={href.message(id, message.ts)}
                >Captured in {id}</a
              >{/each}
          </div>
        </article>{/each}{#if !pending && !search?.messages.length}<p
          class="empty"
        >
          No captured messages for this identifier.
        </p>{/if}</Panel
    ><Panel title="Activity"
      ><Activity
        events={search?.events ??
          data.events.filter((e) =>
            kind === "actors"
              ? e.actor === value
              : related.some((r) => r.id === e.issue),
          )}
      /></Panel
    >
  </div>{/if}
