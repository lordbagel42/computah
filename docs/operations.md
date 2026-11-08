# nest-bagel operations

The authorized target is the existing nest-bagel Debian container. Docker 26.1.5
runs without Swarm. Alchemy and `@alchemy.run/docker` are pinned to
2.0.0-beta.85 with Effect/platform-node 4.1.2 in an independent `deploy` workspace.
The supported `Docker.Container` provider manages only `computah-backend`.
Because deployment runs on this host, it uses the local socket, not an SSH hop
back to itself. A remote Docker context is not configured.

## Release ownership

GitHub Actions is the normal delivery owner: the main-only `Deploy / nest-bagel`
job requests its exact commit through pinned SSH and validates the returned
healthy receipt. Hosted Actions does not run on a self-hosted runner. The previous
`computah-reconcile.timer` is disabled and inactive after verified handover.

The independently installed root-owned updater takes
`/run/lock/computah-deploy.lock`, archives the trusted full commit into an immutable
release directory, builds a Docker image once and applies that exact image ID
using real Alchemy plan/apply. It never runs PR code. Trusted main is privileged
deployment code; repository write access is deployment authority. The no-argument
pull-based updater remains available for explicitly authorized recovery, not a
second normal delivery owner. The selected gateway's root authority is documented
below; dedicated credentials do not make it a restricted deployment account.

The updater itself is installed separately and does not self-replace from main.
To update it, review the diff and explicitly install the new script/unit. The
Alchemy stack in each trusted release controls its declared application resource.
No other services, volumes or host infrastructure are adopted. Container
replacement stops the old process before the new one starts; brief downtime is
expected. There is no automatic old-image rollback across Pi storage migrations.

## Low-interruption deployment boundary

The supported path is **prepare while serving → isolated candidate preflight →
stop/drain the old writer → start the new writer → exact-revision readiness**.
It is not blue-green or a zero-downtime guarantee. Alchemy's official
[Docker lifecycle documentation](https://alchemy.run/docker/local-services/)
and the pinned 2.0.0-beta.85 provider both specify delete-first replacement.
The [Pi Durable storage contract](https://unpkg.com/@earendil-works/pi-durable@1.5.0/README.md)
requires one owning process per store; SQLite WAL is not a distributed writer
lease. Never run two native engines against `/var/lib/computah/data`, mount a
live copy as a candidate, or split auth/checkpoints from the actor store.

Image build and deploy dependency installation already happen while the old
backend serves. Each release's `apply.ts` now runs that exact immutable image in
a disposable `--network none` container with no host ports, no real env files,
no production mounts and a fresh UID 1000 disk-backed HOME under the unique
`/var/lib/computah/preflight-*` path. It checks actual native startup,
authenticated faux submission → completed result, then clean
SIGTERM exit, before invoking Alchemy. A 120-second outer deadline removes only
that uniquely named candidate on timeout; its disposable HOME is removed only
after container removal/confirmed absence. If Docker cannot confirm cleanup,
retain that isolated HOME for operator recovery, never delete live storage.
The managed engine validates 4 GiB of free filesystem capacity for its configured
log shard even when the smoke records are tiny. Small tmpfs mounts fail
that validation; do not reserve gigabytes of RAM on the small host or change
production engine storage sizing to make a candidate test pass.
A failed preflight leaves the old
backend serving; it does not relax the conservative activation high-water mark
already advanced by the installed updater. This is artifact validation, **not**
a production-storage migration rehearsal, provider authentication check or proof
of real-model generation. Budget extra candidate memory (limit 768 MiB) while
the old backend remains running; the host must have that headroom.

The new HTTP process listens only after native registry startup. Readiness now
includes `revision`, and apply requires `ready:true`, `mode:"real"`, the selected
revision and matching running Docker image/label before publishing its receipt.
Readiness has a 60-second elapsed deadline after apply (plus at most one bounded
HTTP attempt), polled every 100 ms. This detects readiness sooner; it does not
make the underlying engine start faster. No public traffic proxy or new platform
is introduced. Connections go directly to the single loopback listener.

Shutdown shares one promise across signals and startup errors, fences new HTTP
admissions and waits for startup before closing the registry. Existing HTTP/SSE
connections have the existing five-second close window; native registry shutdown
then uses its engine/default grace budget, inside Docker's 60-second stop timeout.
These are bounded drains, not a promise every model turn finishes. At the limit,
streams disconnect and clients must reconnect/resnapshot or poll their retained
signed result handle. Retry uncertain admission with the **same** mutation ID;
do not interpret disconnection as cancellation or blindly replay side effects.
Checkpoint recovery remains subject to the native runtime's actual guarantees.

The independent bus on 8792 stays up during backend replacements: do not change
its dedicated HOME, SQLite/LMDB, signing secret, auth or replay offsets. Slack
remains one service with one delivery journal; backend deployment neither starts
a second Socket Mode owner nor restarts/migrates its journal. Backlogged core
admissions retain their journal mutation identity; uncertain Slack posts still
require reconciliation, not automatic resend.

There is an irreducible backend interruption between old admission close and new
native readiness. Measure it with an independent 100 ms observer of 8787 **and**
8792 across the actual Actions rollout: retain last old success, first failure,
last failure, first selected-revision success, failure count, latency and Docker
die/start times. Report the sampling/timeout resolution and workload. Build time,
container creation → receipt time, and a successful health check alone are not
outage measurements. Idle health continuity is not in-flight real-model proof.
No automatic rollback is safe after a candidate has opened/migrated production
storage: forward-fix, or explicitly review a compatible offline recovery plan.
This path reduces avoidable failed activations but does not claim a measured
subsecond outage until a real rollout establishes one.

| Path                                     | Purpose                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/opt/computah/toolchain`                | Dedicated Node 24.22.0 and pnpm 12.0.0                                                    |
| `/usr/local/lib/computah/reconcile`      | Independently installed updater                                                           |
| `/etc/computah/runtime.env`              | Owner-only stable ingress/connection secrets and model configuration                      |
| `/etc/computah/provider.env`             | Owner-only provider env configuration; may be empty for official OAuth                    |
| `/etc/computah/HOLD`                     | Presence pauses future reconciliations without stopping the running app                   |
| `/var/lib/computah/data`                 | UID 1000 persistent writable HOME, Rivet/Pi and provider storage; never removed by deploy |
| `/var/lib/computah/alchemy/.alchemy`     | Sensitive local Alchemy state, outside releases                                           |
| `/var/lib/computah/releases/<sha>`       | Archived source plus deploy dependencies                                                  |
| `/var/lib/computah/releases/<sha>.image` | Content-addressed built image ID                                                          |
| `/var/lib/computah/active.json`          | Last observed healthy revision/image/time, not merely desired Git head                    |

Alchemy receives env-file **paths**, not secret values. Its provider hashes file
contents to detect credential rotation without persisting values in state.
Docker administrators can still inspect resolved container environment variables;
root/Docker access is privileged. Never publish full `docker inspect`, env-file
contents, auth stores, application histories or runtime logs. Infisical integration
is not implemented; these protected local files are the bootstrap boundary.

## Actions handover and exact revisions

The `Deploy / nest-bagel` job runs only for main push heads or manual main runs,
using the `nest-bagel` environment. The environment allows only branch `main`,
with no reviewers or wait timer. It supplies deployment history and scoped
configuration, not resource provisioning or serialization. Native Actions job
checks need no custom GitHub App or Checks API credential.

The workflow is main-only; its bootstrap hold is removed only after deployment
owner readiness confirms route, host trust, private-key provisioning and transfer
cleanup. Enablement is not deployment evidence: retain the existing timer until
the deployment owner verifies actual hosted Actions health and its exact-revision
receipt, then completes the timer handover.

Set environment variables `COMPUTAH_DEPLOY_HOST`, `COMPUTAH_DEPLOY_PORT`,
`COMPUTAH_DEPLOY_USER` and `COMPUTAH_DEPLOY_HOST_KEY` (bare public host key), and
private environment secret `COMPUTAH_DEPLOY_KEY`. Host identity is pinned; the
workflow never accepts an unverified host key at runtime. The selected owner
route is `bagel@hackclub.app:22`. The direct container IPv6 route was tested from
hosted Ubuntu and failed because that runner had no IPv6 route, not because of
SSH authentication. The existing GitHub integration returned 403 for secret
provisioning; never export Amp credentials as a workaround.

The Nest gateway currently authenticates onward as root using its own bastion
key. Its documented source does not implement per-key forced-command options;
do not claim `restrict,command=...` in a dashboard key is enforced. The dedicated
deployment key is not an existing owner/Amp/June key. The separately installed
direct `computah-deploy` SSH account does enforce `restrict` and
`deploy/ssh-command.sh`, with sudo limited to the validated root-owned entry point.
Those direct-account restrictions do not automatically carry through the gateway.
Gateway activation must verify the actual selected route and record this boundary.

The deployment owner verified owner-approved host pinning and an exact-revision
request over the IPv4 gateway at `c48de6d`, with a fresh matching healthy receipt.
That connection authenticated onward as root, not the restricted direct account.
This is route evidence, not hosted Actions or deployment-only authority evidence.

Install the reviewed `deploy-request.sh` and `ssh-command.sh` under
`/usr/local/lib/computah`, and the validated `computah-deploy.sudoers` under
`/etc/sudoers.d` only for the dedicated direct account. The entry point accepts
one full SHA, invokes `reconcile.sh` with that exact revision and emits only a
fresh matching public receipt. Build/apply diagnostics remain root-only under
`/var/log/computah-deploy`; retention is manual. No-argument reconciliation still
follows main for the timer/recovery path. Explicit requests wait on the shared
lock, fail under HOLD, reject commits outside main history and refuse to replace
a newer or divergent storage activation. Root-only `activation-revision` advances
under the lock before apply can open/migrate storage, even if readiness fails;
it is separate from `active.json`, the healthy receipt. Both timer and explicit
requests honor this high-water mark. The request-specific healthy receipt is
captured before releasing the lock, so a later deployment cannot substitute its
receipt. A busy/held request is not green success.

Success requires `ready:true` plus a running container with the exact image and
revision label, followed by a fresh matching receipt. It is not merely build or
Alchemy command success. Hosted handover is complete: the deployment owner
verified the exact run, host receipt/image/health and then disabled the timer.
Do not re-enable it alongside normal Actions delivery. The installed updater and
Docker supervision remain; see the observed handover evidence below.
Superseded pending Actions runs may be cancelled, never labelled deployed. One
push checks its head SHA; intermediate commits in a multi-commit push do not each
get a separate deployment job. No automatic cross-version storage rollback.

## Separate Slack process

`computah-slack.service` runs one unprivileged outbound-only Socket Mode process,
not another core. Its root-owned source release lives at
`/opt/computah-slack/releases/<sha>` with a `current` symlink. Prepare a release
from canonical main with root/workspace/lock manifests and `apps/slack`, frozen
production dependencies and direct Node entry; verify source/dependencies are
readable by the service account. If pnpm's root store hardlinks retain private
file modes, copy the release's dependency tree to separate inodes before making
that copy readable; never chmod the shared store or unrelated releases.

Protected `/etc/computah-slack/runtime.env` supplies dedicated new-app tokens,
loopback core URL and paths. `/etc/computah-slack/bindings.json` is service-owned
0600 and maps the verified Slack owner/workspace to the **existing** core principal,
not a new actor. The private `/var/lib/computah-slack` directory is 0700 and holds
the SQLite/WAL delivery journal. No core/provider data directory is mounted or
given to this service. The unit allows 60 seconds to stop, uses the installed
Node 24 toolchain, restarts on failure and exposes no HTTP listener. Readiness is
the sanitized `computah.slack.ready` log after Slack installation, trusted viewer
and Socket Mode checks, not merely systemd's active state.

Source publication does not automatically switch this independently installed
Slack release yet. Update the root-owned `current` link to a tested canonical
release and restart the single unit; verify ready/stopped logs, retained journal
and a real owner follow-up. Never run two replicas or blindly replay uncertain
external posts. The one requested identification DM was handled separately; do
not resend it on service startup. See [Slack setup](slack.md) for its exact wire,
enterprise-install guard and unresolved delivery semantics.

## Launch and inspect

After the tested source and server entry point are on main, install the provided
script at the path above and the two units in `/etc/systemd/system`, then run
`systemctl daemon-reload`. Normal delivery uses the configured main-only Actions
workflow; leave the recovery timer disabled. Starting the recovery service or
re-enabling its timer requires an explicit operator recovery decision.
Both env files must already exist. Their format is Docker env-file syntax, not
shell scripts: one `NAME=value` per line, no `export` or shell expansion.

Create the data directory **only for a new installation**, before the first
reconciliation: `test -e /var/lib/computah/data || install -d -o 1000 -g 1000 -m 0700 /var/lib/computah/data`.
The updater refuses missing data or a directory inaccessible to UID 1000; it
does not let Docker create a root-owned replacement. Never recursively chown an
existing store to make a failed activation pass; inspect and recover it first.

The only published application socket is **127.0.0.1:8787**. Do not expose the
Rivet registry, engine or inspector. Use an authorized SSH tunnel or a later
authenticated TLS ingress; no public ingress is provisioned here. `GET /healthz`
checks startup, not model credentials. Protected routes require the configured
bearer token. Read `core.md` for the current HTTP contract and mode reporting.

Useful non-secret checks on nest-bagel:

```sh
sudo systemctl status computah-reconcile.timer --no-pager
sudo systemctl is-enabled computah-reconcile.timer
sudo cat /var/lib/computah/active.json
curl --fail http://127.0.0.1:8787/healthz
sudo docker inspect computah-backend --format '{{.State.Status}} {{.Image}}'
```

Install `deploy/chat.mjs` as `/usr/local/lib/computah/chat` (root-owned, mode 0755)
for a host-only command-line client. On nest-bagel, run
`sudo /usr/local/lib/computah/chat 'Hello Computah; ask your primary Worker to introduce itself.'`
and then run it again with a follow-up. It uses the first configured operator
binding from the protected env file, without putting the bearer in argv/output.
It does not provide public ingress or a Rune UI. Ctrl-C/disconnection does not
mean the durable turn was cancelled; the accepted handle remains queryable.

Keep `COMPUTAH_CONNECTION_SECRET` and ingress token bindings stable. To rotate
runtime/provider configuration, edit the protected file on the host and reconcile;
the provider detects the changed contents and replaces the container. A change
to Git is not required for secret rotation. Never put a credential in Git or an
Alchemy `environment` property.

## Official provider login, not token extraction

Pi AI 1.5.0 documents provider-owned OAuth via its CLI. A supported subscription
login can be used instead of choosing a paid API provider. The operator chooses
the provider and confirms entitlement; no existing app tokens are extracted.
Run the login interactively on nest-bagel, with the app's persistent provider
directory as cwd, so `auth.json` is mode 0600 and refresh can write it. The server
must explicitly load that store; merely creating the file is not authentication.

Raygen selected **legacy Codex subscription auth**: Pi's `openai-codex` provider,
not its newer `openai` login. Set `COMPUTAH_PI_AUTH_FILE=/data/provider/auth.json`
and choose a `COMPUTAH_MODEL=openai-codex/<model>` from that provider's catalog.
For an already running container, use the provider-owned legacy login:

```sh
sudo docker exec -it computah-backend sh -c \
  'umask 077; mkdir -p /data/provider; cd /data/provider; node /app/apps/server/node_modules/@earendil-works/pi-ai/dist/cli.js login openai-codex'
```

Complete the official browser prompts privately. Do not paste keys or callback
codes into thread messages. Other supported provider choices can be listed with
the same CLI's `list` command. An API-key alternative is a host-side private edit
of `/etc/computah/provider.env`, using the chosen provider's documented variable.
No purchase/account/project creation is part of this bootstrap.

## Recovery and limits

The container restart policy and Docker's enabled system service provide process
supervision. Test restart recovery with the same `/data` and connection secret;
verify authenticated history and a follow-up, not only HTTP health. Health and
artifact receipts do not establish live model behavior or pending-task recovery.

Set HOLD to refuse new deployment requests, wait for any active reconciliation
to release the shared lock, and stop the container before any offline backup of
the complete data directory, or use a runtime-supported consistent backup.
Keep the recovery timer disabled. Preserve provider
store/connection secrets separately with equally restricted access. Copying live
SQLite files blindly is not a backup. No backup restore or data deletion is
performed automatically. Newer Pi schemas may refuse older runtimes; forward-fix
unless a separately reviewed compatible recovery plan exists. Do not prune other
projects' Docker images, volumes or source. Release/image retention is manual for
now; monitor the host's finite disk before retaining many releases.

Delivery evidence must distinguish bootstrap/faux from real-provider mode. A
healthy deterministic service is useful operational validation, not a usable live
agent milestone. Record an authenticated Interaction → Worker answer and a
persisted follow-up using the chosen provider before calling that milestone done.

## Observed host verification

On 2026-11-07, main revision `facaddddcbe1729a2d788a3d32da32659e247f7a`
ran on nest-bagel as immutable image
`sha256:b0839d2171987340ff71d8eac38953872c1398b9a74117a6e4a5b1c77f907977`.
Readiness reported real mode, and authenticated HTTP requests completed through
legacy `openai-codex/gpt-6.1-sol`. Missing/forged bearers were rejected; duplicate
submissions retained their handle and conflicting payloads were rejected.
After a container restart with the same persistent data, exact public history
and the old signed result handle survived, and a real follow-up recalled the
earlier canary. These checks do not prove forced OAuth refresh, backup restore,
arbitrary interrupted-task recovery or cross-version storage compatibility.

A separate private in-container client inspected the configured principal's
Interaction and primary Worker histories through the existing registry, without
starting another registry. Aggregate counts confirmed three actual Task calls,
three Worker user messages and three Worker replies. No raw entries or secrets
were emitted and no inspector was exposed; real delegation is not inferred only
from the public text answer.

The enabled timer subsequently selected exact main revision
`eb70afe9c4126fb54583d5a4c83e7d013b915bf9` without manual service start:
trigger 22:54:31Z, container created 22:54:37.373944327Z and observed-ready receipt
22:55:12.484Z. Running revision/image matched immutable image
`sha256:776b60b2fcd64014e67eb0f00f71d56b5f6e11d2fa44d20b4f5469b04e4e2eb4`;
reconciliation exited successfully and readiness reported real mode. A protected
real follow-up after rollout preserved earlier public history and the old signed
handle and recalled prior context. Installed updater, units and chat client
byte-matched published source. This does not establish host-reboot or backup
restore recovery. Slack activation is separate; see [its setup guide](slack.md).

## Observed Actions handover

On 2026-11-08, the push-triggered [Deploy run 42428509279](https://github.com/lordbagel42/computah/actions/runs/42428509279)
and [deployment job 128571953697](https://github.com/lordbagel42/computah/actions/runs/42428509279/job/128571953697)
succeeded for exact main revision
`b4a74ffc5b0effb40e71428b2795838e31b39e93`. The deployment owner matched the
host request log and healthy receipt to the running Docker revision label and
immutable image, with health reporting `ready:true` in real mode. An independent
owner-authenticated check extracted only the normalized hosted-job receipt in
memory; all three fields exactly matched the host evidence, without dumping or
storing raw logs:

```json
{
  "revision": "b4a74ffc5b0effb40e71428b2795838e31b39e93",
  "image": "sha256:d52f6d77210438fd817b222d4d643fbd05fc3004ffb40f00124297a721e0e8f3",
  "observedHealthyAt": "2026-11-08T00:10:54.862Z"
}
```

Only after those checks, the authorized deployment owner disabled the timer:
`computah-reconcile.timer` is inactive/disabled and its service is inactive with
successful result. Docker remains enabled/active and the backend restart policy
is `unless-stopped`. The existing root-owned updater and shared lock remain in
use. This is completed hosted delivery and handover evidence, not a new Slack
roundtrip, inspector activation, host-reboot or backup-restore claim. The gateway
still authenticates onward as root, not the restricted direct account.
