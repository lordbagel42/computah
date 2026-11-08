# External message actor and Durable Streams

Status: implementation in progress, not an enabled bus. Published main `4b89424`
has authenticated Interaction admission/results and connection-local observation
SSE. Slack owns its own durable receipt/delivery journal. Gmail's source index
and live admission callback are unadopted preparation. Production backend and
Slack were explicitly paused; no implementation here authorizes resumption.

## Smallest fit

Use one durable external-message actor per authenticated audience, alongside the
existing Interaction and Workers. It owns incoming receipts, their Interaction
submission mapping, outgoing public records and delivery intent. This is not a
Worker router, another agent harness, general workflow platform or new transcript.
Pi continues to own conversations, tools, generation and compaction.

The host authenticates tenant/user/agent and audience before resolving this actor.
Browser/provider/model fields cannot choose a different principal or account.
Reuse the existing stable admission IDs, signed result handles and public text
projection; do not invent a second generation/result path.

1. Accept a trusted external receipt and freeze its payload/destination. Identical
   retries reuse the receipt; changed content under that ID conflicts.
2. Persist admission intent before acknowledging. Dispatch to the bound
   `session.interactionId` with the same receipt-derived mutation ID on retries.
   Interaction alone decides whether to use Task and which persistent Worker.
3. Reconcile the original submission after a lost response. Read/project public
   observations and terminal results without serializing raw Pi views.
4. Persist output intent and publish ordered public records to an actual Durable
   Stream. Keep stream publication independent of browser connection lifetimes.
5. An adapter consumes that output and performs only its authorized external
   delivery. Freeze destination and delivery ID; ambiguous provider sends remain
   uncertain pending reconciliation, never blindly retried as exactly-once.

## Actual Durable Streams, not renamed SSE

Rivet owns the durable receipt/outbox actor. The selected stream implementation
is the official `@durable-streams/server` pinned to `0.3.9`, embedded on private
loopback with an explicit persistent `dataDir`. This is the upstream Node
reference/embedded implementation, not native Rivet Durable Streams and not a
production-scale recommendation. Computah exposes authenticated read-only access
to its open Durable Streams protocol:

- `PUT` to create a stream with fixed content type; conflicting configuration409.
- `POST` to append JSON records. `Producer-Id`, `Producer-Epoch`, `Producer-Seq`
  together provide idempotent producer writes; repeated sequence204, stale
  epoch403. These producer receipts are not external-delivery guarantees.
- `GET ?offset=-1` from the beginning, an opaque returned offset to resume, and
  `live=sse` or `live=long-poll` for following new data.
- `Stream-Next-Offset` and SSE control records for reconnect position. Readers
  retain the last consumed offset and tolerate replay rather than fabricate a
  connection-local sequence as a durable cursor.
- Explicit close and deletion/expiry semantics. Do not promise indefinite replay
  across stream deletion or apply arbitrary history caps to Gmail source memory.

Persist the logical producer identity, epoch, sequence and exact pending record
before append. After a crash, retry that record with the same producer identity
before advancing. An append response lost after storage must not duplicate the
record. Actor state and stream append are separate commits; no distributed atomic
transaction is assumed. Native durable actor work must resume publication after
gateway disconnect/reopen; an in-memory promise is not enough.

The native Rivet route was probed with pinned3.0.6 and a trivial registry, without
providers: stream creation returned404, not201. Installed and latest
`@rivet-dev/services`0.2.5 describes its binary as intentionally a no-op. The
integration documentation's automatic support claim is not an available runtime
capability here. Rather than build a second protocol or upgrade the actor runtime,
use the official file-backed server. An isolated dependency probe verifies create,
append, producer retry deduplication before/after server restart, exact persisted
offsets and resume returning only subsequent data. This is not yet integrated
actor/API or host deployment proof.

Current `/v1/submissions/:id/events` SSE uses fresh resync sequence0 and current
text replacements. It has no durable replay cursor. Preserve it for compatibility;
do not claim it is already Durable Streams. A future output log records only
observations actually committed to that log, not lost provider tokens before
publication. Effect `Stream` can compose reads, cancellation and backpressure;
it is not persistence or the Durable Streams protocol.

## Public API and authorization

One output stream belongs to each trusted audience, not each receipt:

- `POST /v1/bus/receipts` accepts `BusSendRequest` and returns202 `BusReceipt`.
  The request contains only `clientMutationId` and nonblank `text`, preserved
  exactly; caller authority fields are rejected.
- `GET /v1/bus/receipts/:id` reads the same signed receipt; foreign signed
  receipts return403.
- `GET /v1/bus/stream?offset=-1|opaque&live=sse|long-poll` reads the real stream,
  retaining native `Stream-Next-Offset`. Authenticated `HEAD` is read-only too.
  There are no public stream writes or admin routes.

`BusReceipt` contains version1, signed opaque `id`, `clientMutationId`, status
queued/submitted/completed/failed/cancelled and nullable signed `submissionId`.
`BusOutput` contains version1, that receipt and nullable public `text`. Only a
completed receipt may carry text; no event taxonomy or connection-local sequence
is added. Effect schemas and generated JSON Schema live in `packages/contracts`.

Keep native stream administration and actor credentials private. Custom clients
use the authenticated Computah API, with audience-bound read authorization on
every initial/reconnect request and before releasing output. A path, opaque
offset or source-account handle is not authorization. Only trusted host code
creates/appends/closes streams; clients cannot inject assistant output by writing
to the public read surface. Native engine/service ports remain private.

Public output is safe text/status/result only, using existing projection rules.
No reasoning, tools/results, raw histories, credentials, ingress evidence or
private account/grant lineage is copied into the public output stream. Revocation
must stop further release and dispatch; already delivered bytes cannot be undone.
Do not broadcast one user's stream to another audience or mix private account
events into a shared Slack conversation.

## Gmail's existing seam, not a second bus

Reuse `run(work, current): Promise<string>` from Gmail preparation. Its frozen
`work` is `{ receipt, scope, handle, grantVersion, text }`: trusted scope,
opaque account handle/version, stable admission receipt and untrusted evidence.
Persist those fields privately; reconstruct current grant validation during
recovery rather than serializing the `current` closure. Native every-attempt
generation/compaction and Task lineage must enforce the stored grant version;
ordinary submit authorization alone is insufficient. Do not use provider stream
metadata as authority.

Resolve the callback from the same receipt's durable final Interaction output.
Gmail keeps its `UNSENT LOCAL DRAFT` projection and account/source links. No send
tool or generic delivery engine is added to Gmail by this callback. Structured
citations come from its trusted frozen source record, never parsed model text.
Effectively full historical indexing only writes source memory and never calls
`run` for each old email. Live new-mail events use the external-message actor.

## Offline acceptance and ownership

Core owner implements actor, native stream registration/probe, recoverable
dispatch/publication and existing HTTP wiring. Integrator owns shared schemas
and fixtures after the concrete supported seam is agreed. Gmail owner retains
indexing, signature/account/receipt checks and draft projection. No parallel
copy of core, contracts or Gmail schemas.

Exercise duplicate/conflicting ingress, lost admission/append responses,
reopen-and-resume from the last durable offset, ordered public terminal records,
disconnect without cancellation, cross-audience denial, revoked grant/retry and
untrusted-content projection with deterministic models only. Verify the actual
protocol rather than only a mock. Production Fast-only HOLD remains. Scoped
deployment of a separate bus-only container is explicitly authorized: dedicated
private config/data, loopback8792, no provider runtime/model registry, no old
checkpoint mounts, and non-model append/replay/restart/auth checks under the
deployment lock. This does not authorize backend/Slack restart, HOLD removal or
model calls. Bus-only mode durably queues ingress and public queued records;
Interaction dispatch remains disabled. Deterministic injected dispatch tests must
be labeled separately from real-agent acceptance.
