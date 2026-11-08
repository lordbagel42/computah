# Slack prototype

Status: routing/status, subscriptions/burst batching and bounded first-mention
context are implemented in source, pending canonical publication and a separately
coordinated runtime upgrade. This packet leaves the published manifest, permissions
and installed app untouched. Wider app grants requested earlier are not established
by this source change. No live upgraded routing or typing proof is claimed. It uses
official `@slack/socket-mode` 3.1.1 and `@slack/web-api` 8.3.0, no separate model,
Pi instance or bot history. Protected core REST admission/result calls reuse the
existing tenant/user/agent Interaction and persistent Task/Worker. There is no
streaming, bulk history retrieval, revision replay, OAuth onboarding service or rich UI.

## Minimum dedicated app setup

Prefer the **official Slack CLI**, which supports self-hosted Node Socket Mode
apps, not just Deno. The checked CLI is 4.13.0. `apps/slack/.slack/hooks.json`
exposes the manifest and a Node start hook with SDK-managed connections: the CLI
does not replace our SocketModeClient/ACK handling. `slack manifest info
--skip-update` was actually executed successfully from `apps/slack`.

For a new operator setup, from `apps/slack`, authorize `slack login --skip-update` for the intended workspace.
Run the displayed `/slackauthticket` command in Slack, review its developer CLI
permissions, approve the modal, and enter its challenge **only in the terminal**.
These user-level development permissions are distinct from our narrow bot scopes;
do not grant organization-wide administration. CLI auth/app files stay private and
out of Git. Then use `slack install --team <approved-team-id> --environment deployed`
to create/install a **new Computah app**, never select/link Amp or June.

The current owner login is already complete. It is organization-scoped, so the
manifest is organization-ready (`org_deploy_enabled:true`). That setting alone
grants no extra scopes or workspace access. The actual creation/install explicitly
selected only Hack Club workspace T0266FRGM using `--org-workspace-grant T0266FRGM`,
never `all`. With organization auth, a false org-ready flag was rejected by Slack;
targeting the workspace directly failed `team_not_found`, not a login failure.
The new Computah app A0CFD2Z0487 was created under E09V59WQY1E. Approval request
Ar0CGNR7U7UG was approved; CLI then reported Installed with only that workspace
grant. To operate this exact existing app, use `--app A0CFD2Z0487` and omit
`--environment` (CLI rejects both flags together). Do not create another app.
Owner does **not** need to repeat login, approval or manual app creation.

Real `auth.test` returned `is_enterprise_install:true`, with both `team_id` and
`enterprise_id` equal to E09V59WQY1E, bot user U0CFU8W96M8. Runtime bindings must
still name workspace T0266FRGM, plus explicit `enterpriseId:E09V59WQY1E`; never
replace workspace identity with the enterprise ID. Exact per-event team/user and
channel allowlists remain mandatory. This is not permission for other workspaces.

The published manifest is retained unchanged: only `app_mentions:read`, `im:history`,
`im:write`, `chat:write`, with `app_mention` and `message.im` events. Ordinary DM
chat needs no expansion. The source can handle subscribed channel replies, but
Slack must first be configured to deliver `message.channels`/`message.groups`
with corresponding observed history grants before that feature can work live.
Native status additionally needs observed `assistant:write` and explicit runtime
opt-in. Bounded thread context skips retrieval without the appropriate history
grant. These are runtime/install dependencies, not new permission requests in this
packet. No public ingress or broader workspace enrollment is introduced.

An earlier owner-requested experiment copied the 44 bot/30 user scope lists from
June revision `4ca93fb3973f2106013f90cc50bedd4943ff00a9`, validated/synced an Agent
manifest and opened install request `Ar0CFUFGQAM8`. At the last read-only credential
check, the dedicated bot still had only the original four scopes; the approval and
installation-refresh resolution has not been verified. That experiment's expanded
manifest is **not included in this source packet**. Do not sync the manifest,
request new permissions, rotate tokens or repeat login as a side effect of source
integration. An authorized operator must separately verify the selected app's
actual configuration and installed grants before enabling dependent features.
No user token is loaded or used for impersonation; broader grants would never
auto-enroll users or authorize exporting histories. Slack does not offer an app
setting that forces placement in an individual's sidebar.

For a CLI-controlled test run, `slack run`
supplies app/bot tokens directly to the start hook as environment variables.
Our backend URL/private binding/journal configuration must still be supplied.
Do not print those variables or extract existing apps' credentials. Persistent
nest-bagel activation uses a separate protected environment, not shared CLI auth.
The CLI provided the dedicated app and bot tokens directly to a one-time custom
deploy hook. That hook verified `auth.test` and wrote only a private mode0600
runtime credential file outside the repository, without printing token values.
It did not start a model/server or deploy to nest-bagel; the temporary hook was
removed. No CLI user-login credentials are transferred to the runtime host.
Socket Mode is enabled in the manifest. Invite it only to the explicitly approved
prototype channel (#raygen-builds-an-ai by default; resolve its actual ID).
Do not expand the workspace grant beyond T0266FRGM. Installation changes can
require workspace-admin approval and are not performed by this source packet.

Socket Mode uses Slack's authenticated outbound WebSocket and SDK envelope ACK,
so no public ingress, signing secret or HTTP signature verifier is required. Do
not expose this event handler as an HTTP endpoint. A future HTTP transport must
verify Slack signatures/replay windows before admission. This single-install bot
uses its installation bot token; OAuth client secrets/redirects are unnecessary.
Current connected Executor discovery exposes no Slack app-admin tool. No CLI or
login context existed in this orb or on nest-bagel; CLI was installed in this orb
only. Manual app settings at <https://api.slack.com/apps?new_app=1> are a fallback,
not the preferred ask. Initial installation/approval was verified. This source
packet makes no new runtime or live roundtrip claim; consult the deployment record
for the separately coordinated backend/Slack resumption.

## Private runtime configuration

Run `pnpm --filter @computah/slack start` with Node >=22.19 (uses `node:sqlite`),
using the existing pinned workspace dependencies; this packet adds no packages.
For supervision, prefer direct `node --import tsx src/main.ts` with working
directory `apps/slack`, without pnpm bootstrap at runtime. Readiness emits only
`computah.slack.ready` after binding validation and socket connection. SIGTERM/
SIGINT stop admissions, interrupt a pending Socket Mode startup wait, finish any
active delivery step, disconnect, close SQLite and emit `computah.slack.stopped`.
The process owns its exit so delayed SDK startup/reconnect cannot outlive it.
Socket setup HTTP uses a 15s timeout and no automatic Web API retries. A 45s
shutdown deadline exits nonzero if cleanup cannot finish; interrupted dispatch
remains `posting` and becomes `uncertain` on restart. Allow 60s termination grace.
Startup failure emits `computah.slack.start_failed` and exits nonzero. There is no
HTTP health port; readiness is startup evidence, not continuous provider proof.
Provision secrets directly via protected operator environment/config; **never
paste credentials in Amp, model prompts, Git, manifests or logs**:

| Variable                        | Purpose                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`               | Dedicated installation bot token                                                   |
| `SLACK_APP_TOKEN`               | Dedicated app-level Socket Mode token                                              |
| `COMPUTAH_CORE_URL`             | Protected backend origin; loopback HTTP on nest-bagel port8787, otherwise HTTPS    |
| `COMPUTAH_SLACK_BINDINGS_FILE`  | Absolute private mode0600 JSON file described below                                |
| `COMPUTAH_SLACK_DB`             | Absolute SQLite journal path in dedicated mode0700 persistent directory            |
| `COMPUTAH_SLACK_STATUS_ENABLED` | Optional native threaded status; defaults off, set `true` after grant verification |

Bindings are a private JSON array, each entry containing `teamId`, `slackUserId`,
`tenantId`, `userId`, `agentId`, `coreToken`, `channelIds` (array of explicit Slack
channel IDs), and optional `enterpriseId` required for an organization installation.
The operator must obtain real Slack IDs and map them to an existing
trusted core principal. Reuse the user's existing principal scope, not a new
Slack-specific actor. Never derive these fields from message text or a model.
For approved shared channel replies, add optional `channelBindings`, an array of
`{channelId,tenantId,userId,agentId,coreToken}` with protected values provisioned by
the operator. Each `channelId` must also be in that user's `channelIds`. Its scope
must differ from **every private binding** and may not be reused across different
channel audiences. The same approved channel can share a principal between its
mapped participants. Startup verifies each channel token's `/v1/viewer` too.
The core must be provisioned with that distinct scope/token in its private
`COMPUTAH_AUTH_JSON`; the adapter never mints principals or trusts body-supplied
actor identity. No channel credential means no channel admission or private fallback.
Startup verifies the bot installation team (or exact explicit enterprise for an
organization token) and every binding against `/v1/viewer`,
including `task.send`/`history.read`; the bearer principal owns actor identity.
Restart to rotate/revoke bindings/tokens. Already-running core work is not cancelled.
No default binding, auto-enrollment or email lookup exists.

Run exactly **one adapter process** per journal/installation. Keep journal and
WAL files private; they contain input text and scoped result handles, not secrets
or full histories. Persist them across restarts, on local durable storage; no
network filesystems. The delivery journal is not the canonical Pi transcript.
There is no active-active ownership/locking. Startup adds the `status` cleanup
and `ready` queue columns plus nullable `context_before` when opening an older
journal, plus receipt-alias and thread-subscription tables. Legacy queued work is
immediately eligible and never retroactively enriched; subscriptions
start empty and are established by newly admitted mentions. Existing receipts retain their original
destinations: private jobs are not retroactively moved to a channel. Back up the
private journal before upgrade; old executables cannot insert into the new schema.
Deployment owner must supervise it separately, allow outbound Slack HTTPS/WSS,
and give it private access to the existing loopback backend, without exposing
Rivet/inspector. A separate container cannot reach host loopback by default;
choose host networking on the authorized Linux host or another explicit private
route. Do not start a second core against the same Rivet storage. No deployment
files are part of this packet; deployment owner owns that integration.

## Routing and disclosure

Mapped users' ordinary DM replies are **top-level by default**. An incoming DM
thread reply stays in its chosen thread. To opt in explicitly, start a message
`Reply in thread: ...` (also accepts `Reply in a thread:` / `Reply in this thread:`
and optional `Please`). To escape a thread for one answer, use `Reply top-level: ...`.
These anchored, case-insensitive per-message instructions are stripped before
submission and set the fallback preference, not a sticky setting. New runtime
receipts also offer the Interaction a finite destination choice as described below.

Mentions in explicitly allowlisted, **channel-bound** channels default to replying
inside `thread_ts ?? ts`. The Interaction may instead select the same channel's
top-level surface or a private DM to the already mapped sender, never another channel.
They use the channel's separate trusted Interaction and Workers, not the owner's
private primary history. Shared memory is **channel-wide, not thread-isolated**:
thread timestamps route replies, not authority. Use separate preconfigured
principals/audience policy before supporting narrower or dynamic audiences.
Only the bounded first-mention thread context described below is fetched.
Permissions alone do not declassify private history.

### Agent-selected destination

New runtime admissions persist host-offered symbolic destinations with a fresh
request nonce. `thread` and `conversation` mean only the originating conversation's
thread and top-level surface. Only shared-channel admissions additionally offer
`sender_dm`, resolved by the host to the trusted mapped sender. Private DM inputs
can never select a shared channel, arbitrary person, channel ID or unrelated thread.
Channel-to-DM selection only reduces the audience of the channel agent's answer;
it does not switch to or retrieve private Interaction/Worker history.

Before the first core POST, the adapter freezes the complete input, optional
quoted context and final-output instructions together. The core API remains
exactly `{text,clientMutationId}`. The existing Interaction chooses via a whole
final assistant JSON object with exactly `requestId`, `destination`, `text`.
Only a matching request nonce **and** a persisted host-offered option is accepted;
the nonce alone grants no authority. Tool/user blocks, fenced/embedded examples,
extra fields and arbitrary IDs are not scanned for routing. Prompt instructions
cannot guarantee model intent or prevent the model copying quoted text, so the
host's finite audience checks remain the security boundary, not model obedience.
Plain chat or invalid envelopes retain the original fallback destination.

The selected destination and answer are persisted before opening a DM or posting.
Restart before dispatch resumes that same selection without another model decision;
ambiguous sends still become `uncertain`, never automatic duplicates. Posting
rechecks the current trusted mapping/channel audience against the stored offer.
Revoked audiences are dropped rather than redirected. Original job channel/thread
remain unchanged for status cleanup. Legacy jobs have no options and retain their
original behavior; the additive nullable `reply_options` journal column does not
retroactively wrap inputs which may already have been admitted.

This is source support, not live model/Slack acceptance. After the exact source
upgrade, test a harmless DM such as "For this response, choose the thread on this
message and say ROUTE-THREAD", a threaded DM asking naturally for a top-level
answer, and an approved channel mention asking for a mapped-sender DM. Do not use
the anchored `Reply in thread:` / `Reply top-level:` prefixes for this acceptance:
they also exercise the old static preference, not necessarily model selection.
Confirm destination and unchanged core audience without copying private history
to a channel. No new grants or manifest sync are needed for DM choice; channel
choice still requires the separately provisioned channel principal. Do not send
extra verification messages or restart a live service outside the coordinated rollout.

An admitted mention subscribes its thread under that exact trusted channel audience.
Later ordinary replies in that thread from mapped participants with the same
channel audience are admitted without another mention. Subscriptions survive restart,
expire after 90 days without admitted activity and retain at most 1000 recently
active threads. They grant neither user enrollment nor a new audience: every event
still checks its sender, team, channel allowlist and channel binding. A changed
principal does not inherit old subscriptions. No unrelated channel messages are
admitted. Bot messages, edits, deletions, unmapped users/teams and nonallowlisted
channels are ignored and ACKed. Oversized/empty inputs are ignored.

## Durable DEBUGSHARE capture

Mapped users can DM `DEBUGSHARE` or `DEBUGSHARE optional note`, or mention
Computah with that command in an authorized channel. The first token must be
exactly uppercase `DEBUGSHARE`; leading whitespace is allowed. Quoted/code text,
`DEBUGSHAREfoo`, and lowercase `debugshare` are not commands.

The adapter generates a UUID v4 and commits its mapping to the originating Slack
team/channel/message/thread, trusted requester, UTC time and core scope in the
same SQLite transaction as admission, **before ACK**. The `debugshares` table is
independent of seven-day delivery receipt pruning. It retains immutable report
JSON, the job key, capture completion, confirmed tracker URL and retry time.
An operator with access to the protected journal can look up `id` directly; no
model or browser supplied scope authorizes reads. Prior identifier-only UUIDs
have no retained mapping and are not retroactively reconstructed.

After ACK, capture requests one bounded Slack page (20 messages, no pagination,
2s deadline): the exact invoked thread, or recent top-level DM context. A new
top-level channel command reads only its own root, never surrounding channel
history. Observed history grants are required. Up to 4000 characters per prior
message, actual author IDs/timestamps, command text, participants and at most 20
same-location submission handles are retained. Missing context is explicit;
native actor/task/trace IDs are not invented. Actual issue messages are shown,
not replaced by privacy summaries. Configured credential values and recognizable
token formats are redacted; this is not a universal unknown-secret detector.
No hidden model reasoning, arbitrary backing-store export or bulk history read.

The concise private acknowledgment keeps UUID/time/requester/disabled Amp link.
It adds a real internal report URL only after the tracker durably acknowledges
that UUID, otherwise says `report: stored locally; tracker sync pending`.
Channel commands still reply in the mapped sender's DM. No model submission,
repair, processing status or new thread is started, and commands do not merge
with bursts or subscribe threads. Ambiguous Slack sends are not blindly repeated.

Optional upload requires all three protected runtime variables:
`COMPUTAH_DEBUGSHARE_INGEST_URL` (Executor webhook callback),
`COMPUTAH_DEBUGSHARE_SIGNING_SECRET` (at least 32 characters, private setup page),
and `COMPUTAH_DEBUGSHARE_REPORT_URL` (authenticated Executor app URL). HTTPS only.
The raw JSON is authenticated with HMAC-SHA256 over `timestamp + "." + body`,
using `x-computah-timestamp` (epoch milliseconds) and `x-computah-signature`
(lowercase hex). The receiver pins the source scope, allows five-minute skew,
and returns `{id}` only after storage. A ten-second upload deadline and durable
30-second idle outbox retry do not change the stored UUID/snapshot. Lost upload
responses reconcile idempotently; a conflicting UUID never replaces a report.
Upload failure does not prevent the locally indexed acknowledgment or chat.

The Executor tracker source lives in `integrations/debugshare`; its authenticated
tools expose exact lookup, assignment, evidence notes and revision-checked
open/investigating/blocked/resolved state. Local restart/outbox tests are not a
claim of deployed capture or production credential setup. Amp/Space handoff and
automatic repair remain unimplemented.

## First-mention thread context

For the first newly admitted mention in an existing channel thread, the adapter
can prepend attributed prior text to the **same strict text submission**. It uses
only that approved channel's distinct trusted principal. A top-level mention,
DM, already subscribed thread or legacy queued receipt triggers no history read.
Reading another channel participant's visible thread text does not enroll them
or authorize their future requests. Shared context remains channel-wide, not private
to the thread.

After durable admission/ACK and the burst window, one bot-token
`conversations.replies` request uses exactly the invoked channel/thread, `latest`
equal to the mentioning message timestamp, `inclusive:false` and `limit:15`.
No cursor is followed, even when Slack reports more results. Actual observed
`channels:history` or `groups:history` grants are required for the corresponding
channel type. No search, profile/email lookup, user token, unrelated channel or
DM history read is used. Missing scopes, rate limits and other lookup failures
fall back to the unchanged current request, not a new scope/approval request.

The optional lookup has a two-second total wait/abort budget and at most one
in-flight request. A transport ignoring cancellation retains that slot; later
jobs skip enrichment rather than accumulating stalled requests. This can delay
the first core POST by up to two seconds, but never delays Slack ACK. Runtime
shutdown can finish after the active bounded delivery step; no total process
shutdown guarantee is added.

Only prior plain text in that root/thread is eligible; the current message, later
timestamps, foreign threads, bots and subtype events are excluded. Up to twelve
records preserve Slack author IDs/timestamps and at most 1000 characters each,
with a 6000-character serialized quote budget and 20,000-character total input
budget. Quoted text is labeled **partial and untrusted**, never instructions or
authorization. It cannot select the core principal, move the response destination
or grant tools. The adapter keeps the full current request rather than truncating
it for context; insufficient remaining space skips enrichment.

`preparing` freezes the burst before lookup. A restart in that state can repeat
the bounded read because no core POST occurred yet. Enriched text is committed
and the context marker cleared **before** core admission. Once an admission could
have succeeded, retries/restarts reuse the exact frozen text and mutation ID,
without another history fetch. New input during preparation queues separately.
The private journal therefore contains bounded quoted channel context too; it
is still not an alternate canonical history store. Pending context is not a live
Slack event subscription or proof that installed grants are sufficient.

## Received-message bursts

The runtime uses a 1.2s quiet window for already-received text, capped at five
seconds from the first receipt. Only the same mapped sender, trusted principal,
channel and reply destination may coalesce, with at most eight messages and
20,000 combined characters per job. Text is joined in receipt order with blank
lines. The polling interval and existing network/backlog can delay dispatch beyond
the eligibility time; this is not a five-second response guarantee.
Each event is journaled before ACK even when merged. Mention/message callbacks
for the same Slack message are deduplicated; normal Slack retries reuse their event ID.
Before the first core admission attempt, the batch is frozen durably: a lost
response retries identical text and mutation ID while later messages queue separately.
Restart preserves both the quiet window and that frozen payload.

This does **not** observe unsent typing. The inspected June source at
`4ca93fb3973f2106013f90cc50bedd4943ff00a9` starts human inputs immediately,
checks newer input before sending and coalesces selected bot chatter; it is not a
human typing debounce implementation to copy. Its thread status/reaction mechanisms
do not establish availability of Socket Mode human typing events.

## Native working indicator and its boundary

Native status is **off by default**. Enable `COMPUTAH_SLACK_STATUS_ENABLED=true`
only after validating installed grants and the actual threaded surface. Startup
also requires `auth.test` response-metadata scopes to contain both `chat:write`
and `assistant:write`; otherwise it stays off and emits
`computah.slack.status_disabled_missing_grants` without failing chat startup.

When enabled, threaded DMs and approved channel threads can call official
`agents.sessions.setStatus` with `processing`, then request `active` on completion,
failure, cancellation result, timeout, uncertain delivery or graceful shutdown.
This is a separate best-effort lane: **one status request at a time**, independent
of the message delivery client, with a 1s abort budget. Admission, core requests
and response posting never await status requests. Busy status slots can skip
indicators on later jobs. A transport ignoring abort retains the slot until it
settles or the process restarts; it cannot accumulate concurrent orphan requests.
No hard reply-latency guarantee is implied for core/message transport itself.

Cleanup intent is persisted **before** a status call. Transient/ambiguous failures
retain cleanup, with terminal clears retried at least 30s apart after restart.
Permanent missing-scope, unsupported-feature/token and invalid/revoked-auth errors
disable status for the process and discard its markers; re-enable after resolving
the grant/capability and restarting. Only safe `computah.slack.status_unsupported`
or `computah.slack.status_failed` codes are logged, never raw Slack errors.
Shutdown has **one total 1s status-cleanup budget**, not one per receipt; remaining
intent stays durable. Late completions cannot mutate a closed journal.
An outage/denial can prevent clearing the visible indicator. Slack's processing
status expires after one hour; local cleanup intent is abandoned two hours after
receipt creation, and never extends terminal receipt retention. No native Stop
button subscription is added until core cancellation is wired and verified.

Slack's DM UI does support typing, but its legacy `type:typing` packets are RTM
client messages. Official RTM docs explicitly exclude granular apps like Computah;
Socket Mode is an Events/interactive envelope transport, not an RTM typing socket.
Current `agents.sessions.setStatus` requires `thread_ts` in ordinary DMs/channels;
`assistant.threads.setStatus` also requires it. Slack explicitly warns that setting
processing opens that thread. Streaming likewise requires a thread except in
whole-channel Slack Code sessions. Therefore ordinary **top-level DM native typing
is not implemented**: we retain the requested top-level reply, do not open an
unrequested thread, send fake typing messages or use unsupported user-token sockets.
Native threaded status is locally exercised, not yet visually/live verified in
the owner's actual client. Broader scopes do not remove this protocol constraint.

Output is one bounded plain-text section, no mrkdwn/mentions or unfurls. Answers
over 2800 characters include an explicit shortened-output notice; no attachment
or private-history link is generated. json-render is selected for future rich
messages: shared semantic catalog → explicit `@json-render/chat`/Chat SDK Slack
projection → validated Block Kit budgets. No native controls or arbitrary props
are treated as executable Slack UI; the text-only REST does not supply rich specs.

## Delivery and recovery semantics

An authorized event is committed synchronously to SQLite **before ACK**, without
waiting for a model. Stable SHA256(team,event_id) mutation IDs let core admission
retries reuse the same durable submission even after a lost response/restart.
The SDK owns socket reconnect/envelope ACK. Inbox errors withhold ACK so Slack
can retry; this is not an unlimited guaranteed Slack event archive. At most 100
active receipts and 5000 total are admitted; completed/uncertain receipts older
than seven days are pruned on the next admission, **regardless of status cleanup**.
This is admission-triggered retention, not a background deletion deadline.
These limits count jobs, including up to eight coalesced input receipts per job;
alias receipts are removed with their job. Subscriptions have their separate cap above.
Delayed duplicates outside retention can
produce another notification, although core mutation IDs still deduplicate work.

A single polling worker performs bounded 30s core requests, roughly one per second
between steps, and waits at most five minutes from receipt before trying a truthful
timeout notice at the receipt's original destination (DM or approved channel thread).
This does not cancel core work. Backlog and network outage
can delay that notice; no hard wall-clock delivery guarantee.
Core failures retry with the same receipt until deadline; core errors/private
details never appear in Slack or logs. Revoking the core token blocks new reads.

Slack dispatch is recorded as `posting` **before** opening a DM or posting;
success becomes `done`, failure or restart during dispatch becomes `uncertain`.
A failed DM open therefore cannot retain oldest-job priority and indefinitely
block other users. This deliberately requires operator reconciliation even when
the failure occurred before a message was posted. The SDK's
automatic Web API retries are disabled. No blind re-post after ambiguous network
failure; this trades possible lost notifications for avoiding duplicate
messages. 429 responses also require operator reconciliation in this first slice,
not a claim of complete retry/backoff. `counts()` exposes only aggregate receipt
states for operator checks. Do not manually requeue uncertain sends without
reconciling the actual destination conversation/thread. No exactly-once Slack delivery is claimed.

## Verification / trying it

Run `pnpm --filter @computah/slack typecheck` and
`pnpm --filter @computah/slack test`. Synthetic transport tests exercise real
SQLite restart/dedup, trusted mapping/denials, stable admission after response
loss, private routing, DM threads, uncertain posts, deadline and bounded output.
They also cover DM top-level/explicit-thread routing, channel-thread inheritance,
distinct audience tokens, missing/unsafe channel bindings, status cleanup/restart
and unresolved status not delaying admission/replies or the total shutdown budget,
single status concurrency, permanent-denial disablement, bounded stale intent,
full-capacity terminal receipt pruning and an actual eight-column legacy journal
upgrade preserving old destinations. Executable startup checks cover status-off
unless explicitly enabled with observed grants. They cover a legacy failed DM open
not blocking another user, explicit enterprise
versus workspace installation guards, and SIGTERM/SIGINT during pending Socket
startup. They do not prove live runtime Slack acceptance or model generation.

A separate disposable executable check also passed: synthetic Slack event →
SQLite admission → adapter restart → actual authenticated HTTP → real Rivet/Pi
Interaction/Task/primary Worker → fake private Slack reply. A follow-up shared
the same primary history (four public messages); duplicate admission posted once.
Only the model and Slack delivery were fake. The full workspace formatter, check,
typecheck and tests passed locally. No real Slack post or provider call was made.

After scope approval, channel-principal provisioning and deployment: DM Computah a synthetic
request asking its primary Worker to remember a harmless nonce, then follow up
as an ordinary DM (expect top-level), then use `Reply in thread:` and confirm the
threaded working indicator clears. Mention it once in the approved prototype
channel: confirm a threaded reply using only channel-shared context, not private
DM history. Restart only the adapter and verify
a follow-up uses the same Interaction/Worker; replay a synthetic event in local
tests, not a private real event in logs. An unmapped test user must get no model
response. Record only aggregate outcome, not private message/history contents.
Until that is executed, second-round live behavior is unverified; the updated
scope installation has a fresh admin approval gate, not a repeated login gate.

The subscription/burst slice additionally checks persisted thread follow-ups,
mention/message callback deduplication, denied audiences and senders, quiet-window
boundaries, eight-part/five-second batching, sender/thread separation and immutable
retry after lost admission and restart. Live follow-up testing additionally needs
the new channel event subscriptions applied to the dedicated app. First-mention
context additionally checks same-thread/time filtering, attribution and size
budgets, missing/slow lookup fallback, immutable enriched retries and concurrent
input during lookup. The synthetic executable checks ACK-before-fetch, exact
single-page request arguments, observed-grant gating, the unchanged core request
shape and channel-principal response destination. These are not a live Slack or
deployed-core E2E. The next live client E2E must reuse the exact deployed durable/email
core and its provisioned tenant, never launch a second core or model harness.
Persona-based routing preferences, public-text streaming, signals,
attachment download/vision/transcription and validated semantic rich output remain
separate follow-on slices. No attachment or rich core fields are invented here.

## Durable transport timing (source support)

Each new job receives an independent host-generated W3C carrier, committed with
its inbox admission. Duplicate events and coalesced burst members reuse that
job's carrier; later core submission, polling, ACK attempts, optional status,
delivery and DEBUGSHARE upload retries retain it across restart. No message,
channel, sender, job or receipt identifiers enter transport telemetry. The
separate opaque DEBUGSHARE UUID is an explicitly registered capture attribute.
The authenticated report persists its real transport carrier and actual first
capture span association before upload; a retry does not invent new report IDs.

Additive `job_timing`, `receipt_timing` and `job_phases` tables preserve the inbox
and existing DEBUGSHARE journal. Epoch-ms `receivedAt` is the host Socket Mode
callback observation, **not** Slack sender time; `senderTs` is Slack's supplied
timestamp string. `admittedAt` observes the completed admission commit;
`firstDequeuedAt` observes the first selected queue step. Each phase records its
attempt, start and completion independently. A crashed/in-flight phase has null
completion/outcome. Old rows keep missing timing/root fields null. No timestamp
is inferred from job creation or backfilled from adjacent messages. Queue spans
use persisted admission/dequeue boundaries, not instantaneous dequeue duration.
ACK and post completion mean the respective SDK/API call resolved; no Slack
client-delivery timestamp is available. Never sum nested spans as wall-clock.
After mandatory inbox/root admission commits, auxiliary phase-write failures
emit only a fixed storage-failure category; they cannot suppress ACK/post or turn
a known unsent/successful transport result into delivery uncertainty. Missing
phase completion stays null rather than replacing the real result.

`apps/slack/src/timing.ts` exports the host-only read-only SQLite helper
`readTimingSnapshot(path, requestId, scope)` and `SlackTimingSnapshot` DTO. It
selects one exact `input:slack:<sha256>` and revalidates its stored binding against
the caller's already-authorized `{tenantId,userId,agentId}`. The running adapter
also revalidates its current bindings. A root ID alone is never lookup authority.
No content, principal IDs, credentials or submission handles enter this positive
timing projection. Reads use a snapshot transaction, 250ms SQLite busy timeout,
and a 2048-phase response bound; oversize snapshots fail rather than imply
complete evidence. This helper does not resume or repair jobs on open.

An optional **default-disabled UNIX-socket-only** broker serves
`POST /v1/timing`, with JSON `{requestId,scope}` and a separate bearer token. Set
both `COMPUTAH_SLACK_TIMING_SOCKET` and `COMPUTAH_SLACK_TIMING_TOKEN_FILE` (absolute
paths); the token file must be private 0600 and contain at least 32 characters.
It must not contain Slack/core/provider credentials. Response is
`{timing:SlackTimingSnapshot}`; missing/revoked/foreign scope returns 404 without
content. Invalid input is 400, unauthorized 401, size bound 413, capacity/rate
bound 429 and unavailable lookup 503. Limits: 2KiB request, 256KiB response,
2-second absolute connection deadline (including incomplete headers), four active
authenticated requests, 60/minute total.
The broker ignores incoming trace headers and never accepts a DB path or root ID.

Provision a **separate** socket directory owned by the Slack service user, mode
2750, with a dedicated shared group that includes the core container's UID1000
principal (or equivalent explicit group ACL). The broker creates socket mode
0660 with the inherited group. Mount only this directory into core, never the
Slack DB/bindings/secrets directory. Give each service a private copy of the
separate broker credential; do not place either copy in the shared directory.
The runtime rejects shared directories containing its configured journal,
binding or broker token file. No existing pathname is removed on startup;
including a stale socket causes startup to fail closed. Serialized runtime-owner
cleanup of its confirmed stopped service is required after an unclean crash.
This avoids check/unlink races with a concurrently starting listener. The core needs an
explicit UDS client wired from its frozen native authorization, not model scope.
Source support is not proof of a configured mount, client, broker activation or
live Axiom timeline. Native `message_timing` currently queries native roots only.

Sources: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Agent development](https://docs.slack.dev/ai/developing-agents/),
[session status](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/),
[legacy RTM typing and restrictions](https://docs.slack.dev/legacy/legacy-rtm-api),
[manifest Agent settings](https://docs.slack.dev/reference/app-manifest/#features),
[Slack Node SDK](https://tools.slack.dev/node-slack-sdk/socket-mode/),
[thread replies](https://docs.slack.dev/reference/methods/conversations.replies/),
[core contract](core.md), and the
[json-render assessment](https://ampcode.com/artifacts/json-render-with-native-rune-and-slack-compatibility-assessm-70a08228-b11d-4f4c-b7de-4d12eff43202).
