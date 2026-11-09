<script lang="ts">
import type { Infer } from "apps";
import type { TraceResult } from "../traces.js";
import { tool } from "./data.js";
import { traceRows } from "./waterfall.js";

let {
  id,
  correlation,
  label,
}: { id: string; correlation: "capture" | "transport"; label: string } =
  $props();
let data = $state<Infer<typeof TraceResult>>();
let error = $state("");
let loading = $state(true);
let attempt = $state(0);
const ms = (value: number) =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ms`;
$effect(() => {
  void attempt;
  const controller = new AbortController();
  loading = true;
  error = "";
  void tool<Infer<typeof TraceResult>>(
    "getIssueTrace",
    { id, correlation },
    controller.signal,
  )
    .then((result) => {
      if (!controller.signal.aborted) data = result;
    })
    .catch((failure) => {
      if (!controller.signal.aborted)
        error =
          failure instanceof Error
            ? failure.message
            : "Trace load failed. Retry or open Axiom.";
    })
    .finally(() => {
      if (!controller.signal.aborted) loading = false;
    });
  return () => controller.abort();
});
let spans = $derived(data?.spans ?? []);
let start = $derived(spans.length ? Math.min(...spans.map((s) => s.start)) : 0);
let end = $derived(
  spans.length ? Math.max(...spans.map((s) => s.start + s.duration)) : 0,
);
let duration = $derived(Math.max(end - start, 0.001));
</script>

<section class="trace-viewer" aria-label={label}>
  <div class="trace-toolbar">
    <h3>{label}</h3>
    <button class="button" disabled={loading} onclick={() => attempt++}
      >{loading ? "Loading spans…" : "Reload spans"}</button
    >
  </div>
  <div aria-live="polite">
    {#if loading}<p>
        Querying Axiom for this report’s recorded trace…
      </p>{/if}{#if error}<p class="error" role="alert">
        {error}
      </p>{/if}{#if !loading && data?.notice}<p>
        {data.notice}
      </p>{/if}{#if data?.partial}<p role="status">
        Partial trace: at most 500 spans are shown. Open Axiom for the complete
        result.
      </p>{/if}
  </div>
  {#if spans.length}<p class="trace-summary">
      {spans.length} spans · {ms(end - start)} elapsed · {spans.filter(
        (s) => s.error,
      ).length} errors{loading || error ? " · previous result" : ""}
    </p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <section
      class="trace-scroll"
      tabindex="0"
      aria-label="Trace waterfall. Scroll horizontally on narrow screens."
    >
      <div class="trace-axis">
        <span>Operation / service</span><span
          >0 ms<span>{ms(end - start)}</span></span
        >
      </div>
      {#each traceRows(spans) as { span, depth, missingParent } (span.id)}<details
          class:trace-error={span.error}
          class="trace-span"
        >
          <summary
            ><span
              class="trace-name"
              style:padding-left={`${Math.min(depth, 8) * 12}px`}
              ><span aria-hidden="true">›</span><strong>{span.name}</strong
              ><small
                >{span.service}{missingParent
                  ? " · parent not in result"
                  : ""}{span.error ? " · error" : ""}</small
              ></span
            ><span
              class="trace-lane"
              role="img"
              aria-label={`${span.name}: starts at ${ms(span.start - start)}, lasts ${ms(span.duration)}${span.error ? ", error" : ""}`}
              ><span
                class="trace-bar"
                style:left={`${((span.start - start) / duration) * 100}%`}
                style:width={`${(span.duration / duration) * 100}%`}
              ></span></span
            ><span class="trace-duration">{ms(span.duration)}</span></summary
          >
          <div class="trace-span-detail">
            <p>
              Span <code>{span.id}</code> · parent
              <code>{span.parent || "none"}</code>
              · {new Date(span.start).toISOString()}
            </p>
            <pre>{JSON.stringify(span.fields, null, 2)}</pre>
          </div>
        </details>{/each}
    </section>
  {/if}
</section>
