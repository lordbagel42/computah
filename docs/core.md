# Phase 0 core

Status: core and authenticated HTTP entry implemented and locally checked;
deployment belongs to the deployment owner. `apps/server/src/main.ts` is runnable,
with a deliberately small REST transport, not yet a full streaming `AgentAdapter`.
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
- `history(resourceId, cursor?, signal?)`: up to 100 **raw durable entries** per
  page. Continue using Pi's returned cursor; a page is not the complete history.
- `cancel(resourceId, submissionId)`: native `aborted | already_placed | settled`.
  `already_placed` does **not** confirm cancellation of a running turn.
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

## Shared-VPS tenancy and authority

All gateway reads, admissions and controls compare **all three** identity fields
before resolving an actor. Current grants are checked outside prompts on each
operation and again at actor admission/Task dispatch. Capabilities are:

| Capability      | Effect                                                       |
| --------------- | ------------------------------------------------------------ |
| `history.read`  | Read/wait on this scope's histories/results                  |
| `task.send`     | Admit work/delegate within this scope                        |
| `task.control`  | Cancel this scope's queued submission                        |
| `core.maintain` | Compact/sleep this scope's actors; intended owner-only grant |

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
| `COMPUTAH_MODEL`             | Required in real mode: selected supported `provider/model`                                                                                                |
| `COMPUTAH_PI_AUTH_FILE`      | Explicit absolute private writable Pi `auth.json`, selected deployment path `/data/provider/auth.json`                                                    |
| `COMPUTAH_PROVIDER_API_KEY`  | Optional explicit selected-provider key; native provider environment authentication remains supported                                                     |
| `PORT`                       | Public HTTP port, default 3000                                                                                                                            |

The selected deployment provider is **`openai-codex`**, not the newer `openai`
OAuth flow. Pi AI 1.5.0's published provider is named "OpenAI Codex (legacy)",
uses `openai-codex-responses`, and its pinned catalog includes `gpt-6.1-sol`.
The selected reversible deployment default is
`COMPUTAH_MODEL=openai-codex/gpt-6.1-sol`; the executable still requires explicit
real-mode model configuration. Catalog membership is not entitlement. The owner performs official
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
allow HTTP requests up to five seconds to finish, close remaining HTTP connections,
drain Rivet, dispose clients, and explicitly exit: programmatic Rivet shutdown
does not own Node process lifetime. Reserve the native drain grace period in
addition to that bounded HTTP drain when configuring container termination.

### Minimal HTTP API

Every `/v1` request needs `Authorization: Bearer <configured-token>`.

| Request                             | Response                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                      | Unauthenticated `{ready:true,mode}` after registry startup; **not** provider authentication/entitlement proof |
| `GET /v1/viewer`                    | Trusted viewer binding and fixed `conversationId:"primary"`                                                   |
| `POST /v1/submissions`              | Strict `{text,clientMutationId}` →202 signed `id`; retries reuse it, conflicting text→409                     |
| `GET /v1/submissions/:id`           | Status and projected final answer;202 pending,200 terminal                                                    |
| `GET /v1/submissions/:id?wait=true` | Wait up to25s; timeout returns current status, does not cancel work                                           |
| `POST /v1/submissions/:id/cancel`   | Truthful cancellation result; `already_placed`→`unknown`, settled→`too-late`                                  |
| `GET /v1/history?cursor=...`        | Paged original user/final assistant text and signed next cursor                                               |

All scope comes from server configuration. Public submission/cursor handles are
HMAC-bound to exact scope and purpose; another user's token cannot use them.
No endpoint exposes Worker IDs, raw Pi records, instructions, tool calls,
reasoning, compaction summaries, internal tokens or model errors. Output text is
still model-authored untrusted content, not a guarantee against prompt leakage.
The only public projection is original user text/final assistant text. Errors
have fixed safe categories and random correlation IDs, without SDK stacks.

This REST surface reuses shared wire types but does not claim shared snapshot
revision/cursor/event semantics: message revision1 is a static projection, history
has nullable submission IDs, and subscribe/resync/event journal remain separate.
One scoped primary conversation is supported. No browser CORS/login UI is added.

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
  result/control handle denial and safe message projection, including terminal
  length-limited assistant answers.

Checks passed locally on 2026-11-07. This is **not** a mock actor/storage test,
but also not a real model/provider or production compatibility claim. It has not
tested abrupt process/engine death during a pending tool, cross-machine recovery,
real provider compaction quality, agentOS execution, external side effects,
deployment or browser streaming. Native SDK transaction
naming warnings and expected auth-denial warnings appear in tests.

A separate temporary executable check passed authenticated faux Task/result,
SIGTERM exit, exact public history after process restart, reuse of the previous
signed result handle and follow-up; real-mode official ModelRuntime/authPath
bootstrap also passed without credentials. The selected Codex catalog is checked
at startup, not invented dynamically. No actual OAuth refresh or real provider
generation has been exercised in this orb. The deployment owner separately
reported a real official legacy Codex canary on nest-bagel returning the exact
synthetic requested text with `stopReason: stop`. Authenticated deployed
HTTP → Interaction → Worker → restart remains a separate live milestone.

The shared wire contract is owned by `packages/contracts`; core IDs and raw Pi
entries are server-only. The full adapter still needs atomic snapshots, contiguous
revisions, event replay/subscribe and reconnect semantics.
Cancelling an Interaction does not yet cancel an independently running Worker.
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
