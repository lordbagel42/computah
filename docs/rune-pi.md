# Computah native chat + local Pi

See [`experiments/rune-pi/README.md`](../experiments/rune-pi/README.md) for laptop setup,
the installed Mac app, real Pi chat, inline generated cards, whole-app layout editing,
local conversation history, auto-activated validated UI, Undo and independent Restore. One conversation,
not separate chat/UI modes. The default uses Pi; `--mock` is for developer validation.
Product, agent, app bundle and native window are named Computah. Legacy saved chats/layouts
are migrated compatibly without erasing the original file; see README for paths and precedence.
See its `VERIFICATION.md` for executed checks and remaining limits. This is not the
faithful Figma integration, Pi Durable, or the durable core server.

All generative UI now uses actual json-render/core0.22 catalog/Spec/SpecStream via a trusted
TS materializer into inert Rune builders: inline cards and whole-app layouts/themes, not
React/DOM or arbitrary code in UI data. The local owner Pi has scoped source editing plus
fixed verification/build/state-preserving relaunch for missing native capabilities. Source
execution is authorized owner-local development, not an OS sandbox or a remote card action.
The integration owner retains shared Effect/wire authority; product native/Slack adapters
use explicit projections of the durable core, not this experiment's local Pi brain.
