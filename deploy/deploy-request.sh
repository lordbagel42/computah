#!/bin/bash
# Root-owned sudo entry point. The deployment account cannot replace this file.
set -euo pipefail
umask 077
export PATH=/opt/computah/toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if (( $# != 1 )) || [[ ! $1 =~ ^[a-f0-9]{40}$ ]]; then
  echo "A full main revision is required" >&2
  exit 64
fi
install -d -o root -g root -m0700 /var/log/computah-deploy
log=$(mktemp /var/log/computah-deploy/request.XXXXXXXX.log)
receipt=$(mktemp /var/log/computah-deploy/receipt.XXXXXXXX.json)
trap 'rm -f "$receipt"' EXIT
started=$(date +%s)
if COMPUTAH_DEPLOY_RECEIPT="$receipt" /usr/local/lib/computah/reconcile "$1" >"$log" 2>&1; then
  # Emit only a fresh matching public receipt, never deployment diagnostics.
  node --input-type=module - "$1" "$started" "$receipt" <<'JS'
import { readFileSync } from "node:fs";
try {
  const [revision, started, path] = process.argv.slice(2);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  const image = readFileSync(`/var/lib/computah/releases/${revision}.image`, "utf8").trim();
  if (receipt.revision !== revision || receipt.image !== image ||
      !Number.isFinite(Date.parse(receipt.observedHealthyAt)) ||
      Date.parse(receipt.observedHealthyAt) < Number(started) * 1000) {
    throw new Error("receipt mismatch");
  }
  console.log(JSON.stringify({ revision, image, observedHealthyAt: receipt.observedHealthyAt }));
} catch {
  console.error("No fresh healthy receipt for the requested revision");
  process.exitCode = 1;
}
JS
else
  status=$?
  echo "Deployment request failed (status $status); protected diagnostics retained on host" >&2
  exit "$status"
fi
