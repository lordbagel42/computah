# Computah development contract

- Read `docs/index.md` and the relevant subsystem spec before changing behavior.
- Preserve implemented/planned distinctions. Update applicable docs and fixtures
  with behavior or wire-contract changes.
- Main only: no feature branches or PRs. Preserve others' local work; use isolated
  checkouts and transfer scoped files with their base revisions to the integrator.
- One integration owner edits root manifests/lockfile and `packages/contracts`.
  Other packets request shared changes rather than duplicating schemas.
- Run `pnpm format`, `pnpm check`, `pnpm typecheck` and `pnpm test` before commits.
  Commits should be small and explain what changed and why.
- Build permission alone does not authorize pushing or deployment from Amp.
  Follow explicit task authorization; current Computah main publication and
  nest-bagel deployment are authorized, not unrelated host actions or purchases.
  Computah's product owner-agent self-shipping policy is documented separately.
- Never put real secrets or private histories in fixtures, docs, traces or Git.
  The browser/model cannot grant tenant identity, permissions or secret access.
- Rune is the selected frontend experiment. Do not silently replace it with a DOM
  framework. Wire contracts remain renderer-neutral.
