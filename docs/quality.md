# Behavioral quality gates

`Quality / Deterministic behavior` is a required, no-provider regression gate.
The reusable `.github/workflows/quality.yml` runs on `workflow_call` and
unprivileged pull requests only. Main deployment calls it in the same run and
must use `needs: quality`; no independent push trigger, status polling,
`workflow_run`, secret inheritance, environment or soft failures. The deployment
owner retains `deploy.yml`, its protected environment and host ownership. Merge
the caller dependency and reusable workflow atomically. Failed, skipped, cancelled
or timed-out quality must not deploy. Health/revision receipts are deployment
evidence, not model or Slack behavioral evidence.

## Deterministic coverage

Reuse the existing frameworks and tests, not another agent framework:

| Contract             | Executed evidence                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope/auth isolation | Server tests deny foreign tenant/user/agent, forged internal proofs, revoked grants, missing bearer, forged body scope and foreign result/control handles                                    |
| Durable admission    | Server concurrent dedup/conflict and registry reopen; Slack SQLite restart/dedup and lost-admission-response reuse                                                                           |
| Audience/routing     | Slack allowlists and binding reassignment; accepted v2 uses isolated channel principals and exact triggering threads, with top-level DM finals by default and explicit thread opt-in         |
| Ambiguous send       | Slack posting uncertainty survives restart, never blindly reposted; failed DM open does not block another user                                                                               |
| Disclosure           | Public projection excludes internal instructions, tools, reasoning, compaction and nonfinal output; fixed safe errors exclude synthetic private URLs/stacks; exact mixed-case text preserved |
| Terminal integrity   | Contract mock/reducer cancellation, unknown effects, replay gaps and late output cannot resurrect terminals; server settled cancel returns too-late                                          |
| History              | Actual Rivet/Pi SQLite compaction, sleep/wake, registry reopen, original entries and dedup receipt preservation                                                                              |
| Personality          | Static source policy tripwire plus integrated server persona runtime test checks actual instruction propagation, role separation and deterministic deliverable preservation                  |

Run `pnpm check`, `pnpm typecheck`, `pnpm test`, then
`node --import tsx --test scripts/quality/*.test.ts` from the root. No provider
credentials are needed. Persona source and its core configure-on-wake packet
must be integrated; absence is a failure, not an automatic skip. Static prompt
assertions and faux responses are not proof a real model follows the persona.

Runner contract: fresh Ubuntu 24.04 x64 hosted runner, Node 24, pnpm 12.0.0,
frozen lockfile and 20-minute job timeout. Native Vitest uses one worker, isolated
temporary HOME and engine port. Do not run concurrent registries against shared
storage. Do not blanket retry, skip privacy tests, or replace native actors with
mocks to hide readiness failures. Baseline `2d995` passed all four native tests in
this orb on 2026-11-08 (24.90s total), so the constrained integrator readiness
failure is not reproduced here and its root cause remains unconfirmed. Preserve
failing logs and compare runtime, CPU/memory/process limits, port conflicts and
native child startup with the core owner. Hosted Actions is a separate proof.

## Pending acceptance, not green test names

- Approval execution bound to correct actor, exact action and expiry: no approval
  lifecycle/executor exists in this baseline. Add runtime assertions when shipped.
- The integrated core packet adds native active Interaction-to-Worker cancellation
  and text-only streaming/reconnect tests. Combined local execution and hosted
  workflow results must still be recorded separately; abrupt pending-task process
  death, fault-injected cancellation retries and forced queued-placement races are
  not established by those tests.
- Model-authored output can itself quote private material. The projection checks
  metadata boundaries, not universal secret redaction from arbitrary text.
- Live Slack/provider roundtrip and persona quality require separate evidence.

## Optional semantic evaluation (never automatic paid calls)

`scripts/quality/personality.v1.json` fixes five safe synthetic cases and the
`computah-voice-v1` rubric. It covers ordinary chat, seriousness, explicit
instructions/mixed-case deliverables, unverified claims and authority injection.
No private histories, real tokens or real operator URLs belong in evidence.

No nightly schedule or provider client is installed. Only after explicit approval,
generate at most one response per case with a named model and bounded token/cost
budget; record human or named evaluator judgments. No retries to cherry-pick.
Keep optional credentials outside the public workflow. An LLM score is advisory,
not a replacement for deterministic contracts or an authorization decision.

Offline validation: `node --import tsx scripts/quality/score-semantic.ts evidence.json`.
Evidence contains `datasetVersion:1`, `rubricVersion:"computah-voice-v1"`, nonempty
`revision`, `model`, `promptVersion`, `evaluator`, ISO `observedAt` and exactly five
`results: [{id,response,score,reason}]`. Every case must meet the 0.8 threshold,
have a finite score at most 1, pass required/forbidden text checks and preserve
any exact deliverable. `COMPUTAH_EVAL_MIN_SCORE` explicitly overrides the default
within 0–1 for experiments; record it with the evidence. Dataset/rubric changes
require version changes and baseline comparison. This validates submitted evidence,
not its provenance or the correctness of a subjective judgment. Never publish
private provider output; retain only safe synthetic evidence and aggregate results.
