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
`COMPUTAH_AUTH_JSON`, rechecked before query and disclosure. Runtime uses only
`COMPUTAH_AXIOM_QUERY_TOKEN`, privately provisioned as Query-only access to
`computah-prod-traces`. Key presence does not grant a principal access. Never
extract Amp MCP credentials or reuse ingest/management credentials. Dataset
scoping alone is not tenant isolation: tool arguments cannot select arbitrary
APL, dataset, time range, trace IDs or foreign actors. Incoming `traceparent` is
correlation, not authority to query its entire trace; upstream Slack/bus timing
requires a separately host-verified durable receipt linkage.

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

Admission is a host commit clock, **not sender-to-ingress delay**. Model lifetime
is through terminal stream result, **not TTFT**. Slack Web API lifetime is not
platform delivery confirmation. Nested phases overlap: never add them as reply
wall-clock. Missing sender creation, receive, queue and delivered timestamps stay
unavailable rather than zero. Best-effort export can lose spans; an empty query
does not prove no work occurred. Separate Slack/bus durable timing instrumentation
and scoped query credential provisioning are not implied by this source packet.

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
