# Computah operator dashboard

Read-only web companion to the native Computah app, not its replacement and not
the privileged Rivet inspector. Fixed chrome displays a trusted, single-scope
Interaction → recorded Task calls → persistent Worker projection. It runs no
model, registry, actor database, SQL inspector or general-purpose proxy.

## Run and integration

Node >=22.19 with the frozen workspace install; no browser build. The shared
`@computah/observability` package and existing `tsx` loader provide the canonical
content-free telemetry path, not another exporter. From the workspace run
`pnpm --filter @computah/dashboard start`, or
`node --import tsx apps/dashboard/src/main.mjs` from the repository root.
The gateway listens on loopback by default, `PORT` 8790; `/healthz` reports only
gateway readiness, not core/model readiness.
Use `apps/dashboard/Dockerfile` with the repository root as its build context.
It runs as the unprivileged Node user and needs no data volume. A read-only root
filesystem is suitable. SIGTERM closes HTTP connections and drains telemetry.
The Docker build installs the pinned workspace dependencies, like the core image;
it is not a standalone copy of two dependency-free folders.

Supply secrets using deployment-owned protected env files, not command arguments,
checked-in files, URLs, browser localStorage or Alchemy plaintext state:

| Environment                     | Meaning                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPUTAH_DASHBOARD_ORIGIN`     | Exact public HTTPS origin, no path, credentials or query. TLS terminator must preserve this Host. No forwarded headers are trusted.    |
| `COMPUTAH_DASHBOARD_CORE_URL`   | Fixed core origin, HTTPS except loopback HTTP. Container localhost is not the host or another container.                               |
| `COMPUTAH_DASHBOARD_CORE_TOKEN` | Server-only, separately provisioned token with explicit operator/history read authority for one trusted product scope.                 |
| `COMPUTAH_DASHBOARD_PASSWORD`   | Separate operator login secret, at least 32 characters, never the core bearer.                                                         |
| `COMPUTAH_DASHBOARD_HOST`       | Listener `127.0.0.1` (default), `::1`, or explicit `0.0.0.0` inside an isolated container. Never use a wildcard host-network listener. |
| `PORT`                          | Gateway listener port.                                                                                                                 |

HTTP browser origins are accepted **only** for localhost/127.0.0.1/[::1]. This also
supports owner-authenticated SSH local forwarding to a host-loopback BFF: use the
exact browser origin `http://127.0.0.1:8790` at both ends and keep the remote port
loopback-only. That access path uses SSH encryption/authorization, not public HTTP.
A private wt0/VPN address does not get an HTTP exception. Any non-loopback browser
access needs TLS and verified owner-only network policy; forwarding means a
private bind alone is insufficient. The deployment owner controls host/Alchemy,
network design and activation. Never publish the engine or start a second core.

The BFF forwards only `GET /v1/operator/snapshot?cursor=...` and
`GET /v1/operator/history?cursor=...`; cursor is bounded/opaque and authorization
belongs to the canonical core. Browser requests use `/api/snapshot` and
`/api/history`. It cannot submit, cancel, compact, sleep, select arbitrary actors,
switch tenants or access engine/provider/admin APIs. Core HTTP grants are
token-specific; `core.maintain` is not cross-user history or operator authority.
The configured principal needs **both** `operator.read` and `history.read` in core
standing grants and the authenticated binding. Existing owner credentials may be
held server-side; do not rotate them or add a duplicate scope binding just for
this BFF. The browser gets only the distinct dashboard session credential.
Core `operatorHistory` uses Rivet's existing-only `.get`, never `getOrCreate`.
Core and HTTP recheck grants/current bearer before releasing each bounded result;
continuations are scope- and purpose-bound, not arbitrary actor selectors.

Configure known privileged browser/provider URL prefixes as a protected JSON array
in `COMPUTAH_OPERATOR_PRIVILEGED_URL_PREFIXES` on the core. Configured bootstrap
bearers, connection/provider/search/ingest credentials and native engine token and
endpoint are redacted by the core projection. This is known-value redaction, not
arbitrary-secret DLP. Shared telemetry records fixed operation names/status/duration
and trace correlation only: no histories, URLs, cursors, principal/actor IDs or
credentials. The BFF sends trace correlation only to its fixed configured core.

`POST /session` exchanges the operator password for a random, hashed-server-side,
HttpOnly SameSite=Strict cookie. Production uses Secure and `__Host-` prefix.
Sessions expire after eight hours and are lost on gateway replacement/restart.
POST origin and public Host must match the configured origin; login attempts and
session count are bounded. `POST /logout` revokes the current session. Private
text is cleared immediately on sign-out; old asynchronous responses cannot
restore it or sign out a newer session. CSP rejects embedding/scripts from other
origins. No cookies, input, core responses or upstream errors are logged.

## Evidence, not a simulated admin console

The canonical Effect projection owns the wire contract. Rows expose scoped
resource IDs, availability, recorded Task identity/entry/label/result evidence,
projected user/final-assistant text and signed pagination, not raw Pi records,
reasoning, model instructions, tool arguments or tool output. Content is untrusted
plain text (`textContent`), never HTML, executable generated actions or automatic
links. The projection is not a guarantee that model/user-authored text contains
no sensitive information; treat all evidence as private operator data.

Task `recorded` / `result-recorded` is transcript evidence, not current running,
sleeping, healthy, completed or exactly-once external-effect status. Missing
actors, absent projected text, page boundaries and unavailable core remain
explicit. Existing-actor reads may wake/resume work; read-only means no exposed
inspector mutation controls, **not zero runtime writes**. Pages are independently
observed, not an atomic multi-actor snapshot or streaming journal. Refresh
returns to the first Interaction page; next-page controls replace the current
page rather than implying a complete accumulated transcript.

Native integration is a seam, not a fabricated deep link: the native app can
open the configured dashboard under an operator session and pass an opaque
public Message ID as the `#message-<encodeURIComponent(messageId)>` fragment.
It anchors a message only when present in the displayed scope/page. It grants no
identity/access and is not a history-to-submission/Worker join. No native URI
scheme or automatic native click target was added. Fixed chrome needs no
generative schema; any later generated panels must reuse the integration-owned
json-render semantic catalog, including inert unknown-component fallback.

## Verification state

See `VERIFICATION.md`. Synthetic UI checks are not live core evidence. Private
production deployment and owner acceptance require the deployment owner's gate;
the existence of this source/image does not establish either.
