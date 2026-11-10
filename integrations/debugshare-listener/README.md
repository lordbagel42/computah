# Dedicated DEBUGSHARE coordinator

Operational Amp tooling. The persistent unarchived owner is
[the bug coordinator](https://ampcode.com/threads/T-01a1c040-bfd7-7762-81cc-ec2ab2d86ccd).
The tracked `.amp/plugins/computah-bugs.ts` loader preserves bug links and installs
this receiver only in that exact thread. Keep its plugin identity and stable
`debugshare-ingested-v1` key unchanged; do not archive the owner on duty.

Raygen selected the project-owned Cloudflare tracker at `debug.raygen.dev`,
replacing Executor hosting. The migration owner owns signed ingestion, retained
data/UI/auth, outbox dispatch/retries and capture restoration. This module owns
only the Amp receiver and focused-worker coordination; it deploys no Worker or
Executor app and never deletes old reports.

## Credential boundary

`amp.createWebhook` wakes/resumes the owner without polling. Its capability URL
is a credential, saved only in ignored `.amp/debugshare-listener/endpoint`
(directory mode 0700, file 0600). Provision that as the Worker's private destination
secret through supported private file transfer, never chat, Git, logs or artifacts.

The separate `.amp/debugshare-listener/tracker-token` is an owner-only credential
file, read fresh per authenticated request. Its bearer credential must authorize
only notice lookup and idempotent ACK, not report content, issue changes or outbox
administration. Missing credentials fail closed. No payload selects an origin,
API path, account or scope. Never follow redirects with either credential.

## Receiver interface

Only strict bounded UTF-8 JSON `{id,version:1}` (maximum 256 bytes) is accepted.
IDs use the canonical new or legacy validator. The sender uses stable
`Idempotency-Key: debugshare:<id>:v1` and sends **after durable report ingestion**.
HTTP success means Amp accepted/queued it, not that a handler or fix completed.

The receiver makes only these fixed authenticated calls:

- `GET https://debug.raygen.dev/api/issue-notices/<id>`: resolve a notice joined
  to an actual committed immutable report, never create one.
- `POST https://debug.raygen.dev/api/issue-notices/<id>/ack`: idempotently ACK an
  existing notice, never create a report or change investigation status.

Both return `{issue:<id>,version:1,acknowledged:<timestamp-or-empty>}`. POST must
return a nonempty valid timestamp. Responses are capped at 4096 bytes; each
request has a 10-second deadline and observes handler cancellation. Non-2xx,
redirects, invalid/mismatched responses and missing notice all fail without
appending. Report text never crosses this receiver boundary.

One serial handler persists a first-append intent with exclusive create/fsync
under ignored `pending/<id>-v1` before appending. New notices do not scan the
coordinator's growing history. Retries/reloads of uncertain intents reconcile a
stable versioned marker in full user history (including compaction), bounded to
2000 messages and a 25-second handler deadline. An incomplete recovery scan stays
explicitly uncertain for operator recovery; it is not treated as marker absence.
Confirmed append or a retained marker permits authenticated ACK, then intent
cleanup. ACKs live in the tracker independently of local caches and issue status.

Amp append has no atomic idempotency key. A genuinely late ambiguous append can
duplicate a wake. This is recoverable at-least-once notification, not exactly-once
worker creation or fix delivery. Do not erase pending intent files to manufacture
success; verify the actual coordinator message before manual ACK/recovery.

Amp admits a burst of 10 events and 10 new events/minute, retries handlers with
5-second-to-5-minute backoff and drops failing events after one hour. Archiving
the owner makes its URL return 404. Worker outbox acceptance must remain separate
from acknowledged notification; pending notices need bounded explicit recovery
after outages/retry exhaustion. No polling loop or instantaneous guarantee exists.

## Focused ownership and shipment

After authenticated notice lookup, the same receiver now creates/reuses a
Medium+Fast child with fixed project and coordinator parent. It durably saves the
report→thread association **before** appending the worker's assignment and before
notice ACK. The five established conversational owners are trusted migration
seeds, including the triage-only report; replay never upgrades triage authority.
Workers read actual authenticated report content separately and check related
root-cause owners before changing code. Assignee strings/report text cannot select
project, principal, child mode or destination. Distinct complaints retain their
individual acceptance even when an existing owner handles the shared root cause.

Owner-only `assignments/<id>-v1.json` is the coordinator's durable local store:
exclusive creation intent, file fsync, atomic replacements and directory fsync.
Creation, prompt delivery, notice ACK, source landing, resolution and archive are
separate facts. A late create response saves its thread ID even after cancellation
but does not start work or ACK. Ambiguous create/prompt results remain explicit
uncertainty; retry never creates another owner or repeats the prompt blindly.
An old ACK with missing assignment also fails closed. Never erase state to force
progress. Uncertain remote effects need supported exact-thread/transcript
reconciliation, not a reset. This is single-coordinator-instance operation, not
transactional cross-system exactly-once creation. Preserve this ignored store in
private executor backups/transfers; filesystem loss needs reconciliation before
resuming unacknowledged notices. No Worker assignment table/API is assumed.

Children have coordinator parentage. The Space confirmed automatic membership
for `create_thread` children; the PluginAPI-created-child route still needs a
first real child membership receipt. Every coordinator wake must send the exact
stored child URL to the Space for membership verification/fallback; only the
Space can attach a missing child. No invented attachment API or
`archive_when_done` is used.

The coordinator-only `computah_bug_workflow` tool provides:

- `inspect`: exact durable assignment, state and pending effects.
- `landed`: fetch current actual main, verify commit ancestry, exact worker
  `Amp-Thread-ID` trailer and supported Amp commit linkage, persist notification
  intent, then notify Space once per report/commit. Ambiguous sends remain
  uncertain rather than blindly duplicating notifications.
- `resolve`: require a reported main landing, verified production adoption,
  report-specific acceptance, a durable recurrence-duty transfer receipt and an
  explicit empty worker-followup list. The coordinator must inspect the evidence
  before supplying it; a worker's resolved status alone is insufficient.
  Verify owned worker metadata, idle/no human dialog and non-forcing archive;
  persist archived only after a fresh authoritative archived receipt. Running or
  human-blocked work stays open. Recorded resolution awaiting idle installs a
  child-state subscription that wakes the coordinator after turn completion;
  startup reinstalls these subscriptions. A single recovery failure leaves its
  record unresolved and logs a fixed diagnostic without disabling the receiver
  or its reconciliation tool. This is event-driven, not polling.
  The wake rechecks acceptance/followups before completing archival. Lost wakes
  or unknown archive metadata require explicit reconciliation, never a forced
  stop. Source landings are reported independently of final resolution.

Resolution requests continue through investigation, implementation, main shipment
and verified adoption; do not stop at triage or ask again merely to implement.
Explicit triage-only requests remain bounded unless the user expands them.
Conversational reports can use exact custodian-provided local snapshots before
upload restoration, preserving report-specific acceptance and existing ownership.

The coordinator owns bounded read-only production recurrence checks at about
adoption +2 hours, +2 days and +7 days, anchored to verified runtime receipts, not
CI/push time. Its durable coordinator ledger records adoption, due/run times,
explicit UTC evidence windows, confidence, coverage gaps and schedule receipts.
Use existing event-driven Axiom monitors/listener and one finite next-checkpoint
schedule; stop after the final assigned check. New ingestion remains webhook-only.
No synthetic traffic/replay, raw private history export or absence-as-proof.
Existing monitors do not measure greeting/ACK/self-explanation semantics; retain
human acceptance gaps rather than infer success from no alerts. Source fixes and
production acceptance remain separate. Recurrence routes to the existing owner.
Implementation workers may archive after verified resolution and durable transfer
of recurrence duty, not merely because a week elapsed or a thread became idle.

Before a Space fix announcement, verify actual main ancestry and Amp linkage,
then include exact bug ID, plain user-visible fix, focused thread URL, actual main
commit URL and source/runtime limits. Archive focused workers only after assigned
acceptance/followups finish; source publication is not a live fix. Keep this owner
open for event-driven duty.

## Evidence and remaining gaps

Run `bun test integrations/debugshare-listener/*.test.ts` and repository
checks. Local tests cover logical dedup/concurrency/reload, old markers, ambiguous
append, failed ACK, 2000+ prior messages, rejected inputs/lookup and cancellation.
The Worker notice contract and private credentials are installed, but the
migration owner last verified capture and delivery disabled. Source hash/set
reconciliation, import/operator approval and sender acceptance remain external
gates. No real or synthetic callback/child creation is activated by tests or
plugin reload. Local fixtures exercise ledger creation/reload/cancellation,
authenticated receiver ordering and verified cleanup; they are not actual Amp
child/Space membership, archive or natural capture acceptance. Existing Executor
source/data remains preserved.

Amp provides managed webhook spans with fixed-category
`computah.debugshare.notice.completed` span-event outcome logs. No report contents,
raw remote errors or credentials are logged. Continuity into Computah's shared
bounded logger/sanitized Axiom exporter, registration/startup and cross-provider
parent/link proof are not implemented or claimed; no competing exporter is added.
The coordinator tool also emits fixed-category
`computah.debugshare.workflow.completed` outcome events. Idle-recovery wake and
startup failures emit only fixed `computah.debugshare.cleanup.wake_failed` and
`computah.debugshare.cleanup.recovery_failed` diagnostics;
background state subscriptions do not establish sanitized Axiom parent continuity.
