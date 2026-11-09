<script lang="ts">
import { Search } from "lucide-svelte";
import { tick } from "svelte";
import type { Row } from "./data.js";
import { href } from "./lib.js";

let {
  open = $bindable(false),
  rows,
}: { open?: boolean; rows: readonly Row[] } = $props();
let dialog = $state<HTMLDialogElement>();
let input: HTMLInputElement;
let q = $state("");
let cursor = $state(0);
const destinations = [
  { label: "Overview", to: href.overview },
  { label: "Issues", to: href.issues },
  { label: "Activity", to: href.activity },
  ...(["people", "channels", "traces", "submissions", "actors"] as const).map(
    (k) => ({ label: k, to: href.index(k) }),
  ),
  { label: "Tables", to: href.tables() },
];
let options = $derived(
  [
    ...destinations,
    ...rows.map((r) => ({
      label: `${r.title} ${r.id}`,
      to: href.issue(r.id),
    })),
  ]
    .filter((r) => r.label.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 30),
);
$effect(() => {
  if (!dialog) return;
  if (open) {
    q = "";
    cursor = 0;
    dialog.showModal();
    void tick().then(() => input?.focus());
  } else dialog.close();
});
function navigate(to: string) {
  location.hash = to;
  open = false;
}
</script>

<dialog
  bind:this={dialog}
  class="palette"
  aria-label="Search and jump"
  onclose={() => (open = false)}
  oncancel={() => (open = false)}
  onclick={(event) => {
    if (event.target === dialog) open = false;
  }}
  onkeydown={(event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cursor = Math.min(options.length - 1, cursor + 1);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
    }
    if (event.key === "Enter") {
      event.preventDefault();
      navigate(options[cursor]?.to ?? href.search(q));
    }
  }}
>
  <div class="palette-input">
    <Search size={18} /><input
      bind:this={input}
      bind:value={q}
      oninput={() => (cursor = 0)}
      placeholder="Search or jump…"
      aria-label="Search or jump"
    /><button class="button" onclick={() => (open = false)}>Esc</button>
  </div>
  <div class="palette-results">
    {#each options as option, i}<a
        class:active={cursor === i}
        href={option.to}
        onclick={() => (open = false)}>{option.label}</a
      >{/each}{#if q}<a href={href.search(q)} onclick={() => (open = false)}
        >Search all captured context for “{q}” ↵</a
      >{/if}
  </div>
  <p class="panel-note text-xs muted">
    ↑ ↓ to move · Enter to open · Esc to close
  </p>
</dialog>
