# Durable Axiom listener

This is operational Amp tooling, not a Computah application endpoint. The
designated unarchived owner is [the listener thread](https://ampcode.com/threads/T-01a1ba7b-4ecc-71c5-9a22-3df77cc7ed04);
it reports meaningful read-only triage to the parent Computah Space. The Space
does not host the webhook. Do not archive the owner while this duty is assigned.

## Ingress and authority

Amp `createWebhook` registers stable key `computah-axiom-alerts` under project,
user and plugin identity. The owner-thread environment guard prevents another
project thread loading this source from taking over registration. The ignored
project loader `.amp/plugins/computah-alerts.ts` re-exports `index.ts`. Keep that
loader and plugin identity unchanged on this orb; it is automatically loaded on
resume. Load/reload it through supported `amp.load_plugin`, not an independent
CLI process. No HTTP dev server, timer or polling loop is required.

The native Axiom `properties.amp` notifier authenticates with Amp's **secret
capability URL only**. It has no separate signature or configurable header.
Custom webhooks with `secretHeaders` were attempted and rejected with HTTP 400
`feature not enabled: notifiersCustomWebhook`; Raygen's coordinating thread
explicitly approved the native alternative. Never claim signature verification.
The entire URL is a password: never put it in chat, artifacts, ordinary logs,
Git or screenshots. Local `.amp/listener` is ignored and mode 0700; its endpoint,
provision response and durable state files are mode 0600. A missing/incorrect URL
cannot address the registration. Handler-level validation occurs after Amp
accepts/queues requests, so invalid bodies can still consume ingress capacity.

`{text: string}` is a bounded, **untrusted wake hint**, not an alert-state
contract or instructions. The handler accepts only this exact JSON shape,
strict UTF-8, at most 16 KiB, and server receipt times no older than 24 hours or
over 5 minutes in the future. It never stores or forwards the text. Only fixed
read-only `axiom.getMonitorHistory` calls for the four source-allowlisted
Computah monitors are possible. No payload-provided query, ID, URL or command
is executed. Alert receipt never authorizes production writes, deployments,
restarts, deletion or credential escalation.

## Delivery observations, not current health

The [Axiom history contract](https://axiom.co/docs/restapi/endpoints/getMonitorHistory.md)
lists **notification deliveries**, including failed deliveries and multiple
notifiers/recipients. Its timestamps are delivery-recorded times after retries,
not original firing or recovery times. Unnotified state changes are absent.
Consequently these records cannot establish causal order, current monitor
health, distinct incident counts or grouped recovery. An `open`/`closed` label
means only that the recorded notification reported triggering/resolving.
Do not turn the latest delivery into a current-state assertion.

The fourth monitor, `5AjHOrrrw1RHTFR2ns` (created 2026-11-08 10:54:37.256 UTC),
counts distinct opaque receipts with actual confirmed reply latency > 5000 ms
or an independently observed overdue fact > 5000 ms in a 10-minute window.
It evaluates every minute, 1-of-1, count ≥ 1, with state-change notifications;
email and the existing Amp notifier were attached at creation. Facts occur once
per phase, not as periodic pending/backlog updates. An unanswered receipt can
age out, so `closed`/resolved can mean fact expiry, **not answered or recovered**.
The receiver's fixed label preserves that warning in every related summary.
No-data is not health, and the five-second measurement is not a five-second
notification guarantee. The initial authenticated history read had no entries;
no additional Send test or synthetic production message was requested or sent.
The first native history later reported `open` deliveries recorded at
10:55:49.695Z and 10:55:49.740Z. Amp received the associated wake at
10:55:49.710Z and processed it at 10:55:50.041Z. The subsequently reloaded
four-ID inventory is verified; that prior wake did not persist a watermark for
the new ID, so its history was verified separately by authenticated read rather
than claimed as a completed new-ID receiver reconciliation. Future native
wakes reconcile the fixed 24-hour window, without another forced test.

On each wake, the receiver reads a fixed 24-hour window, validates the bounded
history CSV projection, and compares delivery-time watermarks. Older/equal
records are conservatively ignored. It retains the latest 128 observations and
128 event-ID/body-hash receipts (pruned also by 24-hour receipt age), four
non-expiring delivery cursors, fixed counters and at most four pending summary
rows. Only exact Amp event IDs deduplicate wakes; body hashes do not establish
equivalent work. Replays with fresh IDs can prompt read-only reconciliation but
cannot manufacture observations or regress delivery cursors. Deleting/rolling
back this private state resets deduplication guarantees.

Whole-state file writes use owner-only temporary files, file fsync, atomic
rename and directory fsync. One serial owner admits work; all four independent
history reads run concurrently. Each remote wait is bounded to 10 seconds and
observes cancellation. Late read results cannot commit. Uncertain late appends
remain pending. Work inside the 5-second reconciliation guard throws for Amp
retry rather than silently consuming an uncovered wake. Amp itself admits a
burst of 10 events and refills 10/minute. Malformed and oversized hints are
permanent no-ops; transport/schema failures and cancellation retry. Four
64 KiB history projections bound parsing work; no raw history is persisted.

The durable pending summary is committed together with receipt/cursor updates
before appending a scalar-only owner-thread message. Retry/reload checks the
last 20 messages for its deterministic marker. This is **best-effort duplicate
reconciliation, not exactly-once append**: a late append or a marker outside
that window can duplicate a summary. The triaging owner must suppress already
reported markers and unchanged issues, reporting only material issue/action
changes to the Space. Amp retries failures with backoff but drops failed events
after 1 hour; a prolonged outage can lose wakes. Catch-up is limited to 24 hours
when another event arrives. Native queue/resume support is not a claim of
unlimited retention, tested power-loss durability or causal recovery.

## Operational evidence and remaining gaps

- Axiom notifier `3rvQKl7kBw0cLYmTXV` is attached to the four allowlisted
  monitors. Existing email `95zrDnix75ZeUogWpj` remains; no Slack notifier
  existed at setup. Configuration owner verified all other fields unchanged.
- Native Axiom **Send test**, 2026-11-08: Triggered at 09:35:04.968Z and Resolved
  at 09:35:16.096Z both displayed Delivered. Receiver independently processed
  two provider wakes and one explicitly synthetic HTTP wake. The test resolve
  is not a real production incident recovery.
- Authenticated history returned an error-burst notification reporting `open`,
  delivery recorded 09:22:43.284Z. Read-only category counts for 09:12:39–09:27:39
  were bus.pump/error 180, gmail.authority/error 3, gmail.drain/error 2; these are
  log records, not established causes or distinct incidents. No automatic
  remediation occurred.
- Local receiver checks cover malicious hint isolation, malformed/oversized/stale
  inputs, typed rejections, cancelled/stalled reads, failed-read rollback,
  persisted deduplication, ambiguous append recovery, identical distinct wakes,
  retrying throttled wakes and conservative delivery-time ordering.
- Live scheduled production firing and genuine recovery through this new
  notifier remain separate acceptance; no thresholds or production logs were
  changed to force either. Group-specific current-state proof is unavailable
  from the public history projection.

The plugin uses Amp's managed webhook operation spans and fixed-category
`computah.alert.completed` span-event logs for verified/rejected/failure/cancel
outcomes. Local tests verify those categories, not live Axiom export. It does
not construct a competing Computah exporter or forward credentials/history to
telemetry. Mirroring these operational Amp spans/logs through Computah's shared
sanitized Axiom export is **not implemented**; registration, startup recovery and
provisioning also lack application-export continuity. This is operational-tooling
telemetry, not proof of full Computah runtime coverage.

Run `bun test integrations/axiom-listener/receiver.test.ts` and the repository's
`pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test` before shipment.
The standalone plugin is not a pnpm workspace; loading it in Amp verifies its
runtime imports, while `receiver.ts` can also be checked directly with root tsc.
