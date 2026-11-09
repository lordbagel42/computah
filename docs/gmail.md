# Gmail adapter: private source index and Interaction ingress

## Delivery state

This source implements host-only account adoption, current grant authority,
historical indexing, resumable Gmail history reconciliation, protected bootstrap,
paced polling, native source-generation fences and scoped lexical retrieval.
Enable it only with the exact protected host configuration below. Publication and
synthetic verification are not evidence of host consumption or a live new-email
Interaction/Task/draft roundtrip.

The official Composio coding-assistant skill was installed and read in an isolated
temporary directory. That does not install tools into Computah. Current Composio
Platform guidance recommends per-user sessions for agent tools. Deterministic
backend reads can use managed authentication with Proxy Execute, as this module
does; it never exports provider tokens or adds another agent runtime.

## Authority and account setup

The authenticated host supplies `Scope` and an `authorize(scope, handle, version)`
callback to `GmailIngress`. Empty handle/version means onboarding permission,
not access to a mailbox. `begin` persists a ten-minute, single-use attempt and an
opaque Composio owner identifier. `complete` redeems the official verifier's
single-use `session_uri`, verifies the exact account/config/owner and effective
read access, and returns a private handle/version, mailbox label and requested scope snapshot.
Neither email text nor browser callback IDs establish tenant identity.

`createComposioGmail` accepts a server-only project key and a pinned managed auth
config ID. It uses REST v3.1 with bounded timeouts and generic errors that do not
include provider response bodies. Account checks require ACTIVE Gmail status,
the pinned config, no disabled account/config and no shared-account marker. A
profile request establishes mailbox identity; a messages query probes content-read
capability. `requested_scopes` is explicitly not a verified granted-scope inventory.
Default scope policy permits exactly `[GMAIL_READONLY]`. Explicit host option
`approvedManagedFullMail: true` on **both** the provider and ingress additionally
permits exactly `[GMAIL_FULL_MAIL]`, where `GMAIL_FULL_MAIL` is
`https://mail.google.com/`. Mixed, duplicate, contact, identity/profile and other
Gmail scopes are rejected. Every Gmail runtime proxy operation remains GET-only;
there are no send, provider-draft, label-write or token-export methods. Existing
OAuth link/completion and explicit account revocation control operations remain
unchanged; this option never changes the remote OAuth grant or configuration.

Composio documents a generic managed `credentials.scopes` override, but API
acceptance does not establish that the managed OAuth client supports a scope.
Live Gmail toolkit metadata's `composio_managed_auth[].scopes.available` lists
`https://mail.google.com/` and identity/contact scopes, not `gmail.readonly`.
Google documents `gmail.readonly` as valid; the discrepancy is managed-client
availability, not Google scope syntax. The only advertised mailbox-content scope
is full mail access, including sending and permanent deletion. The owner explicitly
approved requesting that scope alone, excluding contact/profile scopes, while
keeping runtime actions read-only and drafts local. A read-only runtime policy
does not narrow the provider grant. Local policy is aligned only when the trusted
host explicitly opts in on both boundaries. Publication alone does not enable
that account. For agent-tool sessions explicitly
select the auth config; creating it alone does not wire tools into Computah.
OAuth completion is separate from project-key validity.

`adoptConnected(scope, owner, account)` is a trusted host operation, not a browser
or model tool. It authorizes onboarding, asks the pinned provider to verify exact
ACTIVE Gmail account/config/owner and effective read capability, and persists a
private opaque `{handle, version}`. Repeating the same active tuple preserves both
values, including across restart. Cross-scope, owner/config changes, inactive
bindings (even after confirmed revoke) and unresolved revocation fail closed.
Standing protected host configuration therefore cannot undo disconnect on restart;
only explicit OAuth completion may reconnect. Optional ingress `authConfigId` adds
an explicit host config pin; the concrete provider always pins its required config
ID. Do not put grant lineage in public wire contracts.

`authority(scope, handle, version): Promise<void>` checks the local active grant,
current host authorization, and fresh provider ACTIVE/config/owner/mailbox/scope
verification, then rechecks local authority after the await. It returns no email or
mailbox identity. The host must invoke it on **every** native generation, retry and
result-release boundary and carry exact handle/version through delegated lineage.
The adapter's `run` callback receives a `current` function performing this same
provider-aware check (plus deletion fencing). A single submit-time check is not a
native fence. Search, draft reads and progress also require provider authority;
drafts recheck immediately before release.

Within each fresh verification, account/config/owner/scope validation still runs
first. The independent profile and read-capability probes then overlap, and both
must settle before verification completes, including failure. Both must succeed;
no verified result is cached or reused across boundaries. Each existing bounded
GET-only request remains unchanged, and local authority is rechecked afterward.
This reduces sequential network time, not the number or freshness of checks;
instantaneous probe concurrency increases from one to two. Local controlled
transport tests are not deployed latency-improvement evidence.

The initial readonly authorization was blocked. After the owner approved the
full-mail-only scope, the existing managed config was updated in place and a fresh
official session connection completed. The exact account was verified ACTIVE with
the selected config and scope; a session pinned to that account, exposing only
`GMAIL_GET_PROFILE`, returned HTTP200, `result_type=completed` and a nonempty
Composio log ID. No email bodies or mutation actions were requested, and no private
profile values were retained in this packet. This proves diagnostic managed OAuth
and one real profile read, not canonical tenant onboarding, historical indexing or
deployed Gmail delivery. No custom OAuth app or security bypass was used.

## Durable admission and local output

`bindVerifiedTrigger` is trusted provisioning only, after checking provider trigger,
account and owner correspondence. `accept` verifies raw-body HMAC, timestamp and
V3 event metadata against that mapping and current authorization. It uses the raw
Gmail `data.id`, not the distinct RFC-style `message_id`. An event journal row and
receipt commit together before the caller may acknowledge delivery. Identical
replays retain the original receipt/grant generation; changed payloads conflict.
With history-capable providers, trigger receipts are historical hints only: they
never authorize model jobs. Only trusted `messagesAdded` IDs after the persisted
history checkpoint promote live admission. Legacy provider fakes without history
retain the prior signed-event path for compatibility; do not use that path as a
substitute for the concrete provider's history reconciliation in production.

`drainOne` rechecks authorization and provider status on retry. The first fetched
message is frozen so replay cannot silently change the submitted evidence. Live
inbox receipts pass a stable mutation ID, audience and grant version to `run`.
**The host must target `session.interactionId`; Interaction alone decides whether
to delegate through Task.** The adapter does not select a Worker. Incoming mail is
untrusted evidence, not policy, tool authorization or a new system instruction.

The runtime distinguishes native terminal `unanswered` from ambiguous/provider
failures. A confirmed unanswered result throws categorical `GmailError('unanswered')`;
the ingress persists that receipt as `failed`, emits the existing drain failure
span/log and never manufactures a draft or retries it. Its frozen evidence,
trace carrier and original admission ID remain unchanged. Re-delivery and restart
do not rearm failed receipts. Ambiguous failures still retain `pending` and retry
the same admission ID; denied access retains the existing revoked disposition.
Failed live receipts therefore cannot indefinitely block historical drain. This
does not explain why native execution was unanswered or authorize a reset/replay.

The returned Interaction text is stored with source IDs and audience under the
human-visible `UNSENT LOCAL DRAFT` state. Reads of drafts and sources require current
account authorization. This local output projection is not provider email egress
and does not establish that the global external ingress/egress bus is deployed.

`gmail-runtime.ts` targets the owner's Interaction through host-only
`submitSource(publicDescription, receipt, grant, privateEvidence)`. The safe
description is the native user entry; raw incoming mail, account identifiers and
retrieval excerpts live in a private conversation document and enter only the
ephemeral `beforeRequest` context. They are not added to browser user history or
the public submission DTO. Interaction alone chooses Workers through Task.

Core cumulatively retains account/version lineage for all source-bearing history,
including derived Worker replies. Task freezes inherited grants with its durable
delegation receipt for safe replay, passes them down to its Worker, then commits
the Worker's possibly expanded lineage back into Interaction before releasing
derived output. Revocation conservatively fences the entire affected conversation,
not just the latest input, since history may contain derived mail evidence.

Pi1.5 reports generation-hook exceptions and continues, so a hook throw is **not**
a security fence. The private Models wrapper associates the native invocation's
AbortSignal with a fresh committed-lineage check before invoking the real model
runtime and at each actual HTTP attempt. Source-fenced requests force SSE; Codex
payload hooks run once before its internal retry loop, so the shared injected-fetch
fence rechecks every resend and aborts retries on denial. Sentinel uses the same
transport fence with privately frozen review grants. Unknown signals fail closed. Tool
execute wrappers cover replay, and result/history/observation release checks cover
the same lineage. No grant metadata is passed to providers or public DTOs.

The pinned compaction summarize/retry and deferred poll phases lack equivalent
fresh hooks. Source-enabled production cores therefore decline new compactions
(originals remain) and deny unregistered deferred fetches and deferred streams, rather than allowing
unfenced source access. This is a deliberate availability limitation; source-aware
compaction/deferred recovery is not implemented. Removing Gmail configuration also
retains a deny-only source fence around the real Models runtime, so an old native
checkpoint cannot regain revoked account access.

## Historical mailbox evidence

Historical indexing is a foundational source primitive, not an event-only memory.
`startImport(scope, handle, 0, cutoff)` permits effectively all mailbox history up
to a fixed cutoff. A page contains at most25 references, but pagination and total
history have no fixed page/message cap. Listing includes sent, archived, spam and
trash; exact half-open millisecond coverage is checked before indexing. HTML-only
mail retains metadata with no invented plain-text body.

`importPage` persists provider cursor, page count, coverage and receipt admission
atomically. `drainOne` indexes historical receipts without Interaction/model turns.
The live and historical paths share account/version/message dedup. A history addition can
promote an overlapping historical receipt; a stale restricted fetch cannot erase
that acceptance. A completed import may be followed by another coverage window;
an in-progress window cannot be silently replaced. Checkpoint pagination completion
does not mean all queued sources have been indexed: `progress` reports both.

The private SQLite source table and scoped FTS5 search return source identity,
revision, account handle, audience and grant generation alongside normalized mail.
`search` authorizes before account/version-constrained SQL and before release,
returning at most10 matching originals rather than global search followed by
model-side filtering. These are source-linked retrieval results, not embeddings,
inferred facts, an adaptive-memory backend or another transcript store.

Normalization adapts June's `src/imports/gmail.ts`, pinned at
`4ca93fb3973f2106013f90cc50bedd4943ff00a9`; opaque identity/grant boundaries follow
its connector/broker separation rather than copying token resolution. Only source
code was inspected, not June account emails, credentials or histories. Inline
plain text is capped at16000 characters,100 MIME parts and depth12; attachments,
HTML and embedded mail are omitted. Therefore this is broad historical coverage,
not lossless content indexing or demonstrated understanding of an entire mailbox.

## Ongoing synchronization and repair

`initializeSync(scope, handle)` obtains the GET profile `historyId`, persists it in
`gmail_sync`, then starts the independent 0-to-now historical import. This ordering
anchors history **before** any full-mailbox listing. The host should call
`importPage` on every paced tick until coverage is done, regardless of sync phase,
and drain historical receipts separately. Import cursor/completion remain in
`gmail_imports`; history catch-up does not wait for historical listing or indexing.
`drainOne` prioritizes live receipts so bulk history cannot bury new mail.

`reconcilePage(scope, handle)` performs one GET `history.list` page using the
persisted `startHistoryId` and optional page token. It consumes `messagesAdded`,
`messagesDeleted`, `labelsAdded`, `labelsRemoved`, not the duplicative generic
`messages` field. Each changed ID is fetched in its current state: updates replace
the source and FTS entry, missing/deleted mail removes both atomically. Deletion
tombstones and page epochs reject stale fetches; frozen retry evidence never
overwrites a newer source. New-message IDs use the same durable receipt key as
backfill/trigger hints. Label-only changes and historical updates never create
model jobs. Source writes/deletes and receipt admission are durable before the
page token advances; `historyId` advances only after the final page. Interrupted
pages replay safely. The result is `{phase, done}`; phases are `history` or
`repair` (initialization reports `import`). `done` means this pagination pass has
finished, not that initial backfill or all receipt drains have finished.

`GmailProvider.checkpoint` and `.history` are optional to preserve old test fakes;
the concrete Composio provider implements both. History HTTP404 in the proxy
response throws distinct `GmailHistoryExpired`. Expiry captures a fresh checkpoint
before a resumable full source repair. Repair lists/refetches current mail and
removes previously indexed sources absent at completion, without one model job
per historical mail. Initial import cursor/pending receipts are **not reset** by
repair and must still be resumed. After repair, history resumes from its new
anchor. Repeated expiry starts another repair.

Limitations: expiry irretrievably loses live event provenance for the gap; repair
recovers currently present source evidence, **not** jobs for each gap arrival or
mail already permanently deleted. Gmail listing is not a snapshot: changes during
a pass converge through subsequent history, not a claim of atomic mailbox state.
Repair's final absent-source sweep is synchronous and scales with indexed sources.
The host must serialize/pace ticks, provide retry/backoff and persistent private
storage; live-priority drain can starve history under sustained unbounded live
load. The runtime serializes ticks with a two-second minimum delay and exponential
failure backoff capped at60 seconds. Each tick reconciles history, lists one
historical page and drains one receipt. A waiting live Interaction can delay later
ticks; the durable receipt survives restart and retains its original admission ID.

## Disconnect and recovery

Disconnect invalidates the local grant version and queued receipts synchronously,
before remote revocation. Its persistent lifecycle is `revoking` until confirmed;
an ambiguous failure becomes `reconcile-required`. Reconnect cannot race that
revocation or reactivate an unresolved account. Operator/provider reconciliation
for an interrupted revoke is a remaining host seam, not an automatic success.
After confirmed disconnect, reconnect rotates generation and allows a fresh import;
old-generation events, sources and drafts cannot be read using the new grant.
Revocation denies access but does not erase retained private source rows. Define
retention/deletion and backup policy before production storage activation.

## Protected runtime configuration

`COMPUTAH_COMPOSIO_API_KEY` is a private project credential.
`COMPUTAH_GMAIL_JSON` is one protected object with exactly these fields:
`scope: {tenantId,userId,agentId}`, `owner`, `account`, `authConfigId`, `path`
(absolute private SQLite path), and `approvedManagedFullMail` (boolean).
The scope must exactly match an existing host principal with `task.send` and
`history.read`. Unknown keys, unknown scopes, missing credentials, relative paths
and non-real runtime modes are rejected. This is not an account-selection browser
request. The host, not email text, binds the existing verified provider owner and
account to the canonical principal. Startup restores authority before native
checkpoint recovery; inactive local grants cannot be reactivated by restart.

The host's existing persistent `/data` mount supports `/data/gmail/gmail.sqlite`.
Create its directory privately and retain it with the backend data; no second
public listener, TLS route, webhook registration or OAuth grant change is needed
for GET-only provider history polling. The signed webhook simulator remains
available locally but is not an activated production route.

Authenticated `GET /v1/gmail/status` returns coverage/indexed/pending/failed counters.
`pending` combines unprocessed historical and live receipts, not native Tasks;
`failed` counts current-generation terminal unanswered receipts, not drafts.
`GET /v1/gmail/drafts` returns current-authorized UNSENT local drafts. Both require
`history.read`, use only the bearer-bound scope and reject query parameters; they
accept no account/grant selection. The native `gmail_read({query})` tool is offered
only to the configured scope, returning matching original-source excerpts with
source IDs/revisions/limitations. It has no provider mutation operation. Automatic
preload uses the same lexical index, at most3 originals and4000 body characters
each. An empty result means no indexed match, not mailbox completeness.

Fixed `gmail.bind/sync/import/drain/authority/retrieval` operation spans use the
existing sanitized Axiom tracing pipeline; errors log categories only. No account
identifiers, provider bodies, source contents or credentials enter telemetry.
Each newly admitted receipt persists a unique trace carrier linked to its admitting
operation. Every drain restores that parent and links the current pump, including
after retry/reopen. Native Pi admission still uses `BACKGROUND_CONTEXT`: no supported
public caller-to-native telemetry bridge was found, so receipt-to-native Task
parentage is not claimed. Native Task/Worker lineage is verified independently.

## Local verification and acceptance still owed

The Gmail suite uses synthetic messages, mock Composio HTTP and signed simulator
events. It exercises tenant/account isolation, verifier ownership, scope checks,
dedup/conflict, exact import boundaries, restart/retry, revoke/reconnect races and
130-message multi-page history with private retrieval and zero historical model
turns. Its native Rivet/Pi scenario sends live evidence to Interaction, which
autonomously delegates Task to a persistent Worker; a faux model supplies text and
a journal reopen retains the local draft. This is native-runtime local evidence,
not provider-delivered events or a production grant-fence proof.

Beyond the earlier profile read, an account-bound live source probe used this
module with the canonical host scope: ACTIVE/pinned grant verification, a durable
history checkpoint, one25-reference import page, one indexed original, real
history read, original-source retrieval, cross-user denial, and reopen retaining
the same handle/version all succeeded.24 historical references remained pending;
historical model turns were zero. Temporary private source data was deleted after
the probe, and no message contents or identities were printed. This proves a real
source path in the orb, not an indexed whole mailbox or deployed product runtime.

Product acceptance still requires the published revision to be consumed with the
protected host configuration, continued coverage growth, an actual new-email
history admission, authorized Interaction/Task execution, a visibly unsent local
draft and deployed restart/revocation checks. Historical
acceptance additionally requires resumable whole-mailbox coverage and ongoing
reconciliation with current-authorized source retrieval. The shared external bus
and Durable Streams integration are core-owned; the five-field trusted callback
is preparation compatibility, not permission to place private grant lineage in
the public `{clientMutationId,text}` request. A queued bus receipt is not final
Interaction output and cannot complete the Gmail callback or publish a draft.

Official setup references:
[managed scope controls](https://docs.composio.dev/docs/authentication/controlling-scopes),
[manual session authentication](https://docs.composio.dev/docs/authentication/manually-authenticating),
[session configuration](https://docs.composio.dev/docs/configuring-sessions),
[Gmail toolkit](https://docs.composio.dev/toolkits/gmail),
[Google Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Google profile checkpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile),
[Google history.list and expiry contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).
The two Google method references were read directly while implementing the local
checkpoint/history API; they establish API semantics, not live acceptance evidence.
