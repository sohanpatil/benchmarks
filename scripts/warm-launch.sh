#!/usr/bin/env bash
#
# Provision a Namespace VM, upload the warm-ops coordinator bundle, hand off.
# This script lives for ~30s; the actual benchmark (~45 min) runs on the VM.
#
# Required env:
#   TIGRIS_STORAGE_BUCKET
#   TIGRIS_STORAGE_ACCESS_KEY_ID
#   TIGRIS_STORAGE_SECRET_ACCESS_KEY
#   Provider credentials (E2B_API_KEY, etc.) — forwarded if present.
#
# Optional env:
#   RUN_ID                Defaults to "warm-YYYYMMDDTHHMMSSZ-<sha8>"
#   GITHUB_SHA            Defaults to `git rev-parse HEAD` or "local"
#   DURATION              Defaults to 2h
#   MACHINE_TYPE          Defaults to 4x8
#   TIGRIS_STORAGE_ENDPOINT  Forwarded to the coordinator if set
#   SAMPLES_PER_OP        Defaults to 100; useful for smoke tests
#   PROVIDER_FILTER       If set, only run this single provider

set -euo pipefail

: "${TIGRIS_STORAGE_BUCKET:?TIGRIS_STORAGE_BUCKET required}"
: "${TIGRIS_STORAGE_ACCESS_KEY_ID:?TIGRIS_STORAGE_ACCESS_KEY_ID required}"
: "${TIGRIS_STORAGE_SECRET_ACCESS_KEY:?TIGRIS_STORAGE_SECRET_ACCESS_KEY required}"

GITHUB_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo local)}"
RUN_ID="${RUN_ID:-warm-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:0:8}}"
DURATION="${DURATION:-2h}"
MACHINE_TYPE="${MACHINE_TYPE:-4x8}"

# `NSC_TOKEN` is the @computesdk/namespace SDK token (used inside the VM to
# create sandboxes for the namespace *provider* benchmark). The `nsc` CLI
# reads the same env var and, if set, prefers it over the local login
# token. Stash the SDK token under a different name so the launching CLI
# falls back to `nsc login` auth, then re-emit it as NSC_TOKEN inside the
# VM startup script.
SANDBOX_NSC_TOKEN="${NSC_TOKEN:-}"
unset NSC_TOKEN

# `NSC_TOKEN_FILE`, if set, overrides the default `nsc login` token path.
# We've seen it leak in with the literal value "./NSC_TOKEN_FILE.json"
# from stale shell setups, which makes the CLI fail before it even checks
# the login keychain. Force it to the real login token if one exists.
if [ -f "$HOME/.config/ns/token.json" ]; then
  export NSC_TOKEN_FILE="$HOME/.config/ns/token.json"
elif [ -n "${NSC_TOKEN_FILE:-}" ] && [ ! -f "$NSC_TOKEN_FILE" ]; then
  echo "[launch] WARNING: NSC_TOKEN_FILE=$NSC_TOKEN_FILE points to a missing file" >&2
  echo "[launch]          and ~/.config/ns/token.json doesn't exist either." >&2
  echo "[launch]          Run \`nsc login\` first." >&2
fi

echo "[launch] RUN_ID=$RUN_ID duration=$DURATION machine=$MACHINE_TYPE"
echo "[launch]   tigris=s3://${TIGRIS_STORAGE_BUCKET}/warm-ops/${RUN_ID}/"
if [ -n "${SAMPLES_PER_OP:-}" ]; then
  echo "[launch]   SAMPLES_PER_OP=$SAMPLES_PER_OP"
fi
if [ -n "${PROVIDER_FILTER:-}" ]; then
  echo "[launch]   PROVIDER_FILTER=$PROVIDER_FILTER"
fi

# ----- 1. bundle coordinator -----------------------------------------------
echo "[launch] 1/4 bundling coordinator -> dist/warm-coordinator.cjs"
npm run --silent bundle:warm-vm

# ----- 2. provision Namespace instance -------------------------------------
echo "[launch] 2/4 creating Namespace instance"
CIDFILE="$(mktemp)"
trap 'rm -f "$CIDFILE"' EXIT
nsc create \
  --bare \
  --machine_type "$MACHINE_TYPE" \
  --duration "$DURATION" \
  --cidfile "$CIDFILE"
INSTANCE_ID="$(cat "$CIDFILE")"
echo "[launch]   instance: $INSTANCE_ID"

# ----- 3. upload bundle ----------------------------------------------------
echo "[launch] 3/4 uploading coordinator bundle"
nsc instance upload "$INSTANCE_ID" dist/warm-coordinator.cjs /root/coordinator.cjs

# ----- 4. prepare VM and start coordinator detached ------------------------
echo "[launch] 4/4 preparing VM and starting coordinator"

# Wolfi --bare image has no node; install it.
nsc ssh "$INSTANCE_ID" -- apk add -q nodejs

# Build startup script with env values shell-quoted via `printf '%q'` so
# unusual characters survive. The file is uploaded then self-deletes, so
# credentials never linger on the VM disk.
STARTUP_FILE="$(mktemp)"
chmod 600 "$STARTUP_FILE"
trap 'rm -f "$STARTUP_FILE" "$CIDFILE"' EXIT

{
  echo '#!/bin/sh'
  echo 'set -e'
  printf 'export RUN_ID=%q\n'                          "$RUN_ID"
  printf 'export INSTANCE_ID=%q\n'                     "$INSTANCE_ID"
  printf 'export GITHUB_SHA=%q\n'                      "$GITHUB_SHA"
  printf 'export TIGRIS_STORAGE_BUCKET=%q\n'           "$TIGRIS_STORAGE_BUCKET"
  printf 'export TIGRIS_STORAGE_ACCESS_KEY_ID=%q\n'    "$TIGRIS_STORAGE_ACCESS_KEY_ID"
  printf 'export TIGRIS_STORAGE_SECRET_ACCESS_KEY=%q\n' "$TIGRIS_STORAGE_SECRET_ACCESS_KEY"
  if [ -n "${TIGRIS_STORAGE_ENDPOINT:-}" ]; then
    printf 'export TIGRIS_STORAGE_ENDPOINT=%q\n' "$TIGRIS_STORAGE_ENDPOINT"
  fi
  echo 'export COORDINATOR_LOG_PATH=/root/run.log'
  if [ -n "${SAMPLES_PER_OP:-}" ]; then
    printf 'export SAMPLES_PER_OP=%q\n' "$SAMPLES_PER_OP"
  fi
  if [ -n "${PROVIDER_FILTER:-}" ]; then
    printf 'export PROVIDER_FILTER=%q\n' "$PROVIDER_FILTER"
  fi
  # NSC_TOKEN was unset locally so the `nsc` CLI uses our login auth, not
  # the SDK token. Re-emit it under its real name for the VM.
  if [ -n "${SANDBOX_NSC_TOKEN:-}" ]; then
    printf 'export NSC_TOKEN=%q\n' "$SANDBOX_NSC_TOKEN"
  fi
  # Forward provider creds the coordinator might need. Coordinator skips
  # providers whose required env vars are missing — no need to gate here.
  for v in \
    ARCHIL_API_KEY ARCHIL_REGION ARCHIL_DISK_ID \
    BL_API_KEY BL_WORKSPACE \
    CLOUDFLARE_SANDBOX_URL CLOUDFLARE_SANDBOX_SECRET \
    CSB_API_KEY \
    DAYTONA_API_KEY \
    DECLAW_API_KEY \
    E2B_API_KEY \
    HOPX_API_KEY \
    MODAL_TOKEN_ID MODAL_TOKEN_SECRET \
    RUNLOOP_API_KEY \
    SPRITES_TOKEN \
    TENSORLAKE_API_KEY \
    UPSTASH_BOX_API_KEY \
    VERCEL_TOKEN VERCEL_TEAM_ID VERCEL_PROJECT_ID
  do
    eval "val=\${$v:-}"
    [ -n "$val" ] && printf 'export %s=%q\n' "$v" "$val"
  done
  echo 'ulimit -n 200000'
  # nohup + & + redirected stdio is enough to detach. `disown` is a bash
  # builtin and not available in BusyBox sh on Wolfi.
  echo 'nohup node /root/coordinator.cjs > /root/run.log 2>&1 </dev/null &'
  echo 'rm -f -- "$0"   # self-destruct so creds never linger on disk'
} > "$STARTUP_FILE"

nsc instance upload "$INSTANCE_ID" "$STARTUP_FILE" /root/start.sh
nsc ssh "$INSTANCE_ID" -- chmod 600 /root/start.sh
nsc ssh "$INSTANCE_ID" -- sh /root/start.sh

# Verify the coordinator actually started. Retry briefly — `nsc ssh` can
# race the fork on a cold VM.
CONFIRMED=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  if nsc ssh "$INSTANCE_ID" -- pgrep -f coordinator.cjs > /dev/null 2>&1; then
    echo "[launch] node confirmed running on VM (after ${i}s)"
    CONFIRMED=1
    break
  fi
  sleep 1
done

if [ "$CONFIRMED" -ne 1 ]; then
  echo "[launch] ERROR: node not running on VM after 10s"
  echo "         tail /root/run.log for details:"
  nsc ssh "$INSTANCE_ID" -- tail -30 /root/run.log || true
  exit 1
fi

echo
echo "[launch] OK"
echo "  RUN_ID=$RUN_ID"
echo "  INSTANCE_ID=$INSTANCE_ID"
echo "  TIGRIS_PREFIX=s3://${TIGRIS_STORAGE_BUCKET}/warm-ops/${RUN_ID}/"
echo
echo "  Tail logs:    nsc ssh $INSTANCE_ID -- tail -f /root/run.log"
echo "  Done marker:  s3://${TIGRIS_STORAGE_BUCKET}/warm-ops/${RUN_ID}/done.json"
echo "  Stop:         nsc ssh $INSTANCE_ID -- pkill -TERM node"
echo "  Destroy:      nsc destroy --force $INSTANCE_ID"
