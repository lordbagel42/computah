---

name: Computah Observatory
description: Every retained public span as light on a black horizon
colors:
ground: "#000000"
ink: "#f4f4f5"
ink-2: "#b4b4bc"
ink-3: "#8e8e98"
line: "rgba(255,255,255,0.09)"
line-2: "rgba(255,255,255,0.17)"
error: "#ff5c6c"
service-backend: "#b69cff"
service-bus: "#5ad8ff"
service-slack: "#6cf5b0"
service-native: "#ff8fd8"
service-dashboard: "#ffd36e"
service-rune-pi: "#9cb4ff"
service-observatory: "#c8c8d0"
typography:
trace-title:
fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif'
fontSize: "72px (96px ≥1600px, 56px ≤1100px, 40px ≤700px)"
fontWeight: 340
lineHeight: 1
letterSpacing: "-0.04em"
page-heading:
fontSize: "32px (26px ≤700px)"
fontWeight: 500
body:
fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif'
fontSize: "14px"
ramp: "11 · 12 · 13 · 14 · 15 · 17 · 22 · 26 px"
measurements:
fontFamily: '"Geist Mono", ui-monospace, monospace'
fontSize: "11–12px, tabular numerals"
rounded:
control: "999px"
select: "10px"
card: "14px"
panel: "16px"
row: "10px"
bar: "3px"
spacing:
gutter: "clamp(16px, 3.2vw, 56px)"
label-track: "300px (360px ≥1600px, stacked ≤700px)"
row-gap: "8px"
indent: "14px per declared depth (10px ≤700px), capped at 6"
motion:
ease: "cubic-bezier(0.16, 1, 0.3, 1)"
horizon-scan: "1500ms ease-out-cubic on each snapshot"
stage-reveal: "1100ms scan line; bars clip in with 700ms × x-position delay"
row-arrival: "620ms, 26ms stagger during reveal"
bar-update: "850ms linear width/left"
arrival-flare: "1400ms expanding ring, once per first receipt"
handover: "320ms close, 640ms open with 6px blur"
---

# Computah Observatory design system

## Overview

The window is the spectacle. A full-bleed canvas horizon draws every retained
public span as a point of light at its real start time, one lane per service.
The trace the stage follows is pulled out of that field into a large title and
a tree-ordered waterfall. True black, hairline rules, white type; color only
encodes service, red only encodes error. No metric cards, sidebars, glass or
invented activity. This replaces the earlier graphite/mint stage.

## Colors

Ground is pure `#000` everywhere for AMOLED panels. Hierarchy comes from white
at three steps (`ink` 19:1, `ink-2` ≈10:1, `ink-3` ≈6:1 on black) and two
hairline weights. Each known service owns one emission hue; unknown services
(the synthetic demo) take a deterministic hue from the same set. Red `error`
marks error status in bars, horizon rings, summary counts and facts. There is
no warning hue: stale, paused and unconfigured states use white text with a
hollow or dashed dot, and missing parents use a dashed `ink-2` node, so no
state color can be mistaken for a service. Live state is white, never a hue.

## Typography

Geist Variable and Geist Mono Variable are self-hosted (OFL, `fonts/`). The
followed operation name is the largest type; its namespace (up to the last
`/` or `.`) is dimmed so the operation itself reads first. Mono is limited to
measurements, the ruler, the horizon axis, freshness and opaque IDs.

## Layout

A 64px hairline bar holds wordmark, source state, pause and the Controls
disclosure (filters, exporter diagnostics, demo). The horizon spans the whole
viewport (`clamp(300px, 54vh, 620px)`, 230px on mobile) with a 156px lane-label
gutter on desktop and inline label chips on mobile. The stage is centered up to
1760px: title, phase line, summary chips, follow control, then the field. A
selected operation opens a 300–380px inspector beside the field at ≥1100px and
below it otherwise. Recent traces run in a horizontally scrolling strip. At
700px and below, labels stack above full-width timing tracks and odd ruler
ticks are hidden. Above 700px each operation is one line: name, then a muted
service/status that truncates first. No page-level horizontal overflow.

## Elevation & Depth

Flat. Elevation is one hairline border (controls panel, cards, tooltip); no
shadows except the glow on observed-active bar heads. Additive (`lighter`)
canvas compositing makes dense clusters bloom honestly.

## Components

- **Horizon:** x is start time from the earliest retained in-window start to
  now (or the last running moment once paused, hidden or disconnected; the
  example's end in demo). Within a lane, y is a hash of the opaque trace ID, so
  each trace reads as one thread. Faint curves are declared retained parent
  edges. Mark alpha rises with recency. Focus (hover, card hover or following)
  draws that trace on top with white cores, its parent curves and a column
  over its extent. Errors also differ by shape (ring). Open spans get a head:
  pulsing and filled only while runtime-confirmed active, a hollow ring when
  unconfirmed. When runtime push is not fresh, a faint band labelled "no newer
  spans retained" spans the gap between the newest retained start and now;
  its cause (idle time, ingestion delay, a pause) is not claimed. A span that
  began before the visible window gets a left-pointing cue at the edge instead
  of a start dot; its tooltip carries the date when it is not today.
- **Scan reveal:** each snapshot sweeps a white line across the horizon,
  igniting marks as it passes; each new stage trace sweeps its track while bars
  clip in by start position. First receipt of a span after the snapshot flares
  once.
- **Tree waterfall:** rows are a depth-first walk of declared present parents;
  missing or out-of-window parents stay roots in chronological order with a
  dashed node. Indentation stops at depth 6; deeper rows state their depth.
  The ruler uses whole 1/2/5×10ⁿ steps. SVG elbows are measured from layout
  offsets (not animated positions) and rebuilt only when geometry changes. Hover or selection
  brightens the ancestry path. Dashed arcs are declared same-trace links.
  Measures ride inside each bar (after, before or above it) so they move with
  the 850ms bar transition. Active bars shimmer with a glowing white head.
- **Follow ("Following latest work"):** keeps the current trace while it stays
  observed-active, otherwise prefers the largest observed-active trace, then
  the newest trace with more than one span, then the newest. Hold, linger and handover timings
  are unchanged (3s hold, 2.4s linger after observed ends, 320ms close).
  Pinning stops replacement; a pinned trace leaving the window is labelled.
- **Inspector:** name, service chip, start, offset in trace, recorded duration,
  status, lifecycle, observed time, relationship buttons and opaque IDs. Close
  or Escape returns focus to the row.
- Focus: 2px white outline, 3px offset. Arrow keys/Home/End move among rows.

## Motion and performance

All motion sits under `prefers-reduced-motion: no-preference`; reduced motion
draws the horizon statically per update with no scan, flare, pulse, shimmer or
handover. The canvas loop runs at frame rate only during the scan, arrival
flares, observed-active spans or a domain shift; idle drift redraws about
seven times per second, and paused, hidden or disconnected views stop drawing.

## Do's and Don'ts

Draw only supplied spans, timing, status and declared relationships. Never
infer edges from timing, never extend an unconfirmed clock, never label history
as live. Keep color semantic. The synthetic demo stays explicit and labelled.
Local previews used a proxy of the public production stream; active-state
captures used a clearly local synthetic fixture and are not production.
