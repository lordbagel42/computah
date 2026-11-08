# Dashboard verification receipt

## Publication readiness against current main

Rechecked against `49fda8502ad3a8c6d0c29f79e63e7d66677f2751` in an
isolated source checkout. The unchanged dashboard packet plus integration-owned
operator contract exports/schema fixtures and additive `operator.ts`/tests passed
`pnpm format`, `pnpm check`, `pnpm typecheck` and the full `pnpm test` suite.
The check preserved current main's bus contracts/tests and existing core files;
it did not replace them with the older contract packet. A frozen install passed
the lockfile supply-chain policy check. Dashboard runtime dependencies remain zero;
integration owns the nine-line development importer, with no dashboard-induced
resolved-package changes.

Source can publish independently of activation. At this baseline the missing
runtime seams are specifically:

- Core history resolution still uses `getOrCreate`. The operator needs a scoped,
  existing-only read returning a history page or `null`, not actor creation.
  Preserve current authorization and actor binding/token checks; recheck grants
  before reads and release. Existing actors may still wake/resume.
- Core capability/config validation does not include `operator.read`. Operator
  access requires that explicit standing grant **and** `history.read`, not a
  general maintenance grant or browser-selected identity.
- HTTP does not mount `GET /v1/operator/snapshot` or
  `GET /v1/operator/history`. Bind the additive projection to the authenticated
  principal's session/viewer, current bearer/grants, purpose-separated scoped
  cursor sealing/opening, mode and configured secret/privileged-URL redaction.
  Only one bounded opaque cursor is accepted; missing actors remain explicit.

Those core/config/HTTP files stay with their canonical owner. No fallback to raw
`/v1/history`, parallel registry, inspector tokens or fabricated evidence is
appropriate. The additive projection tests use synthetic callbacks; passing the
existing actual-actor suite does not verify these unwired operator routes.
Actor-backed gateway/browser checks, Docker validation and private TLS/access
activation remain separate; no host or access-policy changes were made.

## Implemented and locally checked

The source is a runnable Node gateway and browser evidence view. It consumes
integration-owned `OperatorSnapshot` and `OperatorHistoryPage` Effect-derived
types, not a parallel dashboard schema. No generated panels are introduced.

- `pnpm format`, `pnpm check`, `pnpm typecheck`, `pnpm test` passed in this orb
  after local adoption of the canonical operator/observation contract packet.
  This includes existing actual Rivet/Pi SQLite tests, but **not** new dashboard
  actor-projection runtime proof: canonical routes are separately owned.
- `node --test apps/dashboard/test/*.test.mjs` passed public HTTP boundary checks:
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

Canonical operator runtime routes, real current actor data through this dashboard,
private production deployment, owner acceptance and native click-through remain
separate integration/activation work. No raw history/SQL/engine inspector was used.
No real credentials or private histories are included in synthetic captures.

Docker CLI exists, but the orb has no Docker daemon (`/var/run/docker.sock`
absent), so the supplied unprivileged Dockerfile has not been built/run here.
The equivalent source gateway did run under the orb service supervisor.

The deployment owner must configure trusted operator grants, protected env-file
paths, deliberate gateway/core loopback-or-TLS networking, exact-origin TLS and
owner-only VPN/device policy. No production public/VPN listener was activated.
Eight-hour in-memory sessions deliberately reset on gateway replacement.
