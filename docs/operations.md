# nest-bagel operations

The authorized target is the existing nest-bagel Debian container. Docker 26.1.5
runs without Swarm. Alchemy and `@alchemy.run/docker` are pinned to
2.0.0-beta.85 with Effect/platform-node 4.1.2 in an independent `deploy` workspace.
The supported `Docker.Container` provider manages only `computah-backend`.
Because deployment runs on this host, it uses the local socket, not an SSH hop
back to itself. A remote Docker context is not configured.

## Release ownership

`computah-reconcile.timer` polls public GitHub main every minute. The installed
root-owned updater takes `/run/lock/computah-deploy.lock`, selects a full commit,
archives it into an immutable release directory, builds a Docker image once and
applies that exact image ID using real Alchemy plan/apply. It never runs PR code
or needs a GitHub deployment secret. Trusted main is privileged deployment code;
repository write access is deployment authority. This is a supervised pull-based
delivery path, not a GitHub Actions runner exposed to arbitrary workflows.

The updater itself is installed separately and does not self-replace from main.
To update it, review the diff and explicitly install the new script/unit. The
Alchemy stack in each trusted release controls its declared application resource.
No other services, volumes or host infrastructure are adopted. Container
replacement stops the old process before the new one starts; brief downtime is
expected. There is no automatic old-image rollback across Pi storage migrations.

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

## Launch and inspect

After the tested source and server entry point are on main, install the provided
script at the path above and the two units in `/etc/systemd/system`, then run
`systemctl daemon-reload` and `systemctl enable --now computah-reconcile.timer`.
Both env files must already exist. Their format is Docker env-file syntax, not
shell scripts: one `NAME=value` per line, no `export` or shell expansion.

Create the data directory **only for a new installation**, before enabling the
timer: `test -e /var/lib/computah/data || install -d -o 1000 -g 1000 -m 0700 /var/lib/computah/data`.
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
sudo systemctl start computah-reconcile.service
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

Pause the timer and stop the container before any offline backup of the complete
data directory, or use a runtime-supported consistent backup. Preserve provider
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
