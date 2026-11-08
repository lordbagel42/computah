# Axiom observability

Computah exports every emitted trace, without sampling, from the instrumented
backend, Slack and bus entry points when `COMPUTAH_AXIOM_INGEST_TOKEN` is present.
This is operational tracing, not a copy of user histories. No automatic
DEBUGSHARE collection, diagnostics bundles or diagnostic-agent spawning is added.

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

The AGENTS.md rule requires instrumented runtime changes; this ledger records
known debt, not permission to silently extend it. Static schemas, assets, fixtures
and pure transformations do not need meaningless per-byte spans. The unit of
coverage is an executable operation and its observable outcome/linkage.

| Runtime surface                    | Actual coverage                                                                                                                                                                                                                    | Remaining proof/work                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend HTTP → gateway → Rivet RPC | Request lifetime/status and Effect operations; active RPC context propagates                                                                                                                                                       | Abort/disconnect/reconnect and every route's failures are not exhaustively traced/tested                                                                                               |
| Interaction → Task → Worker        | Native Pi phases and Rivet actions export, including native error/replay events                                                                                                                                                    | Custom `admit` uses `BACKGROUND_CONTEXT`; Pi creates a new root with no caller link at each admission. Presence is not continuity; sleep/restart linkage remains unproved              |
| Slack → backend                    | `d517ae6`: persisted independent job roots across ACK/retry/reopen, actual receive/admit/dequeue timestamps, queue intervals and phase attempts, DEBUGSHARE capture association, startup/finally flush; real sanitized relay tests | Latest job/capture instrumentation runtime adoption and exact Axiom UUID receipts pending; legacy rows remain null; bootstrap both-signal proof at `330af03` is not full-job proof     |
| Tavily                             | Full service typed outcomes/cleanup; production native-adapter tool trace verified at `99962a5`                                                                                                                                    | Separate structured-log ingestion and full Task admission linkage remain unproved; no automatic retries exist                                                                          |
| Standalone bus                     | `1f119b1` full pump/stream/replay lifetimes; `1e1c840` persisted receipt roots, append/dispatch parents and pump links, private durable timing, sanitized trace/log regression                                                     | Dispatch disabled; replay remains HTTP-parented, not falsely receipt-linked. Forced socket/backpressure permutations not exhaustive; latest causal source adoption/query proof pending |
| Dashboard                          | `c9335bc` shared BFF bootstrap/HTTP/core spans and logs, operator.history on actual existing-only actor reads, fixed-upstream IDs; local actor-backed browser proof                                                                | Production consumed-revision/trace/log receipts and browser lifecycle telemetry remain separate; local smoke-provider evidence is not live-model proof                                 |
| Native product                     | `a989f45` shared Node IPC/core/process/materialization/recovery spans/logs through polling/cancel and drain; trusted-core IDs, no embedded ingest key                                                                              | Remote production receipts pending; Rust GPU/input/IME and pre-Node startup intervals uninstrumented; optional protected-host config is not client relay provisioning                  |
| Rune/Pi experiment                 | `76f7751`: bounded local bridge start/spawn, prompt/cancel enqueue, attempt/failure, materialized render and pipe/reap records; same-session local correlation verified                                                            | No remote authenticated client relay/Axiom export/query proof; UI, storage, tool and full relaunch lifetimes remain incomplete; no server ingest credential embedded                   |
| Native Worker files                | `d5034c7` explicit Pi child spans and linked operation logs for grant-scoped read/write/edit, no paths/content/host shell                                                                                                          | Actual production tool trace/log query proof remains separate from local native regression                                                                                             |
| Sentinel                           | `3ecef7e` stored-carrier review/enforce/cancel metadata spans and native preflight/cancellation/replay tests                                                                                                                       | Enabled-host ingestion, real review quality, provider refresh, publication buffering and external-effect protection remain unproved or unimplemented                                   |
| Gmail/analytics                    | Shared fixed Gmail names and typed analytics export API; module hooks exist separately                                                                                                                                             | Runtime hook publication/adoption, native admission join and exact live usage/cost/Gmail receipts remain separate; SDK cost is not invoice proof                                       |
| Public observatory                 | `b3a507e` bounded positive-schema Worker HTTP/poll emitter; public shell and projection tests                                                                                                                                      | Optional ingest/query bindings and actual collection/query/render proof absent; static rejection paths rely on platform telemetry, browser interactions uninstrumented                 |
| Deployment/setup/quality scripts   | Checks/logs, not application trace export                                                                                                                                                                                          | Separate operational tracing policy; no host/process/SQL/socket/metrics/log pipeline coverage claim                                                                                    |

The pinned Pi package's caller-span bridge is internal, not exported publicly.
Do not import private vendor files or weaken atomic admission/deduplication merely
to manufacture a link. A supported bridge/upstream export and restart proof are
needed. A complete repository-wide claim is **not established**. Export remains
bounded best-effort: no sampling does not mean no loss or all paths instrumented.

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
Public shell hosting is enabled; actual Worker query/edge-ingest acceptance,
browser interaction export, static/rejection Axiom coverage and real visitor
disconnect proof remain gaps. A successful MCP query is not runtime activation.
