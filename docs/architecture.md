# Architecture and authority

## Ownership, not competing runtimes

Rivet hosts durable actors/storage/lifecycle. Pi Durable owns cognition, tools,
Task progress and native context compaction; original history remains canonical.
Effect owns typed domain services/schema, cancellation/resource lifetimes and
observability. No second workflow engine or custom transcript database is planned.
Each user's Interaction delegates to persistent Workers; transport does not create
a different identity. The [local core](core.md) implements private scoped gateway
calls and Task delegation on real Rivet/Pi storage. Public authentication and the
core-to-wire adapter are not implemented; a faux model verifies the runtime path.

Rune is the explicitly selected experimental frontend. The generic local-Pi
experiment is independent of the Rivet backend: a laptop subprocess bridge can
run Pi without embedding the distributed server. Figma integration is planned in
parallel, not a requirement to finish the experiment. No React replacement.

## Multiple users on economical shared infrastructure

Host-authenticated tenant/user/agent scope binds every actor, read, write,
subscription, task reopen, credential and execution environment. IDs are references,
not capabilities. Prompts, mail, component props and client-supplied identity cannot
widen authority. Owner administrative power is distinct from content-read grants.
Shared VPS/process/storage is not itself isolation. Tenant code must not gain native
host shell, shared-code writes or operator credentials by default. AgentOS-first
execution is the later deployment intent, with explicit privileged native shell and
E2B escape hatch—not three mandatory Phase 0 implementations.

History, compaction summaries, embeddings, recall caches, traces and debug evidence
inherit source audience/provenance. Authorize before retrieval/model input and again
on retry/dispatch. Revocation invalidates derived reads, not just search results.
No global user summary or post-filtered global recall. Two-user negative checks are
foundational. Real runtime enforcement is not provided by the mock contract alone.

Use opaque secret handles in domain data; resolve values only in the trusted host
under current authority. Never export raw credentials through fixtures, UI blocks,
events, logs or docs. No secret manager/provider is selected by this requirement.

## Self-improvement and shipping

Computah's owner agent has product standing authority to improve its own code and
commit/push verified increments directly to main without per-change human approval.
Tests, serialized integration, what/why commits and docs updates are quality controls,
not an invented approval gate. This policy is not a current instruction for Amp to
push research/implementation work. Push and live activation are distinct; deployment
mechanics, migrations and rollback compatibility must be separately defined.

Other users' agents escalate privileged meta actions to owner's Interaction, then
raygen. Requests carry exact action/resource/argument digest, requester, revisions,
expiry and minimal authorized/redacted evidence. Human decision/revocation/audit
must bind that exact request; tenant prose never becomes owner instructions.
Approval authority does not grant access to full private histories.

Later specialists remain separate: **Reflection** improves behavior/code/experience;
**Dreaming** enriches per-user evidence-linked memory. Inferences retain provenance,
confidence/freshness/corrections and source permissions; repeated dreams do not
create independent corroboration. Neither specialist is implemented or scheduled.

## Later deployment candidate

Alchemy v2 is an Effect-native deployment-reconciliation candidate, not a Phase 0
dependency or another agent replay runtime. Docker-over-SSH is the preferred later
deployment candidate, not a decision to use Swarm, proven Alchemy compatibility or
permission to provision. Git owns authored source, generators
own derived files, immutable artifacts own release code/config, deployment manages
only declared resources, and Rivet/Pi retain mutable data. Do not run production
from an editing checkout or assume old images can read newer Pi databases.
