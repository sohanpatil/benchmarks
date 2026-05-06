export type GitOperation = 'cold_clone' | 'incremental_fetch' | 'commit_push';

export interface GitIterationResult {
  operation: GitOperation;
  latencyMs: number;
  transferBytes?: number;
  error?: string;
}

export interface GitOperationStats {
  median: number;
  p95: number;
  p99: number;
}

export interface GitBenchmarkSummary {
  coldCloneMs: GitOperationStats;
  incrementalFetchMs: GitOperationStats;
  commitPushMs: GitOperationStats;
}

export interface GitBenchmarkResult {
  provider: string;
  mode: 'git';
  fixtureCommitCount: number;
  iterations: number;
  results: GitIterationResult[];
  summary: GitBenchmarkSummary;
  successRate: number;
}
