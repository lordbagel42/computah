<script lang="ts">
import Copy from "./Copy.svelte";
import JsonTree from "./JsonTree.svelte";
import Rich from "./Rich.svelte";

let {
  value,
  path = "$",
  name = "snapshot",
  filter = "",
}: {
  value: unknown;
  path?: string;
  name?: string;
  filter?: string;
} = $props();
let entries = $derived(
  value && typeof value === "object" ? Object.entries(value) : null,
);
let visible = $derived(
  !filter ||
    `${path} ${JSON.stringify(value)}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
);
</script>

{#if visible}
  {#if entries}
    <details class="json-node" open={!!filter}>
      <summary
        ><span class="type-tag"
          >{Array.isArray(value) ? "array" : "object"}</span
        ><span>{name}</span><span class="muted">{entries.length}</span></summary
      >
      <div class="json-children">
        {#each entries as [key, entry]}<JsonTree
            value={entry}
            name={key}
            path={`${path}.${key}`}
            {filter}
          />{/each}
      </div>
    </details>
  {:else}<div class="json-leaf">
      <span class="type-tag">{value === null ? "null" : typeof value}</span
      ><span class="mono min-w-0 break-all">{name}</span><span
        class="min-w-0 break-all"
        ><Rich
          text={typeof value === "string"
            ? value
            : (JSON.stringify(value) ?? "undefined")}
        /></span
      ><Copy
        value={typeof value === "string"
          ? value
          : (JSON.stringify(value) ?? "")}
        label={`Copy ${path}`}
      />
    </div>{/if}
{/if}
