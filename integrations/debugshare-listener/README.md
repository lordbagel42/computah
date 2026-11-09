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

The coordinator reads actual authenticated reports separately, checks current
assignment/related evidence and its persistent owner ledger, then verifies an
existing owner before routing duplicates. Assignee strings and report text are
evidence, not authority. Each distinct actionable report gets one medium+Fast
worker instructed to work itself without nested threads. Conversational requests
can start investigation from exact custodian-provided local snapshots before
upload restoration. Preserve individual acceptance when root causes overlap.

Before a Space fix announcement, verify actual main ancestry and Amp linkage,
then include exact bug ID, plain user-visible fix, focused thread URL, actual main
commit URL and source/runtime limits. Archive focused workers only after assigned
acceptance/followups finish; source publication is not a live fix. Keep this owner
open for event-driven duty.

## Evidence and remaining gaps

Run `bun test integrations/debugshare-listener/receiver.test.ts` and repository
checks. Local tests cover logical dedup/concurrency/reload, old markers, ambiguous
append, failed ACK, 2000+ prior messages, rejected inputs/lookup and cancellation.
Live authenticated Worker endpoints, private token/destination setup, actual
durable-ingest→receiver delivery and natural DEBUGSHARE acceptance remain distinct
gates until exercised. Existing Executor source/data remains preserved.

Amp provides managed webhook spans with fixed-category
`computah.debugshare.notice.completed` span-event outcome logs. No report contents,
raw remote errors or credentials are logged. Continuity into Computah's shared
bounded logger/sanitized Axiom exporter, registration/startup and cross-provider
parent/link proof are not implemented or claimed; no competing exporter is added.
