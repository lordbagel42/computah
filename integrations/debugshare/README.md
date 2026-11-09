# Computah Debug

Internal authenticated issue explorer targeting `https://debug.raygen.dev`.
The SvelteKit/Cloudflare implementation replaces Executor hosting, **not** the
private operator boundary. DNS publication does not publish reports. The previous
Executor tracker remains intact at `https://computah-issues.raygen.executor.website`.
Source implementation and synthetic checks are not migration/deployment acceptance.

## Authority

Better Auth uses email/password (minimum **8**, no complexity rules), its default
password hashing, eight-hour database sessions, secure HttpOnly host-only Strict
cookies, database-backed login rate limits and origin/CSRF checks. Public signup
is disabled. A session alone grants nothing: an enabled `operator_grants` row is
required on every issue read or mutation. Provision only operators entitled to
**all** captured scopes; this is not a self-service multi-tenant portal. Report
requester, workspace, private/channel audience and actor scope remain evidence,
not browser-supplied authority. Declared event actor/assignee is attribution,
not an authenticated identity claim.

Initial owner creation uses `/api/bootstrap`: same-origin JSON POST with a
separate private `BOOTSTRAP_TOKEN` bearer and `{email,name,password}`. The singleton
claim pins the first email; completion disables reuse. An interrupted creation
can resume only with that same email and correct password. No default account or
password exists. Enter credentials only through the private setup flow, never
chat/Git. Revoke the bootstrap secret once the owner is verified. An existing
protected account database must not be reset to repeat bootstrap.

Credentials are separate and deny-by-default:

| Credential                         | Authority                                           |
| ---------------------------------- | --------------------------------------------------- |
| Operator session + enabled grant   | Explorer and bounded operator APIs                  |
| OAuth access token + enabled grant | MCP only, within consented scopes                   |
| `AGENT_MCP_TOKEN`                  | Explicit all-scopes operator automation on MCP only |
| `CAPTURE_SIGNING_SECRET`           | Signed capture only; no read permission             |
| `NOTICE_TOKEN`                     | Notice scalar read/ACK only; no report bodies       |
| `MIGRATION_TOKEN`                  | Bounded backup/import only; revoke after cutover    |
| Callback capability URL            | Fixed outbound coordinator destination only         |
| `AXIOM_TRACE_READ_TOKEN`           | Private read-only trace query, never exported       |
| `AXIOM_TELEMETRY_TOKEN`            | Sanitized trace/log ingest, never query authority   |

## Capture and notification

`POST /api/capture` receives the original UTF-8 JSON bytes, at most 450,000 bytes.
`CAPTURE_ENABLED` remains false (503) until source import reconciliation succeeds;
the host retains pending captures and their original IDs during this gate.
`x-computah-timestamp` is a 13-digit epoch-millisecond timestamp (±5 minutes);
`x-computah-signature` is lowercase hex HMAC-SHA256 of `${timestamp}.${body}`.
Protected `CAPTURE_POLICY` must include exact workspace/core scope and enrollment
policy. Scope derives independently from requester/channel; denied users, wrong
workspaces and forged private/channel scopes fail. HMAC authenticates the trusted
adapter's assertions, not arbitrary Internet users' Slack membership.

Issue and notice persist in one SQLite Durable Object transaction. Original IDs,
immutable snapshots and successful `{id}` replies remain compatible with the
Slack adapter's durable local pending captures. Exact retries do not append extra
events; conflicting snapshots never overwrite. Missing legacy captures cannot be
fabricated. Configure the protected runtime's ingest/report URLs and signing
secret together; keep pending report IDs unchanged.

Notice dispatch is **at least once**, not exactly once. The fixed HTTPS callback
gets exactly `{id,version:1}` and `Idempotency-Key: debugshare:<id>:v1`, after commit.
No report text travels in the callback. Redirects are disabled, response bodies
discarded, requests time out, and batches cap at ten. Pending/accepted/acknowledged
state and retry deadlines are durable. Alarms are armed before commit and I/O,
respect earlier outstanding wakes and recover on eviction. Accepted means queued,
not notification completion; unacknowledged accepted notices retry with the same
key and bounded exponential backoff. No timer/cron polling is needed.

The receiver authenticates these fixed narrow endpoints:

- `GET /api/issue-notices/:id`
- `POST /api/issue-notices/:id/ack`

Both return `{issue:<exact scalar ID>,version:1,acknowledged:""|ISOtimestamp}`.
ACK is idempotent and must return a nonempty timestamp. Reads join a real issue
and notice. The token can ACK any identifiable eligible notice deployment-wide;
it cannot create reports, mutate issue state or query MCP. The dedicated receiver
owns append intent/reconciliation and coordinator deduplication. Operator-only
`POST /api/reconcile` accepts at most 20 exact IDs; it cannot release migrated
historical notifications. Delivery stays disabled until the receiver's readiness
receipt, then requires an isolated synthetic delivery/duplicate/ACK proof.

## Remote MCP

Streamable HTTP endpoint: `https://debug.raygen.dev/mcp`, using the official MCP
SDK, stateless JSON responses, authenticated POST requests and standard OAuth
protected-resource/authorization-server discovery. Better Auth's OAuth provider
supports dynamic registration and PKCE consent. OAuth tokens must have the exact
MCP audience and an enabled operator subject. Scopes are `issues:read`,
`issues:write`, `traces:read`; filters and payload IDs never broaden authority.

| Tool              | Capability                                                    |
| ----------------- | ------------------------------------------------------------- |
| `explore_issues`  | Latest 500 projections/events, exact aggregate counts         |
| `list_issues`     | Bounded keyset pagination, text and exact metadata filters    |
| `search_evidence` | Stored messages/history with entity filters and dedup         |
| `get_issue`       | Exact snapshot, metadata and first 200 lifecycle events       |
| `inspect_issue`   | Snapshot hash/bytes, metadata, evidence-based related records |
| `issue_history`   | Complete history via bounded oldest-first keyset pages        |
| `update_issue`    | Revision-checked status/assignment/evidence change            |
| `add_issue_note`  | Revision-checked note preserving current state/assignment     |
| `get_issue_trace` | Authorized recorded capture/transport correlation only        |

Statuses: open, investigating, blocked, resolved; reopening is explicit. Every
mutation requires `expectedRevision` and an evidence note, and appends one event.
Resolved is not proof of deployment or runtime acceptance. Refresh after a CAS
conflict; never blindly retry a mutation. Cursors use timestamp+ID; concurrent
edits can move entries. Exact UUIDv4 and `computah_bug_` + 24 lowercase random
alphanumeric IDs are retained. The MCP also exposes a contract resource,
`computah-debug://issues/{id}` and an evidence-first investigation prompt. It
does not provide secret export, arbitrary SQL/APL, deletion or admin bypass.

Connect this remote URL using Executor's supported custom OAuth MCP connection,
then complete the private owner login/consent. Actual Executor discovery and
representative authorized read/write, stale revision and denied-scope calls are
separate acceptance gates, using disposable synthetic records only. A local SDK
call or successful import of an MCP definition does not establish that acceptance.

## Explorer and traces

SvelteKit preserves the dark explorer, Geist/Geist Mono local OFL fonts, command
palette, responsive navigation, issue/evidence/history tables, JSON explorer,
related records, search and inline trace waterfall. Existing `#<id>`,
`#<id>/<section>`, `#<id>/m/<timestamp>`, `#/issues`, `#/activity`,
`#/search/<text>`, `#/tables/<table>` and entity hashes remain supported.
IDs become escaped navigation links, not executable HTML. Synthetic workspace
records get no external links. No report or credential is embedded in static
assets. Browser reads use same-origin cookies and bounded server APIs, not SQL.

`get_issue_trace` accepts only capture/transport from a stored issue. The Worker
uses a dedicated read-only Axiom token restricted to `computah-prod-traces`.
Queries cap at 15 seconds, 2 MB and 500 spans; missing/expired correlations,
partial results and missing parents remain explicit. No arbitrary trace/dataset
or APL is accepted. Private Axiom links remain available. The read token never
reaches browser/report/telemetry payloads. Empty provisioning leaves trace reads
unavailable without removing the immutable report.

## Build, deploy and migration

This integration has its own dependency installation outside the core workspace.
Use its pinned dependencies and pnpm; the Computah Docker image does not host it.
The adapter uses a **separate build-only Wrangler configuration**, writing only
`.svelte-kit/cloudflare/_worker.js`. Deployment `worker.ts` owns auth, APIs, MCP
and the `IssueTracker` export. Never let the adapter overwrite that entry.

Run root `pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test`, plus integration
build/typecheck and `node --test worker.test.mjs`. Worker tests run actual workerd,
D1 and SQLite Durable Objects with synthetic secrets/data. Existing trace tests:
`pnpm exec tsx --test scripts/test-debugshare-traces.test.ts`. Inspect rendered
authenticated/denied UI and non-default deep-link states separately.

Independent resources: Worker `computah-debugshare`, fixed DO name
`operator-tracker-v1`, auth D1 `computah-debugshare-auth`, exact hostname route
`debug.raygen.dev/*`. No observatory HMAC/DO/domain/state is reused. Wrangler
disables workers.dev and preview URLs. Preserve the previous proxied DNS record
as an infrastructure rollback receipt; unknown APIs must never fall through to
that old origin. Apply D1 migrations, install private secrets from ignored
owner-only files and deploy with delivery disabled. Do not print secret values.

Migration uses only bounded tracker-owned supported APIs, not Slack bulk export:

1. Re-read the authoritative source deployment; export explore→all exact
   get/inspect→explore. Require stable IDs/revisions/counts, complete events and
   per-record UTF-8 bytes/SHA256. Preserve rawReport bytes. Serialization is valid
   only when its computed hash independently equals the stored hash per record.
2. Transfer into an ignored mode0600 backup through supported private tooling.
   A temporary protected KV sink is acceptable only with required API approval;
   never print report histories or bridge by scraping credential storage.
3. `POST /api/migration/import` with the dedicated bearer imports at most 100
   issues/200 events each/8 MB atomically, preserving all metadata, event IDs,
   timestamps and raw bytes. Exact retries are no-ops, conflicts roll back.
   Migration creates `held` notices: historic imports and later capture retries
   cannot wake the coordinator.
4. `GET /api/migration/export` returns raw bytes, hashes, histories, notices and a
   SQLite PITR bookmark. Export fails rather than silently truncating beyond the
   bounded migration contract. Compare exact ID sets, all metadata/events,
   snapshot hashes, totals, UUID/current lookups and anonymous denial.
5. Revoke migration authority after acceptance, retain the protected backup and
   source tracker, then hand off protected host activation and receiver readiness.
   Source-local pending capture replay must be exact/idempotent, not a new capture.

**Rollback is not just DNS.** Disable new writes/capture and notification delivery
before switching routing. Preserve/export all Worker writes since cutover and its
PITR bookmark; source and target otherwise diverge. Restore the old authenticated
route only after reconciling new revisions/events through supported APIs. Never
erase source records, reset the D1 owner state or force an old snapshot over new
writes. Retain the target database until rollback reconciliation is verified.

## Acceptance status

Local Worker tests are synthetic proof only. The historical source receipt was
9 issues / 33 events / 123 messages / 29,704 report bytes, with nine matching
reconstructed raw hashes. It is not current-freshness or target acceptance.
Record the actual deployment version, fresh migration manifest, authenticated UI,
Executor MCP OAuth/read/write/denial, synthetic callback/duplicate/ACK, pending
host capture and enabled Axiom ingestion receipts separately before calling the
migration complete. No source tracker deletion is authorized by target replacement.
