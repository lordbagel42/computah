---

name: Computah Observatory
description: A continuous public trace stage
colors:
ground: "#101312"
surface: "#171b19"
line: "#343d37"
text: "#eff2e9"
muted: "#a6b2a9"
timing: "#bef5ce"
error: "#ffb0a3"
warning: "#ead099"
typography:
display:
fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif'
fontSize: "clamp(28px, 4.2vw, 64px)"
fontWeight: 450
lineHeight: 1.12
letterSpacing: "-0.04em"
body:
fontFamily: 'Geist, "Helvetica Neue", Arial, sans-serif'
fontSize: "14px"
metadata:
fontSize: "12px"
measurements:
fontFamily: "ui-monospace, monospace"
fontSize: "12px"
rounded:
control: "6px"
bar: "2px"
spacing:
tight: "8px"
group: "16px"
stage: "32px"
components:
control:
rounded: "{rounded.control}"
padding: "10px 15px"
selected-action:
backgroundColor: "#24342a"
textColor: "{colors.timing}"
---

# Computah Observatory design system

## Overview

One large continuous timing stage owns this surface. The visual mechanism is
actual work arriving, extending, ending and handing over to another trace.
Flat graphite, warm white and pale mint fit low-ambient-light viewing. No
decorative metrics, glass, halos, fake topologies or production simulations.
This replacement is explicitly authorized; it is not incumbent dashboard polish.

## Colors

Mint carries measured timing and selection; coral denotes named errors. Amber
denotes missing or unavailable evidence. Status is also written in text.
Parent routes are subdued green, supplied links dashed warm-white. The field's
vertical marks measure time rather than simulating an ornamental background.

## Typography

Geist Variable remains self-hosted with its existing license. The operation
title, not a promotional headline, receives the largest type (34px on mobile).
Controls and span names are 14px; metadata is 12px. Monospace is restricted to
opaque IDs, duration measurements and the ruler. No external font requests.

## Layout

Main margins are 4vw, maximum content width 1920px. A compact masthead carries
source state, fetched age and pause. The full-width stage puts identity/follow
above the timing field. Recent traces form a horizontal strip below the stage;
the inspector and feed controls are secondary native disclosures.

Desktop rows have a 240px label track (290px above 1600px), fluid timing
track and eight-pixel gaps between interactive rows. The field scrolls vertically
at 530px. At 700px and below, margins become
20px, labels stack above full-width timing tracks, the ruler has three visible
ticks, and disclosures stack. Mobile draws no SVG causal routes; textual parent
and cross-trace link navigation remains in span details. There is no huge fixed
left label rail or page-level horizontal overflow.

Bars share a linear axis, from earliest observed start to observed/estimated
extent plus small headroom. Three-pixel minimum markers are disclosed. Rows are
chronological, not a guessed hierarchy. Only declared present endpoints connect.

## Elevation & Depth

Flat surfaces and hairline rules establish hierarchy. No shadows. The
relationship geometry is a functional layer, not decorative illustration.

## Shapes

The stage is square; controls have 6px corners and bars 2px corners. Small
circles mark source state and recently observed open endpoints, never progress.

## Components

- Keyed timing rows: arrival animates once over 650ms; updates preserve the DOM
  and animate bar geometry over 850ms. Buttons keep named status/service text.
- Handover: following holds a trace at least three seconds. When all observed
  lifecycles are ended and a candidate arrives, it lingers another 2.4 seconds,
  clips closed over 320ms, then opens over 600ms with a small translate/blur.
  No unobserved trace completion is claimed. Reduced motion removes all motion.
- Pin: selecting a trace/operation stops automatic replacement. Follow newest
  releases it. A pin leaving the bounded window is explicitly unavailable.
- Native details: selected operation facts, opaque IDs, declared parents/links;
  fixed-mode exporter diagnostics, service/status filters, explicit static demo.
- Focus: mint 2px outline, 4px offset. Arrow keys/Home/End move among rows.
- Freshness: Axiom history always says ingestion delayed. Runtime-push status
  does not overwrite history availability. An open span ages into unconfirmed
  after 15 seconds. Stale/unconfirmed, paused, hidden and disconnected clocks
  show observedAt minus start, not a projected extra 15 seconds. Only fresh
  confirmed runtime spans show provisional wall-clock elapsed; expiry never
  supplies an end.

## Do's and Don'ts

Show only supplied topology, honest freshness, byte/count-neutral truncation and
bounded observations. Do not invent entities or infer causal edges from timing.
Do not equate stream transport with instantaneous source observations. No
browser telemetry/export coverage or live deployment is claimed by this packet.

Local desktop/narrow Chromium, touch-emulated Chromium and fixture-stream
interaction evidence were collected. Integration owns the independent finish
review and combined runtime/telemetry proof. The design launcher/detector could
not run because its signed download could not be verified. No sidecar was added
outside the explicitly owned file boundary; no shipping raster assets exist.
