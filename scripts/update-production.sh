#!/usr/bin/env bash
# One-command production update for memeverse.biz
#
# From the live host, as root — works even when this file is not on disk yet:
#
#   curl -fsSL https://raw.githubusercontent.com/Baharsx/memeverse/main/scripts/update-production.sh | sudo bash
#
# After the first successful run, this also works:
#
#   sudo bash /opt/memeverse/scripts/update-production.sh
#
# Pulls origin/main, installs deps, rebuilds the frontend with production VITE_*
# values, and restarts the API. Worker is left running unless --restart-worker
# is passed. Secrets are never printed. Git is always run as the memeverse user.

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
      sed -n '2,18p' "$0"
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

# Repo is owned by $APP_USER. Root `git pull` otherwise dies with "dubious ownership".
git config --system --add safe.directory "$REPO" >/dev/null 2>&1 || true
sudo -u "$APP_USER" git config --global --add safe.directory "$REPO" >/dev/null 2>&1 || true

export PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin"
# npm otherwise prints "New major version of npm available" on some installs.
export NPM_CONFIG_UPDATE_NOTIFIER=false

echo "==> fetching origin/main"
sudo -u "$APP_USER" git -C "$REPO" fetch origin main
TARGET="$(sudo -u "$APP_USER" git -C "$REPO" rev-parse origin/main)"
echo "==> checking out $TARGET"
sudo -u "$APP_USER" git -C "$REPO" checkout --force "$TARGET"

echo "==> npm ci"
cd "$REPO"
# --no-fund drops the "packages are looking for funding" notice. The one
# deprecation below stays in the tree: Safe marked the whole gateway type
# package unsupported, and wagmi plus AppKit still install it. There is no
# successor to upgrade to. Any other warning is printed.
npm_log="$(mktemp /tmp/memeverse-npm-ci.XXXXXX)"
set +e
sudo -u "$APP_USER" env PATH="$PATH" HOME="$REPO" npm ci --no-fund >"$npm_log" 2>&1
npm_status=$?
set -e
grep -v -E 'npm warn deprecated @safe-global/safe-gateway-typescript-sdk@' "$npm_log" || true
rm -f "$npm_log"
if [[ "$npm_status" -ne 0 ]]; then
  exit "$npm_status"
fi

VITE_ENV="$(mktemp /tmp/vite-build.env.XXXXXX)"
trap 'rm -f "$VITE_ENV"' EXIT
grep -E '^VITE_' "$ENV_FILE" > "$VITE_ENV"
chown "$APP_USER:$APP_USER" "$VITE_ENV"
chmod 0600 "$VITE_ENV"

echo "==> production frontend build"
sudo -u "$APP_USER" env PATH="$PATH" HOME="$REPO" sh -c "set -a; . '$VITE_ENV'; set +a; NODE_ENV=production npm run build"
rm -f "$VITE_ENV"
trap - EXIT

env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line" | tr -d '[:space:]'
}

wait_for_api() {
  local port chain i body
  port="$(env_value API_PORT)"
  port="${port:-8787}"
  chain="$(env_value VITE_ARC_CHAIN_ID)"
  for i in $(seq 1 40); do
    body="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
    if [[ -n "$body" ]] && printf '%s' "$body" | grep -q '"status":"ok"'; then
      if [[ -z "$chain" ]] || printf '%s' "$body" | grep -q "\"chainId\":${chain}"; then
        if [[ -n "$chain" ]]; then
          echo "==> API healthy on chain ${chain}"
        else
          echo "==> API healthy"
        fi
        return 0
      fi
    fi
    sleep 1
  done
  echo "API did not become healthy" >&2
  systemctl status memeverse-api.service --no-pager -n 30 >&2 || true
  journalctl -u memeverse-api.service -n 40 --no-pager >&2 || true
  return 1
}

wait_for_unit() {
  local unit="$1" label="$2" i pid comm
  for i in $(seq 1 30); do
    if systemctl is-active --quiet "$unit"; then
      pid="$(systemctl show -p MainPID --value "$unit")"
      comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
      if [[ -n "$comm" && "$comm" != "systemd-executor" ]]; then
        echo "==> ${label} running"
        return 0
      fi
    fi
    sleep 1
  done
  echo "${label} did not stay up" >&2
  systemctl status "$unit" --no-pager -n 30 >&2 || true
  journalctl -u "$unit" -n 40 --no-pager >&2 || true
  return 1
}

echo "==> restart API"
systemctl restart memeverse-api.service
wait_for_api

if [[ "$RESTART_WORKER" -eq 1 ]]; then
  echo "==> restart worker"
  systemctl restart memeverse-worker.service
  wait_for_unit memeverse-worker.service worker
else
  echo "==> worker left running (pass --restart-worker to bounce it)"
fi

echo "==> live SHA"
sudo -u "$APP_USER" git -C "$REPO" rev-parse --short HEAD
echo "==> done. Frontend is $REPO/dist — nginx already serves it."
