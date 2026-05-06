# Git Infrastructure Benchmark v1 (Draft)

This document proposes a reproducible benchmark for Git platforms used by humans and AI agents.

## Scope

The benchmark compares two categories without forcing them into the same product assumptions:

- Traditional SCM hosts: GitHub, GitLab, Bitbucket
- API-first / agent-native Git platforms: Freestyle, code.storage

Optional baseline:

- Self-hosted Forge: Gitea or Forgejo

## Goals

- Measure real developer and agent workflows (`clone`, `fetch`, `commit`, `push`, PR/MR-like flow)
- Stress deep history and high commit volume behavior
- Capture reliability under concurrency and failure conditions
- Produce repeatable p50/p95/p99 metrics and cost-normalized comparisons

## Fairness Rules

- Use the same repo fixtures, commit graph, and runner hardware across providers
- Separate cold and warm runs; do not mix results
- Run each scenario at least 20 times and report variance
- Pin runner region for single-region tests; report multi-region separately
- Use provider-native auth and recommended SDK/API paths where applicable
- Report unsupported capabilities explicitly as `N/A`, not `0`

## Test Matrix

### A) Core Git Transport

- `T1` Cold full clone (small, medium, large history)
- `T2` Warm full clone (same fixture)
- `T3` Shallow clone (`--depth 1`, `--depth 100`)
- `T4` Partial clone (`--filter=blob:none`) when supported
- `T5` Incremental fetch after `10`, `100`, `1000` new commits
- `T6` Push latency: single small commit, single large diff, binary/LFS payload

### B) High-Commit and Deep-History Stress

- `T7` Bulk-history clone: repositories at ~1k, ~10k, ~100k, ~1M commits
- `T8` Continuous tiny commits: each worker creates 200 commits and pushes every 20 commits
- `T9` Batch push: one push containing 500+ commits after branch divergence
- `T10` Rebase/squash stress: large rewritten history push behavior and visibility delay

### C) Collaboration and Automation

- `T11` Branch lifecycle: create/switch/merge/delete at scale
- `T12` PR/MR lifecycle: open, attach diff, add comments/review state, merge with checks
- `T13` Webhook e2e latency: `git push` to webhook receiver timestamp
- `T14` CI trigger latency: push-to-first-job and push-to-first-log-line

### D) API / SDK Workflows

- `T15` Programmatic repo create and remote URL retrieval
- `T16` Programmatic branch create and commit write
- `T17` Programmatic diff/log/list metadata read
- `T18` Sync behaviors with GitHub mirror/sync features (where offered)

### E) Reliability and Recovery

- `T19` Parallel workers: 50 and 100 workers performing branch+commit+push loops
- `T20` Failure injection: token expiration, transient network drops, retriable 5xx
- `T21` Event reliability: webhook delivery success and retry completion

### F) Security, Governance, and Cost

- `T22` Access controls and token scope granularity (capability checklist)
- `T23` Auditability: log availability and export ergonomics
- `T24` Cost model based on measured usage: storage, transfer, request/operation costs

## Standard Workload Profiles

- `human-dev`: low concurrency, frequent small fetch/push, PR-heavy
- `agent-burst`: high concurrency, many branches, high commit/write frequency
- `ci-heavy`: frequent clone/fetch and webhook/CI trigger sensitivity

Each profile runs the same test IDs with different concurrency and payload settings.

## Metrics to Record

Per test/scenario capture:

- Latency: p50, p95, p99, min, max
- Throughput: operations/sec, MB/sec
- Reliability: success rate, error class distribution, retry success
- Transfer characteristics: packfile bytes, wall-clock transfer, server processing delay
- Freshness: time from push accepted to ref visibility/API visibility
- Cost units: storage GB-month, transfer GB, operation/API counts

## Repo Fixture Generator (Deterministic)

Generate identical fixture repositories with a seeded generator:

- Sizes: tiny (~10MB), medium (~1GB logical history), large (deep history + binaries)
- Commit graph: linear, fan-out branches, merge-heavy, rebased segments
- File mix: text-heavy, binary-heavy, optional LFS tracks
- Churn model: hot files (frequent edits) + cold files (rare edits)

Publish the fixture seed, generation script version, and resulting commit hashes.

## Initial Scoring Model (v1)

- 40% performance (latency + throughput)
- 25% reliability
- 15% workflow/API completeness
- 10% security/governance
- 10% cost efficiency

Rules:

- Reliability is multiplicative within relevant sections (high failure rates cap score)
- Unsupported feature for optional tests stays `N/A`; required unsupported features score `0` for that metric
- Publish both weighted composite and raw metric tables

## Output Schema (JSON)

```json
{
  "benchmark": "git-infra-v1",
  "date": "2026-05-06",
  "provider": "github",
  "profile": "agent-burst",
  "testId": "T19",
  "fixture": {
    "name": "deep-history-large",
    "seed": 42,
    "commitCount": 100000
  },
  "run": {
    "region": "us-east-1",
    "attempts": 30,
    "successRate": 0.97
  },
  "metrics": {
    "latencyMs": { "p50": 920, "p95": 2410, "p99": 3900 },
    "throughput": { "opsPerSec": 7.2, "mbPerSec": 48.5 },
    "freshnessMs": { "pushToRefVisibleP50": 340 }
  },
  "cost": {
    "storageGbMonth": 12.4,
    "egressGb": 88.1,
    "apiOps": 13420
  }
}
```

## Minimal v1 Launch Plan

Start with 8 tests that provide immediate signal:

- `T1`, `T3`, `T5`, `T6`, `T7`, `T12`, `T13`, `T19`

Then add API and governance layers (`T15+`, `T22+`) in v1.1.

## Open Questions

- Should CI timing be benchmarked using each provider's native CI only, or externalized CI only?
- Should mirrored/synced GitHub repos be scored separately from primary repo storage?
- How should per-seat pricing be normalized against pure usage-based models?
