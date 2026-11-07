# Delivery verification · 2026-11-07

**Ready to try on a laptop from source. Not laptop-tested.** Local uncommitted files on
main; nothing pushed, deployed, or provisioned. No laptop runner was accessed. No macOS
or Windows executable is included. Source package contains the isolated experiment and
`docs/rune-pi.md`, not root manifests, shared contracts, credentials, build output, or UI refs.

## Executed in the Linux E2B orb

- `cargo fmt --check`: clean.
- `cargo clippy --locked --all-targets -- -D warnings`: clean.
- `cargo test --locked`: 3 passed; blank-layout generation/application/recovery through
  Rune Runtime pointer input, composition validation, and inert snapshot fallback projection.
- `cargo build --locked`: successful native link with Rust 1.99.1 and pinned Rune dev
  revision `99c123d6b2127d1226c72dec37919e51019142ff`.
- Rune GPU headless PNGs at 2×: default, table, restaurant, empty, unknown component, and
  the integration owner's actual portable v1 fixture. Every capture inspected for readable
  content/controls and no clipping. Table tree exposes grid, row, column-header, grid-cell;
  default exposes named focusable buttons and text-input; empty removes the composer but
  retains the independent recovery toolbar.
- Native X11 window launched under Xvfb with software Vulkan. Real mouse/keyboard input
  produced a table, restored conversation, generated/applied an empty mount, then restored
  again. The recording includes pointer travel across adjacent controls. Final recording was
  inspected as a one-frame-per-second storyboard after the video-analysis service was
  unavailable. Earlier incomplete recordings were replaced, not included as evidence.
- `scripts/demo.json` independently ran through the same sequence headlessly. Final tree
  contains full `make a table` and `empty` prompts, restored status, and composer placeholder.
- Shared `packages/contracts/fixtures/v1/conversation.json` was consumed without editing
  it. The projected text explicitly shows Synthetic Ramen's missing photo/hours and unknown
  component version. No props or connection payloads enter this read-only projection.

Linux native X11 needed `libxkbcommon-x11-0` in addition to the development dependencies;
the first window launch exposed the missing library, installation fixed it, and README now
includes it. Headless snapshots do not exercise this native dependency.

## Pi transport validation, not an authenticated provider test

A temporary fake `pi` process exercised the actual spawned stdin/stdout transport and app
poll loop, then was removed along with its temporary Rust probe module:

- Two sequential turns, chunked JSON and literal U+2028 inside text; no Unicode line splitting.
- Ignored tool payloads/raw provider-error text; only model text and sanitized outcomes surfaced.
- Recoverable failed partial assistant attempt followed by a successful retry. Final proposal
  came from the successful message, not concatenated attempts; `agent_end` did not settle it.
- Final error followed by settlement, child exit, abort awaiting settlement, and forced timeout.
- A child that never consumed stdin: enqueuing a 1 MiB prompt returned within the 500 ms
  assertion; the entire probe completed in 0.02 s after forced timeout killed/reaped the child.
- Deterministic queued `Unknown → AttemptEnd → Done` while cancelling: unknown outcome won,
  uncertain bridge was dropped, deadline cleared; no false cancellation/success.

Read-only lifecycle review found premature error termination, a cancellation cleanup gap,
and blocking UI pipe writes; all were corrected. Follow-up review found the cross-worker
unknown/completion race; immediate termination on unknown and the deterministic probe
addressed it. This is scoped review evidence, not a comprehensive security certification.

Pi's published **@earendil-works/pi-coding-agent 1.5.0** package was inspected to confirm
RPC event and flag support. No credentials were provided, no real model request was made,
and no claim of live provider success is made. Supported auth remains Pi's terminal login.

## Remaining laptop gates

Use Rust 1.99.1 plus OS build tools. Start with `cargo run --locked` and try `make a table`,
`restaurant`, and `empty` followed by Apply/Restore. For actual Pi install 1.5.0, log in and
choose a model in its terminal UI, then `cargo run --locked -- --pi`. Node >=22.19.0 required.

Unverified: macOS/Windows build and launch, laptop GPU/driver behavior, OS screen reader,
native IME/clipboard, and an authenticated provider turn/cancellation. Not implemented:
faithful Figma UI/v6 presence, image loading/opening-hours logic, virtualized/sortable tables,
durable history, or a full shared send/cancel/subscribe adapter. The local layout document is
composition-only; it does not replace the integration owner's portable wire schema.

## Independent integration rerun

The integration checkout verified archive SHA256
`66324c053a482fb768578402cd8b6c62bffaab42a64c32da772bfbf1c72ab350`,
then reran Rust 1.99.1 fmt, Clippy with warnings denied, all three tests and native
Linux build successfully. The first link needed the documented libxkbcommon-dev;
installing the documented Linux dependencies resolved it.

Six fresh GPU scenes (default, table, restaurant, empty, unknown renderer and the
actual shared snapshot) were inspected. A fresh headless scripted pointer/keyboard
clip completed table Apply → Restore → empty Apply → Restore and was inspected.
The table accessibility export exposes grid, row, column-header and grid-cell roles.
This is independent native-renderer/mock evidence, not a second X11/laptop or
authenticated-provider run. Software-rendered capture speed is not a laptop
performance benchmark. Root pnpm checks and all nine contract/core tests also pass.
