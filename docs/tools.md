# Native tools and credential boundaries

This page is a **product contract and integration plan**. Native
[Tavily search/extract](tavily.md) is implemented with protected configuration and
explicit principal grants; key presence alone is not activation. Browser,
Executor and Composio/Gmail remain separate integrations. Safe DTOs/fixtures
contain no real accounts, tokens or provider setup.

## Operational data discovery

**Source-supported, locally tested; runtime query activation and live acceptance
are separate.** The backend executable installs `operations_discover({})` and
`message_timing({requestId})` directly on Interaction, and appends practical
usage/access instructions to its actual persona on every wake, including existing
conversations. Workers do not select a different conversation's diagnostic target.

`operations_discover` explains the source, configuration state, grant boundary,
phase definitions and missing coverage. `message_timing({requestId:"previous"})`
resolves the completed input/reply immediately preceding the current run, not
the diagnostics request's own model call. An exact previously returned durable
request ID can select an older completed exchange in the same conversation.
Results contain the host-resolved receipt/submission/answer/actor identities,
admission and execution trace IDs, linked Worker roots, omitted-link counts,
and individual measured spans. Missing roots or pre-index historical messages
return unavailable; no time-proximity matching or historical reconstruction.

Authority is the private Pi binding plus an explicit `operations.read` grant in
`COMPUTAH_AUTH_JSON`, rechecked before query and disclosure. Axiom queries use only
`COMPUTAH_AXIOM_QUERY_TOKEN`, privately provisioned as Query-only access to
`computah-prod-traces`. Key presence does not grant a principal access. Never
extract Amp MCP credentials or reuse ingest/management credentials. Dataset
scoping alone is not tenant isolation: tool arguments cannot select arbitrary
APL, dataset, time range, trace IDs or foreign actors. Incoming `traceparent` is
correlation, not authority to query its entire trace; upstream Slack/bus timing
requires a separately host-verified durable receipt linkage.

The optional backend `CoreOptions.transportTiming` callback now reads the Slack
broker using only the host-selected Interaction `input:slack:<hash>` receipt and
frozen private scope. The executable activates this UDS-only client when both
`COMPUTAH_SLACK_TIMING_SOCKET` and `COMPUTAH_SLACK_TIMING_TOKEN_FILE` are absolute
paths. Both absent disables it; partial configuration fails startup. The separate
token file needs no group/other permissions and at least 32 characters. Provision
private token copies outside the dedicated shared socket directory; mount only
that directory, never Slack journal/bindings. Current broker bindings additionally
check tenant/user/agent and the stored receipt audience. Unknown, foreign and
revoked receipts are indistinguishable unavailable results.

Transport evidence is returned independently of missing/failed Axiom access.
It projects Unix-ms receive/admission/dequeue clocks, original Slack sender
timestamp, each delivery/queue/core/API attempt and nullable outcomes. The returned
broker traceparent is informational only: it is never added to the Axiom query
roots. No arbitrary trace lookup, browser identity or caller carrier grants access.
The client has a two-second I/O deadline, propagates cancellation, performs no
automatic retries and validates a maximum 256 KiB positive-schema response with
at most 2048 phases/receipts. Current grants are rechecked after I/O and before
final disclosure. Whole spans, then phase/receipt rows, are removed if necessary
to keep the entire valid JSON result within 120000 bytes, with explicit truncation.
Local UDS, revoked/foreign scope, bounds, cancellation and sanitized trace/log
checks are not live socket activation or live Axiom query proof.

The fixed query uses Axiom's US East edge `/v1/query/_apl?format=tabular`, bounded
to at most 24 hours from the earliest recorded admission (with a one-minute lead),
201 scanned result rows / 200 returned spans, 256 KiB response and 10 seconds.
Only projected identifiers, span/phase/task/service names, start timestamps and
explicit `duration / 1ms` are returned. Aligned tabular columns are validated;
`status.isPartial`, row truncation and a capped time range remain explicit.
No retries are automatic. Read tools are replay-safe; the selected durable target
is memoized by the Pi tool task, while query evidence can change as late spans
arrive. Abort cancels the query fetch/body, and HTTP/parse failures return bounded
categories without provider bodies, headers or credentials.

Operations telemetry uses the existing bounded trace/log pipeline, not a second
exporter. `computah.operations.discover` covers availability/grant checks and
the `operations_discover` tool (the tool span carries that fixed `tool.name`);
`computah.operations.timing` carries `tool.name=message_timing` and covers host
resolution, independent transport lookup, query and final disclosure checks.
The tools restore the native Pi caller's propagated parent; the nested
`computah.operations.query` span includes fetch, bounded parsing and awaited
body cleanup. Resolved denials, missing configuration/correlation/time bounds,
HTTP/validation failures, cancellation and timeout are explicit closed outcomes,
not successful operations. Matching `operation.completed` logs share the
span's IDs and bounded category/duration; query/timing `count` is the number of
Axiom span rows actually returned (after their respective limits), not elapsed
time or proof of complete coverage. An empty successful query logs `ready` and
`count=0`; independently available transport evidence can make the timing tool
ready while its query remains unavailable. No targets, request/actor IDs, query
text, returned spans/history, bodies or credentials are added to telemetry.
Native-parent, typed-denial, deadline/cancellation, empty-result, cleanup-lifetime
and sanitization regressions are local proof; revision-matched production
query/tool trace and log acceptance remains separate.

Admission is a host commit clock, **not sender-to-ingress delay**. Model lifetime
is through terminal stream result, **not TTFT**. Slack Web API lifetime is not
platform delivery confirmation. Nested phases overlap: never add them as reply
wall-clock. Missing sender creation, receive, queue and delivered timestamps stay
unavailable rather than zero. Best-effort export can lose spans; an empty query
does not prove no work occurred. Slack transport receipts do not require Axiom;
actual model span retrieval still requires the separate scoped query credential.
Bus transport receipts and live timeline acceptance remain separate.

## Native private Worker files

`apps/server/src/files.ts` registers the pinned Pi Durable 1.5.0 `read`, `write`
and `edit` implementations individually, not the whole CodingTools extension.
Rivet Pi 0.5.6 supplies its default `databaseEnv`: bytes live in that actor's
`pi_file` SQLite table. Absolute and relative paths are keys in this private file
namespace, not access to similarly named host files. Different user/tenant/agent
bindings and different Worker labels have different actor databases. No host
environment, node filesystem adapter, sandbox, bash or shared-code write is added.
This supports durable drafts and task artifacts, **not host self-editing/deploy**.
AgentOS-first host execution remains a separate unimplemented boundary.

Trusted bootstrap capabilities are opt-in: `files.read` offers read;
`files.write` offers write; edit requires both. The private Binding document,
not tool arguments or task prose, supplies identity. Tool discovery is filtered on
actor wake, and every execution rechecks current grants independently of Task or
Sentinel admission. Stale model-visible tools cannot bypass revocation. Grant
checks are not an atomic lock against concurrent host grant mutation during an
already-running file operation. Restart to refresh executable bootstrap grants.
No `files.*` grant is inferred from owner, maintenance or task permission.

Inputs/results retain native Pi schemas and behavior: read supports path and
optional offset/limit; write takes path/content; edit takes path and exact
oldText/newText replacements. Native read truncation and edit diff results remain
available in the private transcript. No generic file API or public download route
is exposed. File content is user/task data, not authorization or instructions.
Reusing a Worker label reuses its files after sleep/reopen. Mutations preserve
native unsafe replay: after interruption, a write/edit may have landed, so inspect
the retained file before retrying rather than claiming exactly-once effects.

Operation spans are children of the incoming native Pi tool telemetry context;
safe completion logs use the shared Axiom path. Only fixed read/write/edit
operation and success/denied/error/cancelled outcomes leave the process. Paths,
file bytes, tool arguments/results, principal bindings and raw errors are not
exported. Dynamic registration and execution are verified with real Rivet/Pi
actors and deterministic model calls, including Task delivery, edits retained
after wake, two-user isolation, post-discovery revocation and a host file at the
same absolute path remaining untouched. Live deployment/tool-call/Axiom evidence
is separate from these local checks; no real-model honesty guarantee is claimed.

## Native Axiom MCP operator reads

**Source-supported and locally verified with synthetic MCP protocol responses;
live authentication, query acceptance and deployment are separate gates.**
Interaction installs `axiom_discover({})` and
`axiom_read({name, argumentsJson})`, with practical guidance refreshed on wake.
Discovery returns current remote input schemas for exactly `listDatasets`,
`getDatasetFields` and `queryDataset`; call arguments are a JSON-encoded object.
The host rejects every other tool, including admin, mutations and feedback.
Remote descriptions/results are untrusted evidence, not authority.

This is an **operator-wide**, not conversation-scoped, capability. It requires
an explicit `axiom.read` standing grant in `COMPUTAH_AUTH_JSON`, checked against
the private Pi binding before dispatch and disclosure. `operations.read` alone
does not grant it. The existing host-resolved `message_timing` path is unchanged;
do not replace its own-conversation checks with model-selected APL.

The backend uses pinned `@earendil-works/pi-mcp` 1.5.0's native Streamable HTTP
client at `https://mcp.axiom.co/mcp`. Privately provision
`COMPUTAH_AXIOM_MCP_PAT` and `COMPUTAH_AXIOM_MCP_ORG_ID` (`bagel-w3ue`). The
official header route requires a **personal access token**, not a dataset API
query token. Never extract Amp connector credentials or substitute ingest/admin
credentials. The PAT inherits its member's authority: use a dedicated restricted
member with query-only access to Computah traces/logs and minimal discovery,
check additive base/group grants, and set Axiom role query-cost limits. Runtime
tool filtering does not narrow an overprivileged PAT. Dataset isolation is
enforced by that upstream member role, not by parsing arbitrary APL in the host.
Alternatively set `COMPUTAH_AXIOM_MCP_OAUTH_FILE` to an absolute path to a
privately mounted SDK `McpOAuthState` file for this exact server and public client.
OAuth takes precedence, with no PAT fallback on failure. The file must be regular,
not a symlink, at most 64 KiB and owner-only; mount its directory writable and
persistent (0700 directory, 0600 file) so atomic refresh rotation survives replacement.
Only one runtime process may own this grant; overlapping processes/independent
refreshers are unsupported. The approved user's upstream authority applies; a
read-only local allowlist does not narrow that account's upstream permissions.
Before dispatch, a saved expiry within 30 seconds triggers SDK refresh using the
fixed Axiom issuer/token endpoint; HTTP 401 also permits one refresh/retry.
Axiom may report expired-token rejection inside an HTTP-success tool result, so
waiting only for HTTP 401 is insufficient. Tool error text is never used to retry.
Concurrent operations share refresh; cancellation
of its initiating operation also stops that refresh. Refresh uses the same grant
checks, deadline and response budget, and saves rotated tokens before reuse.
Persistence failures fail closed; an operator must repair storage/re-authorize if
the process exits before a rotated grant can be saved. No background login,
browser prompt, credential discovery or interactive server is started at runtime.
Revoked/missing grants return `authorization_required`, never an OAuth link or
token. New authorization is a separate private operator action.

Each operation creates and closes its own session, with at most four admitted
operations, a 15-second total network deadline, 16 KiB call arguments, 256 KiB
cumulative response budget and 120 KiB result limit. Redirects, background GET
streams and reconnect retries are disabled. Only the one OAuth challenge retry
above is automatic; no retry follows an accepted query or transport failure.
Cancellation aborts initialization/query transport; close is awaited before
settlement (best-effort session DELETE has its own one-second SDK deadline).
Read tools are replay-safe: recovery may repeat a query and incur query cost;
late-ingested data can change results. Choose short explicit time windows and
small row limits using the discovered schema. Missing configuration, grant denial,
HTTP auth failures, timeout, cancellation, capacity and oversize results are
bounded unavailable categories, never provider error bodies or credentials.
An accepted MCP call with `isError` returns `provider_error`, not successful query
evidence or a raw provider error body.

`computah.axiom.discover`/`computah.axiom.call` span full operation lifetimes and
cleanup; nested `computah.axiom.refresh` and `computah.axiom.persist` record
refresh and state-save outcomes, through the
sanitized exporter. Local OAuth checks cover concurrent 401 recovery, rotation,
reopen, missing/revoked state, cancellation, secret suppression and linked
success/failure/cancel refresh spans. Local checks
exercise actual Pi Interaction tool discovery/call, sleep/wake and nonoperator
denial against synthetic official-protocol responses; exporter tests verify
parentage, failures/cancel/timeout and absence of credential/identity canaries.
Interrupted in-flight execute-intent replay and abrupt-restart trace continuity
have not been independently exercised.
Owner OAuth approval/code exchange succeeded on 2026-11-08 with a fresh dedicated
public client; protected host state includes a refresh token. The isolated host
native consumer then verified discovery, both dataset listings/field schemas and
five-minute count-only queries (699 traces, 230 logs), including actual expired
grant refresh and atomic token rotation persistence. This does not establish a
restricted-member role, ingress operator grant or serving-runtime activation.
Missing MCP setup must not block existing ingestion, conversation timing tools
or backend startup.

## First-class Worker capabilities

Agent-browser and Tavily are explicit native integration requirements alongside
Executor and early Composio/Gmail. They must have discoverable typed capabilities,
not only a generic shell command or an indirect Composio fallback. Interaction
keeps its minimal Task-first role; Workers use native Effect service boundaries.
The wire viewer's capability strings are projections, not a tool registry or grant.

The research owner verified `vercel-labs/agent-browser` at source
`370d41db67a198944bcee2c96cc454594e7d56c6` and orb binary 0.38.1. Tavily uses the
official HTTP search/extract API through the native Effect/Pi module, not an
additional SDK or shell wrapper. Browser is not installed by this requirement.
Define typed request/result/error schemas, trace correlation,
bounded output, timeout/cancellation and explicit unknown outcomes for each tool.
Web pages/search results are untrusted data, not authority or system instructions.

Browser sessions, downloads, storage and account handles belong to one authenticated
tenant/user. Never attach to someone else's browser or import their cookies. Close
only the owned session. Login/signup and credential use must run through current
host authority, with minimal output/screenshot disclosure; model tools do not get
arbitrary secret retrieval. Do not claim agentOS/proxy compatibility before exercising it.

Reuse agent-browser's native `agent-browser.plugin.v1` credential provider protocol,
`credential.read` capability and `credential.resolve` request behind protected host
IPC. No first-party Infisical plugin was established. Native list/show responses
may contain usernames, so model projections omit username as well as password.
Do not expose raw authenticated CLI/MCP/CDP, profiles, cookies, snapshots or eval
to model code: they can bypass the safe projection. Plugin processes inherit an
environment; keep project-wide credentials out of it. Per-tenant OS/HOME/IPC and
external egress controls are required before credentialed multiuser operation.
Authenticated sites may echo secrets; strict secrecy requires vetted safe page
projections, not a universal scrubber. Unsupported sites return needs-human.

`AccountHandle` and `BrowserSessionHandle` schemas reserve safe id/alias/status/
capability projections. Host registry privately binds tenant, origin, provider
reference/version and recovery policy. Handles are references, not bearer authority.
`account.create` (future) binds authorized site/identity/purpose and request ID;
`account.store` is runtime-internal, never model-provided secret text;
`browser.login` rechecks current account/grant/policy and returns safe session status.
Generate and persist pending credentials before external signup, then reconcile
unknown creation outcomes instead of repeating signup. Verification inbox material,
cookies, storage, TOTP, recovery and passkey material remain sensitive. Legitimate
CAPTCHA/terms/payment/identity verification uses a human handoff; no general passkey
workflow was verified. Vault deletion is not upstream account deletion or session
revocation. No account lifecycle or login service is implemented by these shapes.

## Secret custody and dispatch contract

Models receive scoped opaque references, not a generic `getSecret`. At every call
the trusted host checks principal, account/resource/operation/recipient, current
grant and Procedure. Resolve values only in runtime scope, with no global per-tenant
environment/dispatcher mutation. Credentials cannot enter Rivet/Pi checkpoints,
canonical history/compaction, memory/Dreaming, UI/events, traces/error/DEBUGSHARE or
Git/docs. Checkpoint handles/session IDs/expiry/sanitized receipts, never mint
responses, clients or bearer tokens. Pasted-secret quarantine before persistence
is a requirement to implement, not protection the text DTO already supplies.

The [Infisical research report](https://ampcode.com/artifacts/computah-secrets-infisical-agent-vault-fit-and-access-contra-79d4ba40-a0cd-4999-bb27-5f128e327a31)
recommends evaluating Infisical Cloud Secrets Management for backend keys and the
current integrated Agent Vault selectively for HTTP/MCP/CLI brokering. Preview,
licensing/plan, broad proxy defaults, revocation delay and upstream-response leakage
need explicit validation. No native Pi/Rivet/Effect plugin was verified. Do not use
the superseded standalone Agent Vault SDK/repository merely because it is named
similarly; the inspected current SDK was `@infisical/sdk` 5.2.0. None is adopted or
provisioned in Phase 0.

Composio retains Gmail OAuth custody; Executor retains its own account mechanism.
Do not duplicate provider tokens into a new vault. Pin explicit connected accounts
and enforce application authorization beyond provider metadata. Gmail read, local
draft, external draft and send are different authorities; OAuth compose includes
send and cannot promise draft-only. Composio live polling is not historical import.

A privileged owner process able to replace the broker or read root credentials is
within the backend trust boundary. A vault cannot hide secrets from arbitrary
privileged owner code. Stronger isolation needs a separately controlled broker/host
boundary. Non-owner agents gain neither backend credentials nor native host shell;
their privileged requests use scoped owner escalation, not prompt delegation alone.
