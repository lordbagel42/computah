# Phase 0 core

Status: implemented locally, not deployed. The core is a server-side library in
`apps/server/src/core.ts`, not an authenticated public HTTP service or a finished
`AgentAdapter`. It imports Effect 4.1.2, RivetKit 3.0.6, `@rivet-dev/pi` 0.5.6 and
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
the identity. No browser endpoint or authentication issuer is implemented here.

The session exposes:

- `interactionId`: stable Interaction resource identity for that scope.
- `workerId(label = "primary")`: stable Worker resource identity in that scope.
- `submit(resourceId, text, requestId, signal?)`: durable admission, returning a
  native Pi `submissionId`. Identical concurrent/retried mutations reuse it;
  different text under the same ID conflicts. Empty/oversized inputs are rejected.
- `wait(resourceId, submissionId, signal?)`: native settled submission record.
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
grant revocation blocks new operations, not already completed work or disclosure
from a previously authorized pending wait; session revocation/stream rechecks
need the future authenticated transport.

Application logs emit only `computah.pi.report`, not SDK reports/messages/tool
arguments. SDK logs may include actor IDs/keys and fixed error categories; treat
runtime logs as operator-only. No telemetry exporter is configured or verified.

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

Checks passed locally on 2026-11-07. This is **not** a mock actor/storage test,
but also not a real model/provider or production compatibility claim. It has not
tested abrupt process/engine death during a pending tool, cross-machine recovery,
real provider compaction quality, agentOS execution, external side effects,
deployment, public authentication or browser streaming. Native SDK transaction
naming warnings and expected auth-denial warnings appear in tests.

The shared wire contract is owned by `packages/contracts`; core IDs and raw Pi
entries are server-only and are not that protocol. The future adapter must
validate unknown inputs, emit safe text projections (no prompts/tool args/raw
metadata), maintain atomic snapshots/cursors/revisions, map native outcomes
truthfully, and never label `already_placed` as confirmed cancellation.
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
