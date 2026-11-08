# Sentinel protective Specialist

Status: native Task admission and asynchronous monitoring implemented and locally
tested on real Rivet/Pi with synthetic verdicts. Production activation requires
explicit private host policy; source publication is not deployment or evidence
of real-model detection quality. Unconfigured scopes retain existing behavior.

Sentinel follows the planned [Specialist architecture](architecture.md): a bounded
helper around Interaction → Task → persistent Worker, not another primary agent,
transcript, scheduler or authority service. Reflection improves behavior/code;
Dreaming enriches evidence-linked memory; Sentinel protects intended execution.
Its persona is intelligent, cautious, warmly loyal to the owner and willing to
interrupt mistakes. Loyalty does not mean flattery, manipulation, dependency,
blanket owner bypass or access to another user's private material.

## Trusted review contract

`createSentinel({models, model})` must reuse the existing official legacy Codex
Models boundary and configured capable role model. On current main this means the
**same `priorityModels` wrapper** as core, not the raw ModelRuntime: all review calls
must retain priority/high and safe tier diagnostics from [model policy](model-policy.md).
There is no new model/provider choice or configuration variable in this packet.
It does not discover credentials, create a different provider client or assume
model price or entitlement. `review(input)` makes one stateless, tool-free call.
No source history is loaded automatically. Input is host-created **after** scope/history authority
checks and safe projection; raw transcripts, chain of thought, credentials and
arbitrary unfiltered tool results must not be supplied. There is no universal
secret scrubber: supported projections are a prerequisite, not a prompt promise.

The envelope contains a host-generated `reviewId`, stage (`input`, `tool-intent`,
`output`), policy (`risky-effect`, `benign-monitor`), trusted principal distinction
(`owner`, `other-user`) and up to 12 evidence items (`id`, source, safe text).
Source is `request`, `slack`, `web`, `tool` or `assistant`; all content is untrusted
data, including an owner's quoted text. Only an explicit configured owner scope
binding may set `owner`; display name, maintenance capability and prose cannot.
The module explicitly selects these fields (including each evidence item's three
fields), so structurally compatible host records cannot leak extra private fields
to the model. This is not text redaction. The entire JSON envelope is limited to
16,000 characters, not silently truncated.

`SentinelDecision` is an Effect Schema with:

- `action`: `allow`, `pause`, `cancel`.
- `reason`: `consistent-with-intent`, `prompt-injection`, `privacy-risk`,
  `unintended-effect`, `authority-mismatch`, `uncertain`, `review-unavailable`.
- `evidence`: existing evidence IDs only; non-allow model verdicts need evidence.
- `scope`: exact `reviewId` and stage. A model cannot select another request,
  tenant, Worker or cancellation target.

Unknown fields, free-text reasons, invented references, a changed scope, truncated
responses and nonterminal/error model responses are rejected. `review-unavailable`
is host-generated only. The default deadline is 15 seconds, with cancellation
passed to the provider and an independent timeout so an unresponsive provider does
not hold dispatch open. There is no automatic retry/spending loop. A review
timeout does not establish that the provider stopped computing or billing.

`sentinelAudit` emits a hashed review key, stage, action, fixed reason category and
evidence count only. No payload, quotations, raw provider errors, model-authored
rationale or chain of thought enter this audit. The audit is not another canonical
history; the host must persist it alongside the existing Pi cancellation fence.

## Native interception and policy

The optional private `COMPUTAH_SENTINEL_JSON` contains exactly `ownerScope` and
`reviews`. `ownerScope` is an explicit `{tenantId,userId,agentId}` binding, not a
capability inference. Each review has exactly `scope` (the same three fields) and
`mode` (`monitor` or `preflight`). All scopes must already exist in host auth;
duplicates, extra policy fields, unknown scopes and faux-mode activation fail
startup. This configuration grants no capabilities. Disposable deployment
preflight passes an explicit synthetic env allowlist without this key or real
credentials, so it cannot invoke Sentinel's real model.

`main` supplies Sentinel and core the same runtime Models boundary and configured
Worker model, retaining priority/high. Core selects policy from the authenticated
Binding, not Slack/web/tool content. Its only automatic evidence is the current
Task's assistant-authored text argument (maximum 12,000 characters), already
authorized for the same scoped Worker/provider. No reasoning, raw history,
retrieval result, host metadata or credentials are loaded by the reviewer.
Over-limit evidence is unavailable, never silently truncated. This is a text
projection, not universal secret redaction or a full original-intent reconstruction.

Core owns the native lifecycle:

1. Host authorizes current scope/capability independently of Sentinel. Missing
   authority is denied even when Sentinel says allow and even for the owner.
2. For a selected Task, core records its durable Worker delegation link and bounded
   review. `preflight` waits for review before Worker admission; `monitor` schedules
   one replay-deduplicated native background `computah.sentinel` task and proceeds
   without waiting for the extra model roundtrip.
3. Persist the safe verdict and request fence before scheduling the existing
   `computah.cancel` path on pause/cancel. Do not admit the Worker after a fence,
   including on replay. Do not call and await the external gateway's cancellation
   from the same running Task: it can wait on itself.
4. The native monitor commits its categorical verdict and fence atomically. Original
   submission IDs, not transient generation IDs, identify the active request across
   Pi tool-round handovers; a late verdict is marked `settled` and cannot cancel an
   unrelated successor. Existing `computah.cancel` aborts/joins the
   Interaction and every linked Worker via `cancelRequest`, including its durable
   pre-admission tombstone. RPC failure retries rather than claiming completion.
5. `CoreSession.sentinelAudits(interactionId,submissionId)` is a private host API,
   requiring current history authority and exact submission ownership. It returns
   categorical receipts (plus mode/enforcement), never review payloads. It is not
   exposed as a public bus DTO. History and original admission IDs remain canonical.

The standalone `inspect` helper remains for independently authorized external
monitors; its gateway control calls still require `task.control`. Native policy
review is host-provisioned protective authority, not a user control capability.

`pause` stops/fences this attempt like cancel, but communicates clarification is
needed. There is no automatic resume or new approval authority. A clarified or
newly authorized request needs a new admission ID. Reusing the original ID must
preserve its deduplication/cancellation tombstone and original durable history.

## Policy, latency and threat model

| Boundary                           | Selection                                         | Review failure                              | Enforcement                                                                  |
| ---------------------------------- | ------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Ordinary chat / harmless Task      | No mandatory synchronous review                   | Normal host policy remains                  | No extra model roundtrip by default                                          |
| Host-selected input/output monitor | Explicit safe bounded projection                  | Fail soft (`allow`, `review-unavailable`)   | May cancel active work; not retroactive disclosure prevention                |
| Risky effect intent                | Mandatory at the actual enabled effect dispatcher | Fail closed (`pause`, `review-unavailable`) | Recheck authority and durable request fence immediately before effect        |
| Task preflight                     | Optional host-selected review                     | As selected policy                          | Prevents Worker admission, not a substitute for later effect-dispatch guards |

No external-effect dispatcher is protected by this integration yet. A
future tool must opt into **enforced risky review at dispatch**, not merely run a
pre-Task check and claim downstream protection. Ordinary chat is not silently
model-gated. Output monitoring after emission cannot undo a disclosure; protected
output needs a review-before-publication boundary with a safe projection, not an
unbounded history scan or already-streamed text review.

Sentinel can miss attacks or false-positive legitimate work. Deterministic
capability, tenant, credential and resource checks remain authoritative. Slack,
web and tool content cannot manufacture owner status, permission or a different
cancel target, even if a model follows injected instructions. Cancellation cannot
undo an already-started external mutation; interrupted ambiguous effects remain
unknown and require reconciliation rather than blind retry.

## Verification and remaining limits

Decision tests check bounded scope/schema, untrusted-content separation, rejected
authority fields, safe audits and fail-closed/fail-soft deadlines. These are
synthetic model outputs, not proof a real model reliably recognizes injection.
Actual Rivet/Pi tests exercise denied-before-admit with unchanged Worker history,
active Interaction **and** Worker terminal cancellation, replay/idempotent receipt,
sleep/reopen persistence, retained originals, post-tool generation handover,
late verdict successor safety,
fail-closed preflight/fail-soft monitoring, cross-user audit denial and revoked
host grants despite an allow verdict. These synthetic verdicts establish native
enforcement, not real-model judgment quality. Model review may repeat after a
crash before its verdict transaction commits; durable committed verdicts and
monitor scheduling deduplicate, not provider billing.

Metadata-only `sentinel.review`, `sentinel.enforce` and `sentinel.cancel` spans
use the existing privacy relay/Axiom pipeline, with trusted stored trace carriers.
Only action/mode/fixed reason/enforcement categories are exported; review keys,
evidence IDs/text and raw provider errors are not trace attributes. Live ingestion
and enabled-host proof must be recorded separately after supported deployment.
Live review quality, provider refresh, output publication buffering and external
effect-dispatch protection remain unverified or unimplemented.
