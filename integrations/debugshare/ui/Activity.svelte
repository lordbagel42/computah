<script lang="ts">
import { onMount } from "svelte";
import Badge from "./Badge.svelte";
import type { ExploreData } from "./data.js";
import { fmtDate, href, parseRoute } from "./lib.js";
import Rich from "./Rich.svelte";

let { events }: { events: ExploreData["events"] } = $props();
// This stream is also embedded in reports and overview. Keep the restored
// filtered timeline on the Activity route without changing those embeds.
let timeline = $state(false);
onMount(() => {
  const update = () => {
    timeline = parseRoute(location.hash).view === "activity";
  };
  update();
  addEventListener("hashchange", update);
  return () => removeEventListener("hashchange", update);
});
let days = $derived.by(() => {
  const counts = new Map<string, number>();
  for (const event of events) {
    const day = event.created.slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
});
let maximum = $derived(Math.max(1, ...days.map(([, count]) => count)));
</script>

{#if timeline}
  <section
    class="chart-wrap activity-timeline"
    aria-label="History events over time"
  >
    <h2 class="mono text-[13px] mb-3">History events over time</h2>
    <p class="chart-key" aria-live="polite">events shown {events.length}</p>
    {#if days.length}
      <div class="table-scroll">
        <div
          class="bar-chart"
          role="img"
          aria-label={`Daily filtered history counts. ${days.map(([day, count]) => `${day}: ${count} events`).join("; ")}`}
        >
          {#each days as [day, count] (day)}
            <div class="chart-day" title={`${day}: ${count} events`}>
              <div class="chart-bars">
                <div
                  class="event-bar"
                  style:height={`${(count / maximum) * 100}%`}
                ></div>
              </div>
              <span>{day.slice(5)}</span>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <p class="muted text-xs">No events match these filters.</p>
    {/if}
  </section>
{/if}
<div class="event-stream">
  {#each events as event (event.id)}<article class="event">
      <div class="event-dot"></div>
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <a class="mono" href={href.entity("actors", event.actor)}
            >{event.actor}</a
          ><Badge status={event.status} /><time
            class="muted mono text-xs"
            datetime={event.created}>{fmtDate(event.created)}</time
          >
        </div>
        <a class="block mt-1" href={href.issue(event.issue, "lifecycle")}
          >{event.title}</a
        >
        <p class="mt-2 whitespace-pre-wrap">
          <Rich text={event.note} around={event.created} />
        </p>
      </div>
    </article>{/each}{#if !events.length}<p class="empty">
      No history events in this view.
    </p>{/if}
</div>
