#!/usr/bin/env bash
# One-command production update for memeverse.biz
#
# On the server:
#   sudo bash /opt/memeverse/scripts/update-production.sh
#
# Or, first time / from anywhere on the host:
#   sudo bash -c 'git -C /opt/memeverse fetch origin main && git -C /opt/memeverse checkout origin/main -- scripts/update-production.sh && bash /opt/memeverse/scripts/update-production.sh'
#
# Pulls origin/main, installs deps, rebuilds the frontend with production VITE_*
# values, and restarts the API. Worker is left running unless --restart-worker
# is passed. Secrets are never printed.

set -euo pipefail

REPO="${MEMEVERSE_REPO:-/opt/memeverse}"
ENV_FILE="${MEMEVERSE_ENV:-/etc/memeverse/memeverse.env}"
NODE_BIN="${MEMEVERSE_NODE_BIN:-/opt/nodejs22/bin}"
APP_USER="${MEMEVERSE_USER:-memeverse}"
RESTART_WORKER=0

for arg in "$@"; do
  case "$arg" in
    --restart-worker) RESTART_WORKER=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

if [[ ! -d "$REPO/.git" ]]; then
  echo "Checkout not found at $REPO" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found at $ENV_FILE" >&2
  exit 1
fi

export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin"

echo "==> fetching origin/main"
sudo -u "$APP_USER" git -C "$REPO" fetch origin main
TARGET="$(sudo -u "$APP_USER" git -C "$REPO" rev-parse origin/main)"
echo "==> checking out $TARGET"
sudo -u "$APP_USER" git -C "$REPO" checkout --force "$TARGET"

echo "==> npm ci"
cd "$REPO"
sudo -u "$APP_USER" env PATH="$PATH" HOME="$REPO" npm ci

VITE_ENV="$(mktemp /tmp/vite-build.env.XXXXXX)"
trap 'rm -f "$VITE_ENV"' EXIT
grep -E '^VITE_' "$ENV_FILE" > "$VITE_ENV"
chown "$APP_USER:$APP_USER" "$VITE_ENV"
chmod 0600 "$VITE_ENV"

echo "==> production frontend build"
sudo -u "$APP_USER" env PATH="$PATH" HOME="$REPO" sh -c "set -a; . '$VITE_ENV'; set +a; NODE_ENV=production npm run build"
rm -f "$VITE_ENV"
trap - EXIT

echo "==> restart API"
systemctl restart memeverse-api.service
systemctl status memeverse-api.service --no-pager -n 20 || true

if [[ "$RESTART_WORKER" -eq 1 ]]; then
  echo "==> restart worker"
  systemctl restart memeverse-worker.service
  systemctl status memeverse-worker.service --no-pager -n 20 || true
else
  echo "==> worker left running (pass --restart-worker to bounce it)"
fi

echo "==> live SHA"
sudo -u "$APP_USER" git -C "$REPO" rev-parse --short HEAD
echo "==> done. Frontend is $REPO/dist — nginx already serves it."
