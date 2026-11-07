#!/usr/bin/env bash
# Weekly rewards payout, run by root on the production host.
#
#   sudo memeverse-pay-rewards              # plan only: prints every payout, sends nothing
#   sudo memeverse-pay-rewards --broadcast  # pays from the treasury
#
# The treasury key lives in /etc/memeverse/secrets/treasury.env (root:root 0600). It is NOT in
# /etc/memeverse/memeverse.env, so the internet-facing API process never holds it. This wrapper
# reads it as root and hands it, through the environment (never argv), to scripts/pay-rewards.js
# running as the unprivileged memeverse user — and only for --broadcast.
#
# Install: install -m 0755 -o root -g root ops/memeverse-pay-rewards.sh /usr/local/sbin/memeverse-pay-rewards
set -euo pipefail

REPO="${MEMEVERSE_REPO:-/opt/memeverse}"
ENV_FILE="${MEMEVERSE_ENV:-/etc/memeverse/memeverse.env}"
SECRETS="${MEMEVERSE_SECRETS:-/etc/memeverse/secrets/treasury.env}"
NODE="${MEMEVERSE_NODE:-/opt/nodejs22/bin/node}"
APP_USER="${MEMEVERSE_USER:-memeverse}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 [--broadcast]" >&2
  exit 1
fi

broadcast=0
for arg in "$@"; do
  case "$arg" in
    --broadcast) broadcast=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

unset DEPLOYER_PRIVATE_KEY
if [[ "$broadcast" -eq 1 ]]; then
  line="$(grep -E '^DEPLOYER_PRIVATE_KEY=' "$SECRETS" | tail -1 || true)"
  if [[ -z "$line" ]]; then
    echo "DEPLOYER_PRIVATE_KEY is missing from $SECRETS. The value was not printed." >&2
    exit 1
  fi
  value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  export DEPLOYER_PRIVATE_KEY="$value"
  unset line value
fi

cd "$REPO"
export MEMEVERSE_ENV="$ENV_FILE"
args=()
[[ "$broadcast" -eq 1 ]] && args+=(--broadcast)
# runuser keeps the environment (so the key reaches node) without putting it on a command line.
exec runuser -u "$APP_USER" -- "$NODE" scripts/pay-rewards.js "${args[@]}"
