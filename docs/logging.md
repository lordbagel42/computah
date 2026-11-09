# Structured runtime logs

## Source contract and integration

`packages/observability/src/logs.ts` implements one process-local bounded OTLP
log exporter. The observability index re-exports `runtimeLog`,
`startRuntimeLogging`, `RuntimeLogEvent` and `RuntimeLogFields`; the existing
observability bootstrap starts it and closes it **before** the trace provider,
so `logs.export` spans drain. Operation completion, HTTP lifetime, model streams
and lifecycle events emit fixed content-free records. Typed error outcomes are
not inferred from resolved return objects: explicit span outcome/status writes
drive the completion log. Production adoption/ingestion remains separate proof.
No manifest changes or new dependencies are required.

Runtime owners use the shared hook inside their existing traced operation:

```ts
runtimeLog(
  "operation.completed",
  {
    operation: "native.core",
    outcome: "error",
    reason: "transport",
  },
  "error",
);
```

The hook returns a newly generated UUID `log.id` for an accepted log, or
`undefined` if inactive, closed, invalid or overloaded. It captures the valid
active OTel trace/span IDs at emission, not at eventual flush. Trace correlation
does not convey tenant identity or authorization. Batch export spans link back
to those captured contexts, including cancelled/failed operation records.
No span is fabricated for every static byte, schema, asset or pure transformation.

`startRuntimeLogging(service)` is a process singleton: first bootstrap wins,
including disabled/closed state. It does not hot-reload credentials or restart
after close. Supported services: `backend`, `slack`, `bus`, `native`, `dashboard`,
`rune-pi`, `observatory`. This is a Node module; Cloudflare/other runtime
compatibility and request-lifecycle flushing must be verified by that owner,
not inferred from the service catalog. The lower-level
`createRuntimeLogger({service, token?, dataset?, revision?, fetch?})`
creates an isolated instance for tests and explicitly authorized synthetic proof;
application code should use the singleton, not create competing pipelines.

## Authorized private content records

The owner explicitly requested searchable actual operation content in private
Axiom. `COMPUTAH_AXIOM_CONTENT_ENABLED=1`, together with the normal protected log
configuration, opts a process into `runtimeContent(kind, payload)`. Default is
disabled; the observatory service cannot enable this lane. The isolated test
logger accepts `contentEnabled: true`. Generic `runtimeLog` remains content-free
and cannot manufacture a `content.record` or analytics sample.

This is the same bounded queue/exporter and private `computah-prod-logs` dataset,
not a new exporter or raw stdout sink. Keep its query grants restricted to
authorized operators; its configured dataset retention applies to content too.
Do not grant the public traces credential access to logs. The separately authorized
dashboard recreation uses a new logs-only QueryRead credential solely behind fixed
positive aggregate projections; it is never a raw-log proxy. Runtime code does
not provision permissions/retention or certify their deployed configuration.

OTLP body is fixed `content.record`. Attributes are:

- `content.schema`: exactly `computah.content.v1`.
- `content.kind`: `incoming`, `final`, `model.input`, `model.output`, `tool.call`,
  `tool.result`, `activity`.
- `content.payload`: JSON string containing the bounded actual source-projected
  text/arguments/result, available trusted actor/participant/location/submission
  identity, activity and usage. Literal text is searchable, not replaced by hashes.
- `content.truncated`, `content.redacted`: booleans.
- `content.missing`: `none` or comma-separated fixed categories
  `unsupported_value`, `cyclic_value`, `hidden_reasoning_excluded`,
  `accessor_excluded`; whole-record fallback is `record_limit` or
  `projection_failed`. Source-specific unavailable evidence is explicit in payload.
- `content.correlation`: `active` or `missing`; existing emission-time trace/span,
  `log.id`, service and revision fields remain. A missing context is not fabricated.

`content.ts` removes credential/header/auth fields, registered host secrets and
recognizable credential patterns from free text; hidden thinking/reasoning blocks,
signatures and encrypted reasoning never enter the payload. Explicitly available
reasoning summaries can use `reasoningSummary`, never hidden model reasoning.
Current protected environment/auth JSON credentials and HTTP/operator secret/URL
values are registered locally. Do not interpret pattern matching as universal
secret detection: arbitrary unknown secrets or obfuscated credentials in prose
cannot be guaranteed detectable. Call sites must source-project operation data,
not serialize credentials, arbitrary runtime objects or raw checkpoint histories.
The secret registry retains at most 512 distinct values (64 KiB each). Overflow,
oversized credentials or incomplete bounded auth-config traversal disable further
content admission instead of forgetting known credentials; scalar logs continue.

Projection bounds: depth 12, 1,024 visited nodes, 128 array elements, 64 object
fields, 16 KiB encoded JSON per string and 32 KiB total encoded strings/keys;
serialized payload at most 64 KiB. Redaction uses bounded lookahead before clipping.
Nonserializable/cyclic/getter inputs fail open with missing-evidence markers;
no `toJSON` hooks are executed. Content admission is capped at 128 occupied queue
slots and 2 MiB serialized content bytes including in-flight records, reserving
at least 384 slots for scalar lifecycle/error/analytics rows. New content drops
under pressure. Batches are capped at 64 rows and 256 KiB row bytes (plus fixed
OTLP envelope); the same deadlines, no-retry and shutdown semantics apply.

Only new normal operations are captured: no bulk Slack retrieval, history dump,
database export or backfill. A model input may include the bounded context the
application was already sending for that operation. DEBUGSHARE remains a separate
explicit capture. Local exporter tests are not live ingestion or exhaustive
coverage; the [coverage ledger](observability.md) records adoption/proof separately.

## Slack reply latency observation hook

The dedicated `runtimeSlackReplyLatency(sample)` helper is source-supported at
`398f13b`, with Slack detector source adoption at `5fc4180`. Process adoption
and live ingestion remain separate proof.
Its contract uses the existing bounded logger/exporter, not a content record or
new telemetry pipeline. Generic `runtimeLog` cannot manufacture this event or
bypass the dedicated validation. The return value is a **boolean local queue
admission result**, not an export, Slack delivery or monitor acknowledgment.

The OTLP body is fixed `slack.reply_latency`. The closed input-to-attribute map is:

| Input           | OTLP attribute                | Contract                                            |
| --------------- | ----------------------------- | --------------------------------------------------- |
| `messageId`     | `slack.message_id`            | Opaque source SHA256 receipt identifier             |
| `phase`         | `slack.reply.phase`           | `overdue` or `confirmed`                            |
| `receivedAtMs`  | `slack.reply.received_at_ms`  | Host receipt epoch-ms clock                         |
| `observedAtMs`  | `slack.reply.observed_at_ms`  | Observation epoch-ms clock, at least receipt time   |
| `confirmedAtMs` | `slack.reply.confirmed_at_ms` | Required only for `confirmed`; absent for `overdue` |
| `elapsedMs`     | `slack.reply.elapsed_ms`      | Phase-specific elapsed milliseconds                 |
| `thresholdMs`   | `slack.reply.threshold_ms`    | Exactly `5000`                                      |

All clocks and durations must be nonnegative safe integers, including epoch zero.
A confirmed observation requires received ≤ confirmed ≤ observed and elapsed =
confirmed − received; it can be at or below 5000ms. An overdue observation requires
elapsed = observed − received **strictly greater than 5000ms**, with no confirmed
clock. Unknown keys, invalid SHA256 identifiers, phases or thresholds reject the
sample. The existing `log.id`, service, revision and emission-time trace/span
metadata remain; missing active trace context is not fabricated. No message text,
notification payload or private content is accepted.

The Slack source owns eligibility, durable receipt state and once-per-kind
observations. Stable receipt identifier + phase supports monitor deduplication;
the generated `log.id` is not that stable key. Local queue admission is not an
atomic remote export with SQLite, and drops/crashes can lose telemetry. This is
not exactly-once delivery or an authoritative per-receipt terminal-state stream.

The monitor contract is historical: count explicit overdue observations and
confirmed observations whose elapsed time is strictly greater than 5000ms.
An overdue record means no confirmed answer at that observation, not pending
forever. Window expiry is not an answer or recovery. Failure/denial/cancellation
closures remain separate durable source outcomes, never successful answers;
ambiguous delivery remains unknown. The two phases alone cannot reconstruct a
current-pending cohort, particularly for multiple receipts sharing a job trace.
Such a view would require an explicit per-receipt closure projection, not an
inference from trace correlation or absent records.

## Analytics observation hook

The separately authorized `runtimeMetric(sample: RuntimeMetricSample)` emits
one `analytics.sample` log through **the same queue and exporter**, not a meter
provider. The public observability entry point also re-exports `runtimeMetric`,
`RuntimeMetricName` and `RuntimeMetricSample`. An isolated instance exposes the
equivalent `metric(sample)` method. Generic `runtimeLog` cannot emit analytics
samples or bypass the stricter schema.

The analytics owner invokes this only after its local SQLite deduplication and
commit, once per observation map. Never export cumulative snapshots, native
usage totals on refresh, local receipt IDs, HMACs or principal/task correlation.
The common generated `log.id` and active OTel trace/span IDs remain operational
metadata, not local receipt identifiers. Remote delivery is not transactional
with SQLite; drops/crashes may lose samples and no retry is implied.

Required sample fields:

- `measurements`: partial map of the exact shipped `ANALYTICS_METRICS` keys in
  `apps/server/src/analytics.ts`. The exporter mirrors that closed catalog without
  importing the server application. Units are catalog-defined, never supplied by
  callers. Each value is finite, nonnegative and at most `MAX_SAFE_INTEGER`.
  Unknown/invalid measurements are omitted; no valid measurements rejects the row.
- `role`: `interaction`, `worker`, `slack`, `runtime`.
- `operation`: `submit`, `wait`, `result`, `history`, `cancel`, `compact`, `sleep`,
  `Task`, `observe`, `unknown`.
- `outcome`: `ok`, `error`, `aborted`, `unknown`, `accepted`, `duplicate`, `ignored`,
  `uncertain`, `rate_limited`.
- `model`: `openai-codex/gpt-6.1-terra`, `openai-codex/gpt-6.1-sol`, `unknown`;
  `provider`: `openai-codex`, `unknown`. Unknown model/provider must pair together.
- `sdk`: exactly `pi-ai@1.5.0`. Invalid required labels reject the entire sample.

Optional `reportedFromProvider: true` permits `model.cost.reported` only for a
known configured model/provider. The caller must derive it from the SDK's
explicit per-request `cost.totalFromProvider === true`, not infer it from an
opaque/default/cumulative SDK cost. The helper stamps
`analytics.cost.reported.basis=sdk-provider-reported-not-invoice`.

Optional `rate` permits `model.cost.estimated` only for a known model/provider:
`version` exactly `pi-ai@1.5.0/runtime-model`, `currency` exactly `USD`, required
numeric `input`, `output`, `cacheRead`, `cacheWrite`, optional `cacheWrite1h` and
`inputTokensAbove`. All are finite nonnegative bounded numbers; prices are per
million tokens. The helper stamps
`analytics.cost.estimated.basis=base-catalog-estimate-excludes-tier-account-adjustments`
and exports selected numeric rates/version. The caller calculates the estimate
from actual available token scalars and these selected rates; the exporter does
not perform billing or validate upstream financial truth. These are not actual
priority spend, provider invoices, subscription allocations or account discounts.

Measurements become `analytics.<metric>`, labels become `analytics.<field>`, rate
fields become `analytics.rate.<field>`. Accepted costs carry `analytics.currency=USD`.
Reported and estimated remain separate scalars and bases, never a generic total.
No rate fields are exported without an accepted estimate. Unknown costs are
omitted, never fabricated zeros; an SDK-default all-zero usage observation must
be represented by `model.usage_missing`, not measured zero token/cost counters.
Trace export's cost exclusion is unchanged. This helper is source-supported;
actual analytics hook activation and production row verification remain separate.

## Positive schema

`runtimeLog(event, fields = {}, level = "info")` permits only `info`, `warn`,
`error` severity (OTLP numbers 9, 13, 17). Unknown event/severity rejects the
record; unknown fields or category values are omitted. Fields are copied at
emission. No arbitrary strings, objects, message bodies, exception text/stacks,
credentials, headers, URLs, paths, principals, user/actor/task IDs, histories,
tool arguments/results or hidden reasoning are accepted. There is no console
interception or stdout backfill. New categories require a code/schema review.

Events:

- `runtime.ready`, `runtime.stopped`, `runtime.start_failed`, `runtime.report`,
  `runtime.retry`, `runtime.cancelled`, `runtime.recovery`, `operation.completed`.
- `http.completed`, `model.completed`, `slack.receive`, `slack.delivery`,
  `bus.delivery`, `bus.pump`, `bus.stream.create`, `bus.stream.append`, `bus.replay`.
- `native.ipc`, `native.render`, `native.recovery`, `native.process`, `native.core`.
- `dashboard.http`, `dashboard.core`, `rune-pi.ipc`, `rune-pi.render`,
  `rune-pi.recovery`, `rune-pi.process`, `telemetry.synthetic`.

Fields:

- `outcome`: `success`, `error`, `cancelled`, `timeout`, `denied`, `queued`,
  `retry`, `ready`, `stopped`, `other`.
- `reason`: `transport`, `http`, `capacity`, `rate_limited`, `invalid_input`,
  `not_configured`, `storage_failed`, `authorization_required`, `other`.
- `operation`: `submit`, `result`, `wait`, `history`, `cancel`, `compact`, `sleep`,
  `observe`, `http`, `model`, `receive`, `delivery`, `recovery`, `export`, `other`;
  also `web.search`, `web.extract`, `operator.history` and the exact `native.*`,
  `dashboard.*`, `rune-pi.*`, `bus.*` events above except `bus.delivery`;
  `sentinel.review`, `sentinel.enforce`, `sentinel.cancel`, `gmail.bind`,
  `gmail.sync`, `gmail.import`, `gmail.drain`, `gmail.authority`, `gmail.retrieval`;
  `files.read`, `files.write`, `files.edit`, `slack.receive`, `slack.step`,
  `slack.api`, `slack.core`, `slack.delivery`, `slack.job`, `slack.admit`,
  `slack.queue`, `slack.prepare`, `slack.submit`, `slack.wait`, `slack.retry`,
  `slack.status`, `slack.ack`, `slack.recover`, `slack.finalize`, `slack.timing`,
  `bus.admit`, `bus.receipt`,
  `bus.dispatch`, `observatory.http`, `observatory.poll`.
- `attempt`, `count`, `duration_ms`, `status_code`: finite numbers from zero
  through `Number.MAX_SAFE_INTEGER` inclusive; `resumed`: boolean.

Numeric keys are for the named operational scalars, not encoding content or IDs.
Resource attributes contain fixed `service.name` and optional `service.version`
from `COMPUTAH_REVISION` (or the isolated instance's `revision` option), accepted
only as exactly 40 lowercase hex characters. Invalid versions are omitted;
arbitrary resource values never pass. Scope is `computah`.
OTLP body is the fixed event name; attributes carry approved fields and generated
`log.id`. No ambient OTel resources, baggage or tracestate are copied.

## Delivery, limits and failure

- Protected `COMPUTAH_AXIOM_INGEST_TOKEN` plus
  `COMPUTAH_AXIOM_LOG_DATASET=computah-prod-logs` enable collection. Missing token,
  missing/invalid dataset or invalid service disables admission. Runtime does not
  read `AXIOM_TOKEN`, invent a dataset, provision hosts or request chat secrets.
- Fixed `https://api.axiom.co/v1/logs` OTLP HTTP/JSON destination; bearer token and
  `X-Axiom-Dataset` go only there. Redirects are rejected. Logs use their own
  Events dataset, never `computah-prod-traces`. See the
  [Axiom OTel contract](https://axiom.co/docs/send-data/opentelemetry).
- At most 512 records **including in-flight records**, each bounded by the fixed
  schema. Newest records drop at capacity. One serial exporter sends at most 64
  records and 256 KiB serialized row bytes per batch. Automatic flush runs every
  second on an unreferenced timer.
- Each batch has a five-second deadline covering headers/body/cleanup, aborts
  on timeout, and reads at most 4096 response bytes. HTTP/network/parse failures,
  excessive responses and partial OTLP rejections increment failure counters.
  No remote diagnostic text is logged or retained.
- No automatic retries: uncertain acknowledgements may represent delivered logs,
  so retries could duplicate observations and amplify an outage. Application work
  never waits for logging unless it explicitly awaits flush/close. Export failure
  does not reject those calls. Failures get fixed trace outcomes, never recursive
  log emissions. This is best effort, not durable audit/exactly-once delivery.
- `flush()` settles all records accepted before its invocation; later emissions
  may need a later flush. Concurrent flushes share serialized export work.
  `close()` immediately stops admission and the timer, then drains accepted work;
  repeated close is safe. Content-enabled byte limits can require more batches
  than the content-free queue's eight full batches; shutdown must allow for drain.
  Crashes/exiting without close can lose queued data.
- `stats()`/flush/close return snapshots: `enabled`, `closed`, `queued`, `accepted`,
  `exported`, `failed`, `dropped`, `rejected`. Exported means OTLP acknowledged,
  not query-confirmed persistence; failures can include uncertain delivery.

## Evidence and remaining integration

Deterministic tests exercise correlation and sanitized export links, privacy
canaries, overload including in-flight data, serial batching, concurrent
flush/close, HTTP/network/partial rejection, malformed/oversized replies,
automatic flush, deadline cancellation and disabled configuration.

**Local exporter → live Axiom verified, 2026-11-08 07:41 UTC:** one harmless
`telemetry.synthetic` log passed through this module to `/v1/logs` with HTTP 200,
accepted/exported 1, failed/dropped 0. Query returned exact `attributes.log.id`
`34b0edb9-3906-4e43-a564-60f6749a701b`, service `computah-backend`, operation
`export`, outcome `success`, count 1 from `computah-prod-logs`.
[Exact-ID saved query](https://app.axiom.co/bagel-w3ue/query?qid=IKqtqSrkBf0-to6apo).
The explicitly authorized existing local `AXIOM_TOKEN` was supplied only as a
synthetic instance option. This is not evidence that the serving host's protected
`COMPUTAH_AXIOM_INGEST_TOKEN` has permission for the new dataset; that credential
was not available in this orb. Activation owner must verify its dataset grant.

Shared bootstrap/re-exports and automatic fixed-category HTTP, operation, model
and lifecycle logging are integrated. Protected host adoption and independently
queried real-runtime records remain separate deployment/verification work.
Existing trace activation is independent. No claim of exhaustive
repository coverage, static-byte logging, analytics/cost export or host metrics
is made for running services by this source packet;
[observability](observability.md) records broader trace coverage gaps.
