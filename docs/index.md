# Computah living self-spec

Read this index before changing Computah. Read the relevant linked page again
when the task crosses a subsystem boundary. It is intentionally small enough for
Interaction and Workers to discover on demand; it is not a giant system prompt.

## Current status

- **Implemented locally:** workspace scaffolding; renderer-neutral Effect Schema
  wire model, deterministic in-memory mock, synthetic JSON fixtures and tests;
  tenant-scoped Rivet/Pi core with native durable Task delegation and compaction;
  runnable authenticated REST ingress with safe text projection and persistent
  official legacy Codex authentication support.
- **Imported reference material:** faithful [Figma-to-Rune plan](../ui/IMPORT-PLAN.md),
  recovered standalone Canvas study and source reference images. These are not an
  implemented native app or finished Figma port.
- **Imported experiment:** generic [native Rune frontend](rune-pi.md), with local
  Pi coding-agent subprocess mode, deterministic mock, inert layout registry and
  independent blank-layout recovery. This is not Pi Durable or the Figma port.
- **Unimplemented seam:** full streaming core-to-wire AgentAdapter;
  raw Pi histories are not the renderer-neutral protocol.
- **Live-verified on nest-bagel:** protected real-mode legacy Codex HTTP requests
  and follow-up; private actor-history inspection confirmed three actual Task
  calls and three primary Worker request/reply pairs without publishing entries.
  Also verified rejected missing/forged tokens, idempotency/conflict handling,
  and Docker restart retaining exact public history and the old signed handle.
  The scoped Docker/Alchemy reconciler is enabled; see [operations](operations.md)
  for the observed revision/image. Subsequent automatic main rollout is not yet
  verified. No public ingress is provisioned.
- **Planned:** Composio/Gmail onboarding, Slack, adaptive recall/Dreaming,
  selected json-render native migration, Reflection and DEBUGSHARE/repair.
- **Not claimed:** live integration-account onboarding, tested imported laptop
  build, production tenant isolation, exactly-once effects, forced OAuth refresh,
  backup restore or automatic runtime doc loading.

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
- [nest-bagel operations](operations.md): persistent storage, private credentials,
  serialized Alchemy delivery, readiness receipts and recovery limitations.
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
