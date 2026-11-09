<script lang="ts">
import type { Snippet } from "svelte";

let {
  title,
  count,
  id,
  children,
  actions,
  collapsible = true,
  open = true,
}: {
  title: string;
  count?: number;
  id?: string;
  children: Snippet;
  actions?: Snippet;
  collapsible?: boolean;
  open?: boolean;
} = $props();
</script>

<section {id} class="panel" aria-label={title}>
  <header class="panel-heading">
    {#if collapsible}<button
        class="panel-toggle"
        onclick={() => (open = !open)}
        aria-expanded={open}
        ><span class:rotate={open} class="disclosure">›</span
        >{title}{#if count !== undefined}<span class="count">{count}</span
          >{/if}</button
      >
    {:else}<h2>
        {title}{#if count !== undefined}<span class="count">{count}</span>{/if}
      </h2>{/if}
    {#if actions}<div class="panel-actions">{@render actions()}</div>{/if}
  </header>
  {#if open || !collapsible}{@render children()}{/if}
</section>
