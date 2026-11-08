# Development and recovery

Requires Node 22.19+ and pnpm 12.0.0. The lockfile pins installed packages; Effect
is 4.1.2 and TypeScript 7.0.2. E2B orbs are the default build environment. No cloud
resources, accounts or deployments are needed for contract tests.

## Amp orbs

Executable `.agents/setup` prepares snapshot-ready dependencies: the Dockerfile's
Node version, the root manifest's pnpm version, both pinned Rust toolchains with
Clippy/rustfmt, and Linux native build/graphics prerequisites. It installs frozen
dependencies for the root workspace, the independent Rune experiment (using its
own pnpm pin), and both deployment workspaces. Cargo fetches both locked native
workspaces for the Linux host without compiling them. Warm setup reuses installed
toolchains and package caches; login shells inherit their paths.

`.agents/resume` only checks local toolchain availability. No dependency installs,
servers, provider logins, real Pi installation or deployment actions run on wake.
Deterministic tests need no external services or secrets. Fetching dependencies
does not establish successful compilation, native rendering or live acceptance.
Changes to these scripts affect future project snapshots only after publication
to the default branch; existing orbs can run setup explicitly to refresh.

Run `pnpm install`, then `pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test`.
The only approved dependency install script initially is esbuild's platform-binary
setup. Optional @google/genai, cbor-extract, lmdb, msgpackr-extract and protobufjs
scripts are explicitly disabled; the exercised bus uses packaged native prebuilds,
without running their install scripts. Rivet 3.0.6 release-age
exceptions are exact version pins, not permission to run dependency scripts.
Review additional build scripts before permitting them. Formatting/linting is not
runtime verification. `pnpm test` includes real Rivet/Pi SQLite tests with an
in-process faux model, no account credentials. Actor sleep/wake and registry reopen
are covered, not abrupt process death. Rune rendered/input checks remain separate.

The [Rune experiment](rune-pi.md) is an isolated Cargo workspace, not included in
root pnpm tests. From `experiments/rune-pi` use Rust 1.99.1 and run `cargo fmt --check`,
`cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked`.
See its README for native/headless rendering and OS dependencies. Mock mode needs
no model credentials; actual Pi mode uses terminal authentication and a pinned
local coding-agent subprocess, not the server's durable runtime.

The separate [native product client](../apps/native/README.md) in `apps/native`
uses the existing durable core via REST, never a second local Pi brain. Root pnpm
tests include its Node catalog/transport checks. Its isolated Rust workspace also
requires `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`,
`cargo test --locked` and `cargo build --locked` from `apps/native`. Synthetic Linux
render/input evidence does not establish live access, Mac or mobile acceptance.

## Parallel packet ownership

| Owner           | Files                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| Integration     | Root manifests/lockfile/config, packages/contracts, docs index/cross-cutting spec |
| Core            | apps/server and docs/core.md                                                      |
| Rune experiment | experiments/rune-pi and docs/rune-pi.md                                           |
| UI mapping      | ui/IMPORT-PLAN.md and ui source references                                        |

No branches or PRs. Isolated checkouts each use local main; local main is not
origin/main. Transfer scoped files with base revision and verification evidence;
messages/commit IDs alone do not transfer changes. One integrator reconciles remote
main and shared files, reruns affected checks and uses non-force publishing only
when authorized. Never overwrite another packet's work or discard unpushed changes.
Each commit explains what and why. Current build approval is not push approval.

## Authorized deployment handoff

Raygen has explicitly authorized publishing the tested integrated source to
`lordbagel42/computah` main and deploying Computah on runner `nest-bagel`.
This does not authorize unrelated host destruction or purchases. Integration owns
root manifests/lockfile, contracts, current core and Rune; the deployment owner
owns `deploy/`, Docker, deployment workflows and host operations docs. Coordinate
root edits through integration and runnable `apps/server` additions with the core
owner; do not create competing server bootstraps. Separate checkouts must fetch
the exact published source rather than assuming local uncommitted files transfer.

The runnable core includes transport/auth/config in `apps/server` and
`docs/core.md`; the deployment owner must not create a competing server entry.
Launch contract: Node >=22.19, production tsx start script, bind `PORT`, expose
`GET /healthz` only after real registry startup. `COMPUTAH_AUTH_JSON` is a secret
array of token-to-tenant/user/agent/capability bindings; `COMPUTAH_CONNECTION_SECRET`
is stable server-only key material. `COMPUTAH_MODE` defaults to `real` with required
native provider credentials. Remove legacy `COMPUTAH_MODEL`; role settings default
to `COMPUTAH_INTERACTION_MODEL=openai-codex/gpt-6.1-terra` and
`COMPUTAH_WORKER_MODEL=openai-codex/gpt-6.1-sol`. Generation and compaction requests
force supported priority and high reasoning after caller payload transforms.
This enforces outgoing requests, not a provider no-downgrade guarantee; report
actual raw tiers and errors without silently changing models or selecting standard.
Preserve auth, signing keys and native data during the authorized scoped resume;
stored in-flight checkpoint models are not rewritten. See [model policy](model-policy.md).
`faux` is an explicit smoke mode, never a silent fallback. No values belong in Git
or messages. Authenticate into configured bindings, check current grants per call
and project safe results rather than exposing raw Pi entries.
Authenticated HTTP delegation/restart is locally exercised with a faux model.
The deployment owner separately verified real legacy Codex HTTP requests,
follow-up and Docker restart retaining exact history and the old signed handle;
see `operations.md` for the observed revision/image and limits. Enabled-timer
automatic main rollout and retained real follow-up also passed. The full streaming wire adapter is
not implemented; health alone cannot establish provider operation.

## Evidence and recovery

Keep secrets and private histories out of diagnostic output. A WireError exposes
safe code/message/correlation ID only. Unknown effects must be reconciled, not
blindly retried. A stream gap requires snapshot/resync; local restart is not proof
of durable recovery. Do not claim deployment from a passing build or Git head.

Before later activation, preserve compatible backups and verify serving revision,
health and actor/Pi recovery. Pi schema migrations may be roll-forward-only;
reverting a binary does not undo data migration or external effects. The exact
supervisor, deployment writer and data-retention policies are not implemented.
