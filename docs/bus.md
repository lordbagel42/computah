# Model-free external message bus

The standalone entry is `apps/server/src/bus-main.ts`, not the legacy `main.ts`.
It registers exactly one Rivet actor type, `bus`, and supplies no dispatch
callback. Accepted messages remain durably **queued**, with `submissionId: null`;
this is a working ingress/egress bus, not resumed model execution. It does not
import/register ModelRuntime, Pi Interaction or Worker actors, open their state,
or run their checkpoints. Backend/Slack and their reconciliation HOLD remain
separate and paused. Bus authorization does not authorize resuming them.

## Actual Durable Streams implementation

The pinned RivetKit 3.0.6 native engine probe started a trivial actor registry,
then returned HTTP404 (`amogus`) for PUT
`/durable-streams/v1/stream/computah-probe`. Installed Services0.2.5 documents a
no-op runtime; SDK documentation about automatic Durable Streams availability is
not evidence that this installed route works.

This bus therefore embeds the official `@durable-streams/server`0.3.9 reference
implementation on a random **private loopback** port with an explicit persistent
`dataDir`. This is real Durable Streams protocol and file-backed storage, not
connection-local SSE relabeled as durable replay. It is NOT native Rivet Durable
Streams. The Node reference server is intended for development/prototyping and
embedded use, not the production-recommended Caddy deployment. This initial
self-hosted bus does not claim production scale/hardening or power-loss guarantees
beyond its dependencies' actual guarantees.

## Storage and launch boundary

Use a dedicated writable HOME, never the backend HOME, environment or state
mount. For the separately authorized bus container:

- `HOME=/data`: native engine data under `/data/.rivetkit`.
- `COMPUTAH_BUS_DATA_DIR=/data/bus`: stream files/LMDB under `/data/bus/streams`.
- `PORT=8792`: public authenticated ingress, published on host loopback only.
- `COMPUTAH_BUS_SECRET`: dedicated random secret of at least32 bytes.
- `COMPUTAH_BUS_AUTH_JSON`: dedicated private JSON bindings. Each has `token`
  (at least32 characters), `tenantId`, `userId`, `agentId`, `audience` (nonempty,
  at most200 characters each), and `capabilities` drawn only from `task.send`
  and `history.read`. One token/binding per unique audience scope.

The registry explicitly starts its managed engine on loopback, pool
`computah-bus`, namespace `default` (the fresh engine's bootstrapped namespace),
with native Services disabled. Namespace naming is not process/storage isolation:
the dedicated HOME/engine and absence of old actor registration are the boundary.
`RIVET_RUN_ENGINE=1` may be supplied explicitly by the deployment wrapper;
`RIVET_RUN_ENGINE_PORT` may select a free private engine port. Do not expose the
native engine or reference-server administration ports. The standalone entry
rejects `RIVET_ENDPOINT`, `RIVET_NAMESPACE` and `RIVET_TOKEN` rather than attaching
to a remote/legacy engine. No provider/auth/runtime backend mounts or variables
are needed. The deployment owner owns fresh directories, UID/permissions,
private configuration and immutable-image activation.

Stop on SIGTERM/SIGINT: close HTTP admissions/connections, dispose the client,
drain/shut down registry and then stop streams. All signals await one shutdown
promise. Keep both the native HOME and stream data directory for restart;
keeping only one loses the receipt/stream relationship. Never delete/reset a
stream or its producer state to repair publication behind retained receipts.

## API for custom clients

All routes except health require `Authorization: Bearer <dedicated token>`.
Authentication binds tenant/user/agent/audience; body/query/path/offset cannot
choose another audience. These DTOs come from shared Effect contracts:

- `POST /v1/bus/receipts`: strict `{text, clientMutationId}`. Non-whitespace
  text up to100000 characters is retained **exactly**, not trimmed; mutation ID
  length1..200. HTTP202 returns `BusReceipt`: `{version:1,id,clientMutationId,
  status,submissionId}`. Same ID+bytes reuses the receipt; changed bytes409.
- `GET /v1/bus/receipts/:id`: requires `history.read`, returns the current receipt.
  Receipt handles are audience-bound and signed. A foreign handle is403.
- `GET|HEAD /v1/bus/stream?offset=-1`: actual per-audience Durable Stream from
  its beginning. Save `Stream-Next-Offset`; resume with that opaque offset.
  Add `live=sse` or `live=long-poll` to follow. SSE control records carry native
  resume positions. The proxy does not manufacture offsets or sequence numbers.
- `GET /healthz`: `{ready:true,mode:"bus-only",dispatch:"disabled"}`.

The stream is read-only to clients: no public create/append/close/delete/admin
surface. Output is `BusOutput={version:1,receipt,text}`. Text is null except for
safe completed assistant text. Queued input evidence, reasoning, tools, account
lineage, native handles and raw histories never enter this stream. Scope and
token permissions are checked on admission, after body/RPC waits, initial read,
reconnect and before every proxied chunk. Configuration is startup-bound; changing
the private auth file requires an explicitly coordinated process restart.

## Durability and future deterministic core seam

Each native Rivet bus actor uses SQLite receipts plus an outbox. Receipt and
accepted-output intent commit in one named transaction before admission returns.
A native persistent cron drives recovery independent of a browser connection.
Each exact outbox record is appended with stable actor producer ID, epoch0 and
persisted sequence; SQL `sent` advances only after successful acknowledgement.
Ambiguous append responses retry the same sequence, using actual protocol dedup.
SQL and stream storage are separate commits; no distributed atomicity or
exactly-once external side effects are claimed.

Admission acknowledges durable intent, not stream publication. The internal pump
attempt handles one bounded batch; a busy attempt records `outcome=waiting` and
returns without joining the active pump. Neither admission nor a pump invocation
is a drain/completion barrier. Observe publication through Durable Streams replay
or a live read from a saved offset, not an immediate snapshot after admission.

`bus-core.ts` is an explicit optional seam used only by deterministic native tests:
resolve an authorized scope session, submit to `session.interactionId` with the
stable receipt-derived mutation ID, reconcile that same result and project safe
final text. Existing signed Submission result handles remain interoperable.
Interaction alone owns Task/Worker decisions. `bus-main` never imports this seam
and has no route/flag to enable it. Gmail/source-grant delivery and historical
backfill remain deferred; this bus is not a Worker router or delivery platform.

Native tests exercise public API isolation/idempotency, actual file-backed
offset/replay/SSE/long-poll, executable no-model import guards on startup/restart,
the optional deterministic Interaction seam, and faulted publication recovery.
Run `test/bus.test.ts` alongside the existing core suite. These are offline tests,
not proof of provider Fast entitlement or permission to resume model execution.

## Operational tracing

The bus emits explicit `computah.bus.pump` spans for wake, admission-triggered
background work and cron/explicit pump attempts (`phase=prepare`, `input`, `poll`).
An already-running pump records `outcome=waiting` rather than starting concurrent
publication. Each actual stream PUT and POST has a nested
`computah.bus.stream.create` or `computah.bus.stream.append` span, covering fetch,
response cleanup and, for appends, the SQL sent acknowledgement. Failed, timed-out
and cancelled attempts end before the background caller swallows/retries them.
Stable producer sequences and uncertain-append deduplication remain unchanged.

`computah.bus.replay` covers authenticated GET/HEAD replay and live proxy lifetime,
including authorization checks, upstream fetch/body consumption, downstream
backpressure, response completion/disconnect and upstream cancellation cleanup.
Only a `resumed` boolean describes replay position; no offset, cursor, URL,
producer ID, scope, receipt handle or message content is exported. Supported active
HTTP context parents the replay span; stream creation inherits its active
pump context. Append attempts instead restore the
persisted receipt root and link their pump as described below. Standalone dispatch
remains disabled; no deployed bus-to-backend run linkage is claimed.

The native recovery test verifies emitted spans through the actual Node exporter
and sanitizing loopback relay into an intercepted synthetic Axiom sink. It checks
create failure, lost append acknowledgement, deduplicated retry, cron timeout,
replay/resume, denial, invalid query and live disconnect, including parentage,
lifetimes and private-content canaries. Shared operation-completion logs accompany
these spans; the test also checks linked timeout/cancel records and that resolved
invalid input is not logged as success. This is local runtime/export proof, not
enabled production collection or live Axiom ingestion. Existing bounded,
best-effort fail-open export applies; no new exporter or per-message trace queue
is introduced.

## Durable receipt causality and timing

Each newly admitted receipt persists the carrier of its actual
`computah.bus.admit` operation atomically with the receipt and accepted outbox
intent. Admission continues the admitting transport/actor context rather than
creating an independent linked receipt root. Duplicate admission retains its
original carrier and dates. Without an SDK or valid context, a durable fallback
identity remains available. Trace context never authorizes a telemetry query.

`computah.bus.stream.append` attempts restore the saved receipt parent and link
the current `computah.bus.pump` span; a batch never merges different receipt roots.
The optional deterministic `computah.bus.dispatch` seam restores that same parent,
but standalone dispatch remains disabled. Stream creation stays parented to its
pump. Replay remains HTTP-parented: one replay can contain multiple receipts, so
it is not falsely assigned to any single receipt root. Offsets/cursors, producer
identity/epoch/sequence and payloads are unchanged.

Private actor SQLite records UTC Unix milliseconds:

- `receivedAtMs`: HTTP handler entry, before auth/body waits, not sender time.
  Direct actor admissions without HTTP timing retain null.
- `admittedAtMs`: first admission transaction timestamp, not HTTP response time.
- Per-output `enqueuedAtMs`: durable outbox intent timestamp.
- `firstAttemptAtMs`: first initiated append attempt, saved before network I/O.
- `acknowledgedAtMs`: when this host observed a successful DS append response,
  saved atomically with `sent=1`; not original stream insertion or client delivery.
- `attempts`: initiated append attempts, saved before POST. A crash before the
  actual POST can count an initiated attempt that never reached the wire.

The additive migration leaves historical dates, attempt totals and carriers
unknown. Legacy sent/unsent payloads and sequence positions are not rewritten;
resuming old work does not invent its original enqueue/first-attempt time or count.
An ambiguous append retries the exact same producer sequence, retaining the
original first-attempt timing and recording acknowledgement only after success.

The native-only `session.timing(signedReceiptId)` action requires current
`history.read` and the same audience-bound signed handle as receipt lookup. It
returns the host-generated `traceId`, `receivedAtMs`, `admittedAtMs`, and bounded
`outputs` containing the four per-output fields above. Legacy `traceId`/dates and
`outputs` are null when no proven original metadata/linkage exists. No public HTTP
timing endpoint or arbitrary trace-ID lookup is added. A caller-supplied trace ID
is correlation, never query authority.

Exported elapsed attributes are `queue.duration_ms` (saved first attempt minus
enqueue), `delivery.duration_ms` (observed DS acknowledgement minus enqueue),
`attempt.duration_ms` (monotonic local attempt lifetime), `attempt`, and
`receipt.age_ms` on timing reads. Clock-reversed wall-clock intervals are omitted,
not clamped into fabricated zero durations. Overlapping span durations must not
be summed as end-to-end latency. UTC source dates stay in private storage.
`bus.delivery` structured logs use the existing bounded logger and carry the same
receipt/attempt trace context with fixed outcome, attempt/status and elapsed
scalars, not receipt IDs, scope identities or content. Trace/log export remains
bounded best-effort, separate from durable receipt correctness.

Local native tests cover causal ingress parenting, independent batch pumps, cross-audience
denial, restart, duplicate admission, lost acknowledgement/204 dedup retry,
unchanged replay, saved timing and sanitized trace/log linkage. These tests are
not evidence of exact production revision adoption or actual Axiom ingestion;
those require an observed bus deployment and query result.
