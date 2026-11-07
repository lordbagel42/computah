# June · Rune + local Pi experiment

A small **native Rune** app, not a webview, React app, or the faithful June design. No server,
Rivet, Pi Durable, or account on Computah is required. It is an isolated Cargo workspace.

## Run on your laptop

Install Rust through [rustup](https://rustup.rs). The checked-in toolchain selects **1.99.1**.
macOS needs Xcode Command Line Tools (`xcode-select --install`); Windows needs the Rust
MSVC build tools. Linux needs a graphical session plus development libraries:

```sh
sudo apt-get install build-essential pkg-config libxkbcommon-dev libxkbcommon-x11-0 libwayland-dev mesa-vulkan-drivers
```

From the extracted source directory:

```sh
cd experiments/rune-pi
cargo run --locked
```

This defaults to the **deterministic mock**. Type `make a table`, `restaurant`, or `empty`,
press Enter/Generate, then Apply proposal. Empty really removes the entire document,
including its composer. **Restore** is outside that mount and brings it back. Unknown
renderer versions display inert fallback text instead of executing anything.

### Actual local Pi

This uses **Pi coding agent 1.5.0**, specifically its JSONL RPC process protocol;
it does **not** use Pi Durable. Requires Node.js >=22.19.0 and a provider/model configured in Pi.

```sh
pnpm add -g @earendil-works/pi-coding-agent@1.5.0
pi
```

In Pi's terminal UI, use `/login` to authenticate with your provider and `/model` to choose
a model, then quit Pi. Do not paste credentials into this app, a layout, or this thread.
Keep the `pi` executable on PATH and launch from the same normal user account:

```sh
cargo run --locked -- --pi
```

Pi is a local child process; your configured model may still be a remote provider. Only text
deltas and lifecycle outcomes enter the UI; raw RPC errors/stderr/tool payloads are not
logged or displayed. The child inherits Pi's supported auth store/environment—this app
never reads or edits the auth store. `--no-session`, `--no-tools`, `--no-extensions`,
`--no-skills`, `--no-prompt-templates`, and `--no-themes` keep this experiment narrow.
This is not a sandbox for an arbitrarily modified Pi executable or untrusted Rust source.
Model text is untrusted; never enter secrets. Rune tree/trace captures can include UI text:
only capture synthetic prompts, never private conversations.

Local Pi streams a proposed JSON composition. Apply is explicit and in-memory only; if the
model emits malformed JSON/markdown, the current layout stays intact. Cancel sends `abort`
and waits for `agent_settled`; no false completion on `agent_end`. A 120-second deadline
stops the child and reports **unknown**, not success. Errors/exits require retry and start a
fresh child when its state is uncertain. Closing the app kills/reaps its child.

## Modify everything, without losing recovery

- Edit `layout.json`, then **Reload JSON** (also loaded at startup). Override its path with
  `RUNE_PI_LAYOUT=/absolute/path/layout.local.json`. No file writes happen from generated UI.
- `theme` controls background, surface, text, muted text, spacing, padding, and radius.
- `root` is a recursive `column`/`row` tree; `null` is a valid blank document. Reorder/remove
  any component. IDs must be unique; total nodes <=128, depth <=12, JSON <=128 KiB.
- `src/main.rs` has the native `REGISTRY` keyed by `(kind, version)`. Edit/extend components,
  typography, event handling, shell, or controls there and rebuild. No hidden DOM layer.
- `src/document.rs` owns the **experiment-local composition**, not a competing portable
  frontend wire schema. It accepts inert data only; it has no eval, shell, URL fetch, or
  model-defined action dispatcher. Only host-written controls can submit/cancel/apply.
- The small permanent recovery toolbar is intentionally outside JSON control. It is still
  source-modifiable; do not remove it casually. Restore resets in memory, not your file.

To project the integration owner's shared v1 snapshot fixture into this native conversation:
set `RUNE_PI_SNAPSHOT` to `packages/contracts/fixtures/v1/conversation.json` (absolute path
or relative to this app's working directory). This read-only projection displays text and
inert component fallback, never component props or connection data. It is not the live
send/cancel/subscribe adapter and does not replay the fixture's events.

Registered v1 components: `column`, `row`, `text`, `transcript`, `composer`, `table`,
`restaurant`. Table uses actual native Rune row/columnheader/gridcell elements and aligned
columns, not prose; currently bounded to eight columns and 100 rows, not a virtualized
Rune Kit table. Restaurant is reusable name/description/timezone data with an explicit
missing-photo slot and **hours unknown**, never "closed" for absent hours. Photo loading,
time-aware opening schedules, sorting, full per-node styles, and faithful Figma/presence
rendering are deliberately not implemented in v1. Do not imply they work from field names.

## Checks / captures

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo run --locked -- --snap default.png --tree default.json --scale 2
cargo run --locked -- --scene table --snap table.png --scale 2
cargo run --locked -- --scene restaurant --snap restaurant.png --scale 2
cargo run --locked -- --scene empty --snap empty.png --scale 2
cargo run --locked -- --scene unknown --snap unknown.png --scale 2
cargo run --locked -- --script scripts/demo.json --video demo.mp4 --pointer --duration 9
```

Rune's headless path uses the same native renderer without a display. Software Vulkan
(Mesa lavapipe) can render in a Linux orb. This does not establish laptop launch, native
IME, real OS accessibility, GPU-driver parity, or authenticated provider success.
See `VERIFICATION.md` for the actual tested delivery state.

## Sources and boundary

Rune is [anomalyco/rune](https://github.com/anomalyco/rune), pinned to
`99c123d6b2127d1226c72dec37919e51019142ff`; APIs were checked against `examples/hello`,
`crates/rune/README.md`, and implementation. Pi's published 1.5.0 RPC implementation and
[official protocol](https://pi.dev/docs/latest/rpc) establish the process boundary.
The root/shared frontend contract remains owned by the integration lane; this prototype
does not claim tenant isolation, replay/resume, mutation dedupe, or durable history.
