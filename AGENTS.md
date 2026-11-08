# Computah development contract

- Read `docs/index.md` and the relevant subsystem spec before changing behavior.
- Preserve implemented/planned distinctions. Update applicable docs and fixtures
  with behavior or wire-contract changes.
- Main only: no feature branches or PRs. Preserve others' local work; use isolated
  checkouts and transfer scoped files with their base revisions to the integrator.
- Before closing a delivery thread, preserve its `Amp-Thread-ID` commit trailer
  through integration and report the actual resulting default-branch commit URLs
  to the worker and Space (not just the pre-integration SHA). Verify Amp links the
  landed commits and the Space counts the thread as shipped; idle, a status message
  or a `shipped` label is not shipment. If linkage is missing, use only supported
  Amp mechanisms; report the exact gap rather than rewriting published history or
  inventing a shipped setter. If PRs are explicitly authorized later, include the
  thread URL in their descriptions and verify the merged PR linkage.
- Keep source shipment, successful checks, deployment adoption and runtime/human
  acceptance separate. Leave threads with unshipped work or assigned acceptance
  and follow-ups open with an owner and next action. Under Raygen's standing rule,
  archive completed threads after shipment verification and no pending follow-ups;
  archive completed research/no-code work without calling it shipped.
- One integration owner edits root manifests/lockfile and `packages/contracts`.
  Other packets request shared changes rather than duplicating schemas.
- Run `pnpm format`, `pnpm check`, `pnpm typecheck` and `pnpm test` before commits.
  Commits should be small and explain what changed and why.
- Runtime tracing is mandatory for all new or changed executable behavior: cover
  operation lifetimes, failures, cancellation, retries and background/recovery
  work, not meaningless spans for static bytes. Carry linked trace context across
  HTTP, actor, queue and durable-task boundaries; do not silently introduce an
  untraced path. Verify emitted spans, outcomes and parent/link continuity with
  tests, including failure/cancel cases, through the sanitized Axiom export path.
  Keep tracing fail-open, bounded and backpressured; never export credentials or
  hidden reasoning. Document remaining gaps in `docs/observability.md` and
  distinguish local proof, enabled collection and live Axiom ingestion. Never
  claim complete coverage merely because emitted spans export without sampling.
- Structured runtime logs accompany operation/lifecycle outcomes through the
  shared bounded logger, linked to current trace context. Test typed failures
  as well as thrown errors; never label a resolved denial as success. Do not
  add competing exporters or silently unlogged runtime paths. Keep credentials,
  hidden reasoning and raw histories out of telemetry; use fixed categories.
- Build permission alone does not authorize pushing or deployment from Amp.
  Follow explicit task authorization; current Computah main publication and
  nest-bagel deployment are authorized, not unrelated host actions or purchases.
  Computah's product owner-agent self-shipping policy is documented separately.
- Never put real secrets or private histories in fixtures, docs, traces or Git.
  The browser/model cannot grant tenant identity, permissions or secret access.
- Internal tooling policy: "internal tooling like this has zero concept of
  privacy. you do not build public apps unless asked, but you do not censor
  aspects of the usage". Do not omit requested bounded conversation messages,
  participant, location, actor or available agent activity from diagnostic views
  for authorized operators merely on privacy assumptions. Internal tools,
  including the DEBUGSHARE issue tracker,
  require authentication and are not public unless explicitly requested. Keep
  capture scoped to the issue, protect credentials/security boundaries, and show
  available activity and concise summaries, never hidden model chain of thought.
- Rune is the selected frontend experiment. Do not silently replace it with a DOM
  framework. Wire contracts remain renderer-neutral.
