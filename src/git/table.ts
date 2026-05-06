import type { GitBenchmarkResult } from './types.js';

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function printGitResults(result: GitBenchmarkResult): void {
  console.log('\n--- Git Benchmark Results ---');
  console.log(`Provider: ${result.provider}`);
  console.log(`Fixture commits: ${result.fixtureCommitCount}`);
  console.log(`Iterations: ${result.iterations}`);
  console.log(`Success rate: ${(result.successRate * 100).toFixed(1)}%`);
  console.log('');
  console.log(`Cold clone      median ${fmt(result.summary.coldCloneMs.median)}  p95 ${fmt(result.summary.coldCloneMs.p95)}  p99 ${fmt(result.summary.coldCloneMs.p99)}`);
  console.log(`Incremental fetch median ${fmt(result.summary.incrementalFetchMs.median)}  p95 ${fmt(result.summary.incrementalFetchMs.p95)}  p99 ${fmt(result.summary.incrementalFetchMs.p99)}`);
  console.log(`Commit + push   median ${fmt(result.summary.commitPushMs.median)}  p95 ${fmt(result.summary.commitPushMs.p95)}  p99 ${fmt(result.summary.commitPushMs.p99)}`);
}
