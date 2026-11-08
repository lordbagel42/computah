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

`node scripts/owner.mjs read <source>` returns content plus SHA-256.
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

## Verify

```sh
node --test scripts/*.test.mjs
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
