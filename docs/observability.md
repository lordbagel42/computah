# Axiom observability

DEBUGSHARE correlation accepts exact `computah_bug_[a-z0-9]{24}` IDs and legacy
lowercase UUIDv4 IDs through the shared bounded validator. Only this opaque key
passes the capture attribute allowlist; issue bodies do not. The public
observatory still excludes all attributes and remaps trace/span identities.
Local sanitized-export checks are separate from host adoption and live Axiom
ingestion of new-format IDs; no old evidence or stored IDs are rewritten.

Computah exports every emitted trace, without sampling, from the instrumented
backend, Slack and bus entry points when `COMPUTAH_AXIOM_INGEST_TOKEN` is present.
This is operational tracing, not a copy of user histories. No automatic
DEBUGSHARE collection, diagnostics bundles or diagnostic-agent spawning is added.
Separately, the owner-authorized opt-in [private content log lane](logging.md#authorized-private-content-records)
exports bounded actual normal-operation input/replies, model inputs/outputs and
available tool/activity evidence into `computah-prod-logs`. The same explicit
opt-in now permits bounded OTel GenAI messages on private model spans, as described
below; it never broadens the public observatory projection. Source/local proof,
protected-host activation and independently queried ingestion are separate states.

## Native Axiom conversations

The injected Models wrapper enriches its existing stream/complete spans (including
Sentinel calls through that wrapper) with `gen_ai.operation.name=chat`, the actual
catalog provider (`openai-codex`), requested model, capability/step and available
SDK response model/token usage. These remain the original parented operations,
not a second synthetic conversation trace. SDK usage remains `sdk_unverified`.

[Axiom's manual instrumentation contract](https://axiom.co/docs/use-cases/llm-observability/manual-instrumentation)
identifies chat spans by `gen_ai.operation.name`, not their display names. With
`COMPUTAH_AXIOM_CONTENT_ENABLED=1`, input/output messages use its OTel JSON-string
array schema: `role`, `parts`, text `content`, `tool_call` with actual ID/name/
arguments, and `tool_call_response` with matching ID/response. System messages,
visible assistant text and tool exchanges are retained; images and hidden thinking
are excluded. The shared credential scrubber and 32-KiB content budget apply,
prioritizing recent messages (at most 64) and restoring chronological order.
Malformed/truncated message envelopes and unknown part types are omitted. Existing
private content logs retain their separate source truncation/missing evidence.

The OTLP relay revalidates these two message attributes only under the same
private opt-in; default and observatory-service exports strip them. Public settled
queries and live timing projection still select no attributes/content. The trace
dataset is now explicitly private content when opted in: never grant public
clients unrestricted access to it. No credential, hidden reasoning, public content
export, unsolicited model call or history backfill is introduced. Failed/cancelled
calls keep their existing outcomes and emit no fabricated output when none exists.

Local intercepted Axiom-export tests exercise all four Models methods, async
parent continuity, native message schema, credentials/hidden-block exclusion,
failure/cancellation and opt-out/public-service stripping. Source/local proof is
not protected-host adoption or native Conversation UI acceptance. The historical
`06274a339b809d7f7d2569c13c5fb5b5` trace was exported without operation/provider/
message attributes and is not rewritten; newly ingested genuine work is required
for live acceptance.

## Native reply metrics

Slack's shared bootstrap owns a private OTel `MeterProvider` and periodic reader,
separate from the LOGS-only `runtimeMetric`/`analytics.sample` route. Enable with
the existing protected `COMPUTAH_AXIOM_INGEST_TOKEN` and
`COMPUTAH_AXIOM_METRIC_DATASET=computah-prod-metrics`. This dedicated dataset is
`otel:metrics:v1`, provisioned in US east through the authorized Axiom connector,
inheriting organization retention. Existing logs/traces datasets, credentials
and retention are unchanged. No additional host metrics or backend analytics
instruments are enabled by this slice.

| Instrument                      | OTel/Axiom type                               | Meaning                                                                                                                                         |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `computah.slack.reply.latency`  | Histogram, delta, ms                          | First durable receive → actual awaited successful assistant-answer post, once per receipt (including coalesced inputs with distinct clocks)     |
| `computah.slack.reply.pending`  | Observable Gauge, replies                     | Fresh SQLite count of pending/answer-qualified receipts without a terminal metric outcome, every ten seconds, even idle or blocked in core/post |
| `computah.slack.reply.outcomes` | Observable monotonic Sum, cumulative, replies | Durable receipt totals with exactly four `outcome` values: `success`, `error`, `cancel`, `uncertain`                                            |

Only successful actual answer confirmation enters the histogram; progress,
commands, diagnostic/error posts, cancellation and ambiguous sends do not.
`error` includes denial, empty answer and the adapter's terminal wait timeout,
not every retried transport failure. `cancel` requires observed cancellation or
local withdrawal, not merely a cancellation request. Ambiguous posting/recovered
posting is `uncertain`, never success and never blindly resent. It leaves the
metric pending cohort, but the separate unanswered/overdue log diagnostic is
preserved. Shutdown alone does not invent cancellation. Existing terminal receipt
history is not backfilled; still-unresolved durable receipts join the current
census/recovery. Four-row cumulative totals and their epoch survive receipt
pruning and restart, without replaying increments or exporting receipt IDs.

Histogram boundaries are equal-width 5,000ms steps through 300,000ms, plus the
required +Inf overflow bucket: 61 buckets, below Axiom's 256-point-bucket limit.
Min/max/sum are included: Axiom can ingest an incomplete histogram with a warning
but rejects percentile interpolation without min/max. Exponential histograms are
unsupported. Delta temporality makes the first real reply batch queryable without
a fabricated zero observation. Axiom quantiles interpolate within buckets; they
are estimates, not exact raw reply percentiles. Query with
`interpolate_delta_histogram(...)`, not cumulative conversion or an unfiltered
sum across bucket/count/sum/min/max components.

The package-owned exporter reconstructs the positive OTLP schema from SDK
aggregates. It forwards only the three fixed instrument names, fixed
`service.name=computah-slack`, fixed scope, scalar measurements and the outcome
enum. No message/actor/task IDs, pseudonyms, histories, resources from ambient
configuration, arbitrary attributes or exemplars escape. SDK cardinality is
bounded to one histogram, one gauge and four outcome series (plus reserved SDK
overflow slots, not forwarded). Delivery is OTLP/HTTP JSON to the fixed US-east
`/v1/metrics`, with `x-axiom-metrics-dataset`, not `X-Axiom-Dataset`.

One export request at a time, at most 128KiB request/8KiB response, five-second
HTTP deadline, ten-second collection interval and no transport retry/backlog.
HTTP failures, malformed/oversized replies and OTLP partial rejection/warnings
produce sanitized error outcomes without failing Slack work. Collection failures
omit unknown gauge/counter points rather than inventing zero. `metrics.collect`
and `metrics.export` spans/logs use the shared sanitized traces/logs path; export
links to its collection, explicitly clearing SDK export tracing suppression.
Shutdown drains metrics before logs/traces. No sampling does not imply no loss:
histogram queue acceptance, its durable sent marker and remote ingestion are not
atomic; crashes or failed delta exports can lose samples, and crash/replay can
duplicate a sample. Cumulative outcome totals are not an exactly-once audit log.

Local tests exercise native periodic collection with an actual SQLite adapter,
idle/stalled gauges, asymmetric 5s bucket boundaries, duplicate/reopen outcomes,
uncertain sends, positive-schema rejection and linked export failure spans.
Local synthetic Axiom canaries are distinct from production process adoption and
real human receive→reply acceptance. Pre-adoption experimental
`computah.slack.reply.duration` data is retained unchanged; it mixes temporalities
and is not a production instrument. Production uses the delta-only `.latency`.

**Actual exporter → Axiom canary, 2026-11-08 10:23:40–10:24:26 UTC:**
the local synthetic Slack adapter used real ten-second OTel collection and the
actual remote exporter, with no real Slack/model request. Native metric discovery
returned `.latency` Histogram/Delta/ms, `.pending` Gauge and `.outcomes`
CounterMonotonic/Cumulative. Independent readback returned pending 0→2→2→0,
terminal totals success 2/error 1/cancel 1/uncertain 1 and one histogram with
count 2, sum 10,100ms, mean 5,050ms, p50 5,000ms and interpolated p99 5,098ms.
The raw bucket readback placed one sample at 5,000ms and one at 10,000ms; native
tag discovery contained only fixed scope/service/outcome and Axiom's histogram
tags. Complete min/max/sum exports returned HTTP 200 `{}` without ingest warnings.
The [independently queried sanitized traces](https://app.axiom.co/bagel-w3ue/query?qid=YYZIXTruj5x-to6if5)
contain five collection/export pairs with exact export→collection links. This is
real Axiom ingestion of a local synthetic emitter, not production process or
human conversation acceptance. The protected host separately authenticated an
empty batch and installed the opt-in environment variable without changing its
credential; only a consumed-revision and post-rollout query establish adoption.

**Production adoption and native ingestion, 2026-11-08 10:48:47–10:50:10 UTC:**
the protected host verified Slack actually consumed
[`e657c46`](https://github.com/lordbagel42/computah/commit/e657c460c53b7134cea60f9ed5448fa78d8e58f6),
with its existing ingest credential and the opt-in dataset configured. Independent
native MetricsDB discovery/readback confirmed all three production instrument
types above, pending 0→2→3→3→0 followed by repeated idle zero observations, and
success 3/error 0/cancel 0/uncertain 0. Naturally arriving work, not traffic
generated by the metrics or host checks, supplied three histogram observations:
count 3, sum 78,714ms, mean 26,238ms, interpolated p50 26,309ms and p99 26,643.18ms.
The [actual confirmed-reply log aggregate](https://app.axiom.co/bagel-w3ue/query?qid=lQXkn798UxC-to6jgk)
independently matched count/sum and min/max 25,968/26,650ms on that exact revision.
Native tag discovery still exposed only fixed service/scope/outcome and Axiom's
histogram tags. No message or actor identity is a metric dimension.

The [production completion logs](https://app.axiom.co/bagel-w3ue/query?qid=ykCdlMq35yK-to6jg3)
show eight successful collection/export pairs with that revision and no failures
in the bounded cohort; the [production trace receipt](https://app.axiom.co/bagel-w3ue/query?qid=NwUNzesh38F-to6jf9)
retains exact export→collection links for the first six pairs. These logs/traces
support lifecycle correlation; the native MetricsDB readback, not those logs,
proves metrics ingestion. Error/cancel/uncertain nonzero outcomes remain local
adapter and real-Axiom synthetic canary proof, not intentionally induced
production failures. This receipt does not claim whole-backend deployment success,
a fixed latency SLO or separate human presentation acceptance.

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
  Fixed acknowledgments for top-level sources skip phase observation that cannot
  produce a native source-thread card. Executable sanitized-export checks retain
  status→API ancestry without a core child there; threaded cards retain actual
  status→core/API checks. Fresh Gmail authority checks overlap only their two
  independent provider probes after account validation and await both even on
  failure, keeping work inside the existing authority operation lifetime. No
  verification result is cached and native generation/retry/release fences remain.
  These local checks are not post-change production latency acceptance.
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
  Fair immediate-snapshot polling retains these same per-job phase carriers;
  local sanitized-export checks interleave two receipts and verify separate
  receive→job→submit/wait/delivery ancestry and cancellation outcome logs.
  Typed cancelled/failed snapshots mark the wait phase and its structured log
  accordingly, not just the nested event. The durable service ordinal is not a
  timing measurement and does not rewrite admission/dequeue boundaries. These
  checks prove local scheduling/correlation, not deployed latency improvement
  or a five-second answer guarantee.
  Native phase-card checks exercise executable DM/channel start/append/stop with
  trusted recipients and isolated channel credentials. They verify status→API
  parentage, linked logs and explicit error/denial attributes, including uncertain
  sends and bounded terminal cleanup. Closing a Slack display is not core
  cancellation. Real-client card rendering and revision-specific live ingestion
  remain unverified; no extra telemetry exporter or answer-text stream is added.
  Published causal-admission source `65c460a` makes new durable Slack job carriers
  actual children of first receive, not independent roots joined only by a link.
  The original carrier persists through duplicate/burst
  admission, retry/reopen, phases, outgoing HTTP and delivery; additional receives
  remain links and legacy NULL carriers remain independent roots. Local graph
  regressions fail on the prior mismatched receive/job trace IDs and pass with
  exact parent relationships, actual wire-header ancestry and linked error logs,
  while retaining private-content gate assertions. This bounded Slack
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
  grant broker access or select a DB/root. Published source `b23930e` uses shared
  `traceHttp` as the sole HTTP completion logger; one-log-per-HTTP-span assertions
  cover the removed duplicate listener. Local graph checks are not deployed
  cross-process continuity proof. The separate credential, frozen scope and final
  authorization remain mandatory.
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
The only content exception is the explicitly opted-in private model-message
attributes above, scrubbed and rebuilt rather than blindly forwarded.
Unknown span/event names become `runtime.operation`; the span is not sampled out.
Registered code-owned names can be added to the allowlist as needed.

The workspace pins one compatible OTel API minor. A newer API used by Pi than the
one registering the global SDK silently produces no Pi spans. The native tracing
regression test exercises actual Interaction → Task → Worker activity to detect
that failure, rather than just sending an artificial OTLP payload.

Export is best-effort, not a durable audit log: Node buffers at most 4096 spans,
exports batches of at most 256 (private-content mode instead bounds the queue to
256 and batches to four to keep encoded messages below the relay cap), and the
relay permits eight concurrent requests of at most 2 MiB with a five-second Axiom
deadline. Native Rivet uses its own SDK buffer. Overload, process crashes or sustained destination failure can lose spans.
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

Source implements explicitly enabled private `content.record` logs and the bounded
native GenAI message attributes above. Local intercepted Axiom export tests cover admitted message
search, final text, native tool arguments/results, actual model input/output,
scope/participant identity, existing trace context, typed failure/cancellation,
credential/hidden-thinking exclusion, truncation, overload and public projection.
Protected-host activation and bounded live ingestion at `ab6567b` are independently
verified below; local tests alone do not establish those states.

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

### Deployed private-content acceptance

Backend and Slack consumed `ab6567b` before authorized activation. The backend
same-revision reapply completed at `2026-11-08T09:41:14.562Z`; Slack was ready at
`09:41:42.676631Z`. Both actual processes had content enabled before the single
harmless self-doc canary at `09:42:18.730917Z`–`09:42:43.062514Z`.

Independent private Axiom queries found ten `computah.content.v1` records:
incoming 1, final 1, model.input 2, model.output 2, tool.call 1, tool.result 1 and
activity 2 ([counts](https://app.axiom.co/bagel-w3ue/query?qid=oEgY2l7QG49-to6gc3)).
The literal `computah-private-content-20261108-canary` occurs in actual incoming
text, final content and terminal model output, not just incidental payload fields
([visible-content predicates](https://app.axiom.co/bagel-w3ue/query?qid=p8itlu28Mvy-to6geo)).
Incoming/final share a nonempty submission ID and transport trace
`d39c37d78ee8ea4146f972f4f6f440c7`
([submission match](https://app.axiom.co/bagel-w3ue/query?qid=DJj6zmpVDU8-to6ge1)).

The model's `self_docs_read` call and private tool.call/tool.result records share
one call ID; both tool records carry the same task/conversation IDs and native
span `158ea1bbfa32cfd5`, argument `id=self-docs`, and a parsed ready result
([tool grouping](https://app.axiom.co/bagel-w3ue/query?qid=raiLgNuyY93-to6gdz),
[model/tool match](https://app.axiom.co/bagel-w3ue/query?qid=Kw7NRsp5dUt-to6gf5)).
Runtime trace `468fb53332d1ce3a38e046997e2bc0e8` has an actual ready
`self_docs.read` child `0f77ed257e553a8d` under that native tool span
([native child](https://app.axiom.co/bagel-w3ue/query?qid=BSjH6x9dItD-to6ge2)).
Tool records lack submission ID and there is no direct edge joining this runtime
root to the transport root in this receipt; later causal source cannot
retroactively create that edge.

All ten records have active correlation. Both model inputs are truncated; eight
records report `unsupported_value`, incoming/final report `none`. Eight records
are redacted; the two model outputs are not. This proves bounded actual backend
content search and observed tool correlation, not complete model context/history,
exhaustive secret/hidden-reasoning auditing or live Slack content ingestion. No
extra model request, Slack post, Procedure replay or historical backfill was made.

The public observatory still queries only `computah-prod-traces` and reconstructs
its closed timing/topology schema; local tests reject private canaries injected
into rows/failures. In the exact revision/window, full-row predicates over 103
backend and 51 Slack traces found zero literal/content-schema matches
([sanitizer](https://app.axiom.co/bagel-w3ue/query?qid=0GPhfAZo2mB-to6gco)).
The deployment owner's public default/diagnostic snapshots at
`2026-11-08T09:44:02.321184Z` each contained 1,000 spans and zero canary literals,
raw transport IDs or forbidden keys. These are bounded checks, not a global
no-disclosure claim.

The old installed public Worker credential could query logs. Its replacement is
a dedicated traces-only QueryRead credential, installed in Worker version
`2c45e2bc-bff4-4e90-ac13-3d2c45739a3b` (receipt
`78910b52-8c5d-475c-b49f-69cff117d863`). Identical valid count controls returned
traces HTTP 200 and logs HTTP 400 dataset-inaccessible, versus old logs HTTP 200;
this is permission concealment, not query-validation failure or HTTP 403. Shared
backend credentials were unchanged.

Dataset metadata reports no explicit dataset retention period (`retentionDays: 0`,
`useRetentionPeriod: false`); effective organization/plan retention remains unknown,
not zero-day or unlimited. Activation inherited the existing policy without
retention changes/deletion. Runtime capture makes no universal "all data" or
durable audit claim.

## Runtime coverage ledger

Shared durable APIs support independent roots or explicit causal admission:
`createTraceCarrier(operation, links?, parent?)` creates an independent marker by
default, or an actual child of the strict supplied parent. Valid parent trace IDs
and flags survive disabled export; absent/invalid parents still create independent
roots. Persist that carrier exactly once at admission.
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

| Runtime surface                    | Actual coverage                                                                                                                                                                                                                                                                                                               | Remaining proof/work                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native browser                     | Opt-in embedded agentOS guest CLI → native agent-browser read and cleanup operations, fixed outcomes and bounded linked logs; local real Chromium fixture/native Worker tests use sanitized Axiom export                                                                                                                      | VPS installation/activation and live trace/log receipts remain separate; abrupt host death is not graceful cleanup; no public-only network isolation is claimed                                                                          |
| Backend HTTP → gateway → Rivet RPC | Request lifetime/status and Effect operations; active RPC context propagates                                                                                                                                                                                                                                                  | Abort/disconnect/reconnect and every route's failures are not exhaustively traced/tested                                                                                                                                                 |
| Interaction → Task → Worker        | Native Pi phases and Rivet actions export, including native error/replay events                                                                                                                                                                                                                                               | Custom `admit` uses `BACKGROUND_CONTEXT`; Pi creates a new root with no caller link at each admission. Presence is not continuity; sleep/restart linkage remains unproved                                                                |
| Slack → backend                    | `65c460a`: first receive → durable job actual parent, restored through ACK/retry/reopen, phases, HTTP and delivery; extra receives link without replacing first parent. Exact local sanitized-export graph, wire-header/client-span ancestry and linked error-log assertions; existing timing/capture/export checks retained. | Latest causal revision adoption and exact live Axiom graph receipts remain pending; legacy NULL carriers remain independent, not backfilled. Local Slack graph proof is not complete native Task/Worker continuity or client acceptance. |
| Tavily                             | Full service typed outcomes/cleanup; production native-adapter tool trace verified at `99962a5`                                                                                                                                                                                                                               | Separate structured-log ingestion and full Task admission linkage remain unproved; no automatic retries exist                                                                                                                            |
| Standalone bus                     | `1f119b1` full pump/stream/replay lifetimes; `1e1c840` persisted receipt roots, append/dispatch parents and pump links, private durable timing, sanitized trace/log regression                                                                                                                                                | Dispatch disabled; replay remains HTTP-parented, not falsely receipt-linked. Forced socket/backpressure permutations not exhaustive; latest causal source adoption/query proof pending                                                   |
| Dashboard                          | `c9335bc` shared BFF bootstrap/HTTP/core spans and logs, operator.history on actual existing-only actor reads, fixed-upstream IDs; local actor-backed browser proof                                                                                                                                                           | Production consumed-revision/trace/log receipts and browser lifecycle telemetry remain separate; local smoke-provider evidence is not live-model proof                                                                                   |
| Native product                     | `a989f45` shared Node IPC/core/process/materialization/recovery spans/logs through polling/cancel and drain; trusted-core IDs, no embedded ingest key                                                                                                                                                                         | Remote production receipts pending; Rust GPU/input/IME and pre-Node startup intervals uninstrumented; optional protected-host config is not client relay provisioning                                                                    |
| Rune/Pi experiment                 | `76f7751`: bounded local bridge start/spawn, prompt/cancel enqueue, attempt/failure, materialized render and pipe/reap records; same-session local correlation verified                                                                                                                                                       | No remote authenticated client relay/Axiom export/query proof; UI, storage, tool and full relaunch lifetimes remain incomplete; no server ingest credential embedded                                                                     |
| Native Worker files                | `d5034c7` explicit Pi child spans and linked operation logs for grant-scoped read/write/edit, no paths/content/host shell                                                                                                                                                                                                     | Actual production tool trace/log query proof remains separate from local native regression                                                                                                                                               |
| Native living self-docs            | Fixed `computah.self_docs.discover/read` spans and linked logs; local real Pi Interaction/Worker sleep/reopen tests verify sanitized native-parent continuity and ready/error/cancel outcomes without doc text/paths                                                                                                          | Built-image acceptance, enabled collection and live Axiom ingestion need separate receipts; abrupt-death recovery and Task-admission trace continuity remain unproved                                                                    |
| Operations discovery/timing        | Fixed `operations.discover/query/timing` spans and matching logs; native Pi caller parents, query/body-cleanup lifetime, explicit availability/denial/failure/cancel/timeout, returned-row counts; actual sanitized relay regression; `fb8e297` exercised timing→query parentage and exact paired logs verified               | Native admission root join, absent ingress/delivery and exhaustive failure/cancel coverage remain gaps; five discovery spans include internal/nested work, not five user calls; see [tools](tools.md)                                    |
| Sentinel                           | `3ecef7e` stored-carrier review/enforce/cancel metadata spans and native preflight/cancellation/replay tests                                                                                                                                                                                                                  | Enabled-host ingestion, real review quality, provider refresh, publication buffering and external-effect protection remain unproved or unimplemented                                                                                     |
| Gmail/analytics                    | Shared fixed Gmail names; analytics now wires bounded private projection, outer priority-preserving model observer, native task/usage watches and gateway/Task timings to the shared LOGS-only sink                                                                                                                           | Gmail wiring, full native admission join and revision-matched live analytics proof remain separate; no MeterProvider, invoice truth or complete task census; see [analytics](analytics.md)                                               |
| Public observatory                 | `b3a507e` bounded positive-schema Worker HTTP/poll emitter; `480a953` fixes native fetch; owner-verified production query/render and 1000-row keyed correlation, documented in [observatory](public-observatory.md)                                                                                                           | Optional edge ingest remains disabled/unproved; static/rejection paths use platform telemetry; browser interaction and actual visitor-disconnect export remain gaps                                                                      |
| Deployment/setup/quality scripts   | Checks/logs, not application trace export                                                                                                                                                                                                                                                                                     | Separate operational tracing policy; no host/process/SQL/socket/metrics/log pipeline coverage claim                                                                                                                                      |

The [Axiom listener](../integrations/axiom-listener/README.md) is operational
Amp-managed tooling, not another Computah exporter:

| Runtime surface      | Actual coverage                                                                                                                                                                                     | Remaining proof/work                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Axiom alert listener | Amp-managed webhook spans and fixed `computah.alert.completed` verified/rejected/failure/cancel logs; capability-only URL, discarded untrusted wake text, fixed authenticated monitor-history reads | Not connected to Computah's shared sanitized Axiom export; registration/startup recovery/provisioning export continuity absent. Notification deliveries do not establish current health or causal recovery; runtime/monitors/credentials remain with the listener owner |

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
- **Production private content verified, 2026-11-08 09:42 UTC:** exact `ab6567b`
  backend input/final/model/tool records are independently queryable after
  authorized activation. See [deployed acceptance](#deployed-private-content-acceptance)
  for the exact window, sanitizer/public controls and remaining correlation gaps.
  Slack activation is verified, but this backend-only canary does not prove live
  Slack content ingestion or every production path.

Axiom queries can correlate these content-free trace IDs across operational
boundaries; the separately authorized private content lane now adds actual bounded
normal-operation evidence. DEBUGSHARE remains a separate explicit diagnostic
capture, not permission for automatic history export or backfill.

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

## Live public timing channel

The Node SDK also supports an independent `LiveSpanProcessor`, enabled only with
protected `OBSERVATORY_LIVE_URL` (HTTPS ingestion endpoint) and a dedicated
`OBSERVATORY_LIVE_TOKEN`. It observes the registered JavaScript provider's actual
SDK start/end callbacks, including vendor spans. The existing literal operation
sanitizer runs before delivery; no attributes, events, resources, error text,
messages or histories are read into this channel. The Worker repeats its own
positive projection and HMAC mapping. This is separate from private content capture.

The live channel holds at most 512 active operations and 1,024 queued latest
records, posts batches of at most 128/120 KiB with one request in flight, a two-second
deadline and at most five attempts/second (outside bounded shutdown flushing).
Active operations update once/second. Short operations can coalesce directly to
their end state. Failed batches are dropped rather than blocking runtime work;
later updates and settled Axiom history reconcile gaps. Shutdown closes admission
and drains at most eight batches. Fixed outcome/count logs accompany delivery;
`computah.logs.export` is excluded from this channel to avoid a logging feedback loop.

Initial live delivery enabled on backend and Slack at checked source `2477de6` on
2026-11-08 (backend ready 10:01:36.356Z; Slack ready 10:02:39Z). The actual public
stream captured five active observations of finite registry startup from 28.186
to 32.186 seconds, then its measured end at 33,926.311794 ms, status `unset`, with
a declared root/no parent. The later settled-history replacement retained that
exact duration. Host lifecycle logs separately reported registry success at
33,926 ms. This is real startup evidence, not an inserted span, an encompassing
job, or proof of a private raw-OTLP identity join or human-message ancestry.
Native Rust/Effect providers not using this Node provider still arrive as settled
Axiom history; native start/update delivery is not implemented.
The existing settled OTLP path is unchanged. Browser interaction tracing and
full batch-to-source exporter causal links remain gaps. The optional edge Axiom
export binding is still deployment-owner controlled, not implicitly enabled here.
See [public observatory](public-observatory.md) for stream replay and bounds.
