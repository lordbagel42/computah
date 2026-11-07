#!/bin/bash
# Installed separately as /usr/local/lib/computah/reconcile; not self-replaced.
set -euo pipefail
umask 077
export PATH=/opt/computah/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec 9>/run/lock/computah-deploy.lock
flock -n 9 || exit 0
test ! -e /etc/computah/HOLD || exit 0
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
revision=$(git --git-dir="$repo" rev-parse FETCH_HEAD)
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
pnpm apply
