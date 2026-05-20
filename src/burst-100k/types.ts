import type { ProviderConfig } from '../sandbox/types.js';

export interface BurstProviderConfig extends ProviderConfig {
  /** Peak target concurrency for this provider's burst (typically 100_000). */
  concurrencyTarget: number;
  /** Per-request timeout in ms. Defaults to 120_000. */
  perRequestTimeoutMs?: number;
}

export type SandboxResultStatus = 'ok' | 'timeout' | 'http_error' | 'network_error';

export interface SandboxResult {
  sandbox_idx: number;
  started_at: string;        // ISO-8601
  completed_at: string;      // ISO-8601
  /**
   * "Allocate" phase: time for `sandbox.create()` to resolve.
   * Named `latency_ms` for backward-compat with older runs/queries.
   * On create-failure this is the time-to-failure.
   */
  latency_ms: number;
  /**
   * "First command" phase: time for `sandbox.runCommand('node -v')` to
   * return after `create()` resolved. Null when create failed (never
   * attempted) or when the command itself failed (measurement aborted).
   * Matches the daily benchmark's `node -v` readiness check.
   */
  first_command_ms: number | null;
  status: SandboxResultStatus;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  /**
   * Whatever primitive props the adapter put on the returned sandbox object
   * (e.g. sandbox id, region). Null on failure or when nothing useful is
   * exposed. Stored as JSONB in Postgres and verbatim in Tigris raw.jsonl.
   */
  provider_metadata: Record<string, unknown> | null;
}

export interface ProgressStats {
  done: number;
  in_flight: number;
  errors: number;
}

export interface MetricsSample {
  ts: string;                          // ISO-8601
  uptime_ms: number;                   // since coordinator start
  cpu_user_us: number;                 // cumulative process CPU time (microseconds)
  cpu_system_us: number;
  mem_rss_mb: number;
  mem_heap_used_mb: number;
  mem_heap_total_mb: number;
  mem_external_mb: number;
  event_loop_p50_ms: number;           // lag percentiles since previous sample
  event_loop_p99_ms: number;
  event_loop_max_ms: number;
  loadavg_1m: number;
  loadavg_5m: number;
  loadavg_15m: number;
  open_fds: number | null;             // null on non-Linux
  sockstat: Record<string, number> | null;
}

export interface FinalStats {
  sandboxes_attempted: number;
  sandboxes_succeeded: number;
  timeouts: number;
  http_errors: number;
  network_errors: number;
  p50_latency_ms: number;
  p99_latency_ms: number;
}
