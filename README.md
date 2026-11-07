# Computah

A durable, extensible personal agent. The protected Rivet/Pi backend is running
on nest-bagel, with real-provider delegation, restart recovery and automatic
main rollout verified; see [operations](docs/operations.md) for evidence and limits.
The [Slack prototype](docs/slack.md) is locally checked; its dedicated app is
installed, but the adapter is not yet live-activated or roundtrip-verified.
Rune is the selected native frontend; the local-Pi study remains a separate
experiment, not the product app's backend.

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
