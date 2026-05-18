import type { ProviderConfig, Stats } from './types.js';

export type WarmOpName =
  | 'runCommand_noop'
  | 'writeFile_1mb'
  | 'readFile_1mb'
  | 'readdir'
  | 'runCommand_1mb_stdout';

export interface WarmSampleResult {
  /** Latency of this op invocation in ms. 0 when error is set. */
  latencyMs: number;
  /** Error message if this sample failed */
  error?: string;
}

export interface WarmOpResult {
  samples: WarmSampleResult[];
  summary: Stats;
}

export interface WarmBenchmarkResult {
  provider: string;
  mode: 'warm_ops';
  /** Number of samples requested per op */
  samplesPerOp: number;
  /** Payload size in bytes used for the 1mb read/write/stdout ops */
  payloadBytes: number;
  /** Per-op timings. Keys are WarmOpName values. */
  ops: Partial<Record<WarmOpName, WarmOpResult>>;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /**
   * Success rate as a fraction (0-1) across all samples for all ops.
   * Acts as multiplier on composite score, matching TTI methodology.
   */
  successRate?: number;
  /** Provider skipped because required env vars are missing. */
  skipped?: boolean;
  skipReason?: string;
  /**
   * Provider skipped because filesystem ops are not supported by the
   * adapter. Counts as skipped (not failure) so it doesn't crush the
   * provider's score — they simply opt out of this benchmark.
   */
  unsupportedReason?: string;
}

export interface WarmConfig extends ProviderConfig {
  /** Samples per op (default 100). */
  samplesPerOp?: number;
  /** Payload size in bytes for 1MB ops (default 1048576). */
  payloadBytes?: number;
  /** Per-op timeout in ms (default 10000). */
  opTimeoutMs?: number;
}
