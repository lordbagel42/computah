# Dashboard verification receipt

## Runtime integration

The previously unwired core/config/HTTP seams are now implemented: scoped
`operatorHistory` uses existing-only Rivet `.get`, `operator.read` is an explicit
configured capability, and the two authenticated operator GET routes bind the
canonical projection to the current principal. Core and HTTP recheck both grants
before release; revoked/replaced bearer bindings cannot release an in-flight read.
Known configured secrets/privileged URL prefixes and engine token/endpoint are
redacted. There is no raw-history fallback, second registry or creating lookup.

The actual Rivet/Pi HTTP regression test covers repeated missing reads, foreign
actor denial, Task/Worker joins, final text and known-secret/URL redaction,
correct Worker pagination, foreign/purpose-confused cursors, missing grants,
standing-grant revocation and bearer removal during an actual actor read.
Oracle inspected the installed Rivet3.0.6 lookup and Effect4.1.2 error semantics
and found no source-supported authorization/no-create blocker.

An isolated local registry with the explicit deterministic smoke provider admitted
two requests through the real submit/poll HTTP path. The operator HTTP → actual
BFF → Chromium path displayed four Interaction messages, two recorded Task calls
and one reused persistent Worker with four messages. This is **actor-backed**,
not fixture-fed UI, but still **faux-model**, not live-provider production proof.
Keyboard selection/focus, refresh, narrow ordering/overflow and sign-out clearing
were exercised. The fixed chrome was not redesigned.

The BFF uses the shared observability bootstrap and fixed core tracing path,
not a custom exporter. Host launch defaults to loopback and supports owner SSH
forwarding; Docker explicitly uses an isolated container wildcard listener with
the pinned workspace dependencies. Deployment/consumed-revision and remote trace
and log-query receipts must be recorded separately, not inferred from local tests.

## Implemented and locally checked

The source is a runnable Node gateway and browser evidence view. It consumes
integration-owned `OperatorSnapshot` and `OperatorHistoryPage` Effect-derived
types, not a parallel dashboard schema. No generated panels are introduced.

- Initial source-only `pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test`
  passed after adopting the canonical contract packet. Those earlier checks did
  not establish runtime wiring; the actor-backed checks above are separate.
- `node --import tsx --test apps/dashboard/test/*.test.mjs` passed public HTTP boundary checks:
  unauthenticated/cross-origin denial, hashed opaque cookie login, only fixed
  GET routes with bounded cursor, no token in static/login responses, logout
  invalidation, HTTPS/host-cookie policy and safe upstream failure responses.
- Scratch Chromium/Playwright checks passed actual gateway login, Task selection
  through keyboard with retained focus, Worker/Interaction pagination, empty
  page, missing Worker, narrow overflow, immediate private DOM clearing on logout,
  old delayed 401 after new login and initial core502 recovery controls.
  Page errors: none. These use explicitly labeled synthetic upstream projections.
- lintapple0.1.20 checked signed-out, selected Worker, missing Worker, narrow
  viewport, initial core error and empty page. After fixing 12px button metadata
  against the fixed 14px control policy, the only remaining finding in each was
  `root-background`: it calls explicit `rgb(0, 0, 0)` transparent because its alpha
  regex also matches the blue-zero channel. The root explicitly sets #000;
  this is disclosed, not suppressed or described as an all-green report.
- Impeccable's scoped mechanical detector returned `[]`.
- Desktop1440×1000 and narrow390×844 Chromium screenshots at DPR2 were inspected.
  Narrow capture is browser responsiveness, not a physical phone/native proof.
- Source review resolved HTTPS core transport, stale401/new-session recovery,
  initial-core-error controls and immediate logout clearing. Its narrow-order
  finding was fixed by keeping conversation before execution in both layout and
  keyboard order. The inspected pointer clip is supplemental synthetic selection
  evidence; its large cursor obscures some frames, so screenshots and executed
  assertions carry the state details.

## Not established by these checks

Live-provider production actor data through this dashboard, private production
deployment, owner acceptance and native click-through remain separate activation
receipts. No raw history/SQL/engine inspector was used.
No real credentials or private histories are included in synthetic captures.

Docker CLI exists, but the orb has no Docker daemon (`/var/run/docker.sock`
absent), so the supplied unprivileged Dockerfile has not been built/run here.
The equivalent source gateway did run under the orb service supervisor.

The deployment owner must configure trusted operator grants, protected env-file
paths and deliberate gateway/core loopback-or-TLS networking. Owner-authenticated
SSH local forwarding to a loopback-only BFF is supported; non-loopback access still
requires exact-origin TLS and verified owner-only VPN/device policy. No public/VPN
listener is authorized by these checks.
Eight-hour in-memory sessions deliberately reset on gateway replacement.
