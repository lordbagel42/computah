# Computah Observatory

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Explicitly requested vanilla HTML, CSS and JavaScript, without dependencies.
This separate public surface does not replace the native Rune product.

## Users and purpose

Public visitors explore sanitized OpenTelemetry timing and causal relationships.
Success is understanding which operations occurred, their measured durations,
their status, and which relationships are available in the bounded window.
This is not the authenticated internal DEBUGSHARE diagnostic surface.

## Capabilities and constraints

The backend owns sanitization. The browser consumes `/api/stream` (or the fixed
`?includeExporter=1` diagnostics mode), receiving snapshot, delta and status
events. A keyed map applies upserts/removals and retains at most 1,000 spans;
server byte limits may truncate earlier. IDs are opaque. Only projected names,
services, timing, status, optional lifecycle/observation time, parents and links
are rendered; never attributes, resources or content.

A full-bleed horizon draws every retained span at its start time by service;
touching a mark pins its trace. Unless pinned, the stage keeps an observed-active
trace while it stays active, else follows the largest observed-active trace,
else the newest multi-span trace, else the newest. Ended
observations linger before a close/open handover. A visitor may pin a trace or operation,
return to follow, pause, filter, inspect relationships, include exporter
diagnostics, or explicitly enter the static synthetic demo. Demo is neither
the default nor an unavailable-source fallback. Mode switches clear old data.

Native EventSource reconnects with its server-owned cursor. Pause, hidden tabs
and pagehide close the connection and clear timers; resume requests a snapshot.
Runtime-push status and Axiom-history availability are independent. Axiom history
is always labeled ingestion delayed. Confirmed active elapsed times are
provisional estimates from start. Once observedAt is over 15 seconds old or the
runtime source loses freshness, the clock returns to the last observed elapsed
time (observedAt minus start). Paused, hidden and disconnected views also show
the last observed elapsed time. Unconfirmed spans are never inferred ended.

## Brand commitments

The owner asked for a true-black AMOLED observatory people would share because
it is unusually good. Actual spans, topology and timing own the visual
signature (the horizon and the tree), not invented metrics. Color only encodes
service and error; no permanent sidebar or metric-card dashboard.

## Accessibility

Keyboard-operable controls, visible focus, readable small-screen layouts,
equivalent textual span details, and reduced-motion support are required.

## Evidence and assumptions

The provided API contract is the implementation authority. Local fixture-stream
rendering and browser assertions are not production ingestion or deployment
proof. Combined server/runtime verification belongs to integration. Browser
instrumentation/export is not implemented here; no competing exporter is added.
Assumed: all timestamps are epoch
milliseconds and each span ID is unique within its trace. Audience and product
facts above come from the explicit brief; no interview was needed or conducted
because the assignment explicitly requested unattended execution.
