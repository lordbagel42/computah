<script lang="ts">
import { Check, Copy } from "lucide-svelte";
import { onDestroy } from "svelte";

let { value, label = "Copy" }: { value: string; label?: string } = $props();
let done = $state(false);
let error = $state("");
let timer: ReturnType<typeof setTimeout>;
onDestroy(() => clearTimeout(timer));
</script>

<button
  class="icon-button"
  type="button"
  aria-label={label}
  title={error || (done ? "Copied" : label)}
  onclick={async () => {
    try {
      await navigator.clipboard.writeText(value);
      done = true;
      error = "";
      clearTimeout(timer);
      timer = setTimeout(() => (done = false), 1200);
    } catch {
      error = "Copy failed. Select and copy the text manually.";
    }
  }}
  >{#if done}<Check size={14} />{:else}<Copy size={14} />{/if}</button
>
{#if error}<span role="status" class="text-rose-300 text-xs">{error}</span>{/if}
