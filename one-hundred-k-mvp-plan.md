# Benchmark Orchestration MVP — 100k Burst

An opt-in, multi-hour 100k-sandbox burst benchmark for sandbox providers, run
on dedicated Namespace VMs and orchestrated from this benchmarks repo. This
sits *alongside* the existing daily ~100-burst benchmark (`src/sandbox/`),
not as a replacement: providers participate in the 100k path only if they
explicitly opt in.

---

## Problem

The existing daily benchmark runs end-to-end inside GitHub Actions and works
well at small scale (~100 sandboxes, a few minutes). Extending the same setup
to 100k sandboxes — runs that take several hours per provider — has not been
viable. The Namespace runners themselves are fine; GitHub's orchestration
layer (queue, runner pickup, API, log ingestion, status reporting) flakes
often enough that multi-hour runs regularly fail to start, hang mid-run, or
finish without reporting back.

The fix is structural: use GitHub Actions only for the 30-second job of
provisioning a dedicated VM and handing off a coordinator. Once the
coordinator is running on its own VM, anything happening on GitHub's side is
irrelevant to the run.

---

## Goals

- **Reliable.** GitHub Actions outages, queue stalls, or runner-pickup races
  cannot kill an in-flight benchmark.
- **Isolated.** Each provider being benchmarked runs in its own VM. No
  cross-provider interference for CPU, network, or kernel state.
- **Durable.** Partial results survive coordinator crashes; a VM failure
  loses at most a few seconds of in-flight data.
- **Minimal.** Smallest possible code and configuration surface for v1. Easy
  to extend later; trivial to operate now.
- **Opt-in.** Providers participate only if they explicitly want this burst
  exercise — they're not added automatically alongside the daily benchmark.

## Non-goals for v1

- Replacing or modifying the daily ~100-burst benchmark in `src/sandbox/`.
- PR-comment triggers, status checks, automated regression alerts.
- Dashboards or visual reporting.
- Multi-region or active-active redundancy.
- Cross-run comparisons or historical analysis (the data will land in
  Postgres and Tigris; querying it is out of scope here).

---

## Where this fits in the benchmarks repo

The 100k burst is a new sibling module to the existing `src/sandbox/`,
`src/browser/`, and `src/storage/` families. It does **not** plug into
`src/run.ts` — that dispatcher assumes in-process execution and local-JSON
output, which is the wrong model for a coordinator that runs detached on a
remote VM and streams to Tigris/Postgres.

```
src/burst-100k/
  coordinator.ts        ← esbuild entry; the long-running process on the VM
  providers.ts          ← opt-in provider list (extends existing ProviderConfig)
  runner.ts             ← concurrency limiter, ramp, shared https.Agent
  sinks/
    tigris.ts           ← JSONL multipart upload + heartbeat.json
    postgres.ts         ← runs table + batch sandbox_results inserts + heartbeat
  types.ts

scripts/
  burst-100k-launch.sh  ← the ~50-line provision-and-detach orchestrator

db/
  burst-100k.sql        ← CREATE TABLE IF NOT EXISTS (idempotent, auto-applied)

.github/workflows/
  burst-100k.yml        ← workflow_dispatch (+ schedule later)
```

The existing daily benchmark (`src/sandbox/`, `src/run.ts`) is untouched.

**Provider opt-in is implicit.** A provider participates in the 100k burst
iff there's an entry for it in `src/burst-100k/providers.ts`. There is no
separate JSON registry. This mirrors the existing convention from
`src/sandbox/providers.ts` — providers are TS-defined, with a `createCompute`
closure and a `requiredEnvVars` list that gates the run if anything is
missing.

---

## Architecture

```
GitHub Action (workflow_dispatch / schedule)
   │  (lives for ~30s — bundle, provision, hand off, exit)
   │
   ├─ npx esbuild src/burst-100k/coordinator.ts → coordinator.js
   ├─ psql -f db/burst-100k.sql                  (idempotent schema bootstrap)
   ├─ nsc create --machine_type 16x32 --duration 12h
   ├─ nsc instance upload <id> coordinator.js
   ├─ nsc ssh <id> -- "nohup node coordinator.js &"   ← detached
   ├─ INSERT INTO runs (id, provider, started_at, status='running')
   └─ exit ✓
                              │
                              ▼
                     Namespace instance (one per provider, lives for hours)
                        ├─ bursts 100k concurrent requests at target provider
                        ├─ streams JSONL → Tigris (raw per-request records)
                        ├─ batch-inserts → Postgres (queryable rows)
                        ├─ heartbeat → Postgres every 30s
                        └─ UPDATE runs SET status='done' on completion
                           (instance self-destroys at --duration deadline)
```

The Action and the coordinator are completely decoupled after the SSH
hand-off. The Action can crash, the GitHub API can go down, the workflow page
can hang — none of it affects the running benchmark.

---

## Components

### 1. GitHub Action — single parameterized workflow

`.github/workflows/burst-100k.yml`:

```yaml
name: burst-100k
on:
  workflow_dispatch:
    inputs:
      provider:
        required: true
        type: choice
        options: [e2b, modal, daytona, codesandbox]  # only providers opted in
  # schedule trigger deliberately omitted for v1 — see open questions

jobs:
  launch:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      id-token: write    # for Namespace OIDC auth
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - uses: namespacelabs/nscloud-setup@v0

      - name: Launch benchmark
        env:
          PROVIDER:       ${{ inputs.provider }}
          TIGRIS_STORAGE_ENDPOINT:    ${{ secrets.TIGRIS_STORAGE_ENDPOINT }}
          TIGRIS_STORAGE_ACCESS_KEY_ID:  ${{ secrets.TIGRIS_STORAGE_ACCESS_KEY_ID }}
          TIGRIS_STORAGE_SECRET_ACCESS_KEY:  ${{ secrets.TIGRIS_STORAGE_SECRET_ACCESS_KEY }}
          TIGRIS_STORAGE_BUCKET:      ${{ secrets.TIGRIS_STORAGE_BUCKET }}
          PG_URL:         ${{ secrets.PG_URL }}
          # Provider env vars — same names already used by the daily benchmark
          # (see src/sandbox/providers.ts). Passed through unconditionally; the
          # coordinator's requiredEnvVars check decides what's actually needed.
          E2B_API_KEY:        ${{ secrets.E2B_API_KEY }}
          MODAL_TOKEN_ID:     ${{ secrets.MODAL_TOKEN_ID }}
          MODAL_TOKEN_SECRET: ${{ secrets.MODAL_TOKEN_SECRET }}
          DAYTONA_API_KEY:    ${{ secrets.DAYTONA_API_KEY }}
          CSB_API_KEY:        ${{ secrets.CSB_API_KEY }}
          # …extend as more providers opt in
        run: ./scripts/burst-100k-launch.sh
```

`scripts/burst-100k-launch.sh` is the entire orchestration program. ~50
lines:

```bash
#!/usr/bin/env bash
set -euo pipefail

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:0:8}-${PROVIDER}"

# 1. Bundle coordinator to a single JS file
npx --yes esbuild src/burst-100k/coordinator.ts \
  --bundle --platform=node --target=node20 \
  --outfile=coordinator.js

# 2. Ensure Postgres schema exists (idempotent: CREATE TABLE IF NOT EXISTS)
psql "$PG_URL" -f db/burst-100k.sql

# 3. Provision a dedicated Namespace instance for this run
CIDFILE="$(mktemp)"
nsc create \
  --bare \
  --machine_type 16x32 \
  --duration 12h \
  --cidfile "$CIDFILE"
INSTANCE_ID="$(cat "$CIDFILE")"

# 4. Upload bundle
nsc instance upload "$INSTANCE_ID" coordinator.js /root/coordinator.js

# 5. Record the run as started, BEFORE handing off
psql "$PG_URL" -c "
  INSERT INTO runs (id, provider, commit_sha, instance_id, started_at, status, tigris_prefix)
  VALUES ('$RUN_ID', '$PROVIDER', '$GITHUB_SHA', '$INSTANCE_ID', now(), 'running',
          's3://${TIGRIS_STORAGE_BUCKET}/${RUN_ID}/');
"

# 6. Start coordinator detached on the instance, forwarding env.
#    The coordinator reads PROVIDER, looks up the matching entry in
#    src/burst-100k/providers.ts, and validates its requiredEnvVars.
nsc ssh "$INSTANCE_ID" -- bash -c "'
  ulimit -n 200000
  export RUN_ID=$RUN_ID PROVIDER=$PROVIDER \
         TIGRIS_STORAGE_ENDPOINT=$TIGRIS_STORAGE_ENDPOINT TIGRIS_STORAGE_BUCKET=$TIGRIS_STORAGE_BUCKET \
         TIGRIS_STORAGE_ACCESS_KEY_ID=$TIGRIS_STORAGE_ACCESS_KEY_ID TIGRIS_STORAGE_SECRET_ACCESS_KEY=$TIGRIS_STORAGE_SECRET_ACCESS_KEY \
         PG_URL=\"$PG_URL\" \
         E2B_API_KEY=\"${E2B_API_KEY:-}\" \
         MODAL_TOKEN_ID=\"${MODAL_TOKEN_ID:-}\" \
         MODAL_TOKEN_SECRET=\"${MODAL_TOKEN_SECRET:-}\" \
         DAYTONA_API_KEY=\"${DAYTONA_API_KEY:-}\" \
         CSB_API_KEY=\"${CSB_API_KEY:-}\"
  nohup node /root/coordinator.js > /root/run.log 2>&1 &
  disown
'"

echo "Run $RUN_ID started on instance $INSTANCE_ID"
```

That is the entire Action. From green-light to "coordinator is running" is
under a minute. The Action then exits successfully and stops mattering.

### 2. Namespace instance — one per provider

- **Shape:** `16x32` (16 vCPU, 32 GB) is a reasonable starting point for 100k
  concurrent outbound HTTPS connections from one Node process. Bump to
  `32x64` if you saturate event-loop or memory; this is I/O-bound, but TLS
  handshakes and DNS still want headroom.
- **Lifetime:** `--duration 12h` — the instance self-destructs at the deadline
  even if the coordinator hangs. Tune to the longest expected run plus margin.
- **Services:** `--bare` — we don't need k3s; a plain VM is lighter and
  starts faster. (Replaces the older `--features kubernetes-disabled` flag.)
- **Network:** one Namespace instance per provider means the source-IP pool
  is naturally partitioned by target. Confirm with Namespace support whether
  each instance gets a dedicated egress IP or shares a SNAT pool — this
  matters for two reasons:
    1. The target provider may rate-limit by source IP.
    2. 100k concurrent outbound connections can exhaust ephemeral ports on a
       shared NAT (~28k available per source IP under default settings).
  If egress IP is shared, request a dedicated egress IP per instance, or run
  the burst from multiple smaller instances per provider.

### 3. Coordinator — Node/TypeScript, single-file bundle

The coordinator is **new code** under `src/burst-100k/`, not an adaptation of
`src/sandbox/`. It reuses the same `@computesdk/<provider>` adapter packages
the daily benchmark uses, and follows the same `requiredEnvVars`-based skip
convention from `src/sandbox/providers.ts`.

Responsibilities:

- Read core inputs from environment variables (`RUN_ID`, `PROVIDER`,
  `TIGRIS_STORAGE_*`, `PG_URL`).
- Look up the entry for `$PROVIDER` in `src/burst-100k/providers.ts`. That
  entry declares `requiredEnvVars`, `createCompute()`, `sandboxOptions`, plus
  burst-specific tuning fields.
- If any `requiredEnvVars` are missing, fail fast and `UPDATE` the `runs`
  row to `status='failed'` with a clear message.
- Stream results to Tigris and Postgres as the run progresses.
- Emit a heartbeat every 30s.
- Trap `SIGTERM`, flush in-flight writes, exit cleanly.

`src/burst-100k/providers.ts` extends the existing `ProviderConfig` shape
from `src/sandbox/types.ts`:

```ts
interface BurstProviderConfig extends ProviderConfig {
  /** Peak target concurrency for this provider's burst */
  concurrencyTarget: number;       // typically 100_000, may be lower per provider
  /** Ramp from 0 to concurrencyTarget over this many seconds */
  rampSeconds: number;             // 30–60 is reasonable
  /** Optional per-request timeout override (ms) */
  perRequestTimeoutMs?: number;
}
```

A provider opts in by adding an entry to this file (and ensuring its env
vars are in GitHub Secrets and forwarded by the workflow). No JSON config,
no second registry.

Bundled with `esbuild --bundle --platform=node --target=node20` into a single
`coordinator.js`. No `node_modules` upload, no `npm ci` on the VM, no native
deps. (If a native dep is ever required, switch to uploading a tarball of
`src/ package.json package-lock.json` and running `npm ci` on the VM — same
overall shape, one extra step.)

Critical implementation details for the 100k burst:

- **One shared `https.Agent`** with `keepAlive: true` and an explicit
  `maxSockets` (e.g. 50_000) — not `Infinity`, which saturates the kernel.
  Use `undici` for better performance if not already.
- **Concurrency limiter** (`p-limit` or a small custom queue) to ramp to
  target concurrency over 30–60 seconds. True "100k at once" tanks tail
  latency and triggers provider-side overload behavior in a way that's hard
  to interpret.
- **DNS** for the target provider: resolve once at startup, reuse the IP.
- **Local result file** via `fs.createWriteStream` in append mode, JSONL
  format. A background loop reads chunks and uploads to Tigris using
  multipart upload (see Tigris layout below).
- **Memory:** never hold the result set in memory. Write line, forget line.
- **`ulimit -n 200000`** must be set before `node` starts (the launch script
  does this in the SSH command).
- **Sysctl** (if defaults are too low — usually fine on Namespace, but
  worth setting in the SSH preamble for safety):
    - `net.ipv4.ip_local_port_range = 1024 65535`
    - `net.ipv4.tcp_tw_reuse = 1`
- **Heartbeat** every 30s: write `{done, in_flight, errors, ts}` to Postgres
  (`UPDATE runs SET last_heartbeat = ...`) AND overwrite a tiny JSON object
  in Tigris at `s3://<bucket>/<run_id>/heartbeat.json`. The Postgres heartbeat
  lets you `SELECT * FROM runs WHERE last_heartbeat < now() - interval '5
  minutes'` to find stuck runs.
- **Completion**: on clean exit, `UPDATE runs SET status='done',
  ended_at=now(), sandboxes_succeeded=..., p50_latency_ms=..., ...`. On
  uncaught error, same query with `status='failed'` and the error in a text
  column.

### 4. Data stores — Tigris and Postgres

Both stores are pre-existing infra. The coordinator writes to both.

---

## Data model

### Postgres — queryable, structured

`db/burst-100k.sql`, applied idempotently by
`scripts/burst-100k-launch.sh` on every run:

```sql
CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,           -- e.g. 20260511T143000Z-a3f8d91-e2b
  provider              TEXT NOT NULL,
  commit_sha            TEXT NOT NULL,
  instance_id           TEXT NOT NULL,              -- Namespace instance ID
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  last_heartbeat        TIMESTAMPTZ,
  status                TEXT NOT NULL,              -- running | done | failed
  sandboxes_attempted   INTEGER,
  sandboxes_succeeded   INTEGER,
  p50_latency_ms        INTEGER,
  p99_latency_ms        INTEGER,
  error_message         TEXT,                       -- populated on failure
  tigris_prefix             TEXT NOT NULL               -- e.g. s3://bench/<run_id>/
);

CREATE INDEX IF NOT EXISTS runs_provider_started ON runs (provider, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_stuck            ON runs (last_heartbeat) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS sandbox_results (
  run_id        TEXT NOT NULL REFERENCES runs(id),
  sandbox_idx   INTEGER NOT NULL,                   -- 0..99_999
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  latency_ms    INTEGER,
  status        TEXT NOT NULL,                      -- ok | timeout | http_error | network_error
  http_status   INTEGER,
  error_code    TEXT,
  PRIMARY KEY (run_id, sandbox_idx)
);

CREATE INDEX IF NOT EXISTS sandbox_results_run_status ON sandbox_results (run_id, status);
```

The launch script applies this on every run. Once tables exist the file is
a no-op. When the schema legitimately needs to change later, add a
follow-up `.sql` file and apply it once by hand — a migration framework is
overkill for two tables.

Batch-insert `sandbox_results` in groups of 1000 with a single `COPY` or
multi-row `INSERT` to keep the write rate manageable. 100k rows per run is
small for Postgres; the index size matters more than insert rate.

### Tigris — raw, append-only

One prefix per run:

```
s3://<bucket>/<run_id>/
   ├── raw.jsonl              # one line per sandbox: full record incl. headers, response body
   ├── coordinator.log        # stdout/stderr of the Node process
   ├── heartbeat.json         # overwritten every 30s: {done, in_flight, errors, ts}
   └── meta.json              # written once at completion: final summary
```

`raw.jsonl` is the source of truth — anything you might want to re-analyze
later lives here. Postgres is the queryable projection. If Postgres data
ever gets corrupted or you need a new column, you can rebuild from Tigris.

Tigris is S3-compatible, so use the `@aws-sdk/client-s3` package with the
Tigris endpoint. Use multipart upload for `raw.jsonl` so the coordinator can flush
chunks every few seconds; this is what gives you the "partial results
survive a crash" property.

---

## Secrets & credentials flow

```
GitHub Secrets
   │
   ▼
GitHub Action env (set in workflow.yml under `env:`)
   │
   ▼
burst-100k-launch.sh (inherits env)
   │
   ▼
nsc ssh ... bash -c 'export VAR=...; node coordinator.js'
   │
   ▼
Coordinator process.env (read at startup, never written to disk)
```

Secrets stored in GitHub (most already exist for the daily benchmark):

- `TIGRIS_STORAGE_ENDPOINT`, `TIGRIS_STORAGE_BUCKET`, `TIGRIS_STORAGE_ACCESS_KEY_ID`, `TIGRIS_STORAGE_SECRET_ACCESS_KEY`
- `PG_URL` (full Postgres connection string including credentials)
- Provider-specific env vars matching the existing convention in
  `src/sandbox/providers.ts` (e.g. `E2B_API_KEY`, `MODAL_TOKEN_ID` +
  `MODAL_TOKEN_SECRET`, `DAYTONA_API_KEY`, `CSB_API_KEY`, …).
  Multi-env-var providers stay multi-env-var here — no generic
  `PROVIDER_API_KEY` lookup, because that doesn't fit the existing
  per-provider conventions and would require reshaping working credentials.

Namespace authentication uses OIDC from GitHub Actions via
`namespacelabs/nscloud-setup@v0` — no static API token in secrets.

The Namespace instance is ephemeral (`--duration 12h`) and dies after the
run, so there is no long-lived credential exposure on the VM side.

---

## Reliability properties

What this design buys versus running the benchmark inside a GitHub Actions
job directly:

1. **GitHub Actions can fail freely after hand-off.** The Action's only job
   is the ~30-second provision-and-launch sequence. If it fails before
   `nsc ssh`, no run started — re-run the workflow. If it fails after, the
   run is already going on the Namespace VM and the Action's failure is
   cosmetic. Either way, no half-state to clean up.
2. **No GitHub-side queue between trigger and start.** A regular Action
   waits for runner pickup, which is where most flakiness manifests. Here,
   the Action is short enough that it almost always picks up immediately;
   the multi-hour work doesn't sit in any GitHub queue at all.
3. **No GitHub-side log ingestion for the long-running part.** The
   coordinator writes logs to local disk on the VM and to Tigris. You can SSH
   into the VM (`nsc ssh <id>`) and `tail -f /root/run.log` at any time.
4. **Durable partial results.** Tigris (S3) multipart upload flushes every few
   seconds. Postgres rows are batch-inserted every 1k. A coordinator crash
   loses seconds of in-flight data, not the whole run.
5. **Stuck-run detection is one SQL query.** `SELECT * FROM runs WHERE
   status='running' AND last_heartbeat < now() - interval '5 minutes'`.
6. **Per-provider blast radius.** A run that misbehaves (gets rate-limited
   into oblivion, leaks file descriptors, whatever) cannot affect other
   providers' runs because they're on different VMs.

---

## Operational notes

### Sizing the Namespace instance

Start at `16x32`. Watch for these symptoms during the first real run:

- Event loop lag > 100ms sustained → CPU bound, go to `32x64`.
- `EADDRNOTAVAIL` or `connect: cannot assign requested address` →
  ephemeral port exhaustion. Request dedicated egress IP or shard the
  burst across multiple smaller instances.
- OOM → memory bound, almost certainly because the result set is being
  held in memory somewhere. Fix the coordinator, don't just upsize.
- Bandwidth at NIC ceiling → harder to hit at 100k connections unless
  responses are large; if it does happen, smaller burst per instance and
  shard.

### `nsc` from inside the Action

`namespacelabs/nscloud-setup@v0` installs `nsc` and authenticates via OIDC.
After that step, every `nsc` command in subsequent steps Just Works.
Confirm the OIDC trust is configured for the GitHub org pointing at the
right Namespace tenant (one-time setup in the Namespace dashboard).

### What to do when a run is mid-flight and you need to check on it

- Postgres: `SELECT * FROM runs WHERE id = '<run_id>';` — status,
  heartbeat freshness, current counts.
- Tigris: `aws --endpoint-url $TIGRIS_STORAGE_ENDPOINT s3 cp s3://<bucket>/<run_id>/heartbeat.json -`
  for the in-flight summary.
- VM: `nsc ssh <instance_id>` and `tail -f /root/run.log`.
- Stop a run: `nsc ssh <instance_id> -- pkill -TERM node` (coordinator
  traps SIGTERM and flushes). Then `nsc destroy <instance_id>` if you
  don't want to wait for the duration deadline.

---

## Build order

1. **Coordinator local smoke test.** Write `src/burst-100k/coordinator.ts`
   and a first entry in `src/burst-100k/providers.ts` (start with one
   provider). Reuse the existing `@computesdk/<provider>` adapter package.
   Add Tigris and Postgres write paths. Run locally against N=100 sandboxes.
   Verify rows land in Postgres and JSONL lands in Tigris.
2. **Schema verification.** `psql "$PG_URL" -f db/burst-100k.sql` runs
   cleanly the first time and on re-runs. The launch script will do this
   automatically, but verify once by hand to confirm the file is correct.
3. **Manual end-to-end on Namespace.** From a developer laptop: `nsc
   create`, `nsc instance upload`, `nsc ssh` to start the coordinator
   detached. Run a small benchmark (N=1000) and verify durable result
   storage works under a real network.
4. **GitHub Action.** Write `.github/workflows/burst-100k.yml` and
   `scripts/burst-100k-launch.sh`. Trigger via `workflow_dispatch` with a
   single provider. Run the full 100k benchmark end-to-end on one provider.
5. **Add more opted-in providers.** For each: add an entry to
   `src/burst-100k/providers.ts`, ensure its env vars are in GitHub Secrets
   and forwarded by the workflow, add it to the `provider` input choices.
6. **Scheduled runs.** Add the cron trigger to the workflow. Decide
   whether all opted-in providers run on the same schedule or staggered.

Total scope: a YAML file, a ~50-line shell script, a new `src/burst-100k/`
TS module, and a two-table Postgres schema. Everything else is
configuration.

---

## Open questions

1. **Egress IP per Namespace instance.** Confirm with Namespace support
   whether each instance has a dedicated egress IP or shares a SNAT pool.
   This determines whether one instance can do 100k concurrent
   outbound connections to a single target, or whether the burst needs
   to be sharded across multiple instances per provider.
2. **Bundle vs. tarball.** Going with the esbuild single-file bundle for
   v1. If any `@computesdk/<provider>` adapter ever requires a native
   binary, switch to the tarball-plus-`npm ci` approach — same overall
   shape, one extra step.
3. **`workflow_dispatch` only, or schedule too in v1?** Schedule adds no
   complexity but does mean automatic runs that need a human to look at
   them. Starting with manual-only; add cron after the first few clean
   runs.
4. **Run ID format.** The proposal uses
   `YYYYMMDDTHHMMSSZ-<sha8>-<provider>`. Sortable, human-readable,
   collision-free for sane workflow rates. Adjust if there's an existing
   convention.

*(Previously-open question on per-provider JSON config schema is **closed**:
providers are TS-defined in `src/burst-100k/providers.ts`, extending the
existing `ProviderConfig` from `src/sandbox/types.ts`. No JSON files; opt-in
is implicit via presence in this file plus the `requiredEnvVars` skip
logic.)*
