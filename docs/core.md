# Phase 0 core

Status: core and authenticated HTTP entry implemented and locally checked;
deployment belongs to the deployment owner. `apps/server/src/main.ts` is runnable,
with REST admission/results and native text-only SSE observation, not yet a full
shared streaming `AgentAdapter`.
It imports Effect 4.1.2, RivetKit 3.0.6, `@rivet-dev/pi` 0.5.6 and
Earendil Pi Durable/AI/schema/Chord/telemetry 1.5.0. Node >=22.19 is required;
the local checks used Node 26.12.1 and TypeScript 7.0.2.

## Ownership and public API

`createCore(options)` returns `{ registry, attach, close }`. Supply a stable,
cryptographically random server-only `connectionSecret` (at least 32 bytes),
model/provider configuration, and an `authorize(scope, capability)` callback
backed by trusted current grants. Do not use browser claims as that callback.
Start the registry with Rivet's documented local runtime configuration, construct
a `Client<typeof core.registry>` for that runtime, then call
`const bind = core.attach(client)`. After **server-side authentication**, call
`const session = bind({ tenantId, userId, agentId })`. Binding copies and freezes
the identity. The executable supplies this binding from configured bearer-token
principals, never client identity fields. It is not a public onboarding issuer.

The session exposes:

- `interactionId`: stable Interaction resource identity for that scope.
- `workerId(label = "primary")`: stable Worker resource identity in that scope.
- `submit(resourceId, text, requestId, signal?)`: durable admission, returning a
  native Pi `submissionId`. Identical concurrent/retried mutations reuse it;
  different text under the same ID conflicts. Empty/oversized inputs are rejected.
- `wait(resourceId, submissionId, signal?)`: native settled submission record.
- `result(resourceId, submissionId, wait?, signal?)`: native status and exact
  final answer entry, rechecking history authority before returning it.
- `observe(submissionId, signal)`: private native Interaction and durably linked
  Worker views; the HTTP layer projects safe text/state, never these raw objects.
- `history(resourceId, cursor?, signal?)`: up to 100 **raw durable entries** per
  page. Continue using Pi's returned cursor; a page is not the complete history.
- `operatorHistory(resourceId, cursor?, signal?)`: existing-only lookup returning
  a page or `null`, never creating a missing actor. Requires current `operator.read`
  and `history.read` before reads and release. Existing actors can wake/resume.
- `cancel(resourceId, submissionId)`: cascade cancellation into linked Workers,
  waiting for native runs to settle. Returns `aborted | already_placed | settled`;
  `already_placed` does **not** confirm cancellation.
- `compact(resourceId)`: await native Pi compaction and return its terminal task.
- `sleep(resourceId)`: request Rivet actor sleep; next access reopens it.

Use `await core.close()` to drain the registry and dispose its internal client;
dispose the caller's client separately. Actor recovery uses a private client,
independent of gateway/browser attachment or lifetime. Preserve the secret and
Rivet storage when reopening. Do not run two owners against the same storage.

Pi owns the transcript, generation, tools and checkpoints. Rivet owns actor
identity/SQLite/lifecycle. Effect wraps application calls with typed failure
categories and content-free spans; it is not a second durable workflow engine.

## Interaction → Task → Worker

Each Interaction is keyed by tenant/user/agent. Its task tool is
`Task({ worker, text, acknowledgement? })`. The optional acknowledgment is plain
public prose (at most 3,500 UTF-16 units), not a final-answer envelope or Worker
instruction. Interaction is instructed to include a brief, natural task-specific
acknowledgment for substantive work, including investigations, research and
self-checks, and choose silence for tiny instant utilities. The argument remains
optional for that silence; no host timer invents one. This is model selection
guidance, not a guarantee of model compliance or faster execution. The existing
durable delegation receipt saves the choice and complete native Task-round call identities.
Only after every Task in that round has an actual Worker admission does observation
release its first nonempty choice in call order. Missing/denied/uncertain admission
suppresses it, including a sibling not yet started in a sequential tool round.
Replays reuse the original receipt; legacy receipts without this metadata stay
silent. Current live input membership, cancellation fences, history/source access
and nonterminal submission state still govern release. No new Task/model/runtime
or outbound effect is created by observation. Task still waits for its Worker and
Interaction synthesizes the final outcome normally. The executable also installs the read-only
[operational discovery and message timing tools](tools.md#operational-data-discovery),
with explicit `operations.read` authorization. Workers receive Pi's native `read`, `write`, and `edit`
only with explicit `files.read` / `files.write` grants. These tools operate in the
Worker actor's private SQLite-backed file namespace, never the host filesystem or
another Worker's storage. See [native tools](tools.md). Workers optionally receive the native
[Tavily web tools](tavily.md), only when the protected key and this principal's
explicit `web.search` / `web.extract` grants are present. Task reads its trusted
session binding, checks current task authority and addresses the Worker by the
same scope plus the local worker label. Model arguments cannot select a tenant.
Follow-ups that use the same label reopen/reuse the same Worker and history.

Task execution is declared replay-safe because dispatch uses a stable
`task:<Pi-tool-task-id>` admission ID. Gateway IDs are separately namespaced
`input:<client-request-id>`. A small Pi document-family receipt stores the text
hash and submission ID in the **same Pi commit** as admission, so concurrent
Rivet actions cannot race an in-memory check-then-submit. This does not provide
exactly-once external effects. Tavily tools use unsafe replay and no automatic
HTTP retries because interrupted requests may already consume provider credits.

New admissions also atomically append an identifier-only predecessor link and
host admission timestamp to the receipt. Identical retries do not advance this
chain or rewrite the timestamp. The timing tool bounds traversal to 256 receipts,
finds the earliest current-run input, and selects the newest completed input
before it. In an all-Slack run it skips background/non-Slack inputs sharing the
actor; mixed runs retain actor-wide selection. `recent` catalogs up to eight
such completed targets with bounded input previews under current `history.read`
as well as `operations.read`, without querying Axiom or transport. It permits
exact-ID discovery for older retained inputs, including those whose original
Slack footer exposed only a reply-routing UUID. Current coalesced inputs and
newer queued messages cannot become the diagnostic target. An explicit older
durable request ID is also supported; it
must belong to this actor and precede the active run. Legacy/unindexed inputs
and lookup limits return unavailable, not fabricated historical timing.

The tool checkpoints its selected target. Pi's submission carrier identifies the
admission trace; the final answer's `byTaskId` and task carrier identify actual
execution, including non-leading coalesced inputs that share another admission's
run. Existing durable delegation records resolve up to 20 linked Workers through
their own receipts, with omitted links counted explicitly. Private actor,
conversation, receipt, input and answer identifiers are available to the authorized
runtime tool, not exported as new Axiom attributes or public wire fields.

### Causal admission tracing

The pinned Pi Durable 1.5.0 pnpm patch adds an explicit host-only
`SubmissionDraft.trace` parent carrier. Omitted carriers retain the vendor's
independent-root behavior; no private Rivet imports or export-time reparenting
are used. Gateway and Worker admission RPCs explicitly pass validated trace IDs,
not request cancellation or baggage. Native admission stores its own child span
carrier in the same transaction as the submission, receipt and source evidence.
Task delegation freezes the actual tool invocation carrier with its intent;
replay uses it without changing the admission fingerprint or original receipt.

Native scheduling already persists task carriers. Resumed phase attempts are new
finite spans under those stored parents, not one invented span across downtime.
Busy follow-ups use their own stored admission carrier; coalesced execution uses
its first input as parent and additional inputs as links. Independent later
requests, steering and legacy records are never retroactively reparented.
Local installed-package tests cover opt-in/default behavior, rollback, dedup,
queued cancellation, busy follow-ups and fresh-storage recovery. An actual HTTP
and Rivet/Pi run verifies Interaction discovery → Task → Worker discovery → final
answer ancestry through sanitized trace/log export with a synthetic model.
This is not a live Slack or production Axiom receipt.

Existing `self_docs_discover`, `operations_discover`, `axiom_discover` and Worker
`web_search` executions retain their fixed operation and tool identities. Pi's
deferred-catalog `tool_search` extension is not installed; no empty search tool
or change to direct tool availability is introduced to manufacture evidence.

Dispatch uses submit/wait/history, not the adapter's ten-minute `prompt` helper.
Native Pi compaction remains enabled by default. `compact()` appends a
`pi.compaction` summary/head for active context; it does not replace or delete
original entries. Raw `history()` is distinct from active model context.

Cancellation records the active native run inputs and linked Task admissions in
a Pi transaction before scheduling a background `computah.cancel` task. It fences
new dispatches for those inputs, aborts the Interaction run, then tombstones each
linked Worker receipt and aborts/waits its native active run (or withdraws queued
input). A delayed/replayed Worker admission cannot pass a cancellation tombstone.
Only a settled aborted/withdrawn native submission becomes public `cancelled`;
the public terminal result also waits for its cascade. Transient cancellation
RPC failures commit a native sleeping retry instead of a permanently faulted
task; retries repeat idempotent stops/tombstones. Already completed answers remain
available. Pi can coalesce several same-scope
inputs into one native run: cancelling that run cancels its coalesced inputs.
No cross-scope cancellation occurs. A disconnected observer does not cancel work.
This durable execution is not a new reminder/calendar scheduler. Native task
phases/checkpoints exist; this packet does not add scheduling or question/approval
tools, signals/steering, or task progress notifications to external adapters.

### Default personality

`src/personality.ts` supplies role-specific defaults on every actor wake via
`Conversation.configure({instructions})`, including existing conversations.
Changing only root creation options would leave existing scopes on old prompts.
The voice is adapted from public `lordbagel42/agent` source at
[`4ca93fb`](https://github.com/lordbagel42/agent/tree/4ca93fb3973f2106013f90cc50bedd4943ff00a9)
(`src/runtime/personality.ts` and `src/runtime/prompt.ts`): warm, balanced, subtly
playful Interaction prose, lowercase conversational voice, faithful casing for
deliverables. Workers remain task-focused. No June identity, private memory,
authority, tools or model configuration is imported. Tests check provider-visible
instructions/tool inventory and synthetic deliverables, not real-model tone.

## Shared-VPS tenancy and authority

All gateway reads, admissions and controls compare **all three** identity fields
before resolving an actor. Current grants are checked outside prompts on each
operation and again at actor admission/Task dispatch. Capabilities are:

| Capability      | Effect                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| `history.read`  | Read/wait on this scope's histories/results                                   |
| `operator.read` | Inspect existing actors in this scope; also requires `history.read`           |
| `task.send`     | Admit work/delegate within this scope                                         |
| `task.control`  | Cancel this scope's queued or active submission and linked Workers            |
| `core.maintain` | Compact/sleep this scope's actors; intended owner-only grant                  |
| `web.search`    | Search public evidence through configured Tavily, in this scope               |
| `web.extract`   | Extract bounded public URL evidence through configured Tavily, in this scope  |
| `files.read`    | Read this Worker's private database-backed files                              |
| `files.write`   | Write this Worker's private database-backed files; edit also needs files.read |

The owner may receive the broader maintenance grant. It is **not** cross-user
history authority. No one receives ambient host shell or shared-code writes.
Only the three native file tools are registered, gated by current grants at
execution independently of Task admission; the whole CodingTools extension
(including bash), native host execution and sandbox tools are not installed.
AgentOS-first execution remains later intent, not a fake implemented provider.

Private actor connections require an HMAC bound to actor role and exact key;
forged viewer/capability fields are ignored. The secret, internal tokens, raw
Rivet client, engine/inspector and registry are privileged server material and
must not be given to browsers or tenants. These are internal connection proofs,
not expiring user sessions or a replacement for ingress authentication. Current
grant revocation blocks new operations; `result()` rechecks before disclosure.
The executable reads grants at startup: restart it to rotate/revoke bootstrap
tokens. An already-running Worker is not retroactively cancelled by revocation.

Application logs emit only `computah.pi.report`, not SDK reports/messages/tool
arguments. SDK logs may include actor IDs/keys and fixed error categories; treat
runtime logs as operator-only. The optional [Axiom exporter](observability.md)
ships sanitized spans, not raw logs; see its separate local/live activation status.

## Runnable protected service

Run `pnpm --filter @computah/server start` (production dependency `tsx` 4.21.0).
Container settings: Node >=22.19, `HOME=/data`, `NODE_ENV=development`,
`RIVET_RUN_ENGINE=1`, `PORT=8787`; publish only HTTP, preferably host loopback
behind a TLS/authenticated access boundary. Never publish engine/inspector ports.
Preserve the whole private `/data` volume, including `$HOME/.rivetkit`; the
executable restart check observed this directory and retained history/receipts.
No two registries should own the same local storage concurrently.

Configuration (secrets belong in private operator env files, never Git/state):

| Variable                     | Meaning                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPUTAH_CONNECTION_SECRET` | Stable server-only random secret, at least 32 bytes; also signs scoped public handles                                                                     |
| `COMPUTAH_AUTH_JSON`         | Secret nonempty array of `{token,tenantId,userId,agentId,capabilities,displayName?}`; tokens at least 32 characters and unique; duplicate scopes rejected |
| `COMPUTAH_MODE`              | `real` (default), or explicit `faux`; no automatic faux fallback                                                                                          |
| `COMPUTAH_INTERACTION_MODEL` | Optional real-mode role setting; defaults to and accepts only `openai-codex/gpt-6.1-terra`                                                                |
| `COMPUTAH_WORKER_MODEL`      | Optional real-mode role setting; defaults to and accepts only `openai-codex/gpt-6.1-sol`                                                                  |
| `COMPUTAH_PI_AUTH_FILE`      | Explicit absolute private writable Pi `auth.json`, selected deployment path `/data/provider/auth.json`                                                    |
| `COMPUTAH_PROVIDER_API_KEY`  | Optional explicit selected-provider key; native provider environment authentication remains supported                                                     |
| `PORT`                       | Public HTTP port, default 3000                                                                                                                            |

The selected deployment provider is **`openai-codex`**, not the newer `openai`
OAuth flow. Pi AI 1.5.0's published provider is named "OpenAI Codex (legacy)",
uses `openai-codex-responses`, and its pinned catalog includes both selected roles.
Remove obsolete `COMPUTAH_MODEL` before the authorized backend/Slack resumption;
real mode rejects it. Both roles use high reasoning, and the official Models
boundary forces outgoing priority/high after caller payload transforms, including
generation, compaction and replay. Raw provider-returned tiers are logged safely;
requesting priority does not guarantee priority execution. See [model policy](model-policy.md)
for exact configuration, diagnostics and checkpoint/drain limitations. No silent
standard-tier or model fallback is selected. Catalog membership is not entitlement.
The owner performs official
`pi-ai login openai-codex` privately using pinned Pi AI 1.5.0, in the private
provider directory (the CLI writes `auth.json` in its current directory).
No laptop/other-app auth is discovered or copied. Account entitlement remains
provider-controlled and must be established by an actual request.

The exported official coding-agent 1.5.0 `ModelRuntime.create({authPath,
modelsPath:null})` is passed through Pi's supported `models` option. Its official
file-backed `AuthStorage` locks serialized credential modification and provider
OAuth refresh; credentials/refresh tokens are not model/tool inputs or logs.
Mount the **directory** writable by UID1000, not a read-only single file: refresh
must be able to lock and persist credentials. Use mode0700/0600 permissions.
Without an explicit path, an in-memory credential store prevents accidental
discovery of `$HOME/.pi` auth; provider-native API-key env still works. No model
configuration, extensions or host tools are imported from a Pi user directory.

The executable captures `PORT` then removes it from the child-service environment:
the exercised native child startup otherwise bound that same port, producing
`EADDRINUSE`. Public ingress still binds the captured port on `0.0.0.0`. It opens
only after `registry.startAndWait()` succeeds. SIGTERM/SIGINT stop admissions,
drain Rivet, dispose clients, and explicitly exit: programmatic Rivet shutdown
does not own Node process lifetime. Allow the native drain grace period when
configuring container termination; a running long-poll may add up to25 seconds.

### Minimal HTTP API

Every `/v1` request needs `Authorization: Bearer <configured-token>`.

| Request                                | Response                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                         | Unauthenticated `{ready,mode,revision?}` after registry startup;503 while stopping; **not** provider authentication/entitlement proof |
| `GET /v1/viewer`                       | Trusted viewer binding and fixed `conversationId:"primary"`                                                                           |
| `POST /v1/submissions`                 | Strict `{text,clientMutationId}` →202 signed `id`; retries reuse it, conflicting text→409                                             |
| `GET /v1/submissions/:id`              | Status and projected final answer;202 pending,200 terminal                                                                            |
| `GET /v1/submissions/:id?wait=true`    | Wait up to25s; timeout returns current status, does not cancel work                                                                   |
| `GET /v1/submissions/:id/events`       | Authenticated SSE: resync, live text/state replacements, authoritative terminal result                                                |
| `POST /v1/submissions/:id/cancel`      | Truthful cancellation result; `already_placed`→`unknown`, settled→`too-late`                                                          |
| `GET /v1/history?cursor=...`           | Paged original user/final assistant text and signed next cursor                                                                       |
| `GET /v1/operator/snapshot?cursor=...` | Operator-only Interaction → recorded Task → Worker safe projection; existing-only actors, explicit missing evidence                   |
| `GET /v1/operator/history?cursor=...`  | Operator-only page for the actor selected by a signed, scope/purpose-bound continuation                                               |

All scope comes from server configuration. Public submission/cursor handles are
HMAC-bound to exact scope and purpose; another user's token cannot use them.
The ordinary product endpoints do not expose raw Worker actor IDs, raw Pi records, instructions, tool calls,
reasoning, compaction summaries, internal tokens or model errors. Output text is
still model-authored untrusted content, not a guarantee against prompt leakage.
The public projection is original user/final assistant text and live assistant
text/state with a linked Worker label. Thinking, tool arguments and tool results
are not streamed. Errors
have fixed safe categories and random correlation IDs, without SDK stacks.

The two operator endpoints additionally expose scoped resource/Task identifiers
and recorded delegation relationships, only with both current `operator.read` and
`history.read` grants. Browser identity/actor inputs are not accepted. Current
bearer binding and grants are rechecked before release. Responses are bounded,
non-atomic evidence, not lifecycle or completion truth. Known configured credential
values and protected `COMPUTAH_OPERATOR_PRIVILEGED_URL_PREFIXES` JSON-array URL
prefixes are redacted; native engine endpoint/token are included by the host.
This is not arbitrary-secret DLP. The web gateway/session and owner SSH-loopback
access contract are in [the dashboard guide](../apps/dashboard/README.md).

This REST surface reuses shared wire types but does not claim shared snapshot
revision/cursor/event semantics: message revision1 is a static projection, history
has nullable submission IDs, and the shared durable event journal remains separate.
One scoped primary conversation is supported. No browser CORS/login UI is added.

SSE starts with `resync` sequence0 and current full observation replacements,
then changed `observation` frames. Sequence numbers are connection-local, not
durable replay cursors; `Last-Event-ID` does not request replay. Reconnect starts
fresh, reauthenticates and resnapshots. Native `conversation.watch`/`pi.view` Chord
deltas supply actual in-progress model text, not simulated completed-text chunks.
Native gaps trigger a full rewatch. Slow clients receive coalesced replacements
with socket backpressure rather than an unbounded delta journal. A terminal
`result` contains the same exact final answer as REST, even if the observation
attach races completion, and closes the stream. Stop/length final text is retained.
Broken native observation closes the connection; reconnect or REST result polling
recovers the authoritative result. This is not shared AgentAdapter completion.

## Validation and limitations

From the integrated workspace run `pnpm --filter @computah/server typecheck` and
`pnpm --filter @computah/server test`. The suite uses the **actual installed
Rivet native runtime + @rivet-dev/pi + Pi Durable SQLite backend**, with only the
model replaced by pi-ai's deterministic in-process faux provider. It checks:

- Interaction Task → Worker result, follow-up reuse, concurrent admission dedup,
  and conflicting mutation rejection.
- Successful native compaction, retaining exact original entry records; equality
  after actor sleep/wake and a new registry activation; post-restart follow-up
  and retained conflict receipts.
- Two users in one tenant denied each other's histories, task admission and
  controls; mismatched tenant/agent denied; no-token/forged-token direct actor
  connections denied; revoked grants denied; no model-visible shell/file tools.
- Actual authenticated HTTP Task/result/follow-up, duplicate/conflicting sends,
  missing/invalid bearer rejection, body-supplied scope rejection, cross-user
  result/control handle denial and safe message projection.
- Native live Worker and Interaction text before completion, observer disconnect
  and fresh resync, terminal answer preservation/reopen, active Worker cascade
  cancellation, stable stopped Worker history and subsequent same-Worker follow-up.

Checks passed locally on 2026-11-08. This is **not** a mock actor/storage test,
but also not a real model/provider or production compatibility claim. It has not
tested abrupt process/engine death during a pending tool, cross-machine recovery,
fault-injected cancellation RPC retry/recovery or a forced queued-placement race,
real provider compaction quality, agentOS execution, external side effects,
deployment or a browser client. Native SDK transaction
naming warnings and expected auth-denial warnings appear in tests.

A separate temporary executable check passed authenticated faux Task/result,
SIGTERM exit, exact public history after process restart, reuse of the previous
signed result handle and follow-up; real-mode official ModelRuntime/authPath
bootstrap also passed without credentials. The selected Codex catalog is checked
at startup, not invented dynamically. No actual OAuth refresh or real provider
generation has been exercised here: owner login and an authenticated live request
are the remaining live milestone, not a reason to block protected bootstrap.

The shared wire contract is owned by `packages/contracts`; core IDs and raw Pi
entries are server-only. The full adapter still needs atomic snapshots, contiguous
revisions, event replay/subscribe and reconnect semantics.
Cancellation now reaches Workers durably linked to the active Interaction run;
it does not cancel unrelated historical work or claim external-effect rollback.
No Slack/Gmail/memory/DEBUGSHARE, UI files, cloud provisioning or production writes
are part of this packet. See `contracts.md` for the separately owned wire seam.

## Private Gmail source authority

Optional host-only `CoreOptions.sources` supplies current account-generation
checks, availability and bounded original-source preloads. It requires an injected
Models runtime. `session.submitSource(description, receipt, grant, evidence)` admits
only the description as public user text; private frozen evidence is projected in
`beforeRequest`. Public HTTP requests remain `{clientMutationId,text}` only.
The account/version document is cumulative: derived Worker evidence propagates
back into Interaction before Task output is released. Each Task freezes inherited
grants with its delegation receipt so native replay uses the same admission hash.
Current grant checks remain independent of that immutable fingerprint.

Pi1.5 generation hooks swallow errors. `source-models.ts` therefore requires a
fresh native invocation-signal authority check at the actual Models boundary and
each actual HTTP attempt, rather than trusting a hook throw. Fenced requests use
SSE because WebSocket retries bypass injected fetch. Codex invokes its payload
hook only once, so that hook alone cannot protect its transport retry loop. The
same transport fence checks queued Sentinel reviews against their frozen grants.
Tool execute wrappers
cover initial and safe-replayed calls; history/result/observation release also
rechecks authority. Grant revocation fences the conversation's derived history.
Source-enabled cores decline native compaction and unknown deferred-poll signals,
whose pinned retry phases lack a suitable hook, retaining original entries rather
than sending them through an unfenced model call. The real bootstrap retains this
deny-only boundary even after Gmail configuration is removed. See [Gmail](gmail.md)
for protected configuration, runtime capabilities and live acceptance limits.

## API provenance

- [Published @rivet-dev/pi 0.5.6 package](https://unpkg.com/@rivet-dev/pi@0.5.6/package.json): compatible peer ranges and Node minimum.
- [Published actor lifecycle](https://unpkg.com/@rivet-dev/pi@0.5.6/dist/actor.js): actor-owned database, open on wake, resume after user onWake, close on sleep.
- [Published action types](https://unpkg.com/@rivet-dev/pi@0.5.6/dist/actions.d.ts): root, submit, submission wait/abort, paginated entries and compaction APIs.
- [Pi Durable 1.5.0 README](https://unpkg.com/@earendil-works/pi-durable@1.5.0/README.md): native compaction preserves original entries; replay-safe tools, transactional submit and roll-forward storage caveats. Older binaries are not guaranteed to reopen newer storage.

These exact published sources were inspected before implementation. Neither the
obsolete `@agentos-software/pi` package nor an invented custom Pi database option
is used. Optional cbor-extract/protobufjs/@google/genai build scripts were left
disabled; they were not needed by the exercised local path.
