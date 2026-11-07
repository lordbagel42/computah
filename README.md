# Computah

A durable, extensible personal agent. **Phase 0 is under construction**, not a
deployed service. Rune is the selected experimental frontend; Pi may run locally
on the user's laptop independently of the Rivet backend experiment.

Start with the [living self-spec](docs/index.md). Agents should read that index at
startup and reread relevant pages when working on a subsystem. Docs describe
behavior; they do not grant credentials or capabilities.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
```

Parallel owners: integration owns root configuration, `packages/contracts` and
cross-cutting docs; backend owns `apps/server`; Rune experiment owns its app
folder; designed-UI planning owns source references. No feature branches or PRs.
Work on isolated local `main` checkouts and integrate scoped changes through one
owner. No deployment or push is implied by a passing local check.
