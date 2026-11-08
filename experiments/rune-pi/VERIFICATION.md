# Computah Mac study verification · 2026-11-07

Installed and exercised on the owner's Apple Silicon MacBook. App:
`~/Applications/Computah.app`; source: `~/Projects/rune-local-pi/experiments/rune-pi`.
Local source delivery only: no branch, commit, push, PR, deployment or core-server change.

## Linux source integration · 2026-11-08

The final Mac packet was imported without AppleDouble metadata, runtime, credentials or
history. Setup now explicitly uses the experiment-local lockfile under the root pnpm12
workspace. Actual json-render catalog tests, Rust formatting, Clippy with warnings denied,
five Rust tests and the locked Linux build passed. A new history regression first failed
on a long ordinary message, then passed after separating saved transcript text from the
128KiB generated-UI envelope budget; cards and pending generated replies remain validated.
Default, table and Empty states were rendered with Rune's headless GPU tooling. Synthetic
pointer/input recovery exercises are not a fresh live Pi call or Mac graphical relaunch.
The owner-Mac observations below remain historical evidence with their stated limits.

## Executed on this Mac

- Rust1.99.1; Rune exact revision `99c123d6b2127d1226c72dec37919e51019142ff`.
  Fixed build pipeline passed extension/worker syntax checks, actual json-render catalog
  tests, cargo fmt, Clippy with warnings denied, cargo tests and locked build. SDK26.5 was
  selected per command because default SDK27 failed with the local linker. No system
  SDK/default changed.
- Actual `@json-render/core@0.22.0` schema/catalog/Spec/SpecStream fixture tests passed:
  state/visibility/action resolution, chunk boundaries, malformed final patches, inert
  actions, card/app separation, budgets, tree validation and source-tool path restrictions.
  Rust contract/runtime tests passed on the same source.
- Pi1.5.0 is isolated under project-local `pi-runtime`, global Pi untouched. Supported
  `get_state` reported openai-codex / gpt-6.1-sol. No credential file was inspected/copied.
  Default installed app uses real Pi, one chat, not mock or a mode selector.
- Product, agent, native window/menu and Applications bundle are Computah. Old wrong-named
  bundle retired, not left duplicated in Applications. Compatible history migration copies
  legacy storage only if Computah storage is absent; the original is preserved. Exact host
  identity labels normalize, not user message text/custom styling.
- Real ordinary chat returned “17 plus 26 is 43.” Real table/restaurant/custom cards rendered
  natively; clicking a follow-up button sent its prompt into the same real conversation.
- The font limitation and “fix that” sequence caused genuine Rust/catalog source edits,
  fixed verification/build and state-preserving relaunch. A first attempt hit stale schema
  caching and failed visibly, not falsely applied. Fresh fixed Node workers resolved it.
  The subsequent natural request “change the font on the sidebar to comic sans” actually
  activated installed Comic Sans MS throughout sidebar text/buttons, leaving chat sans.
  Before/after window screenshots were inspected. No font files redistributed.
- A separate natural request for a reusable Divider caused source implementation, verification,
  build and relaunch, then generated the new whole-app component and inline table/restaurant/
  button via json-render in one successful turn. This was not a font-only hardcoded demo.
  The live follow-up button produced a real answer. Window screenshot inspected.
- Whole-app generation activates automatically after complete validation. No Preview/Apply
  gate remains. A real Empty Spec removed the transcript/composer while the host recovery
  toolbar stayed visible; screenshot inspected. Undo returned the chat controls. A second
  real Empty Spec followed by independent Restore returned the default chat; all four chats
  and their messages remained saved. No pending reply remained.
- On the final binary, a real lengthy card generation was stopped while active. Its saved
  assistant result explicitly said no interface/binary activated and source edits, if any,
  remain local. No generated cards were added for that cancelled turn.
- Candidate binary preflight admitted the entire saved checkpoint, including pending reply,
  older cards, active/previous layout and history. Malformed pending content was rejected.
  Actual Revert build switched executable hash while exact conversation/layout/legacy-file
  digests and active chat stayed unchanged. Incompatible rollback is refused before install.
- A real rebuild/relaunch on final source preserved history and consumed the pending reply.
  Single-instance history-file locking rejects an extra direct launch and prevents duplicate
  writers when Finder activation overlaps self-relaunch. Failed build/cancel never installs
  a candidate; local source edits are not automatically undone.

The prior Linux source-owner tests (native X11/headless GPU and fake-process RPC settlement,
retry/abort/deadline/exit cases) are historical evidence, not Linux verification of this Mac
self-edit implementation. Original source archive SHA256:
`66324c053a482fb768578402cd8b6c62bffaab42a64c32da772bfbf1c72ab350`.

## Limits and honest failures

Desktop inventory/activation occasionally temporarily loses the window or reports off-screen
animation bounds; explicit native activation recovers it. No crash was demonstrated. This is
not proof across window managers. Live draft-entry-during-rebuild was not exercised; checkpoint
serialization/preflight covers drafts but ordinary in-flight work is not durably resumed.

Not tested: Windows, full VoiceOver/IME/clipboard/keyboard matrix, long-running storage growth,
portable signed/notarized distribution, Slack or deployed-core adapter. This is a local debug
study, not durable-core conversation storage or the full Figma/presence implementation.
Tables are not sortable/virtualized; restaurant photos/hours are not fetched. Synthetic demo
chats remain available locally. Delivery packets exclude histories, credentials and runtime.

The trusted materializer accepts inert bounded JSON only. Source editing is a separate
authorized local-owner capability with fixed build/reload, not a UI action or remote-user
feature. Compiled edited source runs with the owner's privileges: **not an OS sandbox**.
General shell, auth/history/unrelated-file tools and dependency/deployment mutations are not
exposed. Integration owns shared Effect contracts; future native/Slack adapters need explicit
projections, not assumed visual/state parity or a second local Pi brain.
