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
| Structured coordinator log (timestamped, level-tagged lines with phase markers, per-sandbox events, periodic progress milestones, heartbeats, and a completion summary) | VM `/root/run.log` AND Tigris `<run_id>/coordinator.log` | Uploaded by the coordinator at every heartbeat (30s) and on shutdown ✅ |

---

## Easy to add (~minutes of work)

| Data | Approach | Why it's useful |
| --- | --- | --- |
| ~~Full latency histogram (p25, p75, p95, p99, p99.9, max)~~ ✅ Landed | `latency_distribution` object in Tigris `meta.json` carries count, min, p10/p25/p50/p75/p90/p95/p99/p999, max, mean. Postgres `runs` stays p50/p99-only — meta.json is the analytical view. | — |
| ~~Error-type histogram~~ ✅ Landed | New `timeouts`/`http_errors`/`network_errors` columns on Postgres `runs` (+ matching `error_histogram` object in Tigris `meta.json`). Counted live in the coordinator's `onResult`, no JOIN against `sandbox_results` needed for top-line stats. | — |
| ~~Ramp-phase latency segments~~ ✅ Landed | `ramp_segments` object in Tigris `meta.json` with `first_25pct` / `middle_50pct` / `last_25pct` buckets, each carrying `idx_range`, `count_ok`, p50/p95/p99/max/mean. Bucketed by `sandbox_idx` since the linear ramp maps idx → start-time. | — |
| ~~Concurrency at each point in time~~ ✅ Landed | `concurrency_summary` (peak_concurrent, peak_t_ms, mean_concurrent, total_run_ms, sample_interval_ms, ramp_seconds_configured) + `concurrency_timeline` (1Hz samples of `{t_ms, active}`) in Tigris `meta.json`. Computed from per-sandbox `started_at`/`completed_at` via an interval-overlap sweep. | — |
| ~~Sandbox IDs / region~~ ✅ Landed | `provider_metadata` JSONB column on `sandbox_results` (+ same field in Tigris `raw.jsonl`). Runner reflects every primitive property off the adapter's returned sandbox object, skipping anything that matches a credential-looking regex. On e2b: `{ provider, sandboxId }`. | — |

---

## Moderate effort (~hour of work each)

| Data | Approach | Trade-off |
| --- | --- | --- |
| ~~VM system metrics over time~~ ✅ Landed | Coordinator samples every 5s into `<run_id>/metrics.jsonl` (uploaded at every 30s heartbeat for partial-result durability + at shutdown). Captures: cumulative CPU user/system µs, RSS/heap/external MB, event-loop p50/p99/max lag (since previous sample), load averages, `/proc/self/fd` count, `/proc/net/sockstat` (TCP inuse/tw/alloc etc.). Headline numbers in `meta.json.metrics_summary` (peak RSS, peak event-loop lag, peak open FDs, peak TCP inuse/tw, total CPU). `/proc/*` fields null on non-Linux. | — |
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

---

## GitHub-Actions-style structured coordinator log ✅ Landed

The coordinator log used to be three or four terse `console.log` lines per
run (provider, concurrency, heartbeat, completion). It's now a structured,
timestamped, level-tagged stream similar to GitHub Actions output — useful
for reading what a run actually did, in order, after the fact.

### Shape

Each line is `<ISO timestamp> [<level>] <message>` with levels
`info` / `ok` / `warn` / `error` / `stat` / `debug` and dedicated `phase`
markers rendered as `━━━ … ━━━`. No ANSI colors so the file stored at
`<run_id>/coordinator.log` in Tigris stays clean.

### What it captures

| Phase | Example lines |
| --- | --- |
| **Startup** | `━━━ burst-100k coordinator starting ━━━`, `run_id=…`, `provider=e2b (requires: E2B_API_KEY)`, `concurrency=N ramp=Xs timeout=Yms`, `commit_sha=… instance_id=…`, `tigris_prefix=…` |
| **Validation** | `━━━ validating environment ━━━`, `all 1 provider env var(s) present` |
| **Sink setup** | `━━━ opening sinks ━━━`, `Postgres: connecting…` → `connected` → `bootstrapping runs row` → `runs row in place`; `Tigris: opening multipart upload for raw.jsonl` → `sink ready` |
| **Compute init** | `━━━ initializing compute client ━━━`, `compute client ready for <provider>` |
| **Burst** | `━━━ burst — firing N requests (ramp Xs) ━━━`, then `[ok] sandbox <idx> created in <ms>ms — sandboxId=…` (sampled at high N) or `[error] sandbox <idx> <status> (http=… code=…): <message>` for failures; periodic `[stat] progress N/total (in_flight=Y errors=Z) rate=R/s eta≈Ts` every ~10% |
| **Heartbeat** | `[stat] heartbeat done=N/total in_flight=Y errors=Z` every 30s |
| **Shutdown / completion** | `━━━ flushing sinks and writing summary ━━━`, `Postgres: flushing remaining sandbox_results batch`, `Tigris: closing multipart upload for raw.jsonl`, `Tigris: writing metrics.jsonl`, `Tigris: writing meta.json`, `Postgres: marking run done with final stats`, `━━━ run complete ━━━`, `N/N succeeded (XX.X%)`, `latency p50=…ms p99=…ms`, optional `[warn] errors: …` |

### Volume

Implemented in [src/burst-100k/logger.ts](src/burst-100k/logger.ts) and
[src/burst-100k/runner.ts](src/burst-100k/runner.ts). **Every sandbox gets
a log line at every N** — no sampling. At full 100k that's ~100k `[ok]`
lines plus phase markers, heartbeats, and progress milestones, producing a
log file in the low tens of MB. Uploaded to Tigris on every heartbeat
(30s) so partial data is durable.

| Concurrency | Sandbox `[ok]` lines logged | Approx total log size |
| --- | --- | --- |
| 25 | 25 | ~7 KB |
| 100 | 100 | ~16 KB |
| 1,000 | 1,000 | ~140 KB |
| 10,000 | 10,000 | ~1.4 MB |
| 100,000 | 100,000 | ~14 MB |

`[error]` lines are always emitted — failures are never silently dropped.

### Debug verbosity

A `BURST_100K_DEBUG=1` env var enables `log.debug` calls (currently unused
but available for future verbose diagnostics without recompiling).
