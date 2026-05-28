-- Schema for the 100k burst benchmark.
--
-- Applied idempotently by src/scale/scripts/start.ts on every run, so all
-- statements use IF NOT EXISTS. To evolve the schema later, add a follow-up
-- .sql file and apply it once by hand — a migration framework is overkill
-- for two tables.
--
-- Concurrency note: this file is NOT safe to apply from multiple psql
-- processes in parallel — Postgres' `CREATE TABLE/INDEX IF NOT EXISTS` is
-- racy (two callers can pass the existence check and both try the catalog
-- insert). The launcher (src/scale/scripts/start.ts) applies the schema once
-- up-front in the orchestrator before spawning any per-VM launches, for this
-- reason. Don't paper this over with a session-level advisory lock — pooled
-- connection routers (Neon's `-pooler` endpoint, PgBouncer) hold session
-- locks past the client disconnect and orphan them.

CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,           -- e.g. 20260512T143000Z-a3f8d91-e2b
  provider              TEXT NOT NULL,
  commit_sha            TEXT NOT NULL,
  instance_id           TEXT NOT NULL,              -- Namespace instance ID
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  last_heartbeat        TIMESTAMPTZ,
  status                TEXT NOT NULL               -- running | done | failed
                        CHECK (status IN ('running', 'done', 'failed')),
  sandboxes_attempted   INTEGER,
  sandboxes_succeeded   INTEGER,                    -- count of sandbox_results.status='success'
  partials              INTEGER,                    -- count of sandbox_results.status='partial'
  readiness_failures    INTEGER,                    -- count of sandbox_results.status='readiness_failed'
  timeouts              INTEGER,                    -- count of sandbox_results.failure_class='timeout' AND status='failed'
  http_errors           INTEGER,                    -- count of sandbox_results.failure_class='http_error' AND status='failed'
  network_errors        INTEGER,                    -- count of sandbox_results.failure_class='network_error' AND status='failed'
  p50_latency_ms        INTEGER,
  p99_latency_ms        INTEGER,
  error_message         TEXT,                       -- populated on status='failed'
  tigris_prefix         TEXT NOT NULL               -- e.g. s3://<bucket>/<run_id>/
);

-- Idempotent column additions for already-existing tables (created before
-- these columns existed). CREATE TABLE IF NOT EXISTS above only fires on
-- a fresh DB; existing DBs need ALTER TABLE.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS timeouts           INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS http_errors        INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS network_errors     INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS partials           INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS readiness_failures INTEGER;

-- Sharded-burst columns. A "group" is N runs (one per VM) that together
-- form a single logical burst, tagged by src/scale/scripts/start.ts and
-- aggregated by src/scale/scripts/aggregate.ts.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS group_id    TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS shard_index INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS shard_count INTEGER;

CREATE INDEX IF NOT EXISTS runs_provider_started
  ON runs (provider, started_at DESC);

CREATE INDEX IF NOT EXISTS runs_group_id
  ON runs (group_id) WHERE group_id IS NOT NULL;

-- Partial index for the stuck-run query:
--   SELECT * FROM runs WHERE status='running' AND last_heartbeat < now() - interval '5 minutes';
CREATE INDEX IF NOT EXISTS runs_stuck
  ON runs (last_heartbeat) WHERE status = 'running';


CREATE TABLE IF NOT EXISTS sandbox_results (
  run_id            TEXT NOT NULL REFERENCES runs(id),
  sandbox_idx       INTEGER NOT NULL,               -- 0 .. concurrencyTarget-1
  started_at        TIMESTAMPTZ NOT NULL,            -- when sandbox.create() was called
  completed_at      TIMESTAMPTZ,                    -- when this sandbox's lifecycle ended
  latency_ms        INTEGER,                        -- "allocate" phase: sandbox.create() time
  first_command_ms  INTEGER,                        -- "first command" phase: runCommand('node -v') time; NULL if skipped/failed
  status            TEXT NOT NULL                   -- success | partial | readiness_failed | failed
                    CHECK (status IN ('success', 'partial', 'readiness_failed', 'failed')),
  failure_class     TEXT                            -- timeout | http_error | network_error; NULL on success
                    CHECK (failure_class IS NULL OR failure_class IN ('timeout', 'http_error', 'network_error')),
  http_status       INTEGER,
  error_code        TEXT,
  provider_metadata JSONB,                          -- adapter-exposed primitives (sandbox id, region, etc.)
  PRIMARY KEY (run_id, sandbox_idx)
);

CREATE INDEX IF NOT EXISTS sandbox_results_run_status
  ON sandbox_results (run_id, status);


-- One row per sharded-burst group_id, written by src/scale/scripts/aggregate.ts.
-- Scalars mirror `runs` so dashboards/queries can union the two for a single
-- N-sandbox view; full meta.json (distributions, concurrency timeline, etc.)
-- lives in `meta_json` JSONB and in Tigris at `tigris_prefix`/meta.json.
CREATE TABLE IF NOT EXISTS run_groups (
  id                   TEXT PRIMARY KEY,           -- group_id
  provider             TEXT NOT NULL,              -- comma-joined if shards span providers
  shard_count          INTEGER NOT NULL,
  shards_terminal      INTEGER NOT NULL,           -- how many shards were done/failed at aggregation time
  started_at           TIMESTAMPTZ NOT NULL,       -- earliest shard started_at
  ended_at             TIMESTAMPTZ,                -- latest shard ended_at (NULL if any shard still running)
  aggregated_at        TIMESTAMPTZ NOT NULL,       -- when this row was last written
  sandboxes_attempted  INTEGER NOT NULL,
  sandboxes_succeeded  INTEGER,
  partials             INTEGER,
  readiness_failures   INTEGER,
  timeouts             INTEGER,
  http_errors          INTEGER,
  network_errors       INTEGER,
  p50_latency_ms       INTEGER,
  p99_latency_ms       INTEGER,
  peak_concurrent      INTEGER,
  mean_concurrent      INTEGER,
  total_run_ms         INTEGER,
  tigris_prefix        TEXT,                       -- e.g. s3://<bucket>/groups/<group_id>/
  meta_json            JSONB                       -- full meta.json equivalent
);

CREATE INDEX IF NOT EXISTS run_groups_provider_started
  ON run_groups (provider, started_at DESC);

-- Idempotent column adds for already-existing tables.
ALTER TABLE sandbox_results ADD COLUMN IF NOT EXISTS provider_metadata JSONB;
ALTER TABLE sandbox_results ADD COLUMN IF NOT EXISTS first_command_ms  INTEGER;
ALTER TABLE sandbox_results ADD COLUMN IF NOT EXISTS failure_class     TEXT;

-- Status CHECK constraint changed from {ok, timeout, http_error, network_error}
-- to the four-state lifecycle taxonomy. Existing rows under the old values
-- are tolerated via NOT VALID; new inserts must use the new values.
ALTER TABLE sandbox_results DROP CONSTRAINT IF EXISTS sandbox_results_status_check;
ALTER TABLE sandbox_results ADD CONSTRAINT sandbox_results_status_check
  CHECK (status IN ('success', 'partial', 'readiness_failed', 'failed')) NOT VALID;
ALTER TABLE sandbox_results DROP CONSTRAINT IF EXISTS sandbox_results_failure_class_check;
ALTER TABLE sandbox_results ADD CONSTRAINT sandbox_results_failure_class_check
  CHECK (failure_class IS NULL OR failure_class IN ('timeout', 'http_error', 'network_error')) NOT VALID;
