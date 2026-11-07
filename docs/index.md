# Computah living self-spec

Read this index before changing Computah. Read the relevant linked page again
when the task crosses a subsystem boundary. It is intentionally small enough for
Interaction and Workers to discover on demand; it is not a giant system prompt.

## Current status

- **Implemented locally:** workspace scaffolding; renderer-neutral Effect Schema
  wire model, deterministic in-memory mock, synthetic JSON fixtures and tests;
  tenant-scoped Rivet/Pi core with native durable Task delegation and compaction.
- **Imported reference material:** faithful [Figma-to-Rune plan](../ui/IMPORT-PLAN.md),
  recovered standalone Canvas study and source reference images. These are not an
  implemented native app or finished Figma port.
- **Imported experiment:** generic [native Rune frontend](rune-pi.md), with local
  Pi coding-agent subprocess mode, deterministic mock, inert layout registry and
  independent blank-layout recovery. This is not Pi Durable or the Figma port.
- **Unimplemented seam:** authenticated transport and core-to-wire AgentAdapter;
  raw Pi histories are not the renderer-neutral protocol.
- **Planned:** Composio/Gmail onboarding, Slack, adaptive recall/Dreaming,
  configurable generative UI, Reflection, DEBUGSHARE/repair and deployment.
- **Not claimed:** deployed service, live account connection, tested laptop build,
  production tenant isolation, exactly-once effects or automatic runtime doc loading.

## Read by responsibility

- [Wire contract and fixtures](contracts.md): version 1, mock/live seam, state and
  replay rules, renderer-neutral generated JSON Schema.
- [Durable core](core.md): private scoped gateway, Task/Worker lifecycle, native
  compaction, tested recovery and transport limitations.
- [Native Rune experiment](rune-pi.md): source-build setup, local Pi/mock modes,
  layout customization, portable snapshot fallback and recovery.
- [Architecture and authority](architecture.md): owners, tenancy, runtime intent,
  secret handles and owner self-shipping versus other-user escalation.
- [Development and recovery](development.md): commands, packet ownership,
  main-only integration and evidence requirements.
- [Native tools and credential boundaries](tools.md): first-class browser/search,
  Gmail/Executor, runtime secret references and later provider decisions.

The detailed [research plan](https://ampcode.com/artifacts/computah-architecture-and-phased-implementation-plan-cc4c2e58-8a38-4977-9a06-c1c55aadbc13)
is design context, not proof those features exist.

## Documentation contract

Update applicable docs and fixtures with code/contracts. Label implemented,
source-supported, enabled, locally verified and live-verified separately. Agent
tool/extension APIs must document inputs, results, authority, retry/cancel behavior
and recovery. Documentation describes capabilities but cannot grant them.
No secrets or private user histories belong in this public self-spec.
