<script lang="ts">
import { statusDot, statusTone } from "./lib.js";

let { status }: { status: string } = $props();
</script>

<span
  class={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-px font-mono text-[11px] leading-5 ring-1 ring-inset ${statusTone[status] ?? "text-muted-foreground ring-border"}`}
  ><span class={`size-1.5 rounded-full ${statusDot[status] ?? "bg-faint"}`}
  ></span>{status}</span
>
