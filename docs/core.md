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

Each Interaction is keyed by tenant/user/agent. Its only registered tool is
`Task({ worker, text })`; the Worker has no tools. The tool reads its trusted
session binding, checks current task authority and addresses the Worker by the
same scope plus the local worker label. Model arguments cannot select a tenant.
Follow-ups that use the same label reopen/reuse the same Worker and history.

Task execution is declared replay-safe because dispatch uses a stable
`task:<Pi-tool-task-id>` admission ID. Gateway IDs are separately namespaced
`input:<client-request-id>`. A small Pi document-family receipt stores the text
hash and submission ID in the **same Pi commit** as admission, so concurrent
Rivet actions cannot race an in-memory check-then-submit. This does not provide
exactly-once external effects; no external-effect tools are enabled.

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

| Capability      | Effect                                                             |
| --------------- | ------------------------------------------------------------------ |
| `history.read`  | Read/wait on this scope's histories/results                        |
| `task.send`     | Admit work/delegate within this scope                              |
| `task.control`  | Cancel this scope's queued or active submission and linked Workers |
| `core.maintain` | Compact/sleep this scope's actors; intended owner-only grant       |

The owner may receive the broader maintenance grant. It is **not** cross-user
history authority. No one receives ambient host shell or shared-code writes:
CodingTools, native execution, sandbox tools and file tools are not installed.
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
runtime logs as operator-only. No telemetry exporter is configured or verified.

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
| `COMPUTAH_INTERACTION_MODEL` | Optional real-mode role setting; defaults to and accepts only `openai-codex/gpt-6.1-terra`                                                                  |
| `COMPUTAH_WORKER_MODEL`      | Optional real-mode role setting; defaults to and accepts only `openai-codex/gpt-6.1-sol`                                                                    |
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

| Request                             | Response                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                      | Unauthenticated `{ready:true,mode}` after registry startup; **not** provider authentication/entitlement proof |
| `GET /v1/viewer`                    | Trusted viewer binding and fixed `conversationId:"primary"`                                                   |
| `POST /v1/submissions`              | Strict `{text,clientMutationId}` →202 signed `id`; retries reuse it, conflicting text→409                     |
| `GET /v1/submissions/:id`           | Status and projected final answer;202 pending,200 terminal                                                    |
| `GET /v1/submissions/:id?wait=true` | Wait up to25s; timeout returns current status, does not cancel work                                           |
| `GET /v1/submissions/:id/events`    | Authenticated SSE: resync, live text/state replacements, authoritative terminal result                        |
| `POST /v1/submissions/:id/cancel`   | Truthful cancellation result; `already_placed`→`unknown`, settled→`too-late`                                  |
| `GET /v1/history?cursor=...`        | Paged original user/final assistant text and signed next cursor                                               |

All scope comes from server configuration. Public submission/cursor handles are
HMAC-bound to exact scope and purpose; another user's token cannot use them.
No endpoint exposes raw Worker actor IDs, raw Pi records, instructions, tool calls,
reasoning, compaction summaries, internal tokens or model errors. Output text is
still model-authored untrusted content, not a guarantee against prompt leakage.
The public projection is original user/final assistant text and live assistant
text/state with a linked Worker label. Thinking, tool arguments and tool results
are not streamed. Errors
have fixed safe categories and random correlation IDs, without SDK stacks.

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

## API provenance

- [Published @rivet-dev/pi 0.5.6 package](https://unpkg.com/@rivet-dev/pi@0.5.6/package.json): compatible peer ranges and Node minimum.
- [Published actor lifecycle](https://unpkg.com/@rivet-dev/pi@0.5.6/dist/actor.js): actor-owned database, open on wake, resume after user onWake, close on sleep.
- [Published action types](https://unpkg.com/@rivet-dev/pi@0.5.6/dist/actions.d.ts): root, submit, submission wait/abort, paginated entries and compaction APIs.
- [Pi Durable 1.5.0 README](https://unpkg.com/@earendil-works/pi-durable@1.5.0/README.md): native compaction preserves original entries; replay-safe tools, transactional submit and roll-forward storage caveats. Older binaries are not guaranteed to reopen newer storage.

These exact published sources were inspected before implementation. Neither the
obsolete `@agentos-software/pi` package nor an invented custom Pi database option
is used. Optional cbor-extract/protobufjs/@google/genai build scripts were left
disabled; they were not needed by the exercised local path.
