# Native priority requests and role models

The current operational instruction is to resume backend and Slack with supported
Fast requests. It supersedes the earlier never-start/exclusive-tier HOLD. Remote
scheduling is not under client control: always request priority, disclose actual
tiers, and do not shut down the service merely because the provider downgraded.

## Exact configuration migration

Keep existing durable storage, connection secret, auth bindings and private Pi
credential mount unchanged. Remove the obsolete `COMPUTAH_MODEL` variable; real
mode rejects it rather than silently ignoring an old model selection. Use:

```dotenv
COMPUTAH_MODE=real
COMPUTAH_INTERACTION_MODEL=openai-codex/gpt-6.1-terra
COMPUTAH_WORKER_MODEL=openai-codex/gpt-6.1-sol
```

Both role variables are optional because these exact values are the defaults.
Different real role overrides are rejected. `COMPUTAH_PI_AUTH_FILE` retains its
existing absolute private writable mount; no credential copying, provider change
or alternate account is needed. `COMPUTAH_PROVIDER_API_KEY` retains its existing
explicit provider-scoped semantics; it is not an implicit OAuth fallback.

Both roles configure native `thinkingLevel: high`, including settled roots on
wake. The final provider payload also enforces `reasoning.effort: high`, so old
checkpoint options cannot restore off/low reasoning. No low-reasoning shortcut or
silent model substitution is used. Explicit faux mode remains synthetic only.

## Request boundary and safe diagnostics

`main.ts` passes the official Models runtime through `priorityModels` before
constructing the core. It wraps `stream`, `complete`, `streamSimple` and
`completeSimple`. Pinned Pi Durable generation uses `streamSimple`; native
compaction uses `completeSimple`. Both resumed checkpoint requests go through the
same runtime. The supported `onPayload` callback runs after the caller's native
payload hook and finalizes `service_tier: priority` and high reasoning. This is
necessary because Pi AI simple-options conversion drops `serviceTier`.
Transport retries resend the finalized body; durable retries re-enter this
boundary. Streaming stays native; there is no second loop or output buffer.

Original callbacks, cancellation, auth, headers and native response messages are
preserved. Raw `onProviderStreamEvent` observations, not Pi's pricing-derived
tier, record created/completed tiers. `computah.model` JSON logs contain only the
fixed catalog model ID, request preference, HTTP status, allowlisted tier/stage
and finite terminal outcome. Unknown tiers become `other`; missing becomes
`missing`. Prompts, output text, raw errors, response headers, account IDs,
credentials and request identifiers are never logged by this observer. Native
errors still reach the caller; observer classification distinguishes the known
reasoning rejection without copying arbitrary error text into logs.

The deployment owner's bounded official-provider diagnostics confirmed both exact
models callable with priority/high: HTTP200, raw created `auto`, completed
`default`, terminal stop. These are successful **priority requests**, not proof
of priority execution. Earlier Terra HTTP403 was concretely
`reasoning_effort_not_allowed` at explicit reasoning off; changing to intended
high succeeded. It was not model unavailability or a priority rejection.

OpenAI's [Fast guide](https://developers.openai.com/api/docs/guides/fast-mode)
documents supported priority/fast aliases and possible standard-speed downgrade.
There is no client-selected default fallback here, but the client cannot force
remote scheduling. Default/auto/missing tiers are visible, not grounds for a new
global startup block. No claim of exclusive Fast execution is made.

## Checkpoints, restart and adapter compatibility

Keep all original durable entries and native compaction data. Root configuration
changes settled roles on wake; generation and compaction already in flight retain
their saved checkpoint model. No checkpoint/history rewrite is implemented. The
wrapper applies priority/high even on replay, but rejects an old checkpoint model
outside the requested Codex pair explicitly rather than substituting one. Drain
in-flight generation AND compaction under the deployment owner's existing lock
before upgrade; if stale work exists, use supported cancellation/reconciliation,
not database edits. This is a per-task migration concern, not a universal remote
tier HOLD. Preserve the independently running model-free bus unchanged.

The legacy Slack REST contract is unchanged: authenticated `GET /v1/viewer`
returns trusted tenant/user/agent and capabilities; `POST /v1/submissions` requires
`task.send` and strict `{text, clientMutationId}`; signed
`GET /v1/submissions/:id?wait=true` requires `history.read` and projects results.
No bus rewiring or new adapter behavior is part of this delta.

## Evidence and limits

Deterministic tests run the installed official Codex adapter with synthetic OAuth
and intercepted HTTP, checking the outgoing body for both roles across all four
request methods, caller transforms, high reasoning, raw auto/default observations,
HTTP403 classification/redaction and rejection of old checkpoint models. These
fixtures prove payload compatibility with the pinned adapter, not remote tier
delivery. Existing native Rivet/Pi core tests cover Task/Worker, history retention,
restart, cancellation and native compaction; persona tests cover settled role
model changes across reopen. Interrupted production checkpoint drain and actual
backend/Slack resumption are deployment-owner acceptance, not fixture claims.

Pinned source: `@rivet-dev/pi` 0.5.6 and Pi AI/Pi Durable 1.5.0,
`pi-ai/dist/{providers/data/openai-codex.json,api/openai-codex-responses.js,api/simple-options.js}`,
`pi-durable/dist/harness/{generation,compaction}.js`. No dependency upgrade.
