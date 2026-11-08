# Gmail preparation: private source index and Interaction ingress

## Delivery state

This is an additive, locally verified preparation module, not an enabled Gmail
integration. `apps/server/src/gmail.ts` is not imported by the server bootstrap.
There are no public routes, trigger subscriptions, production scheduler, native
grant-generation fence, retrieval preload, or live Gmail acceptance proof in this
packet. The existing core milestone remains independent.

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
read access, and returns only a handle, mailbox label and requested scope snapshot.
Neither email text nor browser callback IDs establish tenant identity.

`createComposioGmail` accepts a server-only project key and a managed readonly auth
config ID. It uses REST v3.1 with bounded timeouts and generic errors that do not
include provider response bodies. Account checks require ACTIVE Gmail status,
the pinned config, no disabled account/config and no shared-account marker. A
profile request establishes mailbox identity; a messages query probes content-read
capability. `requested_scopes` is explicitly not a verified granted-scope inventory.
Full-mail and other Gmail permission requests are rejected. There are no send,
provider-draft, label-write or token-export methods.

Composio documents a generic managed `credentials.scopes` override, but API
acceptance does not establish that the managed OAuth client supports a scope.
Live Gmail toolkit metadata's `composio_managed_auth[].scopes.available` lists
`https://mail.google.com/` and identity/contact scopes, not `gmail.readonly`.
Google documents `gmail.readonly` as valid; the discrepancy is managed-client
availability, not Google scope syntax. The only advertised mailbox-content scope
is full mail access, including sending and permanent deletion. The owner explicitly
approved requesting that scope alone, excluding contact/profile scopes, while
keeping runtime actions read-only and drafts local. A read-only runtime policy
does not narrow the provider grant. This packet still fails closed on full-mail
grants: its provider policy has not been aligned with the approved managed grant,
so it cannot activate the real connected account as written. Publication of this
preparation module does not enable that account. For agent-tool sessions explicitly
select the auth config; creating it alone does not wire tools into Computah.
OAuth completion is separate from project-key validity.

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

`drainOne` rechecks authorization and provider status on retry. The first fetched
message is frozen so replay cannot silently change the submitted evidence. Live
inbox receipts pass a stable mutation ID, audience and grant version to `run`.
**The host must target `session.interactionId`; Interaction alone decides whether
to delegate through Task.** The adapter does not select a Worker. Incoming mail is
untrusted evidence, not policy, tool authorization or a new system instruction.

The returned Interaction text is stored with source IDs and audience under the
human-visible `UNSENT LOCAL DRAFT` state. Reads of drafts and sources require current
account authorization. This local output projection is not provider email egress
and does not establish that the global external ingress/egress bus is deployed.

The `run(work, current)` contract requires a native generation/recovery fence, not
just a call to `current` before submission. Core ownership must carry the receipt,
account handle and grant version through Interaction and delegated Task lineage,
enforce them in `beforeRequest` on every attempt, and guard result release. Ordinary
submission does not implement this. Provider request metadata is not an authority
channel. Until that core-owned seam is implemented and tested, live admission must
remain disabled; local callback checks alone cannot prevent queued native work.

## Historical mailbox evidence

Historical indexing is a foundational source primitive, not an event-only memory.
`startImport(scope, handle, 0, cutoff)` permits effectively all mailbox history up
to a fixed cutoff. A page contains at most25 references, but pagination and total
history have no fixed page/message cap. Listing includes sent, archived, spam and
trash; exact half-open millisecond coverage is checked before indexing. HTML-only
mail retains metadata with no invented plain-text body.

`importPage` persists provider cursor, page count, coverage and receipt admission
atomically. `drainOne` indexes historical receipts without Interaction/model turns.
The live and historical paths share account/version/message dedup. A live event can
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

Ongoing provider history reconciliation, deletion/label-change propagation,
cursor-expiry recovery, scheduler pacing/backoff and retrieval injection into Pi's
`beforeRequest` projection remain unimplemented. A new-email trigger alone does
not cover every mailbox change or prove eventual full-history coverage. The host
must pace pages/drains, persist private storage and reconcile interrupted sync.

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

## Minimal host handoff (not installed)

- Private configuration: `COMPUTAH_COMPOSIO_API_KEY`, selected readonly auth config
  ID and Composio webhook signing secret. Secret injection is a deployment-owner
  action; never pass these through models, browser URLs or public logs.
- Proposed dedicated HTTPS ingress: GET `/integrations/composio/verify` and POST
  `/integrations/composio/events`, separate from private core/engine ports. Enforce
  exact methods/paths, bounded body/timeouts, no raw-event logs, signature validation
  and durable-before-ACK behavior. OAuth verifier must authenticate the existing
  host principal and attempt, not trust anonymous callback query parameters.
- The proposed Nest hostname and port8791 require explicit route/TLS provisioning
  and exact candidate coordination. DNS alone is not HTTPS readiness. No general
  reverse proxy to core is needed or authorized by this preparation module.
- Add native receipt/Task-lineage authorization, authenticated connection/draft/
  source projections, provisioning and a paced resume/reconcile loop through their
  existing owners. Do not expose `GmailIngress` directly as a model tool object.

## Local verification and acceptance still owed

The Gmail suite uses synthetic messages, mock Composio HTTP and signed simulator
events. It exercises tenant/account isolation, verifier ownership, scope checks,
dedup/conflict, exact import boundaries, restart/retry, revoke/reconnect races and
130-message multi-page history with private retrieval and zero historical model
turns. Its native Rivet/Pi scenario sends live evidence to Interaction, which
autonomously delegates Task to a persistent Worker; a faux model supplies text and
a journal reopen retains the local draft. This is native-runtime local evidence,
not provider-delivered events or a production grant-fence proof.

Diagnostic OAuth and one safe profile result have succeeded independently of this
module. Product acceptance still requires canonical trusted tenant/account binding,
provider-policy alignment, effective content-read confirmation, real signed
new-email delivery into durable admission, authorized Interaction/Task execution,
a visibly unsent local draft, restart reconciliation, revoked queued-access
rejection and cross-user negative checks on the deployed candidate. Historical
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
[Google Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes).
