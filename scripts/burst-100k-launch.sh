#!/usr/bin/env bash
#
# Provision a Namespace VM, upload the burst-100k coordinator bundle, and
# hand off. The script lives for ~30s; the multi-hour benchmark continues on
# the VM independently.
#
# Required env:
#   PROVIDER                  e.g. e2b
#   PG_URL                    Neon connection string
#   R2_ENDPOINT, R2_BUCKET    Cloudflare R2 target for raw results
#   R2_ACCESS_KEY_ID
#   R2_SECRET_ACCESS_KEY
#   Provider-specific keys    e.g. E2B_API_KEY (validated by the coordinator)
#
# Optional env:
#   RUN_ID                    Defaults to "YYYYMMDDTHHMMSSZ-<sha8>-<provider>"
#   GITHUB_SHA                Defaults to `git rev-parse HEAD` or "local"
#   DURATION                  Defaults to 12h
#   MACHINE_TYPE              Defaults to 16x32
#   CONCURRENCY_TARGET        If set, overrides the provider's default
#                             (useful for smoke tests at N=10/100/1000)

set -euo pipefail

# ----- inputs ---------------------------------------------------------------
: "${PROVIDER:?PROVIDER required (e.g. e2b)}"
: "${PG_URL:?PG_URL required}"
: "${R2_ENDPOINT:?R2_ENDPOINT required}"
: "${R2_BUCKET:?R2_BUCKET required}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID required}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY required}"

GITHUB_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo local)}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:0:8}-${PROVIDER}}"
DURATION="${DURATION:-12h}"
MACHINE_TYPE="${MACHINE_TYPE:-16x32}"

echo "[launch] RUN_ID=$RUN_ID PROVIDER=$PROVIDER duration=$DURATION machine=$MACHINE_TYPE"
if [ -n "${CONCURRENCY_TARGET:-}" ]; then
  echo "[launch] CONCURRENCY_TARGET override: $CONCURRENCY_TARGET"
fi

# ----- 1. bundle coordinator -----------------------------------------------
echo "[launch] 1/6 bundling coordinator -> dist/burst-100k.cjs"
npm run --silent bundle:burst-100k

# ----- 2. apply Postgres schema (idempotent) -------------------------------
echo "[launch] 2/6 ensuring Postgres schema"
psql "$PG_URL" -v ON_ERROR_STOP=1 -q -f db/burst-100k.sql

# ----- 3. provision Namespace instance -------------------------------------
echo "[launch] 3/6 creating Namespace instance"
CIDFILE="$(mktemp)"
trap 'rm -f "$CIDFILE"' EXIT
nsc create \
  --bare \
  --machine_type "$MACHINE_TYPE" \
  --duration "$DURATION" \
  --cidfile "$CIDFILE"
INSTANCE_ID="$(cat "$CIDFILE")"
echo "[launch]   instance: $INSTANCE_ID"

# ----- 4. upload bundle ----------------------------------------------------
echo "[launch] 4/6 uploading coordinator bundle"
nsc instance upload "$INSTANCE_ID" dist/burst-100k.cjs /root/coordinator.cjs

# ----- 5. record run in Postgres BEFORE handing off ------------------------
# The coordinator UPSERTs the same row on startup; this INSERT exists so the
# run is recorded even if the SSH hand-off below fails.
echo "[launch] 5/6 recording run in Postgres"
psql "$PG_URL" -v ON_ERROR_STOP=1 -q -c "
  INSERT INTO runs (id, provider, commit_sha, instance_id, started_at, status, r2_prefix)
  VALUES ('$RUN_ID', '$PROVIDER', '$GITHUB_SHA', '$INSTANCE_ID', now(), 'running',
          's3://${R2_BUCKET}/${RUN_ID}/')
  ON CONFLICT (id) DO NOTHING;
"

# ----- 6. prepare VM and start coordinator detached ------------------------
echo "[launch] 6/6 preparing VM and starting coordinator"

# Wolfi --bare image has no node; install it.
nsc ssh "$INSTANCE_ID" -- apk add -q nodejs

# Build a startup script with env values embedded, upload it, execute it.
# Avoids the fragility of multi-arg `nsc ssh -- env ...` (line-continuation
# breaks have silently truncated the command in past attempts and caused
# `env` to fall back to printing the environment — leaking secrets).
# `printf '%q'` shell-quotes each value so unusual characters survive.
STARTUP_FILE="$(mktemp)"
chmod 600 "$STARTUP_FILE"
trap 'rm -f "$STARTUP_FILE" "$CIDFILE"' EXIT

{
  echo '#!/bin/sh'
  echo 'set -e'
  printf 'export RUN_ID=%q\n'               "$RUN_ID"
  printf 'export PROVIDER=%q\n'             "$PROVIDER"
  printf 'export INSTANCE_ID=%q\n'          "$INSTANCE_ID"
  printf 'export GITHUB_SHA=%q\n'           "$GITHUB_SHA"
  printf 'export PG_URL=%q\n'               "$PG_URL"
  printf 'export R2_ENDPOINT=%q\n'          "$R2_ENDPOINT"
  printf 'export R2_BUCKET=%q\n'            "$R2_BUCKET"
  printf 'export R2_ACCESS_KEY_ID=%q\n'     "$R2_ACCESS_KEY_ID"
  printf 'export R2_SECRET_ACCESS_KEY=%q\n' "$R2_SECRET_ACCESS_KEY"
  printf 'export E2B_API_KEY=%q\n'          "${E2B_API_KEY:-}"
  if [ -n "${CONCURRENCY_TARGET:-}" ]; then
    printf 'export CONCURRENCY_TARGET=%q\n' "$CONCURRENCY_TARGET"
  fi
  echo 'ulimit -n 200000'
  # nohup + & + redirected stdio is enough to detach. `disown` is a bash
  # builtin and not available in BusyBox sh on Wolfi (`disown: not found`).
  echo 'nohup node /root/coordinator.cjs > /root/run.log 2>&1 </dev/null &'
  echo 'rm -f -- "$0"   # self-destruct so creds never linger on disk'
} > "$STARTUP_FILE"

nsc instance upload "$INSTANCE_ID" "$STARTUP_FILE" /root/start.sh
nsc ssh "$INSTANCE_ID" -- chmod 600 /root/start.sh
nsc ssh "$INSTANCE_ID" -- sh /root/start.sh

# Verify the coordinator actually started — past failures silently exited
# the launch sequence with a 0 status while leaving the VM idle.
sleep 2
if nsc ssh "$INSTANCE_ID" -- pgrep -x node > /dev/null 2>&1; then
  echo "[launch] node confirmed running on VM"
else
  echo "[launch] ERROR: node not running on VM after hand-off"
  echo "         tail /root/run.log for details:"
  nsc ssh "$INSTANCE_ID" -- tail -30 /root/run.log || true
  exit 1
fi

echo
echo "[launch] OK"
echo "  RUN_ID=$RUN_ID"
echo "  INSTANCE_ID=$INSTANCE_ID"
echo
echo "  Tail logs:  nsc ssh $INSTANCE_ID -- tail -f /root/run.log"
echo "  Status:     psql \"\$PG_URL\" -c \"SELECT id,status,last_heartbeat FROM runs WHERE id='$RUN_ID';\""
echo "  Stop:       nsc ssh $INSTANCE_ID -- pkill -TERM node"
echo "  Destroy:    nsc destroy --force $INSTANCE_ID"
