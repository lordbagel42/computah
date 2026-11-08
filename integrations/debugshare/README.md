# Computah issues — Executor app

Internal authenticated issue tracker, not a public sharing site. Executor owns
browser/MCP authentication, app access and SQLite. App access is the operator
boundary: grant this app only to operators allowed to see every captured scope
in it; it is not a general multi-tenant customer portal. Do not publish its source
as a public Executor app listing. Source in this repository contains no reports.

Actual bounded Slack messages and participant/location/core-scope details are
shown, with observed submission handles, activity, explicit missing evidence and
revision-checked investigation state. No hidden model reasoning is available.
Native actor/task/trace identifiers are not guessed from a timestamp or UUID.
Optional `transport` records the command's actual durable receive request/trace/span
IDs; it is not a core submission. Optional `capture` records the actual capture
span's trace/span IDs. Older reports without these fields remain valid. Capture
spans carry the internal queryable `computah.debugshare.id`; the public observatory
projection excludes that attribute and remaps trace/span identities.

The issue page's **Correlation** panel opens recorded capture and Slack transport
trace IDs in the private `bagel-w3ue` Axiom organization: spans in
`computah-prod-traces`, logs in `computah-prod-logs`, each span by `span_id`, and
"Open in Axiom" for capture spans tagged with the issue ID. All links come from
`ui/axiom.ts` (exact validated IDs only; synthetic reports get none). These are
the diagnostic command's traces, not guessed correlations to an earlier reported
conversation. The links select the exact validated nonzero trace ID and a bounded
window one day before/after report time. Widen Axiom's time range for delayed
capture; retention may remove old spans. Click a trace ID in the results to open
the native waterfall. Missing correlations remain explicit for legacy reports.
The **Traces** panel queries live spans server-side and renders their actual timing,
parent hierarchy, errors and expandable fields. It is not an iframe: Axiom blocks
cross-origin embedding. The small standalone renderer follows the shared-axis
pattern used by [assistant-ui](https://www.assistant-ui.com/elements/trace-waterfall);
Jaeger's [standalone React extraction](https://github.com/jaegertracing/grafana-plugin/blob/main/docs/adr/0001-jaeger-ui-in-grafana.md)
is a proposal rather than a package we can drop in. No third-party viewer code or
new UI dependency is bundled.

Connect exactly one `traces` app account through Executor's private account form,
using a read-only Axiom API token restricted to `computah-prod-traces`. The token
is an opaque credential handle, restricted to the HTTPS Axiom API authorization
header; it never reaches browser code, reports or query results. An empty account
collection leaves the rest of the tracker available and shows setup guidance.
This grants the tracker's authorized operators access to the selected traces,
including retained span fields; app access remains the operator boundary.

`getIssueTrace({id,correlation})` accepts only `capture` or `transport` for a stored
issue. It does not accept raw trace IDs, datasets or APL from the browser. Reads
are one-shot, manually reloadable, cancelled with the Executor invocation, and
bounded to 15 seconds, 2 MB and 500 spans. Partial responses and missing parents
are visible; duplicate span IDs are coalesced. Missing/expired spans and query
failures do not remove the conversation snapshot. The full Axiom links remain.
No public observatory projection or private-content telemetry policy is changed.

## Hosting and setup

Deploy these files through Executor appManagement.create/deploy, using exactly
apps@0.0.1-beta.122. This integration is deliberately outside the pnpm workspace:
it is built by Executor, not the Computah Docker image. Do not send node_modules,
README or local verification files as UI assets. Keep the immutable migrations.
Include `ids.ts`: this tracked symlink points to the canonical pure contract in
`packages/contracts/src/debugshare.ts`. Materialize its UTF-8 contents in the
Executor source snapshot (not the symlink target path). Slack and telemetry import
the same contract; the standalone app needs no workspace dependency or Node crypto.

The `sources` app-account collection is optional for UI/MCP operation. Connect a
source reference (a non-secret deployment label) to enable its `capture` manual
webhook. The generated webhook secret is shown only in Executor's private setup
page; transfer it directly into the protected runtime env, never chat or Git.
Pin subscription config to the exact trusted team/tenantId/userId/agentId.
The hosted `webhooks.configureSource` config is keyed by handler:
`{capture:{team,tenantId,userId,agentId}}`, not the scope object alone.
One subscription signs uploads for that scope; it grants no read/status authority.
Separate scopes need separately pinned subscriptions and runtime routing.

Runtime variables and signing are documented in [Slack capture](../../docs/slack.md#durable-debugshare-capture).
New IDs are `computah_bug_` plus exactly 24 cryptographically random lowercase
alphanumeric characters. The shared validator also accepts existing lowercase
UUIDv4 reports unchanged, without a migration or backfill. Event IDs are separate.
Report URLs are the actual authenticated app URL with `#<id>`. A source-local
pending report is not a hosted report and does not get a fabricated link.

## Tools and lifecycle

- `listIssues({})`: latest 100 summaries, newest update first.
- `getIssue({id})`: exact immutable snapshot plus up to 200 earliest history
  entries. Older identifier-only UUIDs truthfully return not found.
- `explore({})`: explorer index. Up to 500 newest-updated issues with metadata
  extracted by SQL from the stored snapshot (source, scope, trace/span IDs,
  participants, submission handles, counts, latest event), the 500 newest
  history events and table totals.
- `search({text,author,channel,submission,trace,actor})`: case-insensitive text
  over IDs, titles, assignees, full snapshot JSON and notes, plus exact entity
  filters. Messages are deduplicated across overlapping snapshots (max 200).
- `inspectIssue({id})`: `getIssue` plus stored byte size, SHA-256 of the stored
  snapshot and related issues with explicit reasons (same conversation, shared
  messages or submission handles, same trace, exact ID mentions).
- `receiveIssue(report)`: authorized operator import. Exact duplicate is
  idempotent; conflicting snapshot for an existing issue ID is rejected.
- `updateIssue({id,expectedRevision,status,assignee,actor,note})`: authenticated
  agent/operator update. States: open, investigating, blocked, resolved; reopening
  is explicit by setting open. Every change appends a timestamped evidence note.
  Stale revisions fail without overwriting another writer. Actor/assignee names
  are declared attribution, not proof of authenticated identity; Executor audits
  caller access separately. A resolved state is not proof of a deployed repair.

Credentials must be redacted at capture. The app is not a universal secret
scanner; authorized imports and evidence notes must not contain credentials.
HMAC delivery checks raw bytes and timestamp, validates bounded schema and source
scope, then commits before returning `{id}`. Retries cannot overwrite snapshots.

## Explorer UI

A dark Axiom-style React SPA using shadcn/ui-pattern components (Radix Slot and
Tooltip, lucide, Geist), built by Executor with its built-in Tailwind v4.
Executor's browser build fails on `cmdk`, `@radix-ui/react-dialog` and
`@fontsource` imports, so the palette and mobile drawer use the native
`<dialog>` element and the Geist fonts (OFL) are served from `ui/public/fonts`.
Routes are hash
fragments so existing `#<issue id>` links keep working; `#<id>/<section>` and
`#<id>/m/<slack ts>` deep-link to a section or a captured message. Other routes:
`#/issues`, `#/activity`, `#/search/<text>`, `#/tables/<table>` and entity pages
`#/people|channels|traces|submissions|actors[/<value>]`. `/` or ⌘K opens a
jump/search palette; `j`/`k` move through issues.

Every identifier in stored text becomes a destination: issue IDs, Slack user and
conversation IDs, trace and span IDs, Computah commit SHAs, Amp thread IDs and
URLs. Axiom links are query URLs over `computah-prod-traces`/`-logs` (sign-in
required); Slack links use `slack://` and `app_redirect` with team and channel.
Slack message permalinks need `chat.getPermalink`, so messages link within the
tracker instead. Synthetic reports (`SYNTHETIC` workspace) get no external links.
The browser never sends SQL; all reads are the bounded queries above.

## Verification

Install the exact package dependencies in this directory without changing the
root workspace lockfile (`npm install --no-package-lock`). Typecheck `index.ts`,
`ui/main.tsx` and `ui/assets.d.ts` with TypeScript strict, NodeNext, ES2022,
react-jsx and the DOM lib. Deploy only source files: never `node_modules`. Root
formatter/linter cover this source; root tests cover Slack durable capture.
Run `pnpm exec tsx --test scripts/test-debugshare-traces.test.ts` from the repository
root for exact query/time-window construction and invalid-ID rejection.
Verify deployed tools and the actual authenticated page separately. A successful
deploy or tool call is not browser-render evidence or live Slack capture proof.

## Current deployment evidence

The private app is deployed at <https://computah-issues.raygen.executor.website>.
Authenticated synthetic import, exact UUID lookup, immutable retry/conflict,
revision-CAS state changes and retention across app redeployment were exercised.
Anonymous HTTP access returned 403 without reports. The UI was rendered against
the actual browser SDK with synthetic responses; this is not signed-in hosted
browser acceptance. Genuine new-format Slack-to-hosted capture was verified for
`computah_bug_sezwk4oezhoi4y3lqmgtto2v` at 2026-11-08T10:21:56.893Z on source
`855a7c0`: exact stored capture trace/span matched Axiom, with successful upload,
delivery and finalization. No historical IDs were rewritten. Source-local SQLite
capture remains independent of that upload setup. Explorer rendering and hosted
adoption are verified separately from this capture receipt.
