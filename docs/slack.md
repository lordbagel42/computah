# Slack prototype

Status: adapter implementation; dedicated Slack app created, approved and installed
through official CLI, **not yet live message-roundtrip verified or activated**. It uses
official `@slack/socket-mode` 3.1.1 and `@slack/web-api` 8.3.0, no separate model,
Pi instance or bot history. Protected core REST admission/result calls reuse the
existing tenant/user/agent Interaction and persistent Task/Worker. There is no
streaming, subscription, revision replay, OAuth onboarding service or rich UI.

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

The manifest needs only `app_mentions:read`, `im:history`, `im:write`, `chat:write`;
events `app_mention` and `message.im`. For a CLI-controlled test run, `slack run`
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
No workspace-wide history, user email/read, channel discovery, files or admin
scope is requested. Installation can require workspace-admin approval.

Socket Mode uses Slack's authenticated outbound WebSocket and SDK envelope ACK,
so no public ingress, signing secret or HTTP signature verifier is required. Do
not expose this event handler as an HTTP endpoint. A future HTTP transport must
verify Slack signatures/replay windows before admission. This single-install bot
uses its installation bot token; OAuth client secrets/redirects are unnecessary.
Current connected Executor discovery exposes no Slack app-admin tool. No CLI or
login context existed in this orb or on nest-bagel; CLI was installed in this orb
only. Manual app settings at <https://api.slack.com/apps?new_app=1> are a fallback,
not the preferred ask. Installation/approval is now verified; runtime provisioning
and a live message roundtrip remain unverified.

## Private runtime configuration

Run `pnpm --filter @computah/slack start` with Node >=22.19 (uses `node:sqlite`),
after the integrator installs the pinned package and updates the root lockfile.
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

| Variable                       | Purpose                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`              | Dedicated installation bot token                                                |
| `SLACK_APP_TOKEN`              | Dedicated app-level Socket Mode token                                           |
| `COMPUTAH_CORE_URL`            | Protected backend origin; loopback HTTP on nest-bagel port8787, otherwise HTTPS |
| `COMPUTAH_SLACK_BINDINGS_FILE` | Absolute private mode0600 JSON file described below                             |
| `COMPUTAH_SLACK_DB`            | Absolute SQLite journal path in dedicated mode0700 persistent directory         |

Bindings are a private JSON array, each entry containing `teamId`, `slackUserId`,
`tenantId`, `userId`, `agentId`, `coreToken`, `channelIds` (array of explicit Slack
channel IDs), and optional `enterpriseId` required for an organization installation.
The operator must obtain real Slack IDs and map them to an existing
trusted core principal. Reuse the user's existing principal scope, not a new
Slack-specific actor. Never derive these fields from message text or a model.
Startup verifies the bot installation team (or exact explicit enterprise for an
organization token) and every binding against `/v1/viewer`,
including `task.send`/`history.read`; the bearer principal owns actor identity.
Restart to rotate/revoke bindings/tokens. Already-running core work is not cancelled.
No default binding, auto-enrollment or email lookup exists.

Run exactly **one adapter process** per journal/installation. Keep journal and
WAL files private; they contain input text and scoped result handles, not secrets
or full histories. Persist them across restarts, on local durable storage; no
network filesystems. The delivery journal is not the canonical Pi transcript.
There is no active-active ownership/locking or automatic journal migration.
Deployment owner must supervise it separately, allow outbound Slack HTTPS/WSS,
and give it private access to the existing loopback backend, without exposing
Rivet/inspector. A separate container cannot reach host loopback by default;
choose host networking on the authorized Linux host or another explicit private
route. Do not start a second core against the same Rivet storage. No deployment
files are part of this packet; deployment owner owns that integration.

## Routing and disclosure

Mapped users can DM the app, including DM thread follow-ups. Their replies stay
in the originating DM thread. A mention in an explicitly allowlisted channel or
channel thread admits work, but its result goes to the **requester's private DM**,
not that shared thread. Every surface uses the same primary Interaction.
No channel contents are fetched, no other users' messages are used, and no output
is posted to channels. Channel admission permission cannot authorize disclosing
private Interaction/email history to a broader audience. Shared channel replies
need a future audience-safe core projection; they are deliberately not implemented.
Channel follow-ups must mention the bot again; ordinary channel replies are not
subscribed. Bot messages, edits, deletions, unmapped users/teams and nonallowlisted
channels are ignored and ACKed. Oversized/empty inputs are ignored.

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
active receipts and 5000 total are admitted; completed/uncertain receipts expire
after seven days during admission. Delayed duplicates outside retention can
produce another notification, although core mutation IDs still deduplicate work.

A single polling worker performs bounded 30s core requests, roughly one per second
between steps, and waits at most five minutes from receipt before trying a truthful
private timeout notice. This does not cancel core work. Backlog and network outage
can delay that notice; no hard wall-clock delivery guarantee.
Core failures retry with the same receipt until deadline; core errors/private
details never appear in Slack or logs. Revoking the core token blocks new reads.

Slack dispatch is recorded as `posting` **before** opening a DM or posting;
success becomes `done`, failure or restart during dispatch becomes `uncertain`.
A failed DM open therefore cannot retain oldest-job priority and indefinitely
block other users. This deliberately requires operator reconciliation even when
the failure occurred before a message was posted. The SDK's
automatic Web API retries are disabled. No blind re-post after ambiguous network
failure; this trades possible lost notifications for avoiding duplicate private
messages. 429 responses also require operator reconciliation in this first slice,
not a claim of complete retry/backoff. `counts()` exposes only aggregate receipt
states for operator checks. Do not manually requeue uncertain sends without
reconciling the actual DM. No exactly-once Slack delivery is claimed.

## Verification / trying it

Run `pnpm --filter @computah/slack typecheck` and
`pnpm --filter @computah/slack test`. Synthetic transport tests exercise real
SQLite restart/dedup, trusted mapping/denials, stable admission after response
loss, private routing, DM threads, uncertain posts, deadline and bounded output.
They also cover a failed DM open not blocking another user, explicit enterprise
versus workspace installation guards, and SIGTERM/SIGINT during pending Socket
startup. They do not prove live runtime Slack acceptance or model generation.

A separate disposable executable check also passed: synthetic Slack event →
SQLite admission → adapter restart → actual authenticated HTTP → real Rivet/Pi
Interaction/Task/primary Worker → fake private Slack reply. A follow-up shared
the same primary history (four public messages); duplicate admission posted once.
Only the model and Slack delivery were fake. The full workspace formatter, check,
typecheck and tests passed locally. No real Slack post or provider call was made.

After credentials/config and deployment are installed: DM Computah a synthetic
request asking its primary Worker to remember a harmless nonce, then follow up
in that DM thread. Mention it once in the approved prototype channel: confirm
answer arrives only in DM, never in channel. Restart only the adapter and verify
a follow-up uses the same Interaction/Worker; replay a synthetic event in local
tests, not a private real event in logs. An unmapped test user must get no model
response. Record only aggregate outcome, not private message/history contents.
Until that is executed, live Slack roundtrip remains a runtime-provisioning gate,
not an outstanding owner login/install approval.

Sources: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/),
[Slack Node SDK](https://tools.slack.dev/node-slack-sdk/socket-mode/),
[core contract](core.md), and the
[json-render assessment](https://ampcode.com/artifacts/json-render-with-native-rune-and-slack-compatibility-assessm-70a08228-b11d-4f4c-b7de-4d12eff43202).
