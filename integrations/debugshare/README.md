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

## Hosting and setup

Deploy these files through Executor appManagement.create/deploy, using exactly
apps@0.0.1-beta.122. This integration is deliberately outside the pnpm workspace:
it is built by Executor, not the Computah Docker image. Do not send node_modules,
README or local verification files as UI assets. Keep the immutable migrations.

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
Report URLs are the actual authenticated app URL with `#<UUID>`. A source-local
pending report is not a hosted report and does not get a fabricated link.

## Tools and lifecycle

- `listIssues({})`: latest 100 summaries, newest update first.
- `getIssue({id})`: exact immutable snapshot plus up to 200 earliest history
  entries. Older identifier-only UUIDs truthfully return not found.
- `receiveIssue(report)`: authorized operator import. Exact duplicate is
  idempotent; conflicting snapshot for an existing UUID is rejected.
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

## Verification

Install the exact package dependencies in this directory without changing the
root workspace lockfile. Typecheck `index.ts`, `schema.ts`, `ui/main.tsx` and
`ui/assets.d.ts` with TypeScript strict, NodeNext, ES2022 and react-jsx. Root
formatter/linter cover this source; root tests cover Slack durable capture.
Verify deployed tools and the actual authenticated page separately. A successful
deploy or tool call is not browser-render evidence or live Slack capture proof.

## Current deployment evidence

The private app is deployed at <https://computah-issues.raygen.executor.website>.
Authenticated synthetic import, exact UUID lookup, immutable retry/conflict,
revision-CAS state changes and retention across app redeployment were exercised.
Anonymous HTTP access returned 403 without reports. The UI was rendered against
the actual browser SDK with synthetic responses; this is not signed-in hosted
browser acceptance. Live Slack-to-hosted ingestion still needs the generated
webhook secret provisioned privately into the runtime and a genuine new command.
Source-local SQLite capture is independent of that upload setup.
