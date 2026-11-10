# Native Executor catalog

**Source-supported catalog slice; local native MCP/Worker acceptance is separate
from configured production and live Executor/Axiom acceptance.** This is not
complete first-party execution support. DEBUGSHARE is a different integration:
its [independent authenticated tracker](../integrations/debugshare/README.md)
targets `debug.raygen.dev`, replacing the legacy Executor-hosted tracker.
Source implementation does not establish migration or runtime adoption; neither
tracker's credentials grant access to this catalog.

Workers expose `executor_skills`, `executor_search` and `executor_describe` through
the pinned `@earendil-works/pi-mcp` 1.5.0 `McpClient` and Streamable HTTP transport.
Interaction delegates through Task rather than gaining a second dispatcher.
No dependencies, public routes, generic call/execute/resume, account connection,
app effects or alternate email-send path are added. Those require real local
Procedure/account/effect enforcement, not upstream approval alone.

## Supported private provisioning

The supported route in this increment is Executor's documented PAT protocol:

- A human creates a **dedicated, single-organization** PAT at Executor's
  **Account settings → Tokens**, with a bounded expiry. The organization
  **Connections → Personal access token** tab supplies its organization ID/slug.
- The host owner privately provisions `COMPUTAH_EXECUTOR_PAT` and
  `COMPUTAH_EXECUTOR_ORGANIZATION` using the existing backend secret mechanism.
  Requests use the fixed hosted endpoint
  `https://mcp.executor.sh/org/<organization>/mcp` with Authorization Bearer.
- The intended authenticated principal separately needs `executor.catalog` in
  `COMPUTAH_AUTH_JSON`. Credential presence grants no principal access. Only
  provision a credential whose entire catalog this principal may read; a shared
  organization PAT is not per-user upstream isolation.

Missing credentials return `not_configured` without a request; missing grants
return `denied`. Runtime startup does not sign anyone in, register clients,
connect accounts, search local credential stores or extract Amp credentials.
Never substitute DEBUGSHARE/backend/provider keys. Rotate/revoke the dedicated
PAT through Executor; restart to adopt bootstrap credential/grant changes.
Executor validates current membership/token validity on requests; a PAT cannot
be locally narrowed to a scoped connection. The local dispatcher restriction
does not reduce that PAT's upstream authority if the host is compromised.

Executor also supports public-client OAuth registration and browser approval at
`/mcp/authorize`, selecting one organization. A scoped connection at
`/mcp?connection=<id>` selects app tools/accounts and revokes associated grants.
**OAuth state provisioning/refresh and scoped connections are not implemented by
this slice**; PATs do not inherit connection restrictions. Do not place an OAuth
token into the PAT setting or invent a proxy to avoid browser consent.

References inspected on 2026-11-09: [MCP protocol](https://executor.sh/docs/mcp),
[client connection](https://executor.sh/docs/mcp-clients),
[PAT protocol](https://executor.sh/docs/api-keys). Supported MCP discovery also
read the Executor `executor` and `code-mode` skills at revision
`7b3e100cb859051cf0e80ed2fe8ec9e0b078ffc9b8872bd7d70d6735982ae1c0`.
That research used Amp's connector only to inspect documentation/protocol;
the Computah runtime never uses it or its credentials.

## Tools and result contract

- `executor_skills({app?,name?,file?,version?,revision?})`: bounded optional
  selectors (200 characters each); returns the provider's native Markdown as
  `{kind:"skills",text}`. No arbitrary `accounts` argument is accepted.
- `executor_search({query?,namespace?,limit?,offset?})`: query up to 500 characters,
  namespace up to 200, limit 1–20, offset 0–10000. Returns a typed page with exact
  paths, descriptions, input signatures/truncation flags, namespaces/account
  labels, remaining count and next input. Use narrow namespaces and small pages.
- `executor_describe({paths})`: 1–20 exact paths, each up to 300 characters;
  returns full descriptions/signatures, missing paths/matches and namespaces.

Successful results are `{status:"ready",untrusted:true,catalog}`. Upstream
unavailable apps remain explicit app/name entries, without raw failure/recovery
text. Search/describe validate a positive schema and strip unknown fields;
both native structured content and JSON text are supported. Empty valid search
pages are real results, not replacements for errors. Empty/malformed skills,
missing pages and accepted MCP `isError` results never become empty success.
Skills prose, signatures, account labels and all other catalog data are
untrusted, not permission, executable instructions or evidence an app can run.

Unavailable results use only fixed codes: `denied`, `not_configured`,
`invalid_input`, `authorization_required`, `capacity`, `cancelled`, `timeout`,
`transport`, `provider_error`, `invalid_response`, `response_too_large`.
The Pi Durable tool result sets native `isError: true` for every unavailable
result and `false` for ready catalogs; the bounded JSON output is preserved.
No raw exception, credential, provider error body or stderr is checkpointed.
Known PAT echoes fail closed before disclosure; this is not a universal scrubber
for secrets an upstream app improperly embeds in catalog content.

## Lifetimes, authority and recovery

Each read creates/closes one session. At most four operations are admitted;
one 15-second total deadline includes grant/source checks and network I/O.
Cancellation aborts initialization/tool I/O and response consumption. Session
close and body cleanup are awaited before disclosure; DELETE uses the SDK's
bounded close deadline. Responses have a cumulative 256 KiB wire budget and
120000-byte MCP-result budget. Redirects, persistent GET streams, automatic
reconnect and retries are disabled. No background auth, refresh or recovery job
is created. Read-only safe replay can repeat discovery and observe catalog changes;
it is not durable remote program continuation or a frozen catalog snapshot.

The host captures the private Worker principal, checks current `executor.catalog`
and inherited source generations before every request and after cleanup. Revocation during
I/O suppresses the result; neither tool arguments nor catalog content can change
the principal or source authority. Executor owns these execute-level fences,
including safe replay, inside its total deadline rather than the generic source
wrapper's unbounded checks. Bootstrap grant updates require host adoption;
the library callback supports dynamic revocation.

## Evidence and remaining gates

Local tests exercise the actual pinned client over loopback HTTP, not a mock MCP
client: skills/search/describe, malformed/oversize/error/auth results, current
principal/source-generation revocation, capacity, deadlines and cancellation.
Real Rivet/Pi Worker tools with a deterministic model exercise catalog selection,
sleep/wake and revoked-grant denial; no live model or app effect is invoked.

`computah.executor.catalog` spans include initialization, authority checks,
read and awaited cleanup. Native Pi context is restored for parent continuity.
Fixed outcomes and linked `operation.completed` logs use the shared bounded,
sanitized Axiom export path. Tests inspect exported spans/logs, parent continuity
and credential/account/catalog canary absence, including failure/cancellation.
No catalog, selector, account identity, credential or provider body is telemetry.
Local exporter interception is **not live Axiom ingestion**. Abrupt process death
and interrupted execute-intent replay continuity are not independently proved.

Production credential provisioning, source adoption, a live catalog request under
the intended principal and revision-matched live Axiom evidence remain separate
host-owner/human gates. Default-disabled publication is useful source delivery,
not configured/live discovery and not first-party execution completion.
