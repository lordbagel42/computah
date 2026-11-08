# Computah · native chat with local Pi

One conversation for ordinary answers, generated cards and editing the app itself. Native
Rune, not a webview. Product and agent are Computah. Open `~/Applications/Computah.app`.
No Chat/Layout mode selector and no backend server are required for this local study.

## Use it

- Ask a question; assistant prose streams into chat.
- Ask for a table, restaurant or custom card. Cards appear inline. Buttons send follow-up
  messages into the same conversation; card data never runs code or arbitrary commands.
- Ask to change typography, theme, sidebar or the whole layout. Validated changes activate
  automatically, without Preview/Apply. **Undo** reverses the last layout change/Restore.
- Ask for a missing native capability, or say **fix that** after a limitation. The owner-local
  agent can read/edit this experiment's UI Rust/catalog, run a fixed build and relaunch with
  conversation/draft/layout intact. Build failures keep the running app. Source edits remain
  local after failure/cancellation. **Revert build** recovers the prior executable.
- **New conversation** creates another saved chat. Select previous chats in the sidebar.
- **Stop** requests cancellation. It never reports stopped work as completed.
- **Restore**, outside the editable tree, restores the default layout even after an Empty
  app removes the composer. Restore does not erase conversations.

No web search, image fetching, general shell, credential or unrelated-file tools are exposed.
Data/recommendations are illustrative unless supplied by you; restaurant hours are unknown.
This is not the full Figma implementation or deployed durable-core product adapter.

## Build and run

Rust1.99.1 is pinned. Rune revision is `99c123d6b2127d1226c72dec37919e51019142ff`.
macOS needs Xcode Command Line Tools; Windows needs MSVC tools. Linux needs a graphical
session, compiler/pkg-config, xkbcommon/xkbcommon-x11/Wayland development libraries and Vulkan.
Only this Mac's new self-edit path has been exercised; other platforms are not newly verified.

Pi `@earendil-works/pi-coding-agent@1.5.0` requires Node>=22.19. This Mac's isolated
`../../pi-runtime` installation leaves global Pi untouched. On a fresh machine, install Pi
normally, run `pi`, `/login` and `/model` in your terminal. Never paste credentials into chat.
json-render/core0.22.0 and Zod are pinned in the experiment-local pnpm lockfile; no root lock
or shared Effect contract is changed.

From `experiments/rune-pi` on this Mac:

```sh
export PATH="$HOME/.cargo/bin:$HOME/Projects/rune-local-pi/pi-runtime/node_modules/.bin:$PATH"
export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
pnpm install --ignore-workspace --lockfile-dir . --frozen-lockfile --ignore-scripts
cargo run --locked
```

The scoped SDK avoids this Mac's default SDK27/local-linker mismatch, without system changes.
Default launch uses **real local Pi**; `--pi` also works. `--mock` is developer validation only.
Build the local bundle with `sh scripts/package-macos.sh` under that same environment, copy
`dist/Computah.app` into user Applications, then `open "$HOME/Applications/Computah.app"`.
The launcher records this source root and local Node/Pi paths (`PI_BIN` may point to an
alternative executable named `pi`). The source workspace must remain available for self-editing. It is a local debug bundle,
not a portable/signed/notarized release. Native Edit/Window menus remain available.

## Actual json-render → native Rune

`scripts/ui-catalog.mjs` uses actual `defineSchema`, `defineCatalog`, catalog validation,
Spec validation, state/visibility/action resolution and SpecStream compiler from
`@json-render/core@0.22.0`. Catalog identity is `computah.native@1`; node/style version1
remains backward compatible. Generative UI enters only through `render_ui`:

```json
{
  "catalog": "computah.native@1",
  "message": "Here is a card.",
  "cards": [
    {
      "root": "hello",
      "elements": { "hello": { "type": "Text", "props": { "text": "Hello" } } }
    }
  ],
  "app": null
}
```

A Spec is flat `{root,elements,state?}` with catalog types and props, not the old recursive
native protocol. Cards and app Specs also accept actual SpecStream JSONL patch strings.
Chunks compile privately; only complete validated results mount. Malformed/truncated streams,
unsafe pointers, unknown versions and unsupported directives fail instead of partially
activating UI. `scripts/ui-worker.mjs` runs in a fresh fixed Node process for every schema/
render call: Pi's TS loader otherwise caches stale catalog imports after a source edit.

Reusable semantic types: Row, Column, Card, Text, Button, Table, Restaurant, Divider. Native-only app
controls: Sidebar, Header, Transcript, Composer, Empty. Only `chat.send {message}` on Button
press is admitted; the host sends that message to this same conversation. No model-defined
handlers or arbitrary code in UI data. State references, visibility and action params resolve
through core; repeat/watch/slots/two-way bindings need a real native extension before use.
Table supports up to8 columns/100 rows. Empty is legal as sole app root, never an inline card.
Divider is childless with thickness0.5..16 (default1); `style.fill` overrides its line color.
There is no implied native/Slack visual or state parity, nor automatic native control export.

Whole-app changes carry `{theme,spec}`: complete app layout and explicit color/spacing/radius
tokens. Style supports bounded geometry, font size/weight/family and colors. Named installed
OS fonts load through Rune. Fonts inherit through the native subtree, including sidebar
buttons/text. Comic Sans MS is installed on this Mac; no licensed font files are bundled.

Materialization produces only literal inert Rust builder data. Original `{catalog,spec}`
design metadata persists beside that projection for future editing; old saved native trees
remain readable. Limits:128KiB materialized reply/document,128 app nodes/depth12,12 cards/
120 aggregate card nodes, unique scoped IDs, bounded styles. All controls remain native.
Unknown legacy kinds/versions show inert fallbacks; inline cards cannot mount app controls.

`layout.json` remains a backward-compatible local default. **Reload JSON** explicitly reads
it (`RUNE_PI_LAYOUT` overrides). Ordinary generation saves active layout in history, not this
file; authorized source editing may change it. `src/document.rs` is an experiment-local
projection, not a shared Effect wire/domain contract. `RUNE_PI_SNAPSHOT` remains a read-only
v1 shared snapshot text/fallback projection, not a live core send/subscribe adapter.

## Storage, recovery and trust

Completed chats/cards/layout and one layout Undo save atomically at0600 in
`~/Library/Application Support/Computah/conversations.json`. `RUNE_PI_HISTORY` overrides it.
First launch without Computah history validates/copies legacy `June Rune/conversations.json`,
leaving the original intact. Existing Computah history always wins; nothing merges/erases.
Only exact legacy host branding/assistant role labels change, not message text or styling.
An explicit history override disables legacy discovery. Linux equivalents are
`~/.local/share/computah` and legacy `june-rune`. June/Figma references are provenance only.
Invalid history is left untouched and disables writes for that launch. Mock/snapshot/scene/
script checks do not persist. Build/relaunch checkpoints retain draft and a one-time pending
rendered reply; normal in-flight streaming is not continuously checkpointed or replayed.

Pi uses its existing supported terminal authentication; the host/source tools never read auth.
Built-in tools, MCP, discovered extensions, skills, templates, themes, context files and Pi
session persistence are disabled. Only explicit `scripts/self-tools.ts` loads. Pi1.5
`--no-tools` disables custom tools too: use **`--no-builtin-tools`** here. Current app/recent
conversation and inspected owned source may go to the configured remote model provider.
Raw RPC/stderr/credentials are not logged or saved. Idle deadline120seconds, extended to240
after tool progress; fixed build stages each have a180-second limit. Unknown exits reap Pi.

Scoped source tools expose `src/*.rs`, UI catalog, prompt, layout and README. Pinned Rune API
source under `rune/` is read-only. Paths outside these roots, traversal/symlinks, credentials,
history, tooling/dependency changes, deployment and arbitrary shell are not exposed. Build
is fixed: catalog tests, cargo fmt, Clippy, tests, locked build. The host preflights the entire
saved checkpoint with the new binary, including pending UI, older chats and previous layout,
then installs only its own executable with a previous backup and relaunches. Rollback checks
saved UI compatibility before changing binaries; an incompatible rollback is refused.
A lifetime-held history lock prevents two normal instances from writing concurrently.
Failure/cancellation never activates a candidate. Compiled authorized source
runs with user privileges: **the tool allowlist is not an OS security sandbox**. Do not expose
this local-owner self-edit capability to untrusted remote users or generated UI actions.

## Checks

```sh
pnpm test
node --check scripts/self-tools.ts
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo run --locked -- --mock --snap default.png --scale 2
cargo run --locked -- --scene table --snap table.png --scale 2
cargo run --locked -- --scene empty --snap empty.png --scale 2
```

Captures may contain chat: use synthetic requests. See `VERIFICATION.md` for actual runs,
failed attempts and limits. No tenant isolation, durable replay/resume/mutation deduplication,
image loading, sortable/virtualized tables, or full Figma/presence claim is made here.
