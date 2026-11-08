# Local delayed-email Procedure

Implemented in source: native Worker `procedure_draft` and the trusted bound
session's `procedureDraft(workerId, request)` actor action. This is executable
local draft storage in the existing Rivet/Pi actor database, not a second
workflow engine, mailbox index, timer service or unused policy library.

## Authority and limits

Every call requires current `task.send` and `history.read` on the actor's trusted
tenant/user/agent binding. Model arguments cannot select that binding. Drafts
belong to one persistent Worker; another Worker or scope cannot read them by
guessing an operation ID. Trusted session control rejects foreign actor IDs.
Interaction delegates through its existing Task tool; it does not receive a
provider send tool. The host-only session action is not a new public HTTP route.

Before access/mutation and again before release, core reuses the existing source
boundary to check the Worker's cumulative source account/version lineage.
Revoked derived mail remains fenced, including after reopen and when source
configuration is removed. This is deliberately conservative: all drafts in a
source-bearing Worker are fenced by its accumulated lineage. No Gmail module,
source index, OAuth grant, account or credential is changed.

**There is no external dispatcher.** Every result says `UNSENT LOCAL DRAFT` and
`externalSendEnabled: false`. Eligible means LOCAL eligible/unsent, not sent,
scheduled for provider delivery, or enforcement over every possible email path.
No provider draft, arbitrary Executor proxy, send credential, attachment upload,
new Composio scope or Gmail mutation is available. The existing read-only Gmail
gate remains intact. A future dispatcher needs its own current authority,
effective-policy check and ambiguous-effect reconciliation; this increment does
not establish a global enforced-send gate.

## Tool contract and durable transitions

`procedure_draft` accepts exactly these string fields:

- `action`: `create`, `read`, `edit`, `cancel`, or `claim`.
- `operationId`: stable draft identity, 1–160 ASCII letters/digits/`:_-`.
- `requestId`: stable mutation identity in this Worker's namespace, same bounds.
- `expectedVersion`: `0` for create; the exact current decimal version for mutations.
  Reads ignore this field.
- `recipients`, `subject`, `body`: complete replacement content for create/edit;
  use empty strings otherwise. Recipients/body must be nonempty for create/edit.
  Limits are 2000/1000/16000 characters respectively. Recipients are local text,
  not verified provider addresses. Attachments are not supported.

Procedure policy version1 explicitly interprets the approved “couple minutes” as
a **120000ms minimum**. Create atomically records version1, creator task identity,
creation/update times, policy version, full content, `notBefore = now + 120000`
and state `held`. A trusted host creation is labeled `trusted-host` rather than
inventing a Pi task identity. Clock authority is the backend wall clock, not a
model-supplied timestamp; host clock correctness is an operational prerequisite.

Edit, cancel and claim require both the expected version and `held` state in one
Pi commit. Every successful mutation increments the version. Editing replaces
the complete draft and resets the **full** 120-second hold, even when the old
version was already due. Cancellation remains guaranteed while held, including
due-but-unclaimed versions. Competing edit/cancel/claim operations cannot both
win against the same version. `claim` requires `now >= notBefore` and changes
state only to `local-eligible`. Cancelled and claimed drafts are terminal in this
increment; cancellation after claim conflicts, though no email has been sent.

Reads return exact persisted times, current content/version/state, `observedAt`
and `localEligible` (false when cancelled, otherwise `observedAt >= notBefore`).
State and observation time come from the same serialized transaction, before
the asynchronous release-authority recheck. This is an as-of projection, not a
promise that a concurrently edited version remains eligible at response arrival.
Time alone never writes state or sends mail. There is no timer to lose: read/claim
recomputes eligibility from durable state after sleep/restart.

Mutation payload hashes and transitions commit together. An identical successful
request retry does not mutate or reset the hold, and returns the **current** draft,
not a stale pre-edit/pre-cancel receipt. Changed payload under a committed request
ID conflicts; another create ID cannot replace an existing operation. Failed
transactions do not consume request IDs. Read requests are live projections and
do not reserve mutation IDs. Safe native replay rechecks current authority before
executing; native committed tool results remain ordinary durable Pi history.
Failures have fixed `ProcedureError.code` values: `invalid`, `conflict`,
`unavailable`, `held`, `denied`, `cancelled`, `runtime`. Trusted actor transport
preserves these codes instead of collapsing conflicts into an opaque RPC error;
native tools report the same fixed-category error. No provider/storage diagnostic
or draft content is included in a failure message.

Tool cancellation before the transaction prevents writes. Cancellation or loss
of acknowledgement after a commit does not roll it back: inspect the operation or
retry the same mutation identity. No retry can resend external mail because no
external effect exists. Current source/grant denial before result release prevents
disclosure, even if a local mutation already committed during a revocation race.

## Evidence and remaining acceptance

The focused suite exercises the actual installed Rivet/Pi runtime with deterministic
models, native Interaction→Task→Worker creation, trusted actor controls, asymmetric
hold boundaries, reset holds, duplicate/conflicting IDs, atomic races, foreign
scope, current revocation and sleep/reopen. It intercepts the existing sanitized
Axiom export path to check fixed `computah.procedures.draft` spans, structured
`operation.completed` outcomes, native phase parentage, explicit trusted-session→actor
trace carrier continuity and content canaries. A paused authority recheck plus
concurrent edit cannot fabricate eligibility at a later time. Native execution
cancellation during an authority await leaves no draft and emits `cancelled`;
this is separate from successfully changing a draft to `cancelled`.
The sanitizer changes are only fixed operation allowlist entries.

Local deterministic runtime proof is not provider, deployment or live Axiom
ingestion proof. Actual consumed revision, real native local-draft use and live
Axiom records must be reported separately. Existing Gmail receipt→native
BACKGROUND_CONTEXT linkage limitations remain; no new caller-to-native causal
bridge is claimed. Abrupt process death during a commit, cross-host clock changes,
retention/erasure of private Pi history and future policy-version migration are
not established by this increment. No real email is sent as acceptance.
