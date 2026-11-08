# Computah native

A Rust [Rune](https://github.com/anomalyco/rune) frontend for the existing durable
Computah core. This is a separate product track, not the local Pi experiment.
No model SDK, Pi process, provider login, engine inspector or server signing secret
is included. The native renderer and private Node host share only inert JSON.

## Run

Requires Rust 1.99.1 (pinned), Node 22.19+, pnpm 12 and the root workspace install.
Rune is pinned to `99c123d6b2127d1226c72dec37919e51019142ff` in Cargo.lock.
On Linux, the exercised build needs pkg-config, libxkbcommon-dev,
libxkbcommon-x11-0, libwayland-dev and Vulkan/Mesa. On macOS, install Xcode command
line tools. This product checkout has not been built or tested on macOS.

From this directory:

```sh
cargo run --locked -- --demo
```

The demo is explicit: synthetic messages/panels, no model. Ask for a table, a
restaurant or “delete all” to exercise deterministic registered UI fixtures.
Nothing is booked, searched or connected. The production-mode sidebar never
shows those synthetic panels as real account data.

For the real REST adapter, use the trusted host environment's `COMPUTAH_URL`
(HTTPS origin or an explicitly forwarded loopback origin) and `COMPUTAH_TOKEN`
(bearer provisioned separately), then `cargo run --locked`. Never commit these
values or place them in generated JSON. Current nest-bagel loopback access/auth
provisioning is a separate task; health alone is not authentication proof.

### User-local installation

From a fully installed canonical source checkout, with Cargo/Node/pnpm on PATH:

```sh
pnpm --filter @computah/native install:app "$HOME/.local/opt/computah-native/<revision>"
"$HOME/.local/opt/computah-native/<revision>/bin/computah-native" --demo
```

Use a **new unused absolute prefix**, not the state directory or the experiment's
Computah.app. The installer builds the pinned native binary, deploys its production
JS dependencies/assets, and publishes a relocatable shell launcher. It never
replaces an existing directory, modifies PATH, provisions credentials, or changes
drafts/outboxes. The bundle excludes Cargo target/cache and private runtime files.
It still requires system Node and the platform graphics libraries. This is a
source-built launcher, not a signed/notarized app or mobile package. Omit `--demo`
only with the trusted private endpoint and separately provisioned bearer in the
launch environment. Relative `COMPUTAH_STATE` is resolved against the launch cwd
before the host changes cwd; moving the bundle must not relocate pending work.

### Explicit real-service acceptance

An authorized operator can run `node --import tsx scripts/acceptance.mjs` with the
existing trusted `COMPUTAH_URL`/`COMPUTAH_TOKEN` supplied privately. This makes three
harmless real turns: a Task-requesting canary, a context-recalling follow-up and a
cancellation attempt. It deliberately loses a **successful real admission ACK**,
reloads the private outbox and asserts identical mutation/handle on retry. It checks
forged-bearer denial, authenticated viewer/history, real result, reconnect history,
follow-up recall and truthful cancellation reconciliation. A too-fast finished
turn is explicitly marked as skipped cancellation, not cancellation proof.
Requests stop after a ten-minute acceptance deadline (plus one in-flight HTTP
deadline). Failed acceptance retains its private outbox for operator recovery.
Only booleans/categories and trace IDs are emitted, never history/credentials or
signed handles. Public answer text cannot prove Worker invocation: the operator
must separately verify private aggregate Task/Worker evidence. This entry is not
automatically run in tests, install or startup, and its existence is not a live
receipt. Never point it at an unapproved endpoint or run duplicate concurrent turns.

## Composition, recovery and transport

`layout.json` is the default version-1 entire composition: header, sidebar,
transcript, composer and theme. The registered native renderer owns their
platform-specific behavior, rather than letting model JSON execute code.
`scripts/ui-catalog.mjs` reuses the Mac study's actual @json-render/core 0.22
catalog/materializer and SpecStream compiler. See [DESIGN.md](DESIGN.md).

The host can watch an explicitly configured `COMPUTAH_UI_FILE` containing the
catalog reply envelope demonstrated by fixtures. Valid replacements apply
automatically after whole-document validation, without mandatory Preview/Apply.
Malformed or unsupported replacements leave the current composition intact.
Undo restores the preceding composition; Restore independently reinstates the
default even when the app root is intentionally Empty. Neither deletes history.
Recovered layout/draft/demo history are atomically saved in a version-1 private
file under `~/.local/share/computah-native` (macOS: Library/Application Support).
Override with `COMPUTAH_STATE`. Invalid checkpoints are retained, not overwritten.
Real conversation history is loaded from the core, not cached as a second brain.

EOF drains active host commands before telemetry shutdown. SIGTERM aborts only
local HTTP transport, retains the saved mutation/outbox, and attempts a bounded
ten-second drain; it never sends remote cancellation. Failed Stop requests report
unknown cancellation without clearing the still-active Send/Stop state.

The host GETs authenticated viewer and every opaque history page. It POSTs only
`{text,clientMutationId}`: **not** the shared SendRequest with conversationId,
because the live route forbids body scope. A principal+origin-bound local outbox
persists one mutation identity before every admission attempt. Ambiguous retries
retain that identity across restart. Draft text is retained until the host's
checkpoint acknowledgement; a rejected pre-checkpoint send does not erase it.
Results are long-polled (not streamed), then full history reconciles the user
prompt and final answer. Stop reports confirmed/too-late/unknown cancellation;
closing the app or losing a connection does not cancel durable work.

Current core source includes authenticated submission-observation SSE; this native
adapter deliberately uses the compatible final-result polling route and does not
consume that stream. There is still no generated-component endpoint. The UI-file seam and demo
are fixtures for that future adapter, not a claim that ordinary assistant prose
changes the app. Unknown public component versions show only their fallback.
Public Effect schemas remain owned by packages/contracts; this private materialized
tree is not a new public protocol and must not replace those schemas.

## Local owner source capability

`node --import tsx scripts/owner.mjs read <source>` returns content plus SHA-256.
`write <source> <base-sha>` accepts replacement source on stdin, rejecting stale
bases, non-allowlisted names and symlinks. `build` runs fixed tests, fmt, Clippy and
build steps and records a candidate hash; it does not replace the running app.
`relaunch <active-state-path>` requests a checkpoint, verifies the candidate hash
and that the candidate can read the current checkpoint, then spawns the fixed
candidate before the app quits. A failed current save blocks relaunch even if an
older valid file exists. Source edits are not automatically rolled back by Undo.

This is an explicit **local owner CLI**, not a generated UI action, not a durable
core tool yet, not arbitrary shell, and not an OS sandbox. Edited Rust executes
with the owner's OS permissions. Only `chat.send {message}` is available to
generated Button actions. Backend owner-tool registration and app packaging are
separate integration work; no second production model runtime is introduced.

## Content-free observability

The private Node host, REST adapter, installer and owner CLI reuse
`@computah/observability`, not a client-specific exporter. Fixed native process,
IPC, materialization, recovery and core-request operations emit lifecycle/status
outcomes; only W3C IDs propagate to the configured trusted core, with redirects
rejected. No content, bearer, signed handle, scope identity, local path or source
body is logged. Native IPC spans remain active through polling/recovery and have
child HTTP spans; structured logs inherit their trace IDs. Invalid generated UI,
failed disk checkpoints, denied auth, failed HTTP and unknown cancellation are
observable without exposing their payloads.

Collection is optional and uses the **existing protected host** telemetry config:
`COMPUTAH_AXIOM_INGEST_TOKEN` and, for logs, `COMPUTAH_AXIOM_LOG_DATASET`.
No server ingest key or client authorization is bundled or auto-provisioned.
Exporter errors fail open; buffering/drain remain bounded and best-effort. Rust
GPU draw timings, text/IME handling and the interval before Node starts are not
instrumented by these Node spans. Local sink tests are not an actual Axiom receipt;
see [verification](VERIFICATION.md) and [observability](../../docs/observability.md).

## Verify

```sh
node --import tsx --test scripts/*.test.mjs
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked
target/debug/computah-native --demo --size 390x844 --scale 2 --snap narrow.png
target/debug/computah-native --demo --size 1100x780 --scale 1 --script fixtures/interaction.json --pointer --video interaction.mp4 --duration 7
```

Run root `pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test` too.
Rune rendering/input checks are separate from pnpm. See [VERIFICATION.md](VERIFICATION.md)
for observed results, fidelity limits and platform gates.
