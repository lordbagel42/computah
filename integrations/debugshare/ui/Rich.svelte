<script lang="ts">
import { tokenize } from "./lib.js";

let { text, around }: { text: string; around?: string } = $props();
</script>

<span class="rich"
  >{#each tokenize(text, around) as token}{#if token.kind === "link"}{#if token.prefix}<span
          class="muted">{token.prefix}</span
        >{/if}<a
        href={token.href}
        target={token.external ? "_blank" : undefined}
        rel={token.external ? "noopener noreferrer" : undefined}>{token.text}</a
      >{:else if token.kind === "code"}<code>{token.text}</code
      >{:else}{token.text}{/if}{/each}</span
>
