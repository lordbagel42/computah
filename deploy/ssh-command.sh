#!/bin/bash
# Forced command for the dedicated deployment key; never evaluate client input.
set -euo pipefail
if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^/usr/local/lib/computah/deploy-request\ ([a-f0-9]{40})$ ]]; then
  echo "Only the deployment entry point and full main revision are permitted" >&2
  exit 64
fi
exec /usr/bin/sudo -n /usr/local/lib/computah/deploy-request "${BASH_REMATCH[1]}" </dev/null
