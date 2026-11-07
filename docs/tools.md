# Native tools and credential boundaries

This page is a **product contract and later integration plan**, not enabled tooling.
Phase 0's safe DTOs/fixtures contain no real accounts, tokens or provider setup.

## First-class Worker capabilities

Agent-browser and Tavily are explicit native integration requirements alongside
Executor and early Composio/Gmail. They must have discoverable typed capabilities,
not only a generic shell command or an indirect Composio fallback. Interaction
keeps its minimal Task-first role; Workers use native Effect service boundaries.
The wire viewer's capability strings are projections, not a tool registry or grant.

The research owner verified `vercel-labs/agent-browser` at source
`370d41db67a198944bcee2c96cc454594e7d56c6` and orb binary 0.38.1; Tavily's native
SDK is `@tavily/core`. Recheck selected versions at integration; neither provider
is installed by this requirement. Define typed request/result/error schemas, trace correlation,
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
