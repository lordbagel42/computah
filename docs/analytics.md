# Operational analytics

Status: additive source and local checks only. `apps/server/src/analytics.ts`
does not alter core/main/Slack or enable an exporter. Integration owns those
hooks and the operator wire contract. No dashboard endpoint, collector, paid
service, budget enforcement, or host/container inspection is introduced.

## Inventory of the actual pinned stack

Inspected installed Pi AI/Durable/telemetry 1.5.0, Rivet Pi 0.5.6 and current
Computah core/main/Slack source, not an assumed GenAI schema:

- Effect already wraps gateway operations with `computah.<operation>` spans.
  `onReport` currently logs a fixed category only. No SDK/exporter is configured
  in this baseline; a span API is not evidence of exported telemetry.
- Rivet Pi maps durable `pi.durable.submit` and `pi.durable.phase` spans into
  OTel and strips exception messages. Native phase attributes include invocation
  attempt, resumed, tool name, phase and outcome. Events include replay, reports,
  committed entries and settled submissions. Native metrics define phase
  duration, active task up/down counts and reports. A phase is not a whole Task.
- Native Pi AI defines request/poll duration, first normalized chunk, tokens and
  cost metrics. Rivet maps model spans to `chat <model>` and GenAI attributes;
  that mapping does not retain the complete cache/reasoning/cost provenance.
- `main.ts` supplies the official custom `ModelRuntime`. Rivet's default
  `traceModelRequests` wrapper is applied only when it constructs the runtime;
  an application-supplied runtime is left alone. Do not assume the configured
  provider therefore emits the default model spans. This packet does not patch
  dependency internals or install another tracing stack.
- Pi Durable atomically records assistant usage and compaction summarization
  attempts in `pi.usage`. `harness.usage()` sums the session's conversations.
  Entries/history alone miss compaction spend. The latest native ledger is the
  authoritative cumulative source; repeated reads must replace, never add.
- `Usage` includes uncached input, output, cacheRead/cacheWrite, totalTokens,
  optional cacheWrite1h and reasoning. Reasoning is a subset of output, and 1h
  writes are a subset of cacheWrite. Never add either subset to total tokens.
- Cost components are catalog estimates. `cost.totalFromProvider === true`
  identifies a provider-reported total, not a reconciled invoice. Native
  cumulative addition does not reliably maintain this flag across mixed
  requests: the cumulative total is deliberately labelled mixed-or-estimated.
- Task records expose startedAt/endedAt and consecutive restart streak, not a
  total retry count. `inspect()` exposes current live tasks/unsettled submissions.
  Old records may lack timestamps. No trustworthy queue-admission clock is
  exposed by the inspected contract. Never subtract sequence IDs as timestamps.
- Slack's durable journal exposes admission outcomes and queued/submitted/done/
  uncertain counts. SDK retrying is disabled; rate-limited calls reject. The
  current adapter catches transport errors categorically, so 429/retry-after
  must be measured at its transport boundary, not guessed from `uncertain`.

## Collection and cost semantics

`OperationalAnalytics` accepts a private local SQLite path, stable server-only
HMAC key, at most 100 configured provider/model IDs, and optionally the existing
Pi `TelemetryMetrics` adapter. It creates no exporter and reads no environment,
auth storage, prompt/history/context contents, tool arguments, HTTP headers or
host resources. The operator must create its parent directory privately and
set process umask 0077. One owner per projection file; keep it on the existing
private data volume if retention across process/container replacement is wanted.

- `record(id, dimensions, scalarMeasurements, receiptMetadata?)` atomically deduplicates an
  observation and updates UTC hourly count/sum/min/max rows. IDs must be globally
  unique to a real observation, including actor identity for durable receipts.
  Retrying collection uses the same ID; an actual new attempt uses a new ID.
- `replaceUsage(actor, dimensions, nativeUsage, observedAt?, correlation?)` replaces that
  actor's native cumulative ledger. Older observedAt cannot overwrite a newer
  sample. Callers must serialize captures per actor if their clock resolution
  could give concurrent reads the same timestamp. Native ledgers are not a
  daily spend series and are never added to request-attempt rollups.
- `captureHarness(actor, dimensions, harness, correlation?)` reads only native usage and
  inspection metadata, refreshes that ledger and samples running tasks/queued
  submissions at most once per actor/minute. These are point samples, not a
  concurrency integral or a complete high-water mark. Captures can be stale and
  no observation means unknown, not zero. Read failures are counted as dropped.
- `observeModels(runtime, analytics)` works with the configured ModelRuntime.
  It observes logical stream/simple/deferred calls and completion conveniences,
  not hidden SDK HTTP retries or every wire attempt. It delegates original
  options, including AbortSignal; does not inspect auth, request payloads or
  callback bodies; and observes only terminal scalar usage and event kinds on
  the caller's own iterator. There is no second stream consumer or payload copy.
  Completion methods delegate to the supplied runtime's corresponding completion
  methods, preserving priority/checkpoint policy rather than substituting streams.
  It does not create model spans; existing tracing remains independent.
- Request duration includes runtime authentication/setup until terminal result.
  First-output latency is caller-observed delivery of the first text/thinking/
  tool JSON delta, **not provider wire TTFT**, and is absent when only `.result()`
  is consumed. Slow consumers can inflate it beyond request duration. Empty
  streams do not fabricate first output. Pending/deferred results and any request
  with only SDK-default all-zero usage are usage-unknown, including successful
  requests. An explicit provider-reported zero is preserved. Default-only native
  cumulative rows likewise project null, not invented measured zeros.
  Failed requests with reported nonzero usage retain it, separately from success.
- `modelAttempt(...)` accepts an explicitly selected rate card: numeric USD
  per-million-token input/output/cacheRead/cacheWrite prices, optional separate
  1h-write price, and immutable version. Estimates use those numeric rates, not
  an opaque SDK total. The complete rate card remains in operator-only receipt
  metadata, never metric dimensions or grouping keys. USD cost sums can combine
  different rates; inspect the bounded receipts for per-request provenance.
  `observeModels` captures the selected runtime model's
  rate card labelled `pi-ai@1.5.0/runtime-model`; zero catalog prices do not mean a
  subscription is free. It selects the highest strictly exceeded long-context
  tier using uncached plus cached input, and follows Pi's explicit 2× input
  price for reported 1h writes. The selected threshold/rates are retained.
  These are base catalog-rate estimates: provider service-tier multipliers,
  subscription entitlements and account discounts are not captured by this rate
  card. In particular a priority request is not proof of priority execution or
  billing, and these estimates must not be labelled actual priority spend.
  Missing rate data (including a needed 1h rate) produces no estimate.
- `measure(dimensions, body, correlation?)` times one invocation and categorizes success,
  failure or AbortError without altering its value/error. Task tool timings are
  invocation durations, not replay-deduplicated logical Task lifetime. Compaction
  attempts and cancellation requests are explicitly named as attempts/requests,
  not proof of effective compaction/cancellation.
- `settledTask(...)` accepts scalar metadata only, deduplicating native terminal
  duration by actor/task/end timestamp. Native restarts are labelled a restart
  streak, never billed as total retries. Missing timestamps mean unavailable.
- `consumeSpan(StoredSpan, dimensions?)` can attach to the existing backend once
  configured. It only recognizes durable Pi submit/phase names and picks scalar
  duration/replay/resumed/report counts; model spans are ignored to avoid double
  counting the model wrapper. No span payload/error/attribute map is retained.

Metric dimensions and rollup grouping keys are fixed role/operation/outcome plus
allowlisted model/provider, identically for local rows and optional export.
Per-principal/task HMAC correlation is accepted only as separate operator receipt
metadata or native usage snapshot correlation fields. Pseudonymization does not
bound cardinality: identities, rate versions and numeric prices are never metric
dimensions or grouping keys. No actor/principal/task IDs, arbitrary tool names,
error messages, rate values or pseudonyms enter exporter labels. Per-request principal/task
association is unavailable in the shared ModelRuntime wrapper: do not infer it
from whichever HTTP request is active. Native actor usage captures can supply
trusted scope as separate correlation, not dimensions. Tool-specific usage and semantic answer quality are
not inferred from model token totals or success status.

## Exact metric catalog

`ANALYTICS_METRICS` is the source of truth. Optional exporter names have the
`computah.` prefix. Local rollups retain the names below and their units.

| Metrics                                                                         | Unit                   | Source in this packet                                               |
| ------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| model.requests, model.usage_missing, model.length_limited                       | request                | Model wrapper / explicit modelAttempt                               |
| model.duration, model.first_output                                              | ms                     | Model wrapper; first output is caller-observed, not wire TTFT       |
| model.tokens.input/output/cache_read/cache_write/cache_write_1h/reasoning/total | token                  | Terminal SDK usage; optional fields stay absent                     |
| model.cost.reported                                                             | USD                    | Explicit per-request provider-reported flag only; not invoice truth |
| model.cost.estimated                                                            | USD                    | Supplied versioned numeric rate card                                |
| task.active, task.queued                                                        | task                   | Native inspection point samples                                     |
| task.duration                                                                   | ms                     | Supplied native terminal timestamps                                 |
| runtime.restart_streak                                                          | restart                | Supplied native terminal restart streak                             |
| runtime.phase_duration                                                          | ms                     | Supplied settled durable span                                       |
| runtime.replays, runtime.resumed_phases, runtime.reports                        | replay/phase/report    | Supplied durable span events/metadata                               |
| operation.duration, tool.duration, memory.compaction_duration                   | ms                     | measure invocation / Task / compact                                 |
| memory.compactions, operation.cancellations                                     | attempt/request        | measure compact / cancel                                            |
| worker.duration, task.queue_wait, operation.retries                             | ms/ms/attempt          | Reserved scalar hook vocabulary; no automatic source wired          |
| slack.admissions, slack.delivery, slack.rate_limits                             | event/attempt/response | Reserved transport/admission hooks; no Slack edits in this packet   |
| slack.delivery_duration, slack.retry_after, slack.queue_age                     | ms                     | Reserved transport/journal hooks; no Slack edits in this packet     |
| memory.context_tokens, runtime.wakes                                            | token/activation       | Reserved native metadata/lifecycle hooks; no automatic source wired |

The reserved vocabulary is not a claim that these signals are collected. There
is no source here for provider invoices, subscription allocation, unreported
reasoning, cache savings, semantic quality/user satisfaction, host CPU/memory,
image generation cost, builds/deployments or deployment resource prices. Deploy
owner may expose existing receipts/counters separately; do not scrape unrelated
host/container data or provision infrastructure to fill the gaps.

## Retention, gaps and safe projection

The projection retains seven days of event dedup receipts and latest actor
samples; hourly rows retain the whole boundary hour (at most seven days plus
one hour). Limits are 50,000 observations, 10,000 hourly series, 5,000 actor
snapshots. At capacity, reject new observations atomically and increment dropped;
do not falsely reset or collapse another principal's totals. Rows are bounded;
SQLite page reuse/WAL behavior does not promise secure physical erasure or a
precise disk-byte cap. Duplicates older than the dedup window may count again.

The native ledger remains durable even if the optional projection drops a
receipt. Crashes before request telemetry is persisted, abrupt interrupted
requests, local disk failure, cap drops and disconnected exporters create gaps;
they do not justify inferred zeros or exactly-once billing claims. Local commits
and remote metric delivery are not atomic; exporter failures are counted but not
retried blindly. No raw SDK event/payload archive is kept. Only count/sum/min/max/mean are
reported; percentiles cannot be recovered from those summaries.

`snapshot()` returns version, generatedAt, retention/dedup window, limits,
diagnostics, rollups, latest native usage projections and explicit coverage text.
Each rollup has hour, metric, unit, dimensions, count, sum, min, max and mean.
Each latest usage record has HMAC id, observed `at`, bounded dimensions, separate
operator-only correlation, and model counters/cost provenance. `receipts(limit)`
is a separate operator evidence API returning up to 200 latest observations:
HMAC id, at, bounded dimensions, scalar values, and metadata containing optional
HMAC correlation and versioned numeric rate card. It is not automatically included
in the generic metric snapshot or exported. It shares the 50,000 receipt/seven-day
cap and dedup transaction. Missing optional counters are null in latest usage
and absent in request metrics. Cumulative optional reasoning/1h totals may cover
only some requests. Do not add them to output/cacheWrite or imply full coverage.
Only an authenticated operator projection may serve this snapshot. It grants no
tenant identity, permission or cross-user read authority. The dashboard should
render the server values without accumulating on refresh or deriving new costs.

## Narrow wiring handoff (not applied to other owners' files)

1. Main: privately construct one OperationalAnalytics store on the existing data
   volume; allowlist the unique values of `config.model` and `config.workerModel`.
   Compose `observeModels(priorityModels(models, report), analytics)` in real
   mode when passing Models to createCore; do not remove or shadow the current
   priority wrapper. In faux mode wrap the configured faux runtime directly.
   Keep the original ModelRuntime for startup authentication/catalog checks.
   Drain core before closing the projection. Faux mode remains explicitly faux.
   The existing private connection secret can supply the domain-separated HMAC
   key; no new credential is required. If projection construction fails, disable
   analytics with a fixed categorical diagnostic, not a new agent startup gate.
2. CoreOptions: optional analytics instance. Preserve Effect.withSpan; wrap its
   existing run body with analytics.measure and bounded operation dimensions;
   pass trusted scope only through its separate correlation argument. Do not
   expose the instance or raw native harness in any tenant endpoint.
3. Add a private actor action that calls captureHarness with `c.actorId`, trusted
   scope from actor key, role and `c.pi`. Invoke after native wait/result/compact
   settlement, and onWake for recovery. **Do not capture cumulative usage from
   onAnswer/onYield:** that hook precedes appendAssistant/recordUsage commit and
   would lag the current response. Do not read harness inside a Pi commit.
4. Task tool execute: measure the actual invocation; after native task settlement
   pass only task id/timestamps/restart streak/outcome to settledTask. Give each
   actual dispatch/retry a distinct observation ID; stored result replay is not
   a new model call. Unknown cancellation outcomes remain unknown.
5. Slack owner: record admission decision after durable commit, per actual
   transport attempt duration/status, explicit 429 and numeric retry-after only
   where the SDK reports them. Never log channel/user/text/error payloads. Keep
   delivery uncertainty separate from known failure; no blind resend.
6. Integrator may add the safe snapshot to its existing canonical operator
   projection. No extra route or shared contract change is authored here.
   Existing telemetry backend can supply TelemetryMetrics and native spans;
   no exporter setup is implied by this module.

All manual `record`, `replaceUsage`, `settledTask` and `consumeSpan` hooks must
catch local sink errors at the call site; unlike `measure`/`captureHarness`/the
model observer these explicit APIs can throw on storage failure. Do not make
task completion, cancellation or Slack delivery depend on projection availability.
The current main baseline reviewed for this packet is `49fda85`. No runtime hook
in this list has been applied by the packet itself.

## Verification

Tests exercise actual SQLite close/reopen dedup/rollups/retention/cardinality,
stale cumulative replacement, optional counters, asymmetric rate calculations,
mixed-cost provenance, identity exclusion, exporter failure isolation, scalar
native span/task replay, AbortError preservation and closed-store fail-open.
An actual configured ModelRuntime with a synthetic provider checks stream event
identity, original cancellation signal propagation, failed attempt handling and
first-output observation. The installed official Codex adapter with synthetic
OAuth and intercepted HTTP proves composition with priority/high for Terra and
Sol across stream/simple/completion boundaries, exactly one receipt per request,
and preservation of custom completion behavior. An actual Rivet/Pi actor with a faux provider checks
native usage capture and actor sleep/wake without accumulating snapshots.

This is not a live model call, live Slack delivery, configured exporter test,
process-kill recovery test, dashboard proof or deployed instrumentation claim.
The core/main/Slack hook adoption must be verified in the integrated checkout.
