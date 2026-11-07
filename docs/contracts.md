# Wire contract v1

Source of truth: `packages/contracts/src/index.ts` (Effect 4.1.2 Schema).
`@computah/contracts` imports no Rivet, Pi, Node APIs or server runtime. Rune may
consume generated JSON Schema in `packages/contracts/fixtures/v1/schema`; it does
not need to embed JavaScript or Effect. Version 1 is experimental and not deployed.

## Adapter

`AgentAdapter` is bound by a trusted host, not a browser-supplied viewer:

| Method                                                     | Result                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `viewer()`                                                 | Safe display identity and available capabilities; not credentials    |
| `snapshot(conversationId)`                                 | Ordered messages, submissions, connection summaries, revision/cursor |
| `send({conversationId, clientMutationId, text})`           | Submission admission/current deduplicated outcome                    |
| `cancel({conversationId, submissionId, clientMutationId})` | requested/cancelled/too-late/unknown                                 |
| `subscribe({conversationId, cursor}, signal?)`             | Async stream; abort or iterator return closes idle reads             |

Transport and authenticated session establishment are adapter responsibilities,
not established by this package. Reusing a send mutation ID with identical input
returns the same submission; different input conflicts. No API parameter grants
tenant authority. Live adapters validate unknown inputs and recheck current access.

Outcomes: accepted, streaming, completed, failed, cancelled, unknown. Unknown is
not failure and must not trigger blind retry. Cancellation requested is not
confirmed. Offline drafts are unsent. Model completion is not email delivery.

Events use stable IDs and monotonic conversation revisions with opaque cursors.
This minimal revision uses **full message/block replacement, not text deltas**:
it costs some bandwidth but removes fragment-order ambiguity. Replay duplicates
at/below snapshot revision are ignored. Gaps/expired cursors require a new atomic
snapshot/cursor. Do not resurrect terminal submissions or accept assistant output
after termination. A message's nullable submission ID binds turn output; unsolicited
system content may be unbound. `applyEvent` is the reference client reducer, not
an authorization boundary. Clear all private state/subscriptions on tenant switch.

Components are inert key/version/JSON props/fallback blocks, never evaluated code.
Unknown versions render readable fallback. Registry actions require separate host
authorization. Connection states are placeholders only: disconnected, connecting,
connected, expired, error, unknown; no OAuth secrets or auth URLs are exposed.
Account/browser-session handle schemas reserve nonidentifying references/status
only; their lifecycle services and secret custody are [planned, not enabled](tools.md).

## Fixtures and mock

`createMockSession(viewer)` from `@computah/contracts/mock` binds a cloned synthetic
viewer and returns `{adapter, conversationId, advance}`. `advance(submissionId,
outcome, text?)` is an explicit deterministic scheduler: no timers/providers.
Fixed fixture clock is 2026-01-01T12:00:00Z, timezone UTC. Mock cursors are test
implementation details; live clients must keep cursors opaque. The mock is
in-memory only and is **not** real authentication or crash durability.

`fixtures/v1/conversation.json` is a portable unknown-component fallback plus
send/replay example. Broader table, schedule, signed-out, layout recovery and
connection-state visual fixtures belong to later UI packets; do not pretend they
are implemented. Tests cover mutation dedup/conflicts, two-user access denial,
replay/resync, cancellation/unknown, terminal output and JSON validation.

Regenerate JSON Schema with `pnpm --filter @computah/contracts schema` after
editing the source. Commit the generated files with the source change. Breaking
changes require a wire/fixture version change and agreement with both adapters;
do not hand-maintain parallel Rust and TypeScript authority definitions.
`pnpm check` detects stale generated schemas without rewriting them.
