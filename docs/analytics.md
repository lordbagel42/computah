# Operational analytics

Status: backend runtime collection is wired in source. Main composes the model
observer outside the existing priority runtime, constructs a private SQLite
projection, and sends committed increments through the shared typed
`runtimeMetric` log sink. Core observes native committed task metadata and usage,
Task invocations, and gateway lifetimes. Deployment and genuine Axiom ingestion
must be verified separately for the consumed revision. No new dashboard endpoint,
collector, paid service, budget enforcement, or host/container inspection is
introduced. Slack-specific analytics hooks remain unwired here. The separate
[native reply metrics](observability.md#native-reply-metrics) slice uses its own
private OTel MeterProvider; it does not convert this catalog's logs into metrics.

## Inventory of the actual pinned stack

Inspected installed Pi AI/Durable/telemetry 1.5.0, Rivet Pi 0.5.6 and current
Computah core/main/Slack source, not an assumed GenAI schema:

- Effect wraps gateway operations with `computah.<operation>` spans. The shared
  observability package owns the existing OTel backend and sanitized Axiom relay;
  analytics does not replace it. Its structured-log route is distinct from traces.
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
  provider therefore emits the default model spans. The existing priority wrapper
  supplies model tracing; the outer analytics observer neither replaces nor
  duplicates it. No dependency internals or replacement tracing stack are added.
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
  submissions at most once per actor/minute/distinct active-and-queued pair. These are point samples, not a
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
- `watchHarness(...)` follows the supported native task-graph observation API,
  serializes committed metadata captures and reads terminal metadata only for
  tasks that disappear from the live graph. Native watch updates can fold very
  short tasks out of view, and interrupted observers can miss completions. These
  durations are observed samples, not a complete task census. Observer attachment
  records a runtime wake; this is not proof of a process restart. Native usage is
  also refreshed on wake and after gateway wait/result/compact settlement, never
  from precommit answer/yield callbacks. Shutdown joins observers before closing
  the local store. Collection and transport errors remain fail-open.
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

`ANALYTICS_METRICS` is the source of truth. Optional native metric adapter names
have the `computah.` prefix; no MeterProvider is configured by this module.
The active shared log route uses `analytics.sample` with `analytics.<metric>`
scalar fields. Local rollups retain the names below and their units.

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
| runtime.wakes                                                                   | activation             | Native onWake observer attachment                                   |
| memory.context_tokens                                                           | token                  | Reserved native metadata vocabulary; no automatic source wired      |

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

## Runtime wiring and shared export

Main constructs `$HOME/.computah/analytics.sqlite` under umask 0077, on the
existing private data volume, with the connection secret as domain-separated
HMAC key. Failure disables the projection with a fixed diagnostic, not an agent
startup gate. The configured real Models boundary remains priority-enforced and
then analytics-observed. Faux mode explicitly constructs its synthetic provider;
it is not relabelled as a production model.

Only after an observation's dedup receipt and rollups commit does `onObservation`
invoke the existing `runtimeMetric(RuntimeMetricSample)` sink. Duplicate receipts
and cumulative ledger replacement emit nothing. The sink owns its bounded queue,
OTLP `/v1/logs` transport and separate `COMPUTAH_AXIOM_LOG_DATASET`; no cost enters
the trace relay. It is disabled without the existing protected ingest token and
log dataset configuration. This is structured-log analytics, not native OTel
metrics ingestion. Local commit and remote delivery remain non-atomic and
best-effort; a crash between them can lose export, not justify blind replay.

The exported sample has a fixed metric map and closed role/operation/outcome,
model/provider catalog, plus `sdk: pi-ai@1.5.0`. Only the supported Terra/Sol pair
is named remotely; other explicitly configured local models become unknown.
Finite nonnegative scalar values are bounded by MAX_SAFE_INTEGER. Reported cost
requires the explicit provider flag and is labelled not-invoice. Estimated cost
requires the selected numeric USD rate card with exact version
`pi-ai@1.5.0/runtime-model` and is labelled base-catalog-only, excluding service-tier
and account adjustments. Neither is subscription/invoice/spend assurance. Rates
are event provenance, never grouping labels. Principal/actor/task/receipt IDs,
including local HMACs, are excluded. The logger's own log ID and active trace
context are separate transport metadata, not exported usage receipt identity.

Gateway scalar receipts retain trusted principal correlation only in the private
store; native task receipts retain actor/task correlation there. Model request
correlation is unavailable at the shared runtime boundary. No tenant endpoint or
shared wire schema exposes the store. Slack transport/admission hooks and an
authenticated operator projection remain separate work; reserved catalog keys
do not establish collection.

All manual `record`, `replaceUsage`, `settledTask` and `consumeSpan` hooks must
catch local sink errors at the call site; unlike `measure`/`captureHarness`/the
model observer these explicit APIs can throw on storage failure. Do not make
task completion, cancellation or Slack delivery depend on projection availability.
The runtime wiring deliberately preserves existing priority Models and native
authorization hooks. It does not grant source access or override source-enabled
compaction restrictions; attempted compaction is not a claim of successful
compaction or universal coverage.

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
native usage capture and actor sleep/wake without accumulating snapshots. The
integrated core suite enables the private projection and exercises real native
Task/Worker terminal timing, Task invocation timing, native compaction and both
roles' cumulative ledgers. Callback checks distinguish committed increments from
duplicate receipts/cumulative refresh and preserve cost provenance without
identity export.

A separate temporary actual-main executable check used isolated HOME and the
explicit faux provider with the real native Task/Worker runtime. It completed one
delegation with exactly three model requests; refreshing its result did not add
requests. Two native ledgers persisted, the database mode was 0600, and SIGTERM
drained successfully. Intercepting only the shared OTLP destination captured 20
`analytics.sample` rows and 41 spans, including HTTP and native phase spans, with
the configured version and no content/identity/token canaries. Synthetic models
exported no production cost or rate claims. This validates the executable wiring
and sanitized transport shape, not remote delivery or real-provider spend.

These local checks are not live model traffic, live Slack delivery, process-kill
recovery, a dashboard proof or deployed ingestion evidence. Verify the consumed
revision and redacted real `analytics.sample` rows independently after rollout.
