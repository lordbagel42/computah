# Multi-user Slack identity and security

## Findings before implementation (2026-11-09)

- `apps/slack/src/adapter.ts` admits only statically mapped team/user pairs.
  There is no general Slack enrollment. A Slack mention is not authorization.
- Private bindings select durable core scopes. `interactionId` and `workerId`
  in `apps/server/src/core.ts` include tenant, user and agent; native Worker
  files use the actor database, not host files. Durable history is implemented;
  general memory/recall and user-built executable plugins are not.
- Channel bindings are deliberately disjoint from private scopes, but currently
  may share a channel actor across users. That is channel-wide history, not a
  custom private Interaction per person. Thread routing is not thread isolation.
- Backend grants come from protected `COMPUTAH_AUTH_JSON`, not Slack prose.
  There is no cross-agent public disclosure protocol or owner proposal inbox.
  Operator-wide Axiom, browser, source and maintenance grants must not be
  inherited by newly enrolled users or by an owner's shared-channel actor.
- DEBUGSHARE already bounds captured Slack context and binds reports to a
  requester and location, but only mapped users can invoke it. It is not an
  arbitrary history export tool. Capture/upload must keep checking current
  authorization, including after restart and revocation.

## Implemented source boundary

Workspace enrollment must be explicitly host-enabled. Authenticated Socket Mode
team/user/channel metadata, never display names or message text, selects identity.
Each user gets a private DM scope and separate per-user shared-channel scopes.
Private memory never enters shared-channel model input. Shared-channel facts are
public only to that explicitly configured channel audience, not the Internet.
New users receive no global, secret, host, config, operator or admin capabilities.
Verified existing owner capabilities remain private to the protected owner scope.

Native arbitrary-code plugins cannot be safely enabled in this shared process.
Scoped declarative plugins may store reusable instructions as actor-private data;
they must not claim JS execution, isolation by prompt, host writes or extra grants.
Broader requests must be explicit bounded proposals to the owner's agent, not
authority-bearing tasks or private history forwarding.

### Enrollment and authority

Both backend and Slack adapter require the same protected
`COMPUTAH_SLACK_ENROLLMENT_JSON` and distinct random
`COMPUTAH_SLACK_ENROLLMENT_SECRET` (at least 32 characters). JSON fields are
`teamId`, optional `enterpriseId`, `channelIds`, `deniedUserIds`,
`ownerSlackUserId` and `ownerScope:{tenantId,userId,agentId}`. The owner must
already have an exact static core principal and private adapter binding.
No enrollment configuration means existing static behavior, not open admission.

Canonical versioned HMAC bearers encode only authenticated workspace/user/audience.
Backend verification independently derives `slack:<team> / <Slack user> / private`
for DMs or `channel:<channel>` for a configured channel. The namespace is reserved
even while disabled. Grants are exactly `task.send`, `history.read`,
`task.control`, `files.read`, `files.write`; source, browser, Axiom, Executor,
operator, config, secrets and maintenance authority are not inherited. Verified
owner private DMs keep the old scope/grants. Owner channel messages are unprivileged
and separate too. No legacy channel history is migrated into new actors.

These deterministic bearers are replayable credentials, not proof of current
Slack membership. Denied users, removed channels, disabled enrollment and issuer
rotation revoke subsequent access; actor recovery reconstructs current policy
without an initial HTTP enrollment call. Membership/deactivation events and Slack
Connect membership verification are not implemented. Policy admits authenticated
speakers in explicitly enabled audiences, including external participants Slack
delivers there; do not enable such channels if that is not the intended audience.

Mentions establish bounded 90-day channel-thread subscriptions; other authenticated
participants in that thread use their own actor. No anonymous/public HTTP ingress,
MPIM, bot/subtype processing or arbitrary channel addressing is added. The adapter
rechecks exact scope and current location before recovered execution and delivery.
Shared output can only use a shared actor's context, never its user's DM history.

### Explicit sharing, proposals and plugins

- `SHAREFACT <text>` in a channel explicitly publishes up to 2000 characters to
  agents in that exact channel. `channel_facts {}` returns up to 50 attributed,
  untrusted records. It does not read another actor's history, prompts, files or
  tools. `FORGETFACT <id>` retracts only that author's same-channel fact; prior
  replies are not erased. Durable tombstones prevent old publication retries
  restoring withdrawn text. The request receipt binds scope/action/text/message.
- `PROPOSE <text>` records only that bounded explicit text in the fixed protected
  owner's inbox. `owner_proposals {}` is owner-only, returns up to 50 records and
  neither wakes a model nor approves/executes anything. Requesters receive only a
  receipt, never owner conversation/tool output. The addressing prefix and outer
  whitespace are removed; internal mentions/text are preserved. Facts/proposals
  are capped at 200 records each and 20 per author, including tombstones. Capacity
  is terminal, not an endless retry; operator lifecycle/pruning is not yet added.
- `private_plugin {action,name,template,input}` supports save/render/list/delete
  of 16 actor-private declarative templates (name 1–40 lowercase letters/digits/
  underscore/hyphen, template/input at most 4000 characters, output at most 8000).
  All fields are required; unused strings may be empty, but name must be valid.
  Render substitutes literal `{{input}}` only. It cannot execute JS, import hooks,
  access host paths, cross actors or widen grants. Native Worker read/write/edit
  likewise use private actor SQLite files, not the host filesystem. Arbitrary
  user-built executable plugins remain unsupported rather than prompt-isolated.

Community commands are durable/idempotent across response loss and restart.
Typed denial/invalid/conflict/capacity errors terminate with a bounded rejection;
transient retries stop after five minutes, explicitly reporting uncertain commit
status. Read tools have a five-second caller deadline and cancellation fence;
RPC cancellation does not promise interruption of an already-running owner actor
action. Accepted mutations may commit after caller loss/cancellation, so retain
the same request ID and reconcile receipts rather than invent rollback.

Introductions are brief, once per user and actual delivery audience (DM or channel),
reserved immediately before the first answer post. Failed submissions do not
consume them; uncertain posts remain uncertain and are not blindly resent. A crash
before a reserved post can omit the introduction rather than spam it on retry.
Markers survive ordinary seven-day receipt pruning and are capped at 10,000.

Admission caps each user at five active and 100 retained jobs, with up to 120
retained for cancellation of an actual outstanding target; duplicate pending STOP
requests coalesce. Global bounds remain 100 active/5000 retained, with the last
500 retained slots reserved for useful cancellation. Diagnostics separately cap
50 retained reports/user and 5000 total. These are bounded admission budgets, not
complete CPU/storage quotas for an indefinitely growing native actor history.

### DEBUGSHARE

Any currently permitted requester can capture their exact issue thread. An
unthreaded DM command captures one bounded recent page of that requester's own
DM conversation, excluding replies in other threads; it never fetches another DM.
Capture and inline/recovered upload recheck original team/requester/location/core
scope against current policy. No private actor histories or bulk channels are
exported. Tracker enrollment must independently configure the same exact workspace,
owner Slack ID, allowed channels and denied users; unsupported scopes remain local
with upload unavailable. Reports and tracker access remain authenticated operator
data, never anonymous Internet publication.

## Delivery and acceptance

Local synthetic checks use real durable actors/native Workers and HTTP with fake
model/Slack transports, including private file/template canaries, forged credentials,
audience splits, retries/reopen, owner sleep, retraction replay, admission saturation
and diagnostic revocation. This is not installed/runtime acceptance. Runtime adoption
belongs to the existing protected deployment owner. Live acceptance requires two
consenting real Slack participants, exact installed event/history grants and a
revision-matched core/adapter; no unsolicited messages or real model tests are
authorized by local synthetic checks.

Adoption must coordinate backend, adapter, protected enrollment and tracker policy.
The source manifest adds `channels:history` and `message.channels`; it does not
establish installed grants. Real acceptance must exercise two people mentioning
Computah in an enabled channel/thread, their separate DMs, one brief introduction,
private canary non-disclosure, explicit same-channel fact sharing/retraction,
proposal receipt/owner review, scoped template isolation, denied global tools,
DEBUGSHARE by both users, and restart/revocation. Verify emitted sanitized traces
separately from actual live Axiom ingestion. No real participant/model calls have
been made by this implementation work.
