#!/usr/bin/env bash
#
# Provision a Namespace VM, upload the burst-100k coordinator bundle, and
# hand off. The script lives for ~30s; the multi-hour benchmark continues on
# the VM independently.
#
# Required env:
#   PROVIDER                          e.g. e2b
#   PG_URL                            Neon connection string
#   TIGRIS_STORAGE_ENDPOINT, _BUCKET  Tigris (S3-compat) target for raw results
#   TIGRIS_STORAGE_ACCESS_KEY_ID
#   TIGRIS_STORAGE_SECRET_ACCESS_KEY
#   Provider-specific keys            e.g. E2B_API_KEY (validated by coordinator)
#
# Optional env:
#   RUN_ID                    Defaults to "YYYYMMDDTHHMMSSZ-<sha8>-<provider>"
#   GITHUB_SHA                Defaults to `git rev-parse HEAD` or "local"
#   DURATION                  Defaults to 12h
#   MACHINE_TYPE              Defaults to 16x32
#   CONCURRENCY_TARGET        If set, overrides the provider's default
#                             (useful for smoke tests at N=10/100/1000)
#   GROUP_ID                  Sharded-burst group identifier (set by
#                             burst-100k-launch-sharded.ts when one logical
#                             burst is spread across multiple VMs).
#   SHARD_INDEX               0..SHARD_COUNT-1 — this VM's position in group.
#   SHARD_COUNT               Total VMs in the group.

set -euo pipefail

# ----- inputs ---------------------------------------------------------------
: "${PROVIDER:?PROVIDER required (e.g. e2b)}"
: "${PG_URL:?PG_URL required}"
: "${TIGRIS_STORAGE_ENDPOINT:?TIGRIS_STORAGE_ENDPOINT required}"
: "${TIGRIS_STORAGE_BUCKET:?TIGRIS_STORAGE_BUCKET required}"
: "${TIGRIS_STORAGE_ACCESS_KEY_ID:?TIGRIS_STORAGE_ACCESS_KEY_ID required}"
: "${TIGRIS_STORAGE_SECRET_ACCESS_KEY:?TIGRIS_STORAGE_SECRET_ACCESS_KEY required}"

GITHUB_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo local)}"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:0:8}-${PROVIDER}}"
RUN_DATE="${RUN_DATE:-$(date -u +%Y-%m-%d)}"
DURATION="${DURATION:-12h}"
MACHINE_TYPE="${MACHINE_TYPE:-16x32}"
SHARD_INDEX_FOR_PATH="${SHARD_INDEX:-0}"

echo "[launch] RUN_ID=$RUN_ID PROVIDER=$PROVIDER duration=$DURATION machine=$MACHINE_TYPE"
if [ -n "${CONCURRENCY_TARGET:-}" ]; then
  echo "[launch] CONCURRENCY_TARGET override: $CONCURRENCY_TARGET"
fi

# ----- 1. bundle coordinator -----------------------------------------------
echo "[launch] 1/6 bundling coordinator -> dist/burst-100k.cjs"
npm run --silent bundle:burst-100k

# ----- 2. apply Postgres schema (idempotent) -------------------------------
# Skipped when SKIP_SCHEMA is set — the sharded launcher applies the schema
# once up-front because `CREATE TABLE/INDEX IF NOT EXISTS` isn't race-safe
# under N parallel applies.
if [ -n "${SKIP_SCHEMA:-}" ]; then
  echo "[launch] 2/6 skipping Postgres schema (SKIP_SCHEMA set)"
else
  echo "[launch] 2/6 ensuring Postgres schema"
  psql "$PG_URL" -v ON_ERROR_STOP=1 -q -f db/burst-100k.sql
fi

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
# When GROUP_ID/SHARD_* are set they're written here too so the row is fully
# tagged even if the coordinator never starts (network race, OOM on the VM, …).
GROUP_ID_LIT="$( [ -n "${GROUP_ID:-}" ]    && printf "'%s'" "$GROUP_ID"    || echo NULL )"
SHARD_IDX_LIT="$( [ -n "${SHARD_INDEX:-}" ] && printf "%d"   "$SHARD_INDEX" || echo NULL )"
SHARD_CNT_LIT="$( [ -n "${SHARD_COUNT:-}" ] && printf "%d"   "$SHARD_COUNT" || echo NULL )"
psql "$PG_URL" -v ON_ERROR_STOP=1 -q -c "
  INSERT INTO runs (id, provider, commit_sha, instance_id, started_at, status, tigris_prefix,
                    group_id, shard_index, shard_count)
  VALUES ('$RUN_ID', '$PROVIDER', '$GITHUB_SHA', '$INSTANCE_ID', now(), 'running',
          's3://${TIGRIS_STORAGE_BUCKET}/${RUN_DATE}/${PROVIDER}/s${SHARD_INDEX_FOR_PATH}/',
          $GROUP_ID_LIT, $SHARD_IDX_LIT, $SHARD_CNT_LIT)
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
  printf 'export RUN_DATE=%q\n'             "$RUN_DATE"
  printf 'export PROVIDER=%q\n'             "$PROVIDER"
  printf 'export INSTANCE_ID=%q\n'          "$INSTANCE_ID"
  printf 'export GITHUB_SHA=%q\n'           "$GITHUB_SHA"
  printf 'export PG_URL=%q\n'               "$PG_URL"
  printf 'export TIGRIS_STORAGE_ENDPOINT=%q\n'          "$TIGRIS_STORAGE_ENDPOINT"
  printf 'export TIGRIS_STORAGE_BUCKET=%q\n'            "$TIGRIS_STORAGE_BUCKET"
  printf 'export TIGRIS_STORAGE_ACCESS_KEY_ID=%q\n'     "$TIGRIS_STORAGE_ACCESS_KEY_ID"
  printf 'export TIGRIS_STORAGE_SECRET_ACCESS_KEY=%q\n' "$TIGRIS_STORAGE_SECRET_ACCESS_KEY"
  # Tell the coordinator where to read its own stdout/stderr from (the file
  # the line below redirects to). Coordinator uploads this to Tigris on
  # heartbeat + shutdown so logs survive VM tear-down.
  echo 'export COORDINATOR_LOG_PATH=/root/run.log'
  # Provider-specific credentials — forward whatever's in the env. Coordinator's
  # `requiredEnvVars` check fails fast if its provider's vars are missing.
  for v in E2B_API_KEY MODAL_TOKEN_ID MODAL_TOKEN_SECRET DAYTONA_API_KEY CSB_API_KEY RUNLOOP_API_KEY TENSORLAKE_API_KEY DECLAW_API_KEY; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && printf 'export %s=%q\n' "$v" "$val"
  done
  if [ -n "${CONCURRENCY_TARGET:-}" ]; then
    printf 'export CONCURRENCY_TARGET=%q\n' "$CONCURRENCY_TARGET"
  fi
  # Sharded-burst metadata (set by scripts/burst-100k-launch-sharded.ts).
  # Forwarded as-is when present; coordinator treats absence as single-VM mode.
  for v in GROUP_ID SHARD_INDEX SHARD_COUNT; do
    eval "val=\${$v:-}"
    [ -n "$val" ] && printf 'export %s=%q\n' "$v" "$val"
  done
  echo 'ulimit -n 200000'
  # nohup + & + redirected stdio is enough to detach. `disown` is a bash
  # builtin and not available in BusyBox sh on Wolfi (`disown: not found`).
  echo 'nohup node /root/coordinator.cjs > /root/run.log 2>&1 </dev/null &'
  echo 'rm -f -- "$0"   # self-destruct so creds never linger on disk'
} > "$STARTUP_FILE"

nsc instance upload "$INSTANCE_ID" "$STARTUP_FILE" /root/start.sh
nsc ssh "$INSTANCE_ID" -- chmod 600 /root/start.sh
nsc ssh "$INSTANCE_ID" -- sh /root/start.sh

# Verify the coordinator actually started. Past failures silently exited
# the launch sequence with a 0 status while leaving the VM idle, so this is
# load-bearing. Retry briefly because `nsc ssh` can race the fork on a cold
# VM, and use `pgrep -f` against the command line (more reliable than
# `pgrep -x node` under BusyBox).
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
echo
echo "  Tail logs:  nsc ssh $INSTANCE_ID -- tail -f /root/run.log"
echo "  Status:     psql \"\$PG_URL\" -c \"SELECT id,status,last_heartbeat FROM runs WHERE id='$RUN_ID';\""
echo "  Stop:       nsc ssh $INSTANCE_ID -- pkill -TERM node"
echo "  Destroy:    nsc destroy --force $INSTANCE_ID"
