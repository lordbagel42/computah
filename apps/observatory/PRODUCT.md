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

The backend owns sanitization and exposes only the supplied `/api/traces`
projection. The browser receives opaque IDs, safe names, services, timing,
status, parent presence and links; never attributes, resources or content.
The frontend polls every five seconds, times out requests, backs off to thirty
seconds, pauses in hidden tabs, and keeps previous data visibly disconnected
on failure. Older-than-fifteen-second data is marked stale. A visitor may pause
updates, filter, select traces and spans, or explicitly enter a labeled synthetic
demo. Demo is never the default or a fallback for unavailable production data.

## Brand commitments

The brief pins a striking futuristic, dark, Geist-inspired public observatory.
Actual topology and timing must own the visual signature, not invented metrics.

## Accessibility

Keyboard-operable controls, visible focus, readable small-screen layouts,
equivalent textual span details, and reduced-motion support are required.

## Evidence and assumptions

The provided API contract is the implementation authority. No live ingestion or
deployment is claimed by these static files. Assumed: all timestamps are epoch
milliseconds and each span ID is unique within its trace. Audience and product
facts above come from the explicit brief; no interview was needed or conducted
because the assignment explicitly requested unattended execution.
