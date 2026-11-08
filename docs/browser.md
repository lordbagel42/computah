# Native agent-browser launcher

**Source implementation; local and deployed acceptance are separate.** Workers
can opt into `browser_read({url})`, backed by agent-browser **0.38.1**, native
Chromium and an explicit embedded agentOS host function. There is no backend
browser image, sidecar proxy service, global Pi environment override or default
agentOS startup. Missing browser configuration leaves existing tools unchanged.

## Supported route

`browser_read` invokes a fresh embedded `@rivet-dev/agentos-core` **0.4.7** VM's
generated `/bin/agentos-browser read --json …` command. That typed command invokes
the trusted host's `browser.read` callback. Only the host launches native
agent-browser and Chromium. The guest has an ephemeral virtual filesystem, no
network permission, an empty configured environment and permission to invoke only
`browser:read`. The host browser still has the VPS's ordinary network access.
The callback result—not guest-rewritten output—is returned to Pi. The VM and its
explicitly owned native agentOS sidecar are disposed before settlement.

This is **not** stock hosted agentOS guest ELF execution: that runtime reports
`ERR_NATIVE_BINARY_NOT_SUPPORTED` for native executables, and custom host functions
are an embedded-library feature, not a hosted actor configuration option. No
existing Worker changes execution provider or switches to `NodeExecutionEnv`.

## Configuration and authority

On a **native Linux VPS process**, provision immutable executable files and set
both absolute paths:

- `COMPUTAH_BROWSER_EXECUTABLE`: the agent-browser 0.38.1 native binary.
- `COMPUTAH_BROWSER_CHROMIUM`: the installed Chromium executable.

The trusted bootstrap separately needs an explicit `browser.read` principal grant
in `COMPUTAH_AUTH_JSON`. Paths alone grant nothing. Discovery is Worker-only;
Interaction continues delegating through Task. Execution checks the private Pi
binding, current capability and current source lineage before browser dispatch
and before result disclosure. No model parameter selects identity, session,
executable, browser flags or filesystem locations. Grants are startup-loaded in
the executable; restart is required to change its bootstrap policy.

The current containerized backend does not contain these tools and is not the
target browser host. Source publication does not install or activate the VPS
launcher. The sole deployment owner retains installation, activation, host state
and credential authority. No Docker socket, application state mount or runtime
package installer is supplied by this feature.

For an explicit local operator smoke invocation (not a public API), use the same
two path variables and run:

```sh
node --import tsx apps/server/src/browser-main.ts https://example.org/
```

That entrypoint binds a fixed local operator scope; possession of host shell is
its authority. It is not an authentication or tenant-provisioning endpoint.

## Input and result contract

The sole tool input is one HTTP(S) URL, at most 2048 characters, without URL
credentials or control characters. The fixed operations launch a new headless
browser, navigate, read body text/title/final URL and close. No login, signup,
forms, clicks, downloads, cookie/storage import, eval, plugin installation,
existing-profile discovery or CDP attachment is exposed. Results are **untrusted
page evidence**, not instructions or authority. A page load can run website
JavaScript and cause remote effects; this is not a semantic no-side-effects claim.

Ready results contain `provider: agent-browser`, `untrusted: true`, final `url`,
`title`, body `text`, `truncated` and `cleanup: closed`. Body text is capped at
12000 UTF-16 code units, title at 300 and transport JSON at 128 KiB. Oversize
transport responses fail rather than silently parsing a partial JSON object.
Unavailable results carry a fixed category (`denied`, `invalid_input`, `capacity`,
`runtime`, `timeout`, `cancelled`, `cleanup_unknown`), request state (`not_sent` or
`possibly_sent`) and cleanup state (`not_started`, `closed`, `unknown`). Raw errors,
provider stdout and protocol/CDP details never become tool results.

## Lifetime, cancellation and recovery

Each admitted read owns a random session, mode-0700 temporary HOME, profile,
socket directory, working directory and cache/config paths. Browser children
receive an explicit small environment, never the server's provider/operator
credentials, browser attachment variables or existing browser state. This is
credential-inheritance hygiene, **not OS-level filesystem/process isolation**.

The launcher checks exact agent-browser version and uses its source-reviewed
0.38.1 daemon protocol (`aff6125c023b810ea3f2e5deec5379e9a4270bdc`) to own the
foreground daemon instead of letting the CLI detach an unowned process. It exposes
no raw daemon protocol to guest/model code. Chromium receives a fresh owned
profile, never a host user's profile. At most two read operations are admitted
per configured client; the default native deadline is 20 seconds. Cancellation
aborts pending socket I/O and joins independent cleanup before Effect settlement.
Cleanup asks the owned daemon to close, then recovers only the uniquely owned
profile's Linux process group, joins daemon exit and removes temporary state.
Unconfirmed cleanup withholds content and returns `cleanup_unknown`.

There are no automatic retries. Native Pi replay is unsafe: an interrupted read
may already have contacted the website. No process, socket or browser session is
assumed to survive Pi sleep/replay or host death. Abrupt host-process death is not
equivalent to graceful cancellation; daemon idle shutdown is a backstop, not a
durable recovery guarantee. No browser session handles/cookies are checkpointed.

## Network limits and verification

**This launcher does not enforce public-only egress.** HTTP(S) URL validation is
input hygiene, not DNS/redirect/subresource/WebSocket/private-IP protection. Host
browser traffic can reach anything permitted by the VPS network, including local
and private services. The guest's network denial does not constrain its host
callback. Use only principals authorized for that native-host browsing boundary.
No isolation claim is made from browser flags or prompts.

The earlier disposable hardened-container probe denied both minimal user
namespace and combined user/mount/PID/network namespace creation with
`unshare: unshare failed: Operation not permitted` (exit 1), at UID1000, CapEff0,
NoNewPrivs1 and Seccomp2 with matched writable root. The rejecting layer remains
unknown. Raygen explicitly redirected this feature to a native VPS launcher; no
container security setting was weakened or alternate topology presumed exercised.

Local opt-in real-browser regression command:

```sh
COMPUTAH_TEST_AGENT_BROWSER=/absolute/agent-browser \
COMPUTAH_TEST_CHROMIUM=/absolute/chrome \
pnpm --filter @computah/server exec vitest run test/browser.test.ts
```

Without these test paths, clean-input/typed-failure, actual embedded agentOS and
native Rivet discovery/revocation tests still run; real Chromium fixture tests
are explicitly skipped, not passed. Local public-page/fixture reads, native
Task calls and intercepted sanitized Axiom exports do not establish installed
VPS revision, enabled collection or live Axiom ingestion. Those need independent
deployment-owner receipts before claiming live availability.
