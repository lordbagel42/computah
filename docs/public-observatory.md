# Public trace observatory

Canonical public HTTPS Worker: https://observe.raygen.dev
The same Worker remains available at https://computah-observatory.enderium42.workers.dev.
Source: `apps/observatory`. This is not the authenticated internal DEBUGSHARE
tracker and does not expose the private backend or its reports.

## Disclosure and wire contract

`GET /api/traces` hides `computah.logs.export` housekeeping by default, before
the Axiom row limit so exporter batches cannot displace application activity.
The **Include log exporter** diagnostics toggle selects the only supported query
parameter, `?includeExporter=1`; all other query parameters and client-supplied
IDs/APL are rejected. Exporter errors remain recorded and are visible in this
diagnostic mode; application errors are never excluded by the housekeeping rule.
A single Durable Object coordinates all readers with two fixed-mode caches;
each mode has independent single-flight/backoff and at most one query per five
seconds (two queries globally per five seconds if both are requested). Switching
modes clears the browser snapshot, never relabeling old data as the new mode.
Its fixed server-side Axiom queries select only timing/topology fields from
`computah-prod-traces`, always exclude observatory self-telemetry before limiting,
and read the newest 1,001 eligible rows in 15 minutes.
At most 1,000 spans are returned. This is a rolling bounded view, not a lossless
archive or a promise that every trace fits. Partial query results and overflow set
`truncated`. Query deadline is eight seconds, response bound is 2 MiB, cadence is
at least five seconds per mode, failure backoff is capped at 30 seconds.

An independent positive projection reconstructs each public span with only:
`id`, `traceId`, `parentId`, `parentState`, `links`, `name`, `service`, `start`
(epoch milliseconds), `durationMs`, and `status` (`ok`, `error`, `unset`). The
response adds `state`, `fetchedAt`, `windowMs`, `limit`, `truncated`, `spans`.
Names/services use a literal approved catalog; unknown values become generic.
Domain-separated keyed hashes replace raw trace/span IDs. Parent/link presence
is checked within the returned window; absent/malformed parents remain explicitly
missing, never joined by timing guesses. Axiom currently has no links column;
`column_ifexists` handles that without inventing endpoints.

All attributes/resources/events, error strings, identities, actor/request keys,
conversation content, model content, DEBUGSHARE IDs/report pointers and private
links are discarded. No credential reaches static assets or public responses.
No arbitrary-query proxy exists. Security headers restrict browser connections
and scripts to the same origin. All rendered payload text uses `textContent`.

## Live transport and freshness

`GET /api/stream` (or its exact `?includeExporter=1` diagnostic mode) uses SSE.
An initial `snapshot` resets the browser's bounded keyed map. Subsequent `delta`
events contain metadata, changed `upserts` and removed keys (JSON-encoded
`[traceId,id]`). Unchanged span snapshots are not repeatedly streamed. `status`
events identify `runtime-push` versus `axiom-history`, last live receipt and
history query freshness. Axiom remains ingestion-delayed settled history, queried
at most once/five seconds per requested mode with the existing backoff and bounds.
An SSE connection does not make native/Axiom-only stages instantaneous.

Authenticated runtime `POST /api/ingest` bypasses that query delay for active
operations. It requires a separate bearer `OBSERVATORY_LIVE_TOKEN` (at least 32
characters); absent/empty binding denies every ingestion request. No query/HMAC
credential is reused. Body version 1 admits at most 128 records and 128 KiB.
Records contain fixed timing/topology fields plus `lifecycle` (`active`, `ended`),
monotonic per-span `revision`, and epoch-millisecond `observed_at`. Invalid/stale
records are dropped, replayed/lower revisions cannot reopen ended spans, and the
Worker reconstructs public fields before retaining anything. Public spans add
only optional `lifecycle` and `observedAt`; no raw IDs, incoming fields, errors,
content or bearer tokens enter SSE, resume tokens or stored public state.

Public live state is capped at 1,000 spans/15 minutes since last observation;
merged responses additionally stop below 512 KiB, marking truncation and
recomputing missing relationships. This prevents link-heavy snapshots from
exceeding the streaming queue budget.
Fresh active spans are prioritized over old settled history at the cap. Operations
may start earlier than the history window, up to seven days. Their ongoing duration
is provisional; after 15 seconds without an update clients freeze at last observed
time and label the operation unconfirmed, never inventing a terminal event.
Settled history wins when it reconciles an active record whose end was lost.

Each fixed mode has an in-memory epoch/sequence replay ring, at most 256 events
and 4 MiB. `Last-Event-ID` resumes newer events only; an unknown/expired cursor or
DO restart yields a full snapshot reset. This is bounded recovery, not lossless
durability. Cursors contain only random epoch/sequence, no runtime identifiers.
Each mode admits at most 16 readers; each reader queue is bounded at 1 MiB.
Replay larger than 768 KiB resets to the latest bounded snapshot instead of
synchronously overfilling a fast reader's queue during connection startup.
Slow readers are disconnected and reset/replay on reconnect. Cancel/disconnect
removes the reader; zero readers stop the history polling loop. Tabs close their
EventSource while hidden/paused and reopen with a full reset. Demo remains
explicitly synthetic, never an automatic fallback for unavailable production data.

## Deployment and activation

Alchemy 2.0.0-beta.85 Cloudflare stack lives in `apps/observatory/deploy`, with its
own pinned workspace/lockfile. Install there with `pnpm install --frozen-lockfile`.
Use `pnpm run plan` then `pnpm run deploy --yes` with the approved Cloudflare
environment credentials/account. No private host ingress changes are required.
Deploy state under `.alchemy` contains unwrapped secret material: keep it ignored,
owner-only and on protected storage. The stack sets umask 077; secure existing
state files/directories too. Do not print or publish state.

Activation requires an explicitly provisioned dataset-scoped query-only
`COMPUTAH_AXIOM_QUERY_TOKEN` and random `PUBLIC_ID_SECRET` of at least 32 characters.
Inject privately through protected environment/bindings; never use an ingest or
Amp MCP credential for queries. Generate and retain the HMAC secret securely;
rotation changes public identifiers. Code-only reconciliation without these values
refuses to proceed. `COMPUTAH_OBSERVATORY_BOOTSTRAP=1` deliberately deploys an
unconfigured shell and can clear existing bindings: use only for initial bootstrap
or intentional deactivation, never routine redeployment.

The canonical `observe.raygen.dev` custom domain is managed by this existing
Alchemy Worker, including Cloudflare DNS and TLS; it is not a second deployment.
Keep the existing state, Durable Object namespace, HMAC and secret bindings on
every update. Domain configuration must not bootstrap or rotate them.

Permission inspection on 2026-11-08 found that the installed Worker query token
returned HTTP 200 for count-only queries to both `computah-prod-traces` and
`computah-prod-logs`. The public query remains fixed to traces, but this is **not
dataset permission isolation**. A separately provisioned token with QueryRead only
on `computah-prod-traces` subsequently replaced only the Worker query binding.
Valid count-only controls using that exact installed binding returned traces HTTP
200 and logs HTTP 400 (`unable to find dataset`), not HTTP 403; the same logs query
had succeeded with the previous credential. The dedicated native grant evidence
corroborates dataset inaccessibility rather than a malformed-query failure.
The shared backend credential and grants were not narrowed or rotated. Retain the
new dedicated Worker credential for redeployment; do not restore a broader ambient
token. Private-content activation remains a separate content/deployment decision.

Optional `OBSERVATORY_LIVE_TOKEN` is a separate, dedicated secret binding for the
planned authenticated live-lifecycle push endpoint, not an Axiom query/ingest
credential or public-ID HMAC. Absent/empty configuration is disabled; configured
tokens must have at least 32 characters. Provision and retain it privately and
preserve it on redeploy. Backend activation awaits checked source adoption and
independent endpoint acceptance; this binding alone does not enable live push.

Optional `COMPUTAH_AXIOM_INGEST_TOKEN` enables an isolated fixed-schema edge OTLP
emitter, not the Node bootstrap. It emits only HTTP/poll lifetimes, fixed outcomes,
random IDs and dropped-count scalars; no URL/request/error data. One DO owns its
budget (eight export attempts/5 seconds, four concurrent, two-second deadline),
and polls inherit the initiating HTTP span. Export fails open; dropped accounting
is bounded. Edge self-telemetry is excluded from the public feed to avoid visitor
traffic displacing application activity.

## Evidence and remaining gaps

- Checked source `2477de6` deployed through the preserved Alchemy state at
  https://observe.raygen.dev, Worker version
  `3ae23c35-8469-4f0d-8eb8-9babb9db26ff`, receipt
  `280d2f39-c9f9-44df-a055-b6892c46a894`. Query/live/HMAC/DO bindings remained
  unchanged; the optional edge Axiom emitter remains disabled. Missing/wrong
  ingestion bearers returned 401; an authenticated empty batch returned accepted
  zero, without fabricating telemetry. Both real history modes streamed with
  no-store/no-transform; unsupported query parameters returned 400.
- A 132-second independent production history audit received 55 frames/25 deltas,
  one snapshot and five frames after cursor reconnect. Incremental IDs were
  unique/ordered, the keyed map remained bounded, and actual public span/status/
  envelope fields matched the positive schema. The captured source was labeled
  `axiom-history`; this receipt does not itself prove active runtime delivery.
  After host activation, real finite registry startup was observed active five
  times, then ended at 33,926.311794 ms and reconciled with settled history at
  that exact duration. No synthetic trace or model turn was inserted.
- A subsequent 252-second independent runtime audit received 1,392 frames,
  693 deltas and 698 `runtime-push` statuses; cursor reconnect delivered 77 more
  frames without a snapshot reset or duplicate/out-of-order incremental IDs.
  The public keyed state and positive span/status/envelope schema stayed bounded.
  A second window captured seven active updates before a real operation ended
  `error` at 7,400.491142 ms, plus its declared-present `computah.submit` child
  observed four times before ending `ok` at 3,925.033646 ms. These are finite
  success/failure delivery receipts, not a private source-identity join or proof
  that a particular human message received its final reply.
- The production Chromium view rendered an actual 59-operation trace with 58
  declared parent routes. Narrow rendering had no page-level horizontal overflow;
  the last remaining operation in its rolling truncated view was reachable by
  internal scrolling and confirmed within the viewport. Production pause/resume,
  selection/pin and follow release were exercised with real pointer input.
- Exporter-noise investigation on 2026-11-08 found 1,217 `computah.logs.export`
  spans in a production 15-minute window. This operation records each nonempty
  structured-log batch; the logger does not enqueue export-result logs, and the
  trace processor only exports spans, not new structured logs. No recursive
  exporter loop was demonstrated; instrumentation is retained. Local checks cover
  fixed default/diagnostic queries, rejection of arbitrary query parameters,
  isolated caches/failure state and retained application errors/truncation.
- Public feed activated through Alchemy on 2026-11-08 after private query-token
  provisioning. The actual Worker returned `live`, 1,000 projected production
  spans and `truncated: true`; desktop and narrow Chromium rendered live data.
  One verified snapshot contained backend, Slack, bus and dashboard services,
  253 present parent relationships and five explicitly missing parents. These
  counts describe that snapshot only, not completeness or a stable runtime metric.
- A separate private REST query correlated all 1,000 returned public spans to
  actual Axiom rows through the keyed span/trace mapping and exact start/duration;
  zero raw trace/span IDs or credential values appeared in the public response.
- Activation exposed native Workers `fetch` rejecting the collector as its
  receiver. Calling the transport as a standalone function changed the deployed
  path from disconnected to live. The same receiver fix covers the optional
  exporter, but that disabled export path has no live ingestion claim.
- Fixed query compiled against real production rows through authorized Axiom MCP:
  https://app.axiom.co/bagel-w3ue/query?qid=fR3cEBDmw9T-to6be1
  This earlier MCP receipt proves schema compatibility; the activated public
  Worker query and rendered live response now independently prove its runtime path.
- Local tests cover positive disclosure canaries, opaque topology, malformed and
  missing ancestry, partial/truncated parsing, single-flight/backoff/stale retention,
  byte/deadline limits and bounded exporter parent/outcome/failure behavior.
- Local rendered checks cover desktop/narrow empty/demo, live fixture,
  disconnect/reconnect, filters, selection and keyboard operation. Fixtures are
  browser-local only, never supplied as production telemetry.
- Browser interaction spans and cross-boundary browser-to-edge carriers are not
  implemented. Static asset/rejection paths rely on Cloudflare platform telemetry,
  not custom Axiom spans. Shared-query callers do not all acquire causal links.
  Visitor disconnect signal is forwarded but actual network-disconnect export
  proof is not established. Optional edge ingest binding remains disabled; no live
  edge Axiom ingestion claim. See [observability](observability.md) for other gaps.
- The earlier graphite continuous-stage finish review approved local
  desktop/narrow captures. Browser checks cover keyed updates/removals, mode isolation, reconnect instance
  retention, pin/follow, stale-clock freezing and mobile internal scrolling.
  Interactive rows have eight-pixel gaps. lintapple checks initial/settings/demo/
  details at both widths; four contrast checks remain unresolved on partially
  clipped recent-trace carousel entries. No measured contrast failure remains,
  but this is not a zero-findings claim. These lint limits remain distinct from
  the inspected production desktop/narrow rendering and interaction checks.
- The AMOLED horizon redesign (client-only: `public/` plus a self-hosted OFL
  Geist Mono) keeps the stream state machine, labels and wire contract
  unchanged. It adds a canvas horizon of every retained span by start time and
  service, a tree waterfall from declared parents, and an operation inspector.
  Local checks used a proxy of the public production stream; active/provisional
  states were checked only with a local synthetic fixture, not production.
  lintapple (initial, paused, pinned, inspector, controls at 390/1440) leaves
  only unresolved contrast measurements over canvas/scroll-clipped cards,
  intentional card-name truncation and a pure-black root false positive. An
  independent design review and code review were addressed. Reduced motion
  runs no CSS animations and no canvas loop. This is not a zero-findings claim
  or production visual acceptance of the redesign.

### AMOLED production acceptance — 2026-11-08

The client source at `6f7af2b8dc67073caaa7ee14885c51d06e6d524f` is deployed
as Worker version `a8886a46-7346-4f2c-882b-2df4655fe066`, receipt
`30d16a7a-2eb2-40aa-8e25-ebc940f7341f`. Independent HTTPS readback matched
the shipped HTML, CSS, JavaScript and Geist Mono bytes. The protected owner
retained the existing domain, Durable Object namespace and query/live/HMAC
bindings; this acceptance did not mutate deployment state.

[Production acceptance evidence](https://ampcode.com/threads/T-01a1bacf-7aa6-7595-8e97-fcf08e05c4c6)
includes inspected desktop (1440px, 2×), Chromium Pixel 7 touch-emulation
captures (coarse pointer verified, not a physical phone), open controls,
inspector, paused and reduced-motion states, and a real-pointer interaction
recording against production, not a fixture or local proxy. Executed checks
covered service filtering/reset, pause/resume reconnect, trace pin/release,
touch selection of a rendered horizon mark, declared-relationship navigation,
inspector dismissal, Escape restoring operation-row focus and Home/End/arrow
navigation. Both widths had zero page-level horizontal overflow; the touch
run reported no page errors. Bounded tree scrolling and missing relationships
remained visible rather than claiming a complete trace.

A separate passive 30-second production SSE read received one snapshot,
74 deltas and 74 statuses, including 97 active observations and 49 observed
active-to-ended transitions. Every observed span field belonged to the positive
timing/topology schema. This corroborates real lifecycle traffic, not a claim
that every transition appears in the interaction recording or that all runtime
paths are instrumented. Stale-clock failure cases retain the earlier synthetic
coverage and source review; no production outage was induced for this check.

lintapple 0.1.20 was rerun at 390/1440px on paused production snapshots and
open controls (pausing avoids its accessibility scan racing live DOM updates).
It still exits nonzero: unresolved contrast over SVG/scroll-clipped content,
intentional operation-label truncation, a pure-black root-background false
positive, and a clipped carousel entry classified as an unlabeled icon button.
These are not a clean automated accessibility bill of health. The inspected
layout and keyboard/touch checks are separate evidence. Read-only review found
no blocking acceptance defect; it did identify a narrow remaining limitation:
an inspector relationship button can lose keyboard focus when an updated span
causes its detail subtree to be replaced. Close/Escape row-focus restoration
passed, but continuous relationship-button focus is not claimed.
