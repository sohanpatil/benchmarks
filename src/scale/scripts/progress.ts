/**
 * Shared terminal-state detection for the scale watch/aggregate scripts.
 *
 * The bench API exposes no run lifecycle status (`BenchRunSummary.status` is
 * always "ok" and `endedAt` is never set for these coordinator runs), so both
 * scripts have to infer "this shard is done" from the per-run progress
 * counters. The obvious rule — `done >= total` — is necessary but not
 * sufficient: the coordinator increments `done` and *then* emits the progress
 * heartbeat (runner.ts emit()), so when a VM is torn down at its `--duration`
 * shortly after a sandbox finalizes, that sandbox's `sandbox_result`/`latency_ms`
 * events get out but the trailing heartbeat doesn't. The progress API keeps only
 * the latest snapshot per run, so `done` permanently stops short of `total` and
 * the shard reads as "running" forever even though it has actually completed.
 *
 * The only additional signal we have is time: a live shard emits a heartbeat
 * every time a sandbox finalizes, so `latestProgressAt` advances continuously. A
 * shard that hasn't advanced for far longer than any single bounded sandbox
 * operation has stopped for good. Readiness/liveness probes cap at 30s, but
 * `create` caps at 120s (`perRequestTimeoutMs`) and successful sandboxes only
 * emit at the final `destroy` barrier, so a healthy shard can legitimately go
 * quiet for ~120s during a slow create stage — the 300s default stale threshold
 * covers this. When it does go terminal-but-stalled, its last `total - done`
 * heartbeats went unreported.
 *
 * What "stalled" means depends on which signal the caller pairs this with:
 *   - aggregate.ts and watch.ts's batch path count finalized sandboxes from the
 *     authoritative `sandbox_result` metric stream (cumulative, not last-write-
 *     wins, so it does NOT lose the tail). There, staleness with finalized <
 *     expected means those sandboxes genuinely never emitted a result — they are
 *     lost (VM torn down mid-flight), not merely an under-reported heartbeat.
 *   - watch.ts's batch-less run fallback has only the heartbeat counters, so a
 *     stalled run there is best-effort: the gap may just be the unreported tail.
 */

/** A shard with no progress heartbeat for longer than this is terminal (stalled). */
export const DEFAULT_STALE_SEC = 300;

/**
 * Resolve the stale threshold (ms) from a CLI override, then `SCALE_STALE_SEC`,
 * then {@link DEFAULT_STALE_SEC}. Must exceed `LIFECYCLE_PAUSE_MS` (the
 * survivor-hold phase emits no progress), or a healthy held shard reads stalled.
 */
export function resolveStaleMs(cliSec?: number): number {
  if (Number.isFinite(cliSec) && (cliSec as number) > 0) return (cliSec as number) * 1000;
  const env = Number.parseInt(process.env.SCALE_STALE_SEC ?? '', 10);
  if (Number.isFinite(env) && env > 0) return env * 1000;
  return DEFAULT_STALE_SEC * 1000;
}

/**
 * Parse a bench-API timestamp. They are UTC but lack a zone designator
 * (e.g. "2026-06-01 11:45:13.830"), so naive Date.parse would read them as
 * local time. Normalize to ISO-with-Z before parsing. Returns null if unusable.
 */
export function parseApiTs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const iso = /([zZ]|[+-]\d\d:?\d\d)$/.test(t) ? t : `${t}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export interface ProgressLike {
  done: number;
  total: number;
  latestProgressAt?: string | null;
}

export interface TerminalState {
  /** True once the shard will make no further progress (complete OR stalled). */
  terminal: boolean;
  /** True when terminal was reached via staleness with done < total. */
  stalled: boolean;
}

/**
 * Decide whether a shard has reached a terminal state. `done >= total` is a
 * clean finish; otherwise a shard whose last progress is older than `staleMs`
 * is terminal-but-stalled (its last `total - done` heartbeats went unreported).
 */
export function terminalState(r: ProgressLike, nowMs: number, staleMs: number): TerminalState {
  if (r.total > 0 && r.done >= r.total) return { terminal: true, stalled: false };
  const last = parseApiTs(r.latestProgressAt);
  const stalled = last != null && nowMs - last > staleMs;
  return { terminal: stalled, stalled };
}
