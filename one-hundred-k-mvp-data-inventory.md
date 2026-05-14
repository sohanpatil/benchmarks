# Burst-100k Data Inventory

What data the burst-100k benchmark captures today, what's cheap to add, and
what's harder. Pairs with [one-hundred-k-mvp-plan.md](one-hundred-k-mvp-plan.md)
and [one-hundred-k-mvp-checklist.md](one-hundred-k-mvp-checklist.md).

---

## Captured right now

| Data | Where | Notes |
| --- | --- | --- |
| Per-run summary: provider, commit_sha, instance_id, start/end/heartbeat times, status, attempted/succeeded counts, p50/p99 latency, error_message, tigris prefix | Postgres `runs` | One row per run; easy to query |
| Per-sandbox: started_at, completed_at, latency_ms, status (ok/timeout/http_error/network_error), http_status, error_code | Postgres `sandbox_results` | One row per sandbox attempt |
| Same as above + `error_message` (truncated to 500 chars) | Tigris `<run_id>/raw.jsonl` | Source of truth; rebuild Postgres from this if needed |
| Mid-run progress snapshots: done, in_flight, errors, timestamp | Tigris `<run_id>/heartbeat.json` | Overwritten every 30s |
| Final summary (run_id, provider, attempted/succeeded, p50/p99, ended_at) | Tigris `<run_id>/meta.json` | Written once at clean exit |
| Coordinator stdout/stderr | VM `/root/run.log` AND Tigris `<run_id>/coordinator.log` | Uploaded by the coordinator at every heartbeat (30s) and on shutdown ✅ |

---

## Easy to add (~minutes of work)

| Data | Approach | Why it's useful |
| --- | --- | --- |
| ~~Full latency histogram (p25, p75, p95, p99, p99.9, max)~~ ✅ Landed | `latency_distribution` object in Tigris `meta.json` carries count, min, p10/p25/p50/p75/p90/p95/p99/p999, max, mean. Postgres `runs` stays p50/p99-only — meta.json is the analytical view. | — |
| ~~Error-type histogram~~ ✅ Landed | New `timeouts`/`http_errors`/`network_errors` columns on Postgres `runs` (+ matching `error_histogram` object in Tigris `meta.json`). Counted live in the coordinator's `onResult`, no JOIN against `sandbox_results` needed for top-line stats. | — |
| ~~Ramp-phase latency segments~~ ✅ Landed | `ramp_segments` object in Tigris `meta.json` with `first_25pct` / `middle_50pct` / `last_25pct` buckets, each carrying `idx_range`, `count_ok`, p50/p95/p99/max/mean. Bucketed by `sandbox_idx` since the linear ramp maps idx → start-time. | — |
| ~~Concurrency at each point in time~~ ✅ Landed | `concurrency_summary` (peak_concurrent, peak_t_ms, mean_concurrent, total_run_ms, sample_interval_ms, ramp_seconds_configured) + `concurrency_timeline` (1Hz samples of `{t_ms, active}`) in Tigris `meta.json`. Computed from per-sandbox `started_at`/`completed_at` via an interval-overlap sweep. | — |
| **Sandbox IDs / region** if the adapter returns them | Add a `sandbox_id` (or `provider_metadata JSONB`) column on `sandbox_results`, extract from the sandbox object | Cross-reference against provider's own dashboards |

---

## Moderate effort (~hour of work each)

| Data | Approach | Trade-off |
| --- | --- | --- |
| **VM system metrics over time** (CPU, mem, event-loop lag, open FDs, sockets) | Periodic snapshot from `os.cpus()`, `process.memoryUsage()`, `perf_hooks.monitorEventLoopDelay()`, `cat /proc/net/sockstat` → row in a new `run_metrics` table or appended to a Tigris JSONL | Catches "we're CPU-bound at 80k concurrency" or port-exhaustion symptoms during the run, not just after |
| **DNS / TLS / TTFB breakdown per sandbox** | Hook into `undici`/`http` via `diagnostics_channel` to capture phase timings | Useful for "is this provider slow because of DNS or their backend?" — but requires bypassing the adapter abstraction |
| **Cost estimate per run** | Track sandboxes_created × known provider rate × wall time | Pretty important for a benchmark, currently absent |
| **Concurrent-actually-active timeline** (`active_at(t)`) | Compute from `started_at` / `completed_at` overlaps; sample every 1s and store | Verify the ramp profile matches intent |

---

## Harder / costlier

| Data | Why hard |
| --- | --- |
| **Raw HTTP request/response per sandbox** (headers, body) | The `@computesdk/<provider>` adapters don't surface these. Would need to either fork the adapter or use a `dispatcher`/interceptor on `undici` |
| **Provider-side log capture** | Requires each provider's API for fetching their server-side logs per sandbox (and per-provider auth/quotas) |
| **VM kernel-level instrumentation** (perf, eBPF, tcpdump) | Would need privileged setup on the Wolfi VM; useful for deep network debugging |
| **End-user experience replay** (run a workload inside the sandbox, not just measure creation) | Different benchmark concern from "burst" — closer to TTI which the daily benchmark already does |

---

## Recommended additions, in priority order

The high-value-to-cost ratio winners worth landing next:

1. ~~**Upload `coordinator.log` to Tigris at shutdown.**~~ ✅ Landed. Coordinator
   reads `$COORDINATOR_LOG_PATH` (set by launch.sh to `/root/run.log`) and
   uploads on every heartbeat plus shutdown.
2. ~~**Full latency histogram in `runs` and `meta.json`.**~~ ✅ Landed in Tigris
   `meta.json`; Postgres unchanged.
3. ~~**Error-type histogram column on `runs`**~~ ✅ Landed. `timeouts`,
   `http_errors`, `network_errors` columns on `runs`; `error_histogram` in
   `meta.json`.

Everything else is on-demand based on what specific question is hard to
answer with the current data.
