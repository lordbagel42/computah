# Native verification receipt

Original implementation base: `eb70afe9c4126fb54583d5a4c83e7d013b915bf9`.
Shipping readiness base: `49fda8502ad3a8c6d0c29f79e63e7d66677f2751`, fetched
origin/HEAD and rebased local main without conflicts. apps/native is still entirely
new and disjoint at this base. The authenticated viewer/send/result/history/cancel
routes consumed here remain compatible. Current core also adds submission-observation
SSE and additive public schemas: this client does not consume that route. Documentation
was corrected rather than implying SSE is absent from current core. No shared root,
contracts, server or experiment source is part of this packet. Canonical dependency
reconciliation and publication were initially delegated. The newer standing Ship
authorization supersedes that restriction: this owned native cut now ships directly
to main, with its exact dependency importer and lock entries. No host activation or
production/platform acceptance is inferred from source publication.

## Executed in the Linux E2B orb

- Shipping-base owned checks rerun at `49fda85`: scoped Biome format/check,
  actual-library Node tests, Cargo fmt/Clippy/tests/build all pass. No test failure
  was ignored. Direct source shipping also requires the current-main full workspace
  suite after dependency reconciliation; publication evidence is reported in the thread.
- Original-base root `pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test`: pass. Includes
  existing durable core's faux-model real Rivet/Pi SQLite/HTTP tests; not a live
  production model request from this frontend.
- `node --test scripts/*.test.mjs`: pass. Actual json-render/core API, SpecStream
  chunk boundaries, resolved state/visibility, action rejection, malformed specs,
  blank/card distinctions, Divider, limits and metadata retention.
- The REST fixture exercises exact body keys, bearer header, signed-handle
  encoding, opaque multi-page history, ambiguous accepted response recovery,
  restart with the same mutation ID, and truthful cancellation outcomes. It also
  forces the first outbox save to fail: no admission occurs; retry checkpoints the
  **same** ID before POST. Escaped over-budget text is rejected before an outbox
  entry is created. Terminal reconciliation includes the initiating user prompt.
- `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`,
  `cargo test --locked`, `cargo build --locked`: pass. Rune Runtime input tests
  verify automatic delete-all, independent Undo/Restore preserving conversation,
  narrow Panels/Chat, inline grid roles, unknown component fallback and atomic
  rejection. Existing valid checkpoint + failed newer save retains the newer
  in-memory draft and prevents successful checkpoint acknowledgement.
- Fixed owner `build` completed. Exact-base source roundtrip succeeded; stale base
  and path traversal rejected. Candidate hash + valid checkpoint preflight passed;
  corrupted checkpoint rejected. **Actual graphical process relaunch was not tested.**

## Rendered and inspected

Rune native headless renderer on Vulkan/Mesa, no DOM/React: desktop 1440×960,
narrow 390×844, inline table 1100×780, narrow restaurant, narrow Panels, intentional
Empty and interrupted-request states at 2× scale. The first interrupted-state
capture clipped status; the final layout puts status below recovery controls and
was re-rendered and inspected without clipping. Table accessibility tree includes
grid/row/columnheader/gridcell, with 3 column headers and 9 cells in the fixture.
Native input has a Message Computah label and focus rings; action/recovery controls
are focusable. This is semantic evidence, not screen-reader acceptance.

The 7-second H.264 recording executes native pointer/key events: moves across
neighboring recovery controls, types a comparison, clicks Send, receives inline
table, types delete-all and presses Enter, then Undo and Restore preserve history.
The recording was inspected (direct local-video fetch failed; uploaded-media
analysis and extracted frames both confirmed the sequence). Video is a deterministic
native demo fixture, not network/model latency evidence. Forced headless capture
ran below realtime on the orb; no smooth physical-device performance claim.

## Remaining gates and intentional limits

- This native product checkout is **not Mac-tested**, signed, packaged or installed.
  Mac study evidence is provenance for APIs, not validation of this product binary.
  A narrow Linux render is not an iOS/Android build or physical touch/keyboard test.
- No authorized production endpoint/auth route is provisioned here. The adapter
  fixture is checked against current server source, not a live nest-bagel exchange.
- Generated replacement delivery and trusted source-tool registration in the durable
  core remain future seams. Native polling does not claim the core's new observation
  SSE or shared snapshot/live revision/replay semantics.
  The explicit local owner CLI is not a production agent tool or an OS sandbox.
- Owner relaunch has checkpoint/hash preflight but no candidate GUI-ready handshake
  or installed-bundle rollback. Run **one process per state/outbox path**; this product
  does not yet port the Mac experiment's lifetime single-instance lock.
- Screen readers/OS accessibility bridge, IME/preedit, CJK and emoji composition,
  selection/clipboard, OS text scaling, high contrast, reduced motion and real
  touch/soft-keyboard behavior need platform acceptance. Native table sorting is
  lexical, not numeric/date-aware. v6 presence animation is deliberately unported.
- lintapple was not run: this is a native Rune surface, not a Chromium DOM. Native
  accessibility tree/input checks and inspected native captures were used instead.

Dependency request to integrator: exact `@json-render/core` 0.22.0 and `zod` 4.6.7.
Root lockfile entries are deliberately excluded for canonical reconciliation.
No secrets, production histories, binary/target output or runtime state are included.
