#!/bin/bash
# Installed separately as /usr/local/lib/computah/reconcile; not self-replaced.
set -euo pipefail
umask 077
export PATH=/opt/computah/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if (( $# > 1 )) || { (( $# == 1 )) && [[ ! $1 =~ ^[a-f0-9]{40}$ ]]; }; then
  echo "Expected no argument or a full trusted main revision" >&2
  exit 64
fi
requested=${1:-}
exec 9>/run/lock/computah-deploy.lock
if [[ -n $requested ]]; then
  flock -w 900 9 || exit 75
else
  flock -n 9 || exit 0
fi
if test -e /etc/computah/HOLD; then
  [[ -z $requested ]] && exit 0
  echo "Deployment is held; requested revision was not deployed" >&2
  exit 75
fi
test -f /etc/computah/runtime.env
test -f /etc/computah/provider.env
if ! test -d /var/lib/computah/data || ! setpriv --reuid=1000 --regid=1000 --clear-groups \
  sh -c 'test -r "$1" && test -w "$1" && test -x "$1"' sh /var/lib/computah/data; then
  echo "Persistent data must already exist and be accessible to UID 1000; refusing activation" >&2
  exit 1
fi

repo=/var/lib/computah/repository.git
if test ! -d "$repo"; then
  git clone --bare https://github.com/lordbagel42/computah.git "$repo"
fi
git --git-dir="$repo" fetch --no-tags origin main
head=$(git --git-dir="$repo" rev-parse FETCH_HEAD)
revision=${requested:-$head}
if ! git --git-dir="$repo" merge-base --is-ancestor "$revision" "$head"; then
  echo "Requested revision is not trusted main history" >&2
  exit 65
fi
high_water=/var/lib/computah/activation-revision
previous=
if test -f "$high_water"; then
  previous=$(cat "$high_water")
elif test -f /var/lib/computah/active.json; then
  previous=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/var/lib/computah/active.json", "utf8")).revision)')
fi
if [[ -n $previous && $previous != "$revision" ]]; then
  if ! git --git-dir="$repo" merge-base --is-ancestor "$previous" "$revision"; then
    echo "Requested revision predates or diverges from storage activation; refusing" >&2
    exit 65
  fi
fi
export COMPUTAH_REVISION=$revision
release=/var/lib/computah/releases/$revision
if test ! -f "$release/.complete"; then
  mkdir -p "$release"
  git --git-dir="$repo" archive "$revision" | tar -x -C "$release"
  touch "$release/.complete"
fi

# Trusted main only. No PR code, remote runner registration or GitHub deploy key.
# Build once; execute by content-addressed image ID, never by a mutable tag.
image_id=/var/lib/computah/releases/$revision.image
if test ! -s "$image_id"; then
  docker build --label "org.opencontainers.image.revision=$revision" \
    --iidfile "$image_id.tmp" "$release"
  mv "$image_id.tmp" "$image_id"
fi
COMPUTAH_IMAGE=$(cat "$image_id")
export COMPUTAH_IMAGE
cd "$release/deploy"
pnpm install --frozen-lockfile
# Persist before apply can open/migrate storage, even if readiness later fails.
# This is not the healthy receipt, and is never rewound automatically.
printf '%s\n' "$revision" > "$high_water.tmp"
mv "$high_water.tmp" "$high_water"
pnpm apply
# Capture the request's receipt before releasing the shared lock. A later
# deployment may replace active.json before the SSH wrapper resumes.
if [[ -n ${COMPUTAH_DEPLOY_RECEIPT:-} ]]; then
  cp /var/lib/computah/active.json "$COMPUTAH_DEPLOY_RECEIPT"
fi
