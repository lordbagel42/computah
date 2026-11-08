# Public trace observatory

Independent public HTTPS Worker: https://computah-observatory.enderium42.workers.dev
Source: `apps/observatory`. This is not the authenticated internal DEBUGSHARE
tracker and does not expose the private backend or its reports.

## Disclosure and wire contract

`GET /api/traces` accepts no query parameters or client-supplied IDs/APL. A single
Durable Object coordinates all readers. Its fixed server-side Axiom query selects
only timing/topology fields from `computah-prod-traces`, excludes observatory
self-telemetry before limiting, and reads the newest 1,001 rows in 15 minutes.
At most 1,000 spans are returned. This is a rolling bounded view, not a lossless
archive or a promise that every trace fits. Partial query results and overflow set
`truncated`. Query deadline is eight seconds, response bound is 2 MiB, cadence is
at least five seconds globally, failure backoff is capped at 30 seconds.

An independent positive projection reconstructs each public span with only:
`id`, `traceId`, `parentId`, `parentState`, `links`, `name`, `service`, `start`
(epoch milliseconds), `durationMs`, and `status` (`ok`, `error`, `unset`). The
response adds `state`, `fetchedAt`, `windowMs`, `limit`, `truncated`, `spans`.
Names/services use a literal approved catalog; unknown values become generic.
Domain-separated keyed hashes replace raw trace/span IDs. Parent/link presence
is checked within the returned window; absent/malformed parents remain explicitly
missing, never joined by timing guesses. Axiom currently has no links column;
`column_ifexists` handles that without inventing endpoints.

All attributes/resources/events, error strings, identities, actor/request keys,
conversation content, model content, DEBUGSHARE IDs/report pointers and private
links are discarded. No credential reaches static assets or public responses.
No arbitrary-query proxy exists. Security headers restrict browser connections
and scripts to the same origin. All rendered payload text uses `textContent`.

## Freshness and interaction

The browser polls on completion every five seconds, never concurrently, with an
eight-second deadline and 10/20/30-second reconnect backoff. Hidden tabs suspend
polling; pause stops it. Failed refreshes retain the last snapshot and original
timestamp, explicitly disconnected/stale. Unknown freshness is not called live.
Service/status filters retain dimmed causal context. Timelines scroll internally
in both dimensions and support keyboard selection. Demo is an explicit static
synthetic example, never automatic fallback or claimed production activity.

## Deployment and activation

Alchemy 2.0.0-beta.85 Cloudflare stack lives in `apps/observatory/deploy`, with its
own pinned workspace/lockfile. Install there with `pnpm install --frozen-lockfile`.
Use `pnpm run plan` then `pnpm run deploy --yes` with the approved Cloudflare
environment credentials/account. No private host ingress changes are required.
Deploy state under `.alchemy` contains unwrapped secret material: keep it ignored,
owner-only and on protected storage. The stack sets umask 077; secure existing
state files/directories too. Do not print or publish state.

Activation requires an explicitly provisioned dataset-scoped query-only
`COMPUTAH_AXIOM_QUERY_TOKEN` and random `PUBLIC_ID_SECRET` of at least 32 characters.
Inject privately through protected environment/bindings; never use an ingest or
Amp MCP credential for queries. Generate and retain the HMAC secret securely;
rotation changes public identifiers. Code-only reconciliation without these values
refuses to proceed. `COMPUTAH_OBSERVATORY_BOOTSTRAP=1` deliberately deploys an
unconfigured shell and can clear existing bindings: use only for initial bootstrap
or intentional deactivation, never routine redeployment.

Optional `COMPUTAH_AXIOM_INGEST_TOKEN` enables an isolated fixed-schema edge OTLP
emitter, not the Node bootstrap. It emits only HTTP/poll lifetimes, fixed outcomes,
random IDs and dropped-count scalars; no URL/request/error data. One DO owns its
budget (eight export attempts/5 seconds, four concurrent, two-second deadline),
and polls inherit the initiating HTTP span. Export fails open; dropped accounting
is bounded. Edge self-telemetry is excluded from the public feed to avoid visitor
traffic displacing application activity.

## Evidence and remaining gaps

- Public shell deployed through Alchemy on 2026-11-08; runtime query credential
  absent, so actual public production ingestion/render acceptance remains blocked.
- Fixed query compiled against real production rows through authorized Axiom MCP:
  https://app.axiom.co/bagel-w3ue/query?qid=fR3cEBDmw9T-to6be1
  This proves schema/query compatibility, not Worker runtime query authorization.
- Local tests cover positive disclosure canaries, opaque topology, malformed and
  missing ancestry, partial/truncated parsing, single-flight/backoff/stale retention,
  byte/deadline limits and bounded exporter parent/outcome/failure behavior.
- Local rendered checks cover desktop/narrow empty/demo, live fixture,
  disconnect/reconnect, filters, selection and keyboard operation. Fixtures are
  browser-local only, never supplied as production telemetry.
- Browser interaction spans and cross-boundary browser-to-edge carriers are not
  implemented. Static asset/rejection paths rely on Cloudflare platform telemetry,
  not custom Axiom spans. Shared-query callers do not all acquire causal links.
  Visitor disconnect signal is forwarded but actual network-disconnect export
  proof is not established. Optional edge ingest binding remains disabled; no live
  edge Axiom ingestion claim. See [observability](observability.md) for other gaps.
- lintapple finds no desktop issues; its mobile SVG viewport rule flags the
  intentionally clipped internal horizontal timeline. Page-level overflow and
  internal scrolling are checked separately; this is not a zero-findings claim.
