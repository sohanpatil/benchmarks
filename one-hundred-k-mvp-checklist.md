# 100k Burst — Implementation Checklist

Tracker for the work described in [one-hundred-k-mvp-plan.md](one-hundred-k-mvp-plan.md).
Check items off as they land.

---

## 0. Prerequisites (external / infra)

- [x] Neon Postgres database provisioned; `PG_URL` (pooler endpoint) tested from a laptop
- [x] `PG_URL` confirmed reachable from a Namespace VM (one-off `nsc ssh` + `psql` round-trip)
- [x] R2 bucket created; access key has write + multipart permission
- [x] R2 reachable from a Namespace VM (one-off `aws s3 cp` round-trip)
- [x] Namespace auth via static token (`NSC_TOKEN` env secret in `burst-100k` environment); OIDC trust deferred
- [x] First opt-in provider selected: **e2b** (single env var: `E2B_API_KEY`)
- [x] GitHub `burst-100k` environment created with reviewer protection
- [x] Environment secrets present: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `NSC_TOKEN`
- [x] Environment variable present: `R2_BUCKET`
- [x] Environment secret present: `PG_URL` (Neon connection string)
- [x] Environment secret present for chosen provider: `E2B_API_KEY`
- [ ] Open question #1 resolved with Namespace: dedicated egress IP or shared SNAT pool? *(non-blocking — find out before first 100k run)*

## 1. Schema

- [x] `db/burst-100k.sql` written with `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
- [x] Applied once locally: `psql "$PG_URL" -f db/burst-100k.sql` runs clean
- [x] Re-applied: second run is a no-op (idempotency confirmed)
- [x] Sanity insert + select against `runs` and `sandbox_results` works

## 2. Coordinator code (`src/burst-100k/`)

- [x] `types.ts` — `BurstProviderConfig extends ProviderConfig` defined
- [x] `providers.ts` — entry for e2b, reusing `@computesdk/e2b`
- [x] `sinks/postgres.ts` — `pg` client, batched 1k inserts, heartbeat `UPDATE`, completion `UPDATE`
- [x] `sinks/r2.ts` — `@aws-sdk/lib-storage` multipart upload for `raw.jsonl`; `putObject` for `heartbeat.json` and `meta.json`
- [x] `runner.ts` — `p-limit` concurrency limiter + linear ramp over `rampSeconds` (HTTP agent managed by `@computesdk/e2b` adapter)
- [x] `coordinator.ts` — wires it all together: bootstraps the `runs` row, validates `requiredEnvVars`, runs burst, heartbeat loop, SIGTERM/SIGINT trap, completion update
- [x] `package.json`: added deps (`pg`, `p-limit`); `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` already transitively present
- [x] `package.json`: added dev deps `esbuild`, `@types/pg`
- [x] `package.json`: added scripts `bundle:burst-100k` and `bench:burst-100k:local`
- [x] `npm run bundle:burst-100k` produces a working `dist/burst-100k.js` (2.7 MB single file)

## 3. Local smoke (N=100)

- [x] Local env vars set (provider keys, R2, `PG_URL`, `PROVIDER`, `RUN_ID`)
- [x] `concurrencyTarget` temporarily overridden to 100 (`CONCURRENCY_TARGET=100`)
- [x] `npm run bench:burst-100k:local` completes without error
- [x] `runs` row created with `status='done'` on clean exit (p50=148ms, p99=792ms)
- [x] 100 rows in `sandbox_results` for the run, all `ok`
- [x] `raw.jsonl` present in R2 at `s3://<bucket>/<run_id>/` (100 lines, first/last span the ~60s ramp)
- [x] `heartbeat.json` present in R2 and was updated
- [x] `meta.json` present with final summary
- [x] SIGTERM mid-run flushes cleanly (`status='failed'` with truthful done count + in-flight rows + raw.jsonl flushed)
- [x] Bundle output is CJS (`dist/burst-100k.cjs`); repo's `"type": "module"` requires `--format=cjs` and `.cjs` extension

## 4. Launch script

- [x] `scripts/burst-100k-launch.sh` written, executable (`chmod +x`)
- [x] `esbuild` step in the script produces a working bundle
- [x] `psql -f db/burst-100k.sql` step runs (idempotent)
- [x] `nsc create` returns an instance ID (using `--bare --cidfile`)
- [x] `nsc instance upload` succeeds (coordinator bundle + startup script)
- [x] `INSERT INTO runs ...` inserts a `running` row (with `ON CONFLICT DO NOTHING`)
- [x] `nsc ssh ... nohup node coordinator.cjs &` returns immediately (detached); `pgrep node` post-check confirms running

### Notes on what we learned (worth keeping)

- Wolfi `--bare` image has no `node`; install with `apk add -q nodejs` before launch.
- BusyBox `sh` has no `disown` builtin (`disown: not found`); `nohup ... & </dev/null` alone is sufficient to detach.
- Passing env via long line-continued `nsc ssh -- env VAR=val \ ...` is fragile — a broken `\` continuation silently truncated the command and caused `env` to print the environment (leaking secrets). The script now writes a `chmod 600` startup script locally with `printf '%q'`-quoted values, uploads it, runs it (which `rm -f`'s itself after detaching node), and confirms with `pgrep -x node`.
- `nsc destroy` requires `--force` to skip the TTY confirmation in non-interactive contexts (CI).

## 5. Manual Namespace dry-run (N=1000)

Run the launch script from a laptop with `GITHUB_SHA` faked. Cap `concurrencyTarget=1000`.

- [ ] Script completes in under 60s
- [ ] `nsc ssh <id> tail -f /root/run.log` shows the coordinator working
- [ ] `runs.last_heartbeat` advances every ~30s
- [ ] `sandbox_results` row count grows
- [ ] R2 multipart parts appear under the run prefix
- [ ] Run reaches completion; `runs.status='done'` with final stats
- [ ] Instance self-destroys at the duration deadline (or `nsc destroy <id>` works)
- [ ] `pkill -TERM node` over `nsc ssh` causes a clean flush + `status='failed'` row

## 6. GitHub workflow

- [ ] `.github/workflows/burst-100k.yml` written
- [ ] Provider env vars passthrough in `env:` block (per-provider, matches existing `src/sandbox/providers.ts`)
- [ ] Workflow includes `id-token: write` permission for OIDC
- [ ] `namespacelabs/nscloud-setup@v0` step present
- [ ] `workflow_dispatch` trigger lists the chosen provider in `inputs.provider.options`
- [ ] First `workflow_dispatch` run (with `concurrencyTarget=1000`) succeeds end-to-end
- [ ] Action exits in <1 min; run continues on VM and reaches `status='done'`

## 7. First full 100k run

- [ ] `concurrencyTarget` restored to `100_000` in the provider's entry
- [ ] `workflow_dispatch` triggers the run
- [ ] No `EADDRNOTAVAIL` errors in the log (if any → revisit egress IP / shard)
- [ ] Event loop lag stays under 100ms (if not → upsize to `32x64`)
- [ ] No OOM (if any → fix coordinator memory; don't just upsize)
- [ ] Run completes with `status='done'`, final stats populated
- [ ] `raw.jsonl` in R2 contains ~100k lines
- [ ] `sandbox_results` row count ≈ `sandboxes_attempted`
- [ ] Spot-check a handful of R2 raw records vs. their Postgres rows for consistency

## 8. Onboard additional providers

Repeat for each opt-in provider:

- [ ] New entry added to `src/burst-100k/providers.ts`
- [ ] Provider env vars added to GitHub Secrets (if not already there for daily benchmark)
- [ ] Provider env vars added to workflow `env:` block and `bash -c` SSH `export` line
- [ ] Provider name added to `inputs.provider.options`
- [ ] Low-concurrency `workflow_dispatch` run completes cleanly
- [ ] Full 100k `workflow_dispatch` run completes cleanly

## 9. Scheduled runs (after a few clean manual runs)

- [ ] Schedule cadence decided (one cron for all, or staggered)
- [ ] `schedule:` trigger added to workflow
- [ ] First scheduled run fires and completes
- [ ] Stuck-run query verified: `SELECT * FROM runs WHERE status='running' AND last_heartbeat < now() - interval '5 minutes';`

## 10. Documentation

- [ ] `README.md` (or a dedicated section) mentions the 100k burst is opt-in, points to the workflow
- [ ] Operational notes captured in [one-hundred-k-mvp-plan.md](one-hundred-k-mvp-plan.md) match reality after first 100k run (sizing, port exhaustion, etc.)
- [ ] Open questions from the plan resolved or knowingly deferred
