# Axiom observability

Computah exports every emitted trace, without sampling, from the instrumented
backend, Slack and bus entry points when `COMPUTAH_AXIOM_INGEST_TOKEN` is present.
This is operational tracing, not a copy of user histories. No automatic
DEBUGSHARE collection, diagnostics bundles or diagnostic-agent spawning is added.
Separately, the owner-authorized opt-in [private content log lane](logging.md#authorized-private-content-records)
exports bounded actual normal-operation input/replies, model inputs/outputs and
available tool/activity evidence into `computah-prod-logs`. It does not broaden
trace attributes or the public observatory projection. Source/local proof,
protected-host activation and independently queried ingestion are separate states.

## Collection boundaries

- Node OpenTelemetry records HTTP request lifetime/status, existing Effect gateway
  spans, explicit injected-model call lifetimes, safe provider tier/outcome events,
  and ready/stopped/report events.
- Backend lifecycle boundaries record model initialization, native registry
  readiness, HTTP listen and HTTP/registry/client drain with fixed phase/outcome
  categories and elapsed milliseconds. These also emit content-free local log
  markers when export is disabled. They distinguish time inside registry startup
  from model initialization; they do not instrument native startup internals or
  establish the cause of a slow phase. Bootstrap logs begin after static imports.
- The native Rivet exporter records actor invocations. Pi's existing OTel adapter
  records submission admission, task phases, tool/delegation activity, compaction,
  checkpoints/replays and model calls on its default model runtime. The injected
  real model runtime needs the explicit wrapper because Pi bypasses its default
  model-tracing wrapper when `models` is supplied.
- Slack records admitted event/ACK lifetime, delivery-loop steps, core requests,
  Web API operations and lifecycle/report categories. Bodies never enter spans.
  The Slack formatting regression check exercises the production executable with
  synthetic Socket/core/Web API boundaries: JSON-decoded multiline mrkdwn reaches
  dispatch and successful `slack.api` spans retain their `slack.delivery` parent
  through the intercepted sanitized Axiom export, without answer text. Existing
  failed-send/cancel/retry/reopen tests cover the same delivery lane. This proves
  local export, not deployed formatting, Slack-client rendering, real-model
  adherence or live Axiom ingestion of the formatting change. No formatting-only
  spans or competing exporter are added; see [presentation parity](slack.md#presentation-parity-checklist-2026-11-08).
  The same retry/cancel/reopen export check now prepares actual Slack source
  attribution in the core input and verifies its author/channel canaries stay out
  of sanitized exports. Speaker IDs and receipt timestamps are model context,
  never trace or generic runtime-log attributes. Explicitly enabled private
  content records may carry them. Attribution preserves the existing admission and
  submit spans rather than introducing per-field spans; live model use of the
  metadata and production adoption remain separate acceptance gaps.
  Rich presentation and stop/progress reuse these same bounded lanes: long-answer
  executable checks preserve delivery→API parentage, while actual SSE phase and
  core cancellation checks cover `slack.status`/`slack.wait`→`slack.core` with
  typed confirmed, denied and unknown outcomes and linked structured logs.
  Model text, envelopes and worker labels stay out of these sanitized exports.
  Retry/reopen and ambiguous sends retain their existing reconciliation rules.
  These are intercepted local exports, not proof of live revision-specific
  Axiom ingestion, real Slack rendering or one unified Slack→native Task tree.
  Native phase-card checks exercise executable DM/channel start/append/stop with
  trusted recipients and isolated channel credentials. They verify status→API
  parentage, linked logs and explicit error/denial attributes, including uncertain
  sends and bounded terminal cleanup. Closing a Slack display is not core
  cancellation. Real-client card rendering and revision-specific live ingestion
  remain unverified; no extra telemetry exporter or answer-text stream is added.
  The separate causal-admission follow-up is in publication checks: new durable
  Slack job carriers become actual children of receive, not independent roots
  joined only by a link. The original carrier persists through duplicate/burst
  admission, retry/reopen, phases, outgoing HTTP and delivery; additional receives
  remain links and legacy NULL carriers remain independent roots. Local graph
  regressions exercise these boundaries, actual wire-header ancestry and linked
  error logs while retaining private-content gate assertions. This bounded Slack
  graph proof is not proof of the complete native Task graph or live Axiom tree.
- Slack core requests propagate only W3C traceparent IDs to the configured core;
  backend/bus HTTP ingress accepts strict valid v00 carriers, never baggage or
  tracestate. Invalid/zero/duplicate carriers start new roots. Correlation never
  grants identity or authorization, and upstream sampling flags cannot suppress
  the always-on exporter.
- Tavily search/extract spans cover authorization, validation, transport, body
  consumption and awaited cleanup, with fixed ready/failure/timeout/cancel outcome
  categories and conservative request-state labels. No query, URL, credential or
  result content enters spans, and no trace headers go to external providers.
- Native Axiom MCP discovery/read spans cover authorization, initialization,
  list/call and session close, including denial, provider errors, timeout and
  cancellation. Only categorical outcomes export, never APL, schemas, results,
  PATs or organization headers. Local sanitized-export tests verify parentage;
  live native MCP queries remain blocked on private restricted-member credentials.
- The backend private Slack timing client records `computah.slack.timing` under
  the native Pi tool carrier, covering grants, bounded UDS I/O, cancellation and
  final authorization. Resolved denials/failures are not successful spans/logs.
  Receipt IDs, bindings, timestamps and broker credentials are not telemetry
  attributes. Local sanitized-export tests cover success/denial/error/cancel and
  timeout, plus parent continuity; they do not prove live ingestion. The broker
  receipt carrier remains data, never authority to broaden Axiom trace queries.
  The causal UDS update forwards current client trace headers, admits only strict
  W3C `traceparent` through broker HTTP tracing and parents `slack.timing` under
  that request. Baggage and `tracestate` are not accepted; correlation cannot
  grant broker access or select a DB/root. This source update is undergoing
  publication/validation, not deployed cross-process continuity proof. The
  separate credential, frozen scope and final authorization remain mandatory.
- The separate bus entry point records HTTP, native actor spans and lifecycle.
  It remains dispatch-disabled and does not mount backend/provider credentials.
  Provision only its Axiom credential, not the backend's provider env file.

All JS and native Rust traces go through one process-local, loopback-only OTLP
HTTP/JSON relay before Axiom. The relay rebuilds the payload from a positive
schema, retaining trace/span IDs, parent/link relationships, timestamps, kind,
status codes and explicitly allowed scalar/category attributes. Raw actor keys,
tenant/user/principal IDs, conversation/task IDs, personal identifiers, URLs,
headers, prompts, reasoning, email/Slack text, tool arguments/results, exception
messages/stacks, baggage and original resource attributes are not forwarded.
Unknown span/event names become `runtime.operation`; the span is not sampled out.
Registered code-owned names can be added to the allowlist as needed.

The workspace pins one compatible OTel API minor. A newer API used by Pi than the
one registering the global SDK silently produces no Pi spans. The native tracing
regression test exercises actual Interaction → Task → Worker activity to detect
that failure, rather than just sending an artificial OTLP payload.

Export is best-effort, not a durable audit log: Node buffers at most 4096 spans,
exports batches of at most 256, and the relay permits eight concurrent requests
of at most 2 MiB with a five-second Axiom deadline. Native Rivet uses its own SDK
buffer. Overload, process crashes or sustained destination failure can lose spans.
Shutdown drains native runtime telemetry before the Node exporter and relay.
Export failures log categories only and do not fail application work. No history
backfill is performed and no model call is needed for ingestion verification.

## What this does not measure

This does not automatically instrument every function, socket frame, SQL
statement or external library. It exports all spans those configured runtimes
emit and adds the explicit boundaries above. Raw stdout/SDK logs are not shipped:
they can contain private actor keys and content. Structured OTLP logs use the
separate [bounded positive-schema pipeline](logging.md); host metrics and the
[analytics](analytics.md) rollup hooks are separate work. Per-call SDK token scalars, where available, are
`sdk_unverified`; native default model spans can also contain SDK usage scalars.
SDK defaults/zeros are not proof of actual provider usage. Missing counters remain
missing, not fabricated zeros. Provider-returned tiers are distinct from requested
priority. Cost attributes are excluded: SDK pricing-derived cost is not an invoice
or proof that priority was served.

## Private content coverage

Source implements explicitly enabled private `content.record` logs, not content
trace attributes. Local intercepted Axiom export tests cover admitted message
search, final text, native tool arguments/results, actual model input/output,
scope/participant identity, existing trace context, typed failure/cancellation,
credential/hidden-thinking exclusion, truncation, overload and public projection.
This source/local proof is not protected-host activation or live content ingestion.

- Core fresh committed admissions capture trusted scope/resource, request and
  submission IDs, actual input and already-available frozen source evidence.
  Duplicate/conflicting admissions do not intentionally emit new input records.
- Normal Worker dispatch and gateway result retrieval capture visible final text;
  repeated result retrieval may repeat it. No extra history read is made for logs.
- Native ToolTask before/after hooks capture actual call IDs/names/arguments,
  available output/details/diagnostics, typed error flags and trusted scope when
  readable. Generation afterResponse captures visible activity. Native hook replay
  and abort-handler limits remain; intermediate progress is not captured.
- The existing priority Models wrapper captures all four normal stream/complete
  methods, latest 64 input messages (newest first), at most 128 blocks per message,
  64 tool declarations, visible terminal output and available SDK token usage.
  Source limits/missing data are explicit. Deferred methods are not newly covered.
  Image bytes, hidden thinking and signatures are excluded. The pinned provider
  exposes no distinct supported reasoning-summary field; none is fabricated.
- Slack captures accepted new receipt text plus prepared text, participant and
  real source/reply locations; frozen prepared submits and final delivery attempts
  have linked job identity. Attempt text is not proof of send; successful delivery
  has a separate activity row and ambiguous sends retain existing error outcomes.
  No additional Slack lookup, history export or unsolicited message is performed.

The public observatory still queries only `computah-prod-traces` and reconstructs
its closed timing/topology schema; private content/identity canaries are rejected
even when injected into query rows or failures. This is local disclosure-boundary
proof, not a certification of deployed token grants. Dataset metadata currently
reports no explicit dataset retention period (`retentionDays: 0`,
`useRetentionPeriod: false`); effective organization/plan retention is unknown.
Do not interpret those values as zero-day or unlimited retention. The exact
last-deployed public Worker query credential returned HTTP 200 for count-only
queries on both traces and logs: it is not log-isolated. Private content activation
is held until a separate trace-only Worker credential is installed and verified
with positive trace access and log permission denial. No grants/retention are
changed by runtime capture, and no universal "all data" or durable audit claim is made.

## Runtime coverage ledger

Shared durable APIs now support independent admission roots:
`createTraceCarrier(operation, links?)` creates a root marker or valid random
IDs when telemetry is disabled; persist that carrier exactly once at admission.
`withTraceContext(carrier, body)` restores strict v00 IDs for synchronous or
asynchronous work, including disabled-export operation; it never restores baggage.
`traceOperation(operation, body, parent?, links?)` uses ambient context only when
parent is omitted, `{}` forces a root, and up to 32 validated causal links survive.
`traceInterval(operation, startEpochMs, endEpochMs, parent, attributes?)` records
actual persisted queue boundaries, including epoch zero, and rejects reversed or
nonfinite intervals. These helpers are not evidence every queue has adopted them.

The shared bootstrap also starts [structured logs](logging.md); HTTP, operation,
stream-model and lifecycle outcomes carry the active trace ID. Closing the logger
before the trace provider preserves export-span drain. A synthetic logger record
was independently queried in `computah-prod-logs` (`34b0edb9-3906-4e43-a564-60f6749a701b`);
that synthetic record alone is not production-token or deployed-collection proof.

Slack production bootstrap at `330af03` is independently verified in both datasets:
`runtime.ready` log `e2e41142-b7ce-42a9-8574-b3b5a04be127` at
`2026-11-08T08:00:41.485Z` has trace `3c56338da1772609e252f8fe6d40605c`,
span `6340018f998c33cf` and the exact same service revision as the
`computah.ready` span ([log](https://app.axiom.co/bagel-w3ue/query?qid=LsmjB4THKhd-to6bzy),
[trace](https://app.axiom.co/bagel-w3ue/query?qid=9uTK6q1jA6x-to6c06)).
This proves Slack's protected runtime credential can ingest logs, not that every
Slack job path is covered. Bus `330af03` is independently verified too:
`runtime.ready` log `e2c9c741-b21d-48a9-a872-827e4681f491` matches trace
`158b910de3015f72bcc6fc94f86cd34f`/span `dcb9593f4fd26080` and the same revision
([log](https://app.axiom.co/bagel-w3ue/query?qid=5xCrgWQLK41-to6c51),
[trace](https://app.axiom.co/bagel-w3ue/query?qid=BzZZMDJtWT7-to6c52)).
These lifecycle receipts do not prove later per-receipt causal instrumentation
is deployed. Backend candidate `330af03` failed registry startup because its native
4 GiB log shard exceeded available disk space; the identical isolated candidate
passed startup, submission/result and graceful stop after scoped disk-headroom
cleanup. No exporter regression was established, and actual backend adoption
requires its own consumed-revision/query evidence.

Tavily production trace ingestion at revision `99962a5` is verified by a bounded
native-adapter run: trace `882ac53cf7d80de89b7e4dc9840a67d1` contains native
`pi.tool` web search/extract parents and ready `computah.web.search/extract`
children ([query](https://app.axiom.co/bagel-w3ue/query?qid=17kuj79bwqv-to6au0)).
Separate log ingestion and complete Task admission linkage remain unproved.

Operations production acceptance at `fb8e297` independently verified trace
`3c1b1db98f760895740d1b8ea88cd8a7`: timing span `8a9059bf2e1b89d6`
has query child `78ae6069d5059800`, both ready/count 14, with exact paired
`operation.completed` logs and revision
([spans](https://app.axiom.co/bagel-w3ue/query?qid=iUIVvzbwA6m-to6fb2),
[logs](https://app.axiom.co/bagel-w3ue/query?qid=omJiyVdbe1F-to6fb5)).
This is exercised tool/query parentage, not native admission/ingress/delivery
continuity or private-content acceptance.

The AGENTS.md rule requires instrumented runtime changes; this ledger records
known debt, not permission to silently extend it. Static schemas, assets, fixtures
and pure transformations do not need meaningless per-byte spans. The unit of
coverage is an executable operation and its observable outcome/linkage.

| Runtime surface                    | Actual coverage                                                                                                                                                                                                                                                                                                 | Remaining proof/work                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend HTTP → gateway → Rivet RPC | Request lifetime/status and Effect operations; active RPC context propagates                                                                                                                                                                                                                                    | Abort/disconnect/reconnect and every route's failures are not exhaustively traced/tested                                                                                                              |
| Interaction → Task → Worker        | Native Pi phases and Rivet actions export, including native error/replay events                                                                                                                                                                                                                                 | Custom `admit` uses `BACKGROUND_CONTEXT`; Pi creates a new root with no caller link at each admission. Presence is not continuity; sleep/restart linkage remains unproved                             |
| Slack → backend                    | `d517ae6`: persisted independent job roots across ACK/retry/reopen, actual receive/admit/dequeue timestamps, queue intervals and phase attempts, DEBUGSHARE capture association, startup/finally flush; real sanitized relay tests                                                                              | Latest job/capture instrumentation runtime adoption and exact Axiom UUID receipts pending; legacy rows remain null; bootstrap both-signal proof at `330af03` is not full-job proof                    |
| Tavily                             | Full service typed outcomes/cleanup; production native-adapter tool trace verified at `99962a5`                                                                                                                                                                                                                 | Separate structured-log ingestion and full Task admission linkage remain unproved; no automatic retries exist                                                                                         |
| Standalone bus                     | `1f119b1` full pump/stream/replay lifetimes; `1e1c840` persisted receipt roots, append/dispatch parents and pump links, private durable timing, sanitized trace/log regression                                                                                                                                  | Dispatch disabled; replay remains HTTP-parented, not falsely receipt-linked. Forced socket/backpressure permutations not exhaustive; latest causal source adoption/query proof pending                |
| Dashboard                          | `c9335bc` shared BFF bootstrap/HTTP/core spans and logs, operator.history on actual existing-only actor reads, fixed-upstream IDs; local actor-backed browser proof                                                                                                                                             | Production consumed-revision/trace/log receipts and browser lifecycle telemetry remain separate; local smoke-provider evidence is not live-model proof                                                |
| Native product                     | `a989f45` shared Node IPC/core/process/materialization/recovery spans/logs through polling/cancel and drain; trusted-core IDs, no embedded ingest key                                                                                                                                                           | Remote production receipts pending; Rust GPU/input/IME and pre-Node startup intervals uninstrumented; optional protected-host config is not client relay provisioning                                 |
| Rune/Pi experiment                 | `76f7751`: bounded local bridge start/spawn, prompt/cancel enqueue, attempt/failure, materialized render and pipe/reap records; same-session local correlation verified                                                                                                                                         | No remote authenticated client relay/Axiom export/query proof; UI, storage, tool and full relaunch lifetimes remain incomplete; no server ingest credential embedded                                  |
| Native Worker files                | `d5034c7` explicit Pi child spans and linked operation logs for grant-scoped read/write/edit, no paths/content/host shell                                                                                                                                                                                       | Actual production tool trace/log query proof remains separate from local native regression                                                                                                            |
| Native living self-docs            | Fixed `computah.self_docs.discover/read` spans and linked logs; local real Pi Interaction/Worker sleep/reopen tests verify sanitized native-parent continuity and ready/error/cancel outcomes without doc text/paths                                                                                            | Built-image acceptance, enabled collection and live Axiom ingestion need separate receipts; abrupt-death recovery and Task-admission trace continuity remain unproved                                 |
| Operations discovery/timing        | Fixed `operations.discover/query/timing` spans and matching logs; native Pi caller parents, query/body-cleanup lifetime, explicit availability/denial/failure/cancel/timeout, returned-row counts; actual sanitized relay regression; `fb8e297` exercised timing→query parentage and exact paired logs verified | Native admission root join, absent ingress/delivery and exhaustive failure/cancel coverage remain gaps; five discovery spans include internal/nested work, not five user calls; see [tools](tools.md) |
| Sentinel                           | `3ecef7e` stored-carrier review/enforce/cancel metadata spans and native preflight/cancellation/replay tests                                                                                                                                                                                                    | Enabled-host ingestion, real review quality, provider refresh, publication buffering and external-effect protection remain unproved or unimplemented                                                  |
| Gmail/analytics                    | Shared fixed Gmail names; analytics now wires bounded private projection, outer priority-preserving model observer, native task/usage watches and gateway/Task timings to the shared LOGS-only sink                                                                                                             | Gmail wiring, full native admission join and revision-matched live analytics proof remain separate; no MeterProvider, invoice truth or complete task census; see [analytics](analytics.md)            |
| Public observatory                 | `b3a507e` bounded positive-schema Worker HTTP/poll emitter; `480a953` fixes native fetch; owner-verified production query/render and 1000-row keyed correlation, documented in [observatory](public-observatory.md)                                                                                             | Optional edge ingest remains disabled/unproved; static/rejection paths use platform telemetry; browser interaction and actual visitor-disconnect export remain gaps                                   |
| Deployment/setup/quality scripts   | Checks/logs, not application trace export                                                                                                                                                                                                                                                                       | Separate operational tracing policy; no host/process/SQL/socket/metrics/log pipeline coverage claim                                                                                                   |

### Causal admission source update

The ledger's earlier independent native-admission and bus receipt roots are
superseded in source by explicit causal parenting. The pinned Pi Durable patch
adds host-only `SubmissionDraft.trace`; gateway/Task RPCs opt in without private
vendor imports, transaction changes or request cancellation inheritance. Native
admission/task carriers remain the recovery source of truth. Task intent freezes
its original invocation carrier; retries never reparent an existing submission.
Independent requests retain their own contexts, while coalesced inputs use the
first admission as parent and additional admissions as links.

New bus receipts atomically persist the actual admission span carrier; append and
dispatch restore it across retry/restart, while batch pumps remain independent
and linked. The UDS timing client now sends active traceparent and the broker
restores it for HTTP/lookup work; receipt IDs and trace IDs never grant authority.
`createTraceCarrier(operation, links, parent?)` remains independent by default,
with an explicit-parent same-trace child and SDK-off ID fallback. No timestamps
or exported parents are rewritten and no spans are invented across downtime.

Installed-package tests cover default/opt-in parenting, rollback, dedup, queued
cancellation, busy follow-ups and fresh-storage recovery. Sanitized actual HTTP →
Interaction discovery → Task → Worker discovery → final answer ancestry and
matching outcome logs provide local proof, not a production Slack/Axiom receipt.
Existing discover/search tools retain fixed actual identities; Pi's deferred
`tool_search` is not installed or added merely to produce no-match evidence.
A complete repository-wide claim is **not established**. Export remains bounded
best-effort: no sampling does not mean no loss or all paths instrumented.

## Provisioning and secrets

The [official Alchemy guide](https://alchemy.run/axiom/) informed the independent
`deploy/axiom.run.ts` stack, separate from serving-container reconciliation.
`deploy/setup-axiom.ts` keeps state under `~/.local/state/computah-axiom`, rejects
plans containing replacements/deletions/orphans, and marks the dataset retained.
Never rename a live dataset or change its kind to fix a setup error. Dataset
management requires additional permissions beyond ingest/query.

Axiom's current official API/MCP docs specify **Events** (`axiom:events:v1`) for
OTLP traces, despite Alchemy's example using `otel:traces:v1`. The existing
`computah-prod-traces` dataset was provisioned through the authorized Axiom MCP
connector. Normal OTLP ingestion uses `/v1/traces` with `X-Axiom-Dataset`.

The owner's `AXIOM_TOKEN` lives in Amp project secret storage. It successfully
lists/reads datasets and ingests traces, but dataset creation and token management
returned 403. The setup therefore reuses that authorized token; it is **not** a
newly minted least-privilege ingest-only credential. The optional Alchemy
management apply remains permission-gated; it has not successfully reconciled
this MCP-created dataset. Narrower token provisioning needs Axiom token-management
authority, not another copy of the same credential in chat.

Runtime reads only `COMPUTAH_AXIOM_INGEST_TOKEN`; an ambient management token does
not enable collection. The deployment owner must securely map the injected
project credential into that variable in `/etc/computah/provider.env` under
the deployment lock, preserving all other entries and root-only mode. Normal
Actions/Alchemy replacement then consumes it. Slack and bus use their own
protected env files and independent release mechanisms; source publication
alone does not activate either service. Never transfer credentials in messages,
artifacts, Git, build arguments or logs. No account-setting CLI workaround is
permitted when the orb's credentials cannot write secrets.

## Verified status

- **Native Axiom OAuth verified on host, 2026-11-08 08:43 UTC:** the isolated
  native consumer discovered all three read schemas, listed both Computah
  datasets and read their fields. Count-only queries over the fixed five-minute
  UTC window 08:38:17–08:43:17 returned 699 traces and 230 logs. Expiry-aware
  refresh changed both tokens and saved future expiry via atomic file replacement,
  retaining owner-only mode. This is actual native consumer acceptance, not an
  ingress grant or serving-container activation receipt.
  The server consumes an explicitly mounted private SDK state file and refreshes
  before saved expiry or on 401 through the bounded transport. `axiom.refresh` and
  `axiom.persist` spans link to the initiating discovery/call; local checks cover
  refresh success/failure/cancellation, cancelled shared-refresh waiters and
  recovery from a failed state save. No credential bytes enter telemetry.
  Owner approval/code exchange succeeded on 2026-11-08; serving activation and
  production refresh-span ingestion remain separate acceptance.
  Atomic rename protects process replacement, not a claim of power-loss durability.
- **Live dataset and synthetic ingestion verified, 2026-11-08 06:59 UTC:** Axiom
  accepted a harmless `computah.synthetic` trace with HTTP 200. The connected MCP
  returned exact trace `cdaef19880af286c1508dc3c4f89e95f` and span
  `c43afdfd5a5586c7` from `computah-prod-traces`.
  [Saved Axiom query](https://app.axiom.co/bagel-w3ue/query?qid=9HmXbtdYWUO-to68qv).
- **Actual exporter → Axiom verified, 2026-11-08 07:07 UTC:** the local Node
  exporter and privacy relay sent `computah.synthetic`, service
  `computah-backend`, trace `69814343a1d8cf835b97c24213ad6a74`. The MCP query
  returned that exact row, not merely an HTTP acknowledgement.
  [Exporter ingestion query](https://app.axiom.co/bagel-w3ue/query?qid=J1LeADMb449-to6958).
  This was a local synthetic emitter, not the production service.
- **Local actual runtime verified:** synthetic Interaction/Worker execution
  exports Pi phases, Rivet actor actions and Effect spans through the privacy
  relay; private-content/identity canaries are absent. Relay tests exercise SDK,
  HTTP and Effect spans, parentage, redaction and destination failure.
- **Production collection not yet verified:** the existing nest-bagel operator
  thread does not receive the saved project secret in its shell. No runtime token
  was written and no service was restarted to bypass normal deployment. Secure
  runner injection/private local bootstrap is the remaining activation gate.

Axiom queries can correlate these content-free trace IDs across operational
boundaries. Native private diagnostics still provide details deliberately absent
from Axiom. DEBUGSHARE remains identifier-only and separately authorized; an
Axiom query is not permission to export a private diagnostic history.

The separate [public observatory](public-observatory.md) uses a second positive
projection and opaque IDs, not DEBUGSHARE content or a public query proxy. Its
edge exporter is isolated from the Node bootstrap and explicitly credential-gated.
Public Worker query and production render acceptance are verified after private
query-token provisioning. Optional edge-ingest acceptance, browser interaction
export, static/rejection Axiom coverage and real visitor disconnect proof remain
gaps; public query activation does not establish complete telemetry coverage.

## Gmail runtime boundary

The Gmail runtime uses the existing fixed `gmail.bind/sync/import/drain/authority/retrieval`
operations and automatic bounded `operation.completed` logs. Each new durable receipt
stores one fresh root carrier linked to the admitting operation. Retry/reopen drains
restore that carrier and link the current pump, without exporting mailbox identity,
source text, account handles or credentials. Existing pre-carrier receipts drain as
new roots. Source admission explicitly passes its drain carrier through the
patched native admission RPC independently of `BACKGROUND_CONTEXT` cancellation
ownership. Gmail receipt roots remain independent of ingress; Gmail-specific
end-to-end ancestry is not claimed here. Atomic admission/dedup and private grant
lineage stay intact.
Live Axiom ingestion of the deployed Gmail path remains a separate acceptance check.
