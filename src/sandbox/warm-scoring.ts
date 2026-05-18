import type { Stats } from './types.js';
import type { WarmBenchmarkResult, WarmOpName } from './warm-types.js';

/**
 * Per-op latency ceiling in ms. Anything at or above scores 0.
 *
 * Tuned per-op because the channels live on different timescales — a 2s
 * `runCommand` RTT on a warm sandbox is unusable for agent loops, but a 2s
 * 1MB file transfer is plausible. Keeping these explicit (rather than one
 * shared TTI ceiling) lets us reward providers that are fast on the
 * dominant ops without unfairly penalizing one slow op.
 */
const OP_CEILING_MS: Record<WarmOpName, number> = {
  runCommand_noop: 2_000,
  writeFile_1mb: 5_000,
  readFile_1mb: 5_000,
  readdir: 2_000,
  runCommand_1mb_stdout: 5_000,
};

/**
 * Weight of each op in the composite score. Must sum to 1.0.
 *
 * runCommand RTT carries the most weight because agent loops pay it on
 * every tool call. File I/O matters but is amortized across fewer calls.
 * readdir is a tiebreaker — light but commonly exercised.
 */
const OP_WEIGHTS: Record<WarmOpName, number> = {
  runCommand_noop: 0.40,
  writeFile_1mb: 0.20,
  readFile_1mb: 0.20,
  runCommand_1mb_stdout: 0.15,
  readdir: 0.05,
};

const PERCENTILE_WEIGHTS = { median: 0.60, p95: 0.25, p99: 0.15 };

function scoreAgainstCeiling(valueMs: number, ceilingMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / ceilingMs));
}

function opTimingScore(stats: Stats, ceilingMs: number): number {
  return (
    PERCENTILE_WEIGHTS.median * scoreAgainstCeiling(stats.median, ceilingMs) +
    PERCENTILE_WEIGHTS.p95 * scoreAgainstCeiling(stats.p95, ceilingMs) +
    PERCENTILE_WEIGHTS.p99 * scoreAgainstCeiling(stats.p99, ceilingMs)
  );
}

/**
 * Compute the success rate across every sample of every op (0-1).
 */
export function computeWarmSuccessRate(result: WarmBenchmarkResult): number {
  if (result.skipped) return 0;
  let total = 0;
  let ok = 0;
  for (const op of Object.values(result.ops)) {
    if (!op) continue;
    for (const sample of op.samples) {
      total++;
      if (!sample.error) ok++;
    }
  }
  if (total === 0) return 0;
  return ok / total;
}

/**
 * Compute the composite warm-ops score: weighted-mean of per-op timing
 * scores × global success rate.
 *
 * Same reliability-is-non-negotiable rule as TTI: a flaky provider has its
 * score multiplied by its success rate.
 */
export function computeWarmCompositeScores(results: WarmBenchmarkResult[]): void {
  for (const result of results) {
    const successRate = computeWarmSuccessRate(result);
    result.successRate = successRate;

    if (result.skipped || successRate === 0) {
      result.compositeScore = 0;
      continue;
    }

    let combined = 0;
    let weightApplied = 0;
    for (const op of Object.keys(OP_WEIGHTS) as WarmOpName[]) {
      const data = result.ops[op];
      if (!data) continue;
      combined += OP_WEIGHTS[op] * opTimingScore(data.summary, OP_CEILING_MS[op]);
      weightApplied += OP_WEIGHTS[op];
    }
    if (weightApplied === 0) {
      result.compositeScore = 0;
      continue;
    }
    // Renormalize in case an op is missing (e.g. partial unsupported surface).
    const timingScore = combined / weightApplied;
    result.compositeScore = Math.round(timingScore * successRate * 100) / 100;
  }
}

export function sortWarmByCompositeScore(results: WarmBenchmarkResult[]): WarmBenchmarkResult[] {
  return [...results].sort((a, b) => {
    if (a.skipped && !b.skipped) return 1;
    if (!a.skipped && b.skipped) return -1;
    if (a.skipped && b.skipped) return 0;
    return (b.compositeScore ?? 0) - (a.compositeScore ?? 0);
  });
}

export { OP_CEILING_MS, OP_WEIGHTS };
