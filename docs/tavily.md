# Tavily and the existing tool inventory

## Actual versus available

Audited 2026-11-08 against Computah `origin/main` at
`2d995cdac6688f282254176e458998bb4d8a527f` and `lordbagel42/agent` (June) at
`4ca93fb3973f2106013f90cc50bedd4943ff00a9`. Source availability is not activation
or a live provider check. The owner's statement that tools/browser/sandbox already
exist is supported by substantial reusable June source, not a reason to build a
second harness.

The integration was validated against `49fda8502ad3a8c6d0c29f79e63e7d66677f2751`
(role/priority core `5bcf9c8`). Its narrow registration hook preserves current
Interaction/Worker model selection, priority wrapper, personality, streaming and
durable cancellation. It changes only Worker web-tool registration, the explicit
capability allowlist, protected startup key wiring and the previously inaccurate
Worker sentence denying all external tools. No root manifests, shared contracts,
model policy, deployment code or runtime restart are part of this packet.

| Checklist capability                                  | Computah canonical baseline                                                                                        | Existing reusable June source                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed tools, delegation                               | Pi `defineTool`, Interaction `Task`, scoped persistent Workers                                                     | Typed capability catalog under `src/capabilities`, `src/runtime/execution.ts`                                                                                                                                                                                 |
| Dynamic availability, tool search/loading, MCP client | Worker registry empty; no MCP client installed                                                                     | `src/tools/mcp.ts` discovers/validates schemas; `connections.ts` filters current connected tools/permissions and pages `mcpCatalog` contracts; `puck.ts` supplies separately consented Amp reads                                                              |
| Account selection/grants, approvals                   | Trusted server Binding + current per-principal capability callback, not model claims                               | `src/tools/{connections,broker}.ts`, OAuth adapters and `src/credentials`; exact action/account/recipient grants, revocation and one-use receipts                                                                                                             |
| MCP server                                            | No MCP ingress in inspected core                                                                                   | `src/agent/mcp.ts` implements authenticated Streamable HTTP tools/list and tools/call, mounted from `src/main.ts`                                                                                                                                             |
| Skills                                                | No native Worker skill loader in inspected core                                                                    | `src/reflection` has evidence-bound skill proposals/evaluation; these explicitly do not install skills. A general Pi skill loader is not established by those modules                                                                                         |
| Parallel/branching workflows                          | Task can address different persistent Worker labels; no exposed fork/join workflow primitive                       | `src/workflows/contracts.ts` exposes `workflow.parallel`; `actors.ts` executes native Rivet `join` (up to eight branches), with ordinary JS conditions/loops                                                                                                  |
| Background work, durable execution/observation        | Rivet/Pi Task lifetime independent of gateway; native history, admission dedup, compaction and wake/reopen checked | `src/tasks`, `src/runtime/execution.ts`, `src/workflows` retain jobs/receipts and scoped presentation                                                                                                                                                         |
| Signals, steering, missing-information suspension     | Follow-ups and native submission/control exist; not a complete shared streaming/steering adapter at this baseline  | Workflow wait/signal/sleep/cancel in `src/workflows`; companion input/reconciliation in `src/browser/companion.ts`                                                                                                                                            |
| Schedules, notifications, goals/task tracking         | Not installed in the inspected minimal core                                                                        | `src/wakeups` implements durable cron/event jobs; `src/tasks` inspects scoped workflow tasks; workflow notify tool and channel adapters exist. This is not proof of a full goals/workboard feature; individual activation still requires configuration/grants |
| Sandboxed files/code                                  | No Worker execution environment installed                                                                          | `src/environments/{boxlite,boxlite-host}.ts`, `src/tools/e2b.ts`, restricted workflow VM; these have explicit provider/isolation gates                                                                                                                        |
| Browser                                               | No browser extension installed in Worker registry                                                                  | `src/tools/browser.ts` (exact digest-bound recipes), `src/browser/{session,companion,codex}.ts` (scoped Chromium/Codex companion)                                                                                                                             |
| Web search                                            | No Worker search installed in baseline                                                                             | `src/tools/web-search.ts` already implements bounded Tavily and TinyFish search                                                                                                                                                                               |

The installed Mac study is separately identified by its installation worker as
`~/Applications/Computah.app`, source
`~/Projects/rune-local-pi/experiments/rune-pi`. It is an owner-local Rune/Pi
coding-agent study, not proof of sandbox isolation or browser integration in the
durable backend. Its scoped self-edit/build/relaunch tools do not grant unrelated
host access. The checked-in `experiments/rune-pi` baseline deliberately passes
`--no-tools --no-extensions` to the local subprocess. See the
[Mac handoff](https://ampcode.com/artifacts/computah-native-local-pi-study-mac-handoff-1669f830-0497-4442-a1dd-1be86e555cc1)
for the separately advanced installed study; no laptop filesystem/auth was read by
this audit.

**Precise remaining workflow work:** adapt source-supported parallel join,
branch/result/cancellation semantics into the canonical Pi Task ownership model
with current scope grants and recovery tests. Do not add Mastra, another workflow
engine or pretend the implementation is greenfield. Browser/BoxLite similarly
need mounting and actual target-runtime verification, not a duplicate provider.
Executor/Composio product intent does not prove either is currently registered:
June's Puck/MCP connection mechanism is reusable, but is not a claimed live
Computah Executor/Gmail connection.

## Tavily module contract

`apps/server/src/tavily.ts` is an additive native Pi extension backed by an Effect
service. It adapts June's existing bounded public-evidence transport instead of
importing June's separate runtime. No SDK dependency, global dispatcher, extra
transcript database, generic fetch tool or parallel harness is introduced.

- `createTavily({apiKey, authorize, timeoutMs?})` closes over the host-only key.
  `capabilities(scope)` returns only configured/current grants; it does not probe
  credentials or grant anything. `run(scope, {query}|{urls})` returns an Effect.
- `createTavilyExtension({client, scope})` registers `web_search({query})` and
  `web_extract({urls})`. `scope(api, context)` must read the private persisted
  Binding, never model arguments. Interaction remains Task-first. Worker registry
  selection must be filtered by `web.search` and `web.extract`, and every dispatch
  checks the host's current grant again. Results recheck authority before release.
- Search accepts a nonblank explicit public query, maximum 500 UTF-16 units,
  excluding control/format characters. Only this query goes upstream: no history,
  identity, memory, model request, source IDs or prompt metadata. Basic/general,
  five results, two chunks, automatic upgrades/answer/raw content/images off.
- Extract accepts one to five unique canonical public HTTP(S) URLs, at most 2048
  characters each. No userinfo, explicit nondefault port, IP literal, single-label
  or local-domain host. Never submit signed/private URLs. This is hygiene, not
  DNS/redirect/network isolation or proof a URL is public. This process contacts
  only the fixed Tavily API; Tavily performs page retrieval remotely.
- Both return `{status:"ready", provider:"tavily", untrusted:true, sources,
  failedUrls}`. Sources preserve complete source URLs, title/content and explicit
  truncation. At most five sources, title 200 characters, search content 1500 or
  extract content 6000 characters each. Extract output is matched to requested
  URLs; absent sources are failed even on HTTP200. No generated provider answer,
  provider request ID, echoed query, image payload or raw provider failure body.
  Workers must cite source URLs and disclose partial/truncated evidence.
- Decoded HTTP body is bounded at 128KiB before JSON parsing. Deadline defaults
  to 15 seconds (host option 1–30000ms), including body consumption. Extract asks
  Tavily for a ten-second timeout. Pi invocation cancellation aborts fetch and
  joins admitted transport/body cleanup before Effect interruption settles.
  Redirects are rejected and cookies omitted.
- Errors are fixed typed categories, not provider text: denied/not-configured,
  invalid-input, auth (401/403), rate (429, bounded numeric Retry-After), quota
  (432/433), capacity (434), timeout/cancel, transport, HTTP, malformed/oversized
  response. `requestState` is `not_sent` or conservatively `possibly_sent`.
- No automatic retries. Both Pi tools use `replay:"unsafe"`: a provider may
  already have charged credits even when interrupted or no result was persisted.
  Pi's native interrupted-tool outcome is not a claim of zero usage. A new
  model-requested query is a new credit-bearing call, not exactly-once recovery.
  Rate/quota errors never enroll, fund or buy capacity.

Public queries/results are ordinary private, scope-owned Pi tool history and may
be sent to the selected cognition provider, including compaction. No query/result
logging is added, and public ingress must continue omitting raw tool records.
The shared sanitized Axiom exporter records `computah.web.search` and
`computah.web.extract` lifetimes through awaited cleanup, fixed outcome categories
and conservative request state; unavailable results mark the span failed even
though the Effect returns a typed value. It does not record queries, URLs, tool
results or credentials, or inject trace headers into external Tavily requests.
Tavily necessarily receives explicit queries/URLs; its retention
policy is external to Computah. This tool cannot infer that arbitrary model text
contains private information; instructions and host grants do not constitute a
general DLP guarantee. Never pass secrets/private context to search.

## Protected configuration and verification status

Required activation is **both**:

1. Private host `COMPUTAH_TAVILY_API_KEY` supplied through the existing protected
   Computah provider env mechanism (`/etc/computah/provider.env` on nest-bagel),
   never a chat message, model argument, Git fixture or public endpoint.
2. Explicit `web.search` and/or `web.extract` in that requesting principal's
   existing `COMPUTAH_AUTH_JSON` capability array. A shared service key grants
   no principal permission by itself. Startup-loaded bootstrap changes require
   coordinated service activation; do not change unrelated grants/credentials.

On 2026-11-08 the initial presence-only check found the key absent from protected
host config and running backend at exact `2d995cdac6688f282254176e458998bb4d8a527f`.
The owner subsequently provided it through masked project-secret input. After
the documented orb environment refresh, it was transferred through the supported
private file-transfer API using a temporary0600 file under an ignored0700 parent;
staging was deleted. The deployment owner verified0600 and atomically provisioned
`/etc/computah/provider.env` under the deployment lock, then deleted the transfer.
No value entered chat, logs, argv, Git or a public URL; no unrelated credential
source was inspected. **The credential-input gate is resolved; do not ask again.**

Local verification passed root format/check/typecheck/test, including deterministic
Pi Harness tool execution, grant denial/revocation, partial extraction, output and
HTTP bounds, provider error categories, stalled-body timeout and cancellation
cleanup joining. An isolated copy with the narrow registration patch also passed
actual Rivet/Pi Task → Worker → search → extract and an ungranted second principal
receiving no web tools. These use deterministic model and synthetic HTTP data.
Separately, the new Effect service made real Tavily calls with only an explicit
public API-documentation query and public docs URL: search returned five cited
sources; extraction returned one source with no failures.

The deployment owner subsequently verified key presence in the container at
`4b89424c8530bb59b42007f9166740bc26503f40`; this proves protected configuration
consumption only. No principal receives `web.search` or `web.extract` implicitly
from key presence or publication. The packet adds no production grant. Existing
principals without those explicit grants continue to see no web tools.

Source publication does **not** establish deployed Slack/native end-to-end
activation. Deployment verifies exact revision, current grants and tool execution
separately. The same scoped brain serves Slack/native; there is no transport-specific
key or implementation. Credential input is already resolved.

Official API contracts inspected 2026-11-08:
[Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and
[Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract).

## Reused source attribution

Transport policies adapted from `lordbagel42/agent` `src/tools/web-search.ts`,
revision `4ca93fb3973f2106013f90cc50bedd4943ff00a9`:

MIT License — Copyright (c) 2026 Raygen Rupe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
