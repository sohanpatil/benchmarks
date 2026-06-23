export type ActionType = 'navigate' | 'waitForSelector' | 'screenshot' | 'textContent' | 'click' | 'goBack';

export const ACTION_TYPES: ActionType[] = [
  'navigate',
  'waitForSelector',
  'screenshot',
  'textContent',
  'click',
  'goBack',
];

export interface ActionResult {
  /** 1-based index of the action within the session (1-50) */
  index: number;
  type: ActionType;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ThroughputTimingResult {
  createMs: number;
  connectMs: number;
  actions: ActionResult[];
  releaseMs: number;
  totalMs: number;
  /** How many of the 50 actions succeeded */
  actionsCompleted: number;
  /** actionsCompleted / (taskMs / 1000) */
  actionsPerSecond: number;
  /** Sum of action durations */
  taskMs: number;
  error?: string;
}

export interface ThroughputStatsTriple {
  median: number;
  p95: number;
  p99: number;
}

export interface ThroughputStats {
  createMs: ThroughputStatsTriple;
  taskMs: ThroughputStatsTriple;
  totalMs: ThroughputStatsTriple;
  actionsPerSecond: ThroughputStatsTriple;
  perActionType: Record<ActionType, ThroughputStatsTriple>;
}

export interface ThroughputBenchmarkResult {
  provider: string;
  mode: 'browser-throughput';
  iterations: ThroughputTimingResult[];
  summary: ThroughputStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}

export interface ThroughputProviderConfig {
  name: string;
  iterations?: number;
  timeout?: number;
  requiredEnvVars: string[];
  createBrowserProvider: () => any;
  sessionCreateOptions?: Record<string, unknown>;
}
