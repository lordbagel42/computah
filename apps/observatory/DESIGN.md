---

name: Computah Observatory
description: A public causal timing instrument
colors: {ground: "#090b0c", surface: "#0e1113", line: "#293237", text: "#edf3f4", muted: "#a3afb5", timing: "#a2f5d1", link: "#b9acfb", error: "#ff9b94", warning: "#efca83"}
typography: {
display: {fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif', fontSize: "clamp(44px, 5.5vw, 80px)", fontWeight: 500, lineHeight: 1.05, letterSpacing: "-0.04em"},
body: {fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif', fontSize: "14px"},
metadata: {fontSize: "12px"},
measurements: {fontFamily: "ui-monospace, monospace", fontSize: "12px"}
}
rounded: {control: "4px"}
spacing: {tight: "8px", group: "16px", panel: "24px"}
components: {
control: {backgroundColor: "{colors.surface}", textColor: "{colors.text}", rounded: "{rounded.control}", padding: "9px 15px"},
selected-action: {backgroundColor: "{colors.timing}", textColor: "{colors.ground}"}
}
---

# Computah Observatory design system

## Overview

The brief's dark futuristic direction is expressed as an instrument, not a
marketing dashboard: measured rules, precise duration bars and actual orthogonal
causal connections. The field is intentionally empty when no data is available.
This records the built source; rendered approval belongs to integration review.

## Colors

Mint denotes timing/selection, lavender supplied links, coral errors, and amber
missing relationships or unavailable/stale data. Status is always also named in
text. Neutral surfaces are flat; no decorative halos or simulated glass.

## Typography

Geist Variable is self-hosted from the official `geist@1.9.2` package, with its
SIL Open Font License beside the font. No third-party requests are made.
Large title type is 500 weight, with a 40–68px mobile
range. Normal controls use the 14px base; metadata is at least 12px. Monospace
is restricted to opaque identifiers, duration labels and measurements.

## Layout

The desktop instrument uses a 272px trace index and a flexible timing stage,
with an inspector below. At 700px it becomes a bounded trace list above the
stage and a single-column inspector. The timeline's 246px label rail plus 820px
timing field scroll internally, rather than forcing page-level overflow. At
1600px the index becomes 300px and the field minimum becomes 1000px.

Bars use a common linear axis from the earliest observed start to latest
observed end. Minimum markers of 2px are disclosed. Rows are chronological, not
an invented hierarchical traversal. Solid parent edges and dashed same-trace
links are drawn only when both endpoints are available. Cross-trace links are
navigable from the inspector; missing endpoints have explicit labels.

## Elevation & Depth

One-pixel boundaries and tonal changes provide hierarchy. There are no shadows.
The timeline ruler and relationship layer are functional stacking planes.

## Shapes

The instrument and data field are square. Small controls use 4px corners;
circles are reserved for source state and the scope marker.

## Components

- Trace buttons: source name, measured extent, span count, errors and opaque ID.
- Span rows: real duration/offset, service, named status and parent availability.
  Selection opens textual detail; arrow keys and Home/End move through spans.
- Feed status: authoritative mode and fetched age, separate from payload timing.
  Demo, stale, unconfigured, disconnected, paused and unknown freshness are named.
- Native service/status selects filter trace membership. Dimmed context is kept
  in the selected trace so filtering never invents a broken ancestry.
- Focus: mint 2px outline with 4px offset. Selection and scrollbars are themed.
- Motion: one 450ms bar registration reveal, disabled for reduced motion.

## Do's and Don'ts

Use only backend-projected facts. Never add synthetic activity to live states,
infer parentage from timing, equate observed extent with total trace duration,
or label a stale snapshot live. Keep documentation outside the static directory.
Do not add private diagnostic destinations, browser credentials, message
contents or resource attributes. No browser telemetry/export path is claimed.
