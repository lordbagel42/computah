# Computah living self-spec

Read this index before changing Computah. Read the relevant linked page again
when the task crosses a subsystem boundary. It is intentionally small enough for
Interaction and Workers to discover on demand; it is not a giant system prompt.

## Golden-path milestones

The durable Task/Worker and stream/cancel/personality cut is published at
`4b89424`; the model-free bus is published at `1fa66e1` and separately deployed.
The owner now explicitly authorizes backend and Slack resumption with supported
Fast requests on every provider boundary, Terra Interaction and Sol execution.
Outgoing priority enforcement is distinct from the actual provider-returned tier:
do not silently select standard mode or claim a remote no-downgrade guarantee.
The earlier operational HOLD is superseded for this scoped tested rollout;
source authorization is not evidence that resumption has actually completed.
The next product exits, in order:

1. Deliver the [external message actor and Durable Streams API](bus.md):
   authenticated ingress, disabled-dispatch durable queue, public output replay,
   reconnect, idempotency, audience denial and restart proof. This is the sole
   immediate focus. Bus-only operation must not construct a provider runtime or
   wake existing Interaction checkpoints. Separate bus-only host activation is
   complete and remains isolated from the separately authorized agent resumption.
2. After the bus is delivered, resume tenant-scoped Composio/Gmail onboarding,
   verified mailbox, effectively
   full historical email indexing/private retrieval and continued updates, plus
   durable new email to its owner's Interaction agent, autonomous Task delegation
   and a visibly unsent local draft. The [Gmail runtime](gmail.md) now implements
   protected adoption, history reconciliation, resumable indexing, private native
   retrieval and source-generation fences. Host consumption and live new-email
   Task/draft acceptance remain unverified.
3. Join one product client to that same durable/email core and prove real send,
   delegated result, reconnect, cancellation and follow-up. Not delivered yet.

Gmail historical indexing is foundational memory, not optional later import.
Process it in resumable quota-aware batches with account-scoped storage/retrieval,
visible coverage/backlog and historical/live deduplication; a bounded recent import
or conversation history is not effectively-full-mailbox memory.
Then extend memory/Worker revival and resume Procedure and Cron acceptance. Slack
and Gmail work is limited to minimum bus compatibility until the bus is delivered;
unrelated expansion and backfill build are deferred, not discarded.
Source packets and passing local checks are not deployed product capabilities.

The global event bus is external ingress and egress around the whole agent.
Trusted tenant/account ingress reaches the audience-bound Interaction agent;
Interaction alone selects persistent Workers through Task. Providers and adapters
do not select Workers. Internal agent communication is a separate concern.
The [external message actor contract](events.md) uses the official file-backed
Durable Streams reference server for API-client replay: the pinned native Rivet
route is unavailable. Current snapshot SSE is not that durable stream transport.
Durable history and native compaction are implemented foundations. Gmail indexing,
retrieval and private preload are source-supported with separate live acceptance;
memory-driven Worker revival, Reflection and Dreaming remain planned. Source-enabled
cores decline compaction until its retry boundary can enforce current source grants.

## Current status

- **Implemented locally:** workspace scaffolding; renderer-neutral Effect Schema
  wire model, deterministic in-memory mock, synthetic JSON fixtures and tests;
  tenant-scoped Rivet/Pi core with native durable Task delegation and compaction;
  runnable authenticated REST ingress with safe text projection and persistent
  official legacy Codex authentication support.
- **Slack prototype implemented:** [Socket Mode adapter](slack.md) with durable
  inbox-before-ACK, trusted existing core identity, private replies and explicit
  uncertain-send handling. Local synthetic checks are not a live Slack install
  or roundtrip. Dedicated app installation and private authorization are complete;
  runtime activation and a real message roundtrip remain separate.
- **Agent-selected Slack routing implemented in source:** finite host-offered
  destinations with durable choice and private/shared audience checks; no core
  identity switch or arbitrary destination IDs. Live acceptance remains separate.
- **Opt-in multi-user Slack implemented in source:** [identity/security](slack-multiuser.md)
  derives per-person/private-or-channel actors from authenticated Slack metadata,
  fixed low-risk grants, explicit channel facts, owner proposals and private
  declarative plugins. Newly seen users enroll wherever Slack delivers mentions
  or DMs, without per-channel selection or human test-participant gates. Installed
  grants and protected runtime adoption remain pending; this is not anonymous
  Internet publication.
- **Durable DEBUGSHARE implemented in source:** the authenticated Slack adapter
  commits an opaque issue-ID-to-origin mapping before ACK, captures bounded actual issue
  context and retries an optional authenticated tracker upload without model/core
  submission or repair. Hosted lookup and runtime activation require separate
  acceptance. New reports use `computah_bug_` plus 24 random lowercase alphanumeric
  characters; existing UUID reports remain readable without migration. Older
  identifier-only UUIDs have no retained diagnostic mapping.
  See [Slack command semantics](slack.md).
- **Imported reference material:** faithful [Figma-to-Rune plan](../ui/IMPORT-PLAN.md),
  recovered standalone Canvas study and source reference images. These are not an
  implemented native app or finished Figma port.
- **Imported experiment:** generic [native Rune frontend](rune-pi.md), with local
  Pi coding-agent subprocess mode, deterministic mock, inert layout registry and
  independent blank-layout recovery. This is not Pi Durable or the Figma port.
- **Native product UI implemented locally:** [Rune client](../apps/native/README.md)
  for the existing durable core, with json-render native cards/composition,
  persisted drafts/layouts and independent blank-app recovery. Linux synthetic
  render/input and REST-fixture checks are not a real authenticated client exchange
  or Mac/platform runtime acceptance. This is separate from the local-Pi experiment.
- **Unimplemented seam:** full streaming core-to-wire AgentAdapter;
  raw Pi histories are not the renderer-neutral protocol.
- **Dashboard source implemented locally:** [read-only operator UI/BFF](../apps/dashboard/README.md)
  and bounded canonical projection module pass synthetic checks. Existing-only
  actor lookup, current operator grants, HTTP wiring and real-stack browser
  evidence remain pending; no dashboard service is deployed.
- **Live-verified on nest-bagel:** protected real-mode legacy Codex HTTP requests
  and follow-up; private actor-history inspection confirmed three actual Task
  calls and three primary Worker request/reply pairs without publishing entries.
  Also verified rejected missing/forged tokens, idempotency/conflict handling,
  and Docker restart retaining exact public history and the old signed handle.
  GitHub Actions now owns delivery through the scoped Docker/Alchemy updater;
  the reconciliation timer is disabled after verified hosted handover and a
  follow-on Actions-only rollout. See [operations](operations.md) for receipts.
  Earlier timer rollout and post-rollout real history preservation also passed.
  No public ingress is provisioned.
- **Planned:** client-facing integration onboarding, deployed Gmail acceptance,
  live Slack setup, adaptive recall/Dreaming,
  selected json-render native migration, Reflection, deeper DEBUGSHARE actor/trace
  correlation and repair, and future Amp/Space handoff.
- **Not claimed:** live integration-account onboarding, tested imported laptop
  build, production tenant isolation, exactly-once effects, forced OAuth refresh,
  backup restore or automatic runtime doc loading.

## Read by responsibility

- [Wire contract and fixtures](contracts.md): version 1, mock/live seam, state and
  replay rules, renderer-neutral generated JSON Schema.
- [Durable core](core.md): private scoped gateway, Task/Worker lifecycle, native
  compaction, tested recovery and transport limitations.
- [Sentinel Specialist](sentinel.md): explicit host-selected Task preflight or
  asynchronous monitoring, durable verdict/fence and native cancellation; not
  downstream effect-dispatch protection or a blanket owner bypass.
- [Native Rune experiment](rune-pi.md): source-build setup, local Pi/mock modes,
  layout customization, portable snapshot fallback and recovery.
- [Native product client](../apps/native/README.md): durable-core REST boundary,
  json-render registry, versioned composition, local owner tools and platform limits.
- [Architecture and authority](architecture.md): owners, tenancy, runtime intent,
  secret handles and owner self-shipping versus other-user escalation.
- [Development and recovery](development.md): commands, packet ownership,
  main-only integration and evidence requirements.
- [nest-bagel operations](operations.md): persistent storage, private credentials,
  serialized Alchemy delivery, readiness receipts and recovery limitations.
- [Axiom observability](observability.md): full emitted trace export, privacy relay,
  credential/provisioning boundaries and actual ingestion/activation evidence.
- [Public trace observatory](public-observatory.md): independent content-free
  public projection, bounded live polling, hosting and activation evidence.
- [Slack prototype](slack.md): dedicated app setup, private identity mapping,
  durable inbox, DM routing, delivery uncertainty and local/live verification.
- [Native tools and credential boundaries](tools.md): first-class browser/search,
  Gmail/Executor, runtime secret references and later provider decisions.
- [Tavily integration and tools inventory](tavily.md): native bounded web evidence,
  explicit principal grants, current-versus-reusable source and verification limits.
- [Executor catalog](executor.md): native Worker skills/search/describe, private
  organization PAT provisioning and explicit grants; no app execution.
- [Native browser launcher](browser.md): opt-in embedded agentOS host function,
  fresh agent-browser/Chromium sessions, native VPS execution and network limits.
- [Gmail runtime and source authority](gmail.md): protected account setup, GET-only
  history reconciliation, private retrieval, native grant fences and acceptance limits.
- [Local delayed-email Procedure](procedures.md): durable versioned holds, edit/cancel
  and exact local eligibility; always UNSENT, without external-send enforcement.

The detailed [research plan](https://ampcode.com/artifacts/computah-architecture-and-phased-implementation-plan-cc4c2e58-8a38-4977-9a06-c1c55aadbc13)
is design context, not proof those features exist.

## Documentation contract

Update applicable docs and fixtures with code/contracts. Label implemented,
source-supported, enabled, locally verified and live-verified separately. Agent
tool/extension APIs must document inputs, results, authority, retry/cancel behavior
and recovery. Documentation describes capabilities but cannot grant them.
No secrets or private user histories belong in this public self-spec.
