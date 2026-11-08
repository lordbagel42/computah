# Sentinel protective Specialist

Status: additive review module and local synthetic decision tests, reviewed against
main `49fda85` / core `5bcf9c8`. No production caller imports this module. Core hook,
native Sentinel cancellation acceptance and executable activation are pending
integration; this page does **not** claim enabled protection or a live model evaluation.

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

## First runnable interception contract

Core owns the hook and native cancellation lifecycle. The additive module must
not be mistaken for an installed dispatch guard. Current core already has durable
`Delegations`, `Receipt.cancelled`, `cancelCascade`, `computah.cancel` and Worker
`cancelRequest` with native abort/join. None invokes Sentinel or persists its audit.
The integration contract is:

1. Host authorizes current scope/capability independently of Sentinel. Missing
   authority is denied even when Sentinel says allow and even for the owner.
2. For a selected Task preflight, core records its durable Worker delegation link,
   then builds bounded safe review input before Worker admission. A trusted policy
   callback selects the review and principal; model content cannot set that policy.
3. Persist the safe verdict and request fence before scheduling the existing
   `computah.cancel` path on pause/cancel. Do not admit the Worker after a fence,
   including on replay. Do not call and await the external gateway's cancellation
   from the same running Task: it can wait on itself.
4. An independent monitor can call `inspect(session, [resourceId, submissionId],
   input)`. A non-allow verdict calls the existing scoped `CoreSession.cancel`;
   its returned native cancellation result is forwarded without inventing success.
   Only an authorized host may construct this monitor. The core still checks
   exact ownership and `task.control`. Verify actual terminal Interaction/Worker
   state separately; a request receipt is insufficient.

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

The current Worker has no external-effect tools, shell, file access or account
credentials. No external-effect dispatcher is protected by this module yet. A
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

## Evidence required before activation

Decision tests check bounded scope/schema, untrusted-content separation, rejected
authority fields, safe audits and fail-closed/fail-soft deadlines. These are
synthetic model outputs, not proof a real model reliably recognizes injection.
Acceptance additionally requires actual Rivet/Pi tests showing denied-before-admit,
Sentinel-triggered active Interaction **and** Worker terminal cancellation,
replay/idempotent fences, retained history, and denied cross-user controls even
with a model allow. Live legacy Codex review quality, provider refresh, output
publication buffering and external effects remain separately unverified.

There is intentionally no source-only switch claiming to enable this behavior.
The integration owner must add the explicit owner scope/policy binding, safe
projection selection, review-before-admission transaction and audit/fence storage,
then prove those native outcomes. Publication of these three additive source files
does not satisfy that activation contract and requires no host rollout or restart.
