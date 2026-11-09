<script lang="ts">
import Badge from "./Badge.svelte";
import type { Row } from "./data.js";
import { ago, fmtDate, href, isSynthetic } from "./lib.js";

let {
  rows,
  cursor = -1,
  compact = false,
}: { rows: readonly Row[]; cursor?: number; compact?: boolean } = $props();
</script>

<div class="table-scroll">
  <table class="issue-table">
    <thead
      ><tr
        ><th>status</th><th>title</th>{#if !compact}<th>requested by</th
          >{/if}<th class="numeric">msgs</th><th class="numeric">events</th
        >{#if !compact}<th>trace</th><th>created</th>{/if}<th>updated</th><th
          >assignee</th
        ></tr
      ></thead
    ><tbody>
      {#each rows as row, i (row.id)}<tr
          class:selected={cursor === i}
          data-row={i}
          ><td><Badge status={row.status} /></td><td class="issue-title"
            ><a href={href.issue(row.id)}>{row.title || "Untitled issue"}</a>
            <div class="mono muted text-xs">
              {row.id}{#if isSynthetic(row)}
                <span class="type-tag">synthetic</span>{/if}
            </div></td
          >{#if !compact}<td
              ><a
                class="mono nowrap"
                href={href.entity("people", row.requestedBy)}
                >{row.requestedBy}</a
              ></td
            >{/if}<td class="numeric">{row.messageCount}</td><td class="numeric"
            >{row.eventCount}</td
          >{#if !compact}<td
              >{#if row.captureTrace}<a
                  class="mono"
                  href={href.entity("traces", String(row.captureTrace))}
                  >{String(row.captureTrace).slice(0, 8)}</a
                >{:else}—{/if}</td
            ><td class="nowrap muted" title={fmtDate(row.created)}
              >{ago(row.created)}</td
            >{/if}<td class="nowrap muted" title={fmtDate(row.updated)}
            >{ago(row.updated)}</td
          ><td>{row.assignee || "—"}</td></tr
        >{/each}
    </tbody>
  </table>
  {#if !rows.length}<p class="empty">No issues match this view.</p>{/if}
</div>
