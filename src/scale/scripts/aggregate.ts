#!/usr/bin/env node
/**
 * Aggregate sandbox_results across every shard in a sharded-burst group via
 * the bench API query client and emit the same metrics shape an unsharded
 * burst would emit in its meta.json.
 *
 * Does not touch Postgres. Sandbox-level totals come from the per-shard progress
 * counters; everything else is built from the per-sandbox metric streams the
 * coordinator emits, the same source the watch live view trusts — NOT from
 * getBatchStats, whose totalSpans/statusCounts count lifecycle-step spans (one
 * create/exec/destroy span per sandbox per step — ~5×concurrencyTarget per shard)
 * rather than sandboxes, and whose latencyDistribution is step-span durations
 * rather than per-sandbox allocate latency. Specifically:
 *   - status / latency / first_command / tti distributions and the failure-by-
 *     error-code breakdown  → getBatchMetricStats / getBatchMetricCounts.
 *   - create_failure_class + timeouts/http/network                → the
 *     `failure_class` field on sandbox_result (null for runs predating that emit).
 *   - fleet-wide metrics_summary (peak/mean mem, event-loop, fds, sockets)
 *     → getBatchMetricStats over the `coordinator_metrics` stream.
 *   - concurrency_summary/timeline + throughput_timeline → getBatchMetricTimeline,
 *     attempted best-effort (the endpoint may 503; fields stay null until served).
 * Anything still null here (per-shard cpu/heap series, exact concurrency from
 * intervals) lives only in each shard's Tigris meta.json / metrics.jsonl.
 *
 * Usage:
 *   tsx src/scale/scripts/aggregate.ts --group <GROUP_ID>
 *   tsx src/scale/scripts/aggregate.ts --recent
 *   tsx src/scale/scripts/aggregate.ts --group <GROUP_ID> --out meta.json
 *   npm run bench:scale:aggregate -- --group <GROUP_ID>
 *
 * Exit code:
 *   0 — group found and aggregated
 *   1 — group is non-terminal (still running) and --allow-running was not passed
 *   2 — bad arguments / missing env / no matching group
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import { createBenchQueryClient } from '@computesdk/bench';
import type { BenchRunSummary, BenchMetricDistribution, BenchMetricCounts, BenchMetricTimeline, BenchGroupedMetricDistribution } from '@computesdk/bench';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { resolveStaleMs, terminalState, parseApiTs } from './progress.js';

interface Args {
  groupId?: string;
  recent: boolean;
  out?: string;
  requireTerminal: boolean;
  writeTigris: boolean;
  staleSec?: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/aggregate.ts [options]',
    '',
    'One of:',
    '  --group <id>           Aggregate the named group',
    '  --recent               Aggregate the most-recently-started group',
    '',
    'Optional:',
    '  --out <file>           Also write the aggregate meta.json to <file>',
    '  --allow-running        Aggregate even if some shards are still running',
    '                         (default: refuse and exit 1)',
    '  --stale <sec>          Treat a shard with no progress for <sec> as',
    '                         terminal/stalled (default: 300; or SCALE_STALE_SEC).',
    '                         Must exceed LIFECYCLE_PAUSE_MS.',
    '  --no-tigris            Do not upload meta.json to Tigris',
    '  --help, -h             Print this help',
    '',
    'Required env:',
    '  COMPUTESDK_API_KEY    Bench API token',
    '',
    'Tigris env (if --no-tigris not passed):',
    '  TIGRIS_STORAGE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { recent: false, requireTerminal: true, writeTigris: true };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--group') out.groupId = next();
    else if (a === '--recent') out.recent = true;
    else if (a === '--out') out.out = next();
    else if (a === '--allow-running') out.requireTerminal = false;
    else if (a === '--stale') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--stale must be a positive integer'); process.exit(2); }
      out.staleSec = v;
    }
    else if (a === '--no-tigris') out.writeTigris = false;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.groupId && !out.recent) { console.error(`pass --group <id> or --recent\n${usage()}`); process.exit(2); }
  return out;
}

const args = parseArgs();
const staleMs = resolveStaleMs(args.staleSec);

const query = createBenchQueryClient({
  baseUrl: 'https://platform.computesdk.com/api/v1',
  apiKey: process.env.COMPUTESDK_API_KEY,
});

// Some metric queries are best-effort: a field may have no events yet, or the
// endpoint may be unavailable (the timeline endpoint currently 503s). Degrade to
// a fallback rather than failing the whole aggregate on one missing signal.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

// Resolve groupId (either explicit or most recent)
let groupId = args.groupId;
if (!groupId) {
  const { items } = await query.listRuns({ limit: 1 });
  if (items.length === 0 || !items[0].batch) {
    console.error('no sharded groups found in bench API');
    process.exit(2);
  }
  groupId = items[0].batch;
  console.log(`[aggregate] --recent → batchId=${groupId}`);
}

// Fetch progress and runs plus metric aggregates in parallel.
const [
  progress,
  runsRes,
  latencyDistRaw,
  firstCmdDistRaw,
  ttiDistRaw,
  statusCountsRaw,
  errorCodeCountsRaw,
  failureClassCountsRaw,
  latencyBySegmentRaw,
] = await Promise.all([
  query.getBatchProgress(groupId),
  query.listRuns({ batch: groupId, limit: 500 }),
  query.getBatchMetricStats(groupId, { name: 'latency_ms', field: 'value' }),
  query.getBatchMetricStats(groupId, { name: 'first_command_ms', field: 'value' }),
  query.getBatchMetricStats(groupId, { name: 'tti_ms', field: 'value' }),
  query.getBatchMetricCounts(groupId, { name: 'sandbox_result', field: 'status' }),
  query.getBatchMetricCounts(groupId, { name: 'sandbox_result', field: 'error_code' }),
  query.getBatchMetricCounts(groupId, { name: 'sandbox_result', field: 'failure_class' }),
  query.getBatchMetricStats(groupId, { name: 'latency_ms', field: 'value', groupBy: 'submission_segment' }),
]);

const latencyDist = latencyDistRaw as BenchMetricDistribution;
const firstCmdDist = firstCmdDistRaw as BenchMetricDistribution;
const statusCounts = statusCountsRaw as BenchMetricCounts;
const errorCodeCounts = errorCodeCountsRaw as BenchMetricCounts;
const ttiDist = ttiDistRaw as BenchMetricDistribution;

const countMap = (rows: Array<{ key: string; count: number }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.key] = row.count;
  return out;
};
const statusMap = countMap(statusCounts.counts);
const failureMap = countMap(errorCodeCounts.counts);

// Create-phase failure taxonomy, derived from the `failure_class` field the
// coordinator now tags on each create-failure's sandbox_result (coordinator.ts).
// Older runs predating that emit report total=0 — keep those fields null rather
// than claiming zero create-failures we can't actually confirm.
const failureClassCounts = failureClassCountsRaw as BenchMetricCounts;
const failureClassMap = countMap(failureClassCounts.counts);
const haveFailureClass = failureClassCounts.total > 0;
const timeouts = haveFailureClass ? (failureClassMap.timeout ?? 0) : null;
const httpErrors = haveFailureClass ? (failureClassMap.http_error ?? 0) : null;
const networkErrors = haveFailureClass ? (failureClassMap.network_error ?? 0) : null;
const create_failure_class = haveFailureClass
  ? {
      timeout: failureClassMap.timeout ?? 0,
      http_error: failureClassMap.http_error ?? 0,
      network_error: failureClassMap.network_error ?? 0,
    }
  : null;

// BenchBatchProgress carries only per-run counters (no roll-up), so derive both
// the shard-level breakdown and the sandbox-level totals here. A run is terminal
// once done >= total, or once it has gone quiet past the stale threshold (its VM
// was torn down with a sandbox still in-flight, so done never reaches total) —
// see ./progress.ts. Each shard's `total` is its concurrencyTarget, `done` is
// sandboxes finalized, and `errors` increments once per non-success sandbox
// (failed + readiness_failed + partial), so done − errors == successes.
const now = Date.now();
let shardsRunning = 0, shardsCompleted = 0, shardsFailed = 0, shardsStalled = 0;
let sandboxesAttempted = 0, sandboxesDone = 0, sandboxErrors = 0;
for (const r of progress.runs) {
  sandboxesAttempted += r.total;
  sandboxesDone += r.done;
  sandboxErrors += r.errors;
  const { terminal, stalled } = terminalState(r, now, staleMs);
  if (!terminal) shardsRunning++;
  else if (stalled) shardsStalled++;
  else if (r.errors > 0) shardsFailed++;
  else shardsCompleted++;
}
const shardsTerminal = shardsCompleted + shardsFailed + shardsStalled;

if (shardsRunning > 0 && args.requireTerminal) {
  console.error(
    `batch ${groupId} has ${shardsRunning} shard(s) still running; ` +
    `pass --allow-running to aggregate anyway`,
  );
  console.error(`still-running shards:`);
  for (const r of progress.runs.filter(r => !terminalState(r, now, staleMs).terminal)) {
    console.error(`  ${r.runId} (${r.done}/${r.total} done, ${r.errors} errors)`);
  }
  process.exit(1);
}

// Fleet-wide coordinator health, pooled across every shard's `coordinator_metrics`
// samples (coordinator.ts emits these every 5s). getBatchMetricStats gives a
// distribution per field; we surface peaks (max) and means (avg). Only the fields
// the coordinator emits as a metric are queryable here — heap/cpu/event-loop-max
// live solely in each shard's Tigris metrics.jsonl. Each call is best-effort.
const metricField = (field: string) =>
  safe(() => query.getBatchMetricStats(groupId, { name: 'coordinator_metrics', field }) as Promise<BenchMetricDistribution>, null);
const [memRss, eloopP99, openFds, tcpInuse, tcpTw, load1m] = await Promise.all([
  metricField('mem_rss_mb'),
  metricField('event_loop_p99_ms'),
  metricField('open_fds'),
  metricField('tcp_inuse'),
  metricField('tcp_tw'),
  metricField('loadavg_1m'),
]);
const metrics_summary = (memRss?.count ?? 0) > 0 ? {
  source: 'coordinator_metrics pooled across all shards (bench metric stream)',
  sample_count: memRss!.count,
  peak_mem_rss_mb: memRss?.max ?? null,
  mean_mem_rss_mb: memRss?.avg != null ? Math.round(memRss.avg) : null,
  peak_event_loop_p99_ms: eloopP99?.max ?? null,
  mean_event_loop_p99_ms: eloopP99?.avg ?? null,
  peak_open_fds: openFds?.max ?? null,
  peak_tcp_inuse: tcpInuse?.max ?? null,
  peak_tcp_tw: tcpTw?.max ?? null,
  peak_loadavg_1m: load1m?.max ?? null,
  mean_loadavg_1m: load1m?.avg ?? null,
} : null;

// Concurrency- and throughput-over-time. The single-VM coordinator builds these
// from per-sandbox intervals it holds in memory; across shards we can only get
// them from the timeline endpoint, which is currently unavailable (503). Attempt
// anyway with a null fallback so these populate automatically once it's served.
const tryTimeline = (name: string, field: string, agg: 'sum' | 'avg' | 'max' | 'count') =>
  safe(() => query.getBatchMetricTimeline(groupId, { name, field, interval: '1s', agg }) as Promise<BenchMetricTimeline>, null);
const [concurrencyTl, throughputTl] = await Promise.all([
  tryTimeline('concurrency', 'active', 'max'),
  tryTimeline('latency_ms', 'value', 'count'),
]);
// Re-base timestamps to t=0 at the first point so the series is run-relative.
const relSeries = (tl: BenchMetricTimeline | null): Array<{ t_ms: number; value: number }> | null => {
  if (!tl || tl.points.length === 0) return null;
  const t0 = parseApiTs(tl.points[0].ts);
  if (t0 == null) return null;
  return tl.points.map(p => ({ t_ms: (parseApiTs(p.ts) ?? t0) - t0, value: p.value }));
};
const concurrencySeries = relSeries(concurrencyTl);
const concurrency_timeline = concurrencySeries
  ? concurrencySeries.map(p => ({ t_ms: p.t_ms, active: p.value }))
  : null;
let concurrency_summary: Record<string, number> | null = null;
if (concurrencySeries && concurrencySeries.length > 0) {
  let peak = -Infinity, peakT = 0;
  for (const p of concurrencySeries) if (p.value > peak) { peak = p.value; peakT = p.t_ms; }
  concurrency_summary = {
    peak_concurrent: peak,
    peak_t_ms: peakT,
    mean_concurrent: Math.round(concurrencySeries.reduce((s, p) => s + p.value, 0) / concurrencySeries.length),
    total_run_ms: concurrencySeries[concurrencySeries.length - 1].t_ms,
    sample_interval_ms: 1000,
  };
}
const throughputSeries = relSeries(throughputTl);
const throughput_timeline = throughputSeries
  ? throughputSeries.map(p => ({ t_ms: p.t_ms, finalized: p.value }))
  : null;

// Prefer metric-derived per-sandbox status splits. The sandbox_result stream
// emits one status per finalized sandbox, so when it has any rows a missing
// bucket is a true zero — not unknown. Only when the stream is empty (older /
// unavailable) do we fall back to the progress rollup (or null where it can't
// be split).
const haveStatus = statusCounts.total > 0;
const succeeded = statusMap.success ?? (haveStatus ? 0 : sandboxesDone - sandboxErrors);
const partials = statusMap.partial ?? (haveStatus ? 0 : null);
const readinessFailures = statusMap.readiness_failed ?? (haveStatus ? 0 : null);
const failed = statusMap.failed ?? (haveStatus ? 0 : sandboxErrors);

const provider = [...new Set(runsRes.items.map((r: BenchRunSummary) => r.provider).filter(Boolean))].join(',') || 'unknown';

const final = {
  sandboxes_attempted: sandboxesAttempted,
  sandboxes_succeeded: succeeded,
  partials,
  readiness_failures: readinessFailures,
  failures: failed,
  timeouts,
  http_errors: httpErrors,
  network_errors: networkErrors,
  p50_latency_ms: latencyDist.p50,
  p99_latency_ms: latencyDist.p99,
};

const aggregate = {
  ...final,
  latency_distribution: {
    count: latencyDist.count,
    min_ms: latencyDist.min,
    p10_ms: latencyDist.p10 ?? null,
    p25_ms: latencyDist.p25 ?? null,
    p50_ms: latencyDist.p50,
    p75_ms: latencyDist.p75 ?? null,
    p90_ms: latencyDist.p90 ?? null,
    p95_ms: latencyDist.p95,
    p99_ms: latencyDist.p99,
    p999_ms: latencyDist.p999 ?? null,
    max_ms: latencyDist.max,
    mean_ms: latencyDist.avg,
  },
  status_histogram: {
    success: succeeded,
    partial: partials,
    readiness_failed: readinessFailures,
    failed,
  },
  create_failure_class,
  failure_breakdown_by_code: errorCodeCounts.counts,
  first_command_distribution: {
    count: firstCmdDist.count,
    min_ms: firstCmdDist.min,
    p10_ms: firstCmdDist.p10 ?? null,
    p25_ms: firstCmdDist.p25 ?? null,
    p50_ms: firstCmdDist.p50,
    p75_ms: firstCmdDist.p75 ?? null,
    p90_ms: firstCmdDist.p90 ?? null,
    p95_ms: firstCmdDist.p95,
    p99_ms: firstCmdDist.p99,
    p999_ms: firstCmdDist.p999 ?? null,
    max_ms: firstCmdDist.max,
    mean_ms: firstCmdDist.avg,
  },
  tti_distribution: {
    count: ttiDist.count,
    min_ms: ttiDist.min,
    p10_ms: ttiDist.p10 ?? null,
    p25_ms: ttiDist.p25 ?? null,
    p50_ms: ttiDist.p50,
    p75_ms: ttiDist.p75 ?? null,
    p90_ms: ttiDist.p90 ?? null,
    p95_ms: ttiDist.p95,
    p99_ms: ttiDist.p99,
    p999_ms: ttiDist.p999 ?? null,
    max_ms: ttiDist.max,
    mean_ms: ttiDist.avg,
  },
  submission_segments: latencyBySegmentRaw,
  concurrency_summary,
  concurrency_timeline,
  throughput_timeline,
  metrics_summary,
  group_id: groupId,
  provider,
  shard_count: runsRes.items.length,
  shards: runsRes.items.map((r: BenchRunSummary) => ({
    run_id: r.runId,
    status: r.status,
    started_at: r.startedAt,
    ended_at: r.endedAt ?? null,
    tigris_prefix: `s3://${process.env.TIGRIS_STORAGE_BUCKET ?? '<bucket>'}/${r.runId}/`,
  })),
  started_at: runsRes.items.reduce<string | null>((m: string | null, r: BenchRunSummary) =>
    (m == null || r.startedAt < m ? r.startedAt : m), null),
  ended_at: runsRes.items.reduce<string | null>((m: string | null, r: BenchRunSummary) =>
    (r.endedAt && (m == null || r.endedAt > m) ? r.endedAt : m), null),
  aggregated_at: new Date().toISOString(),
  tigris_prefix: null,
};

const manifest = {
  schema_version: 1,
  group_id: groupId,
  provider,
  shard_count: runsRes.items.length,
  started_at: aggregate.started_at,
  ended_at: aggregate.ended_at,
  aggregated_at: aggregate.aggregated_at,
  tigris_group_prefix: process.env.TIGRIS_STORAGE_BUCKET
    ? `s3://${process.env.TIGRIS_STORAGE_BUCKET}/groups/${groupId}/`
    : null,
  shards: runsRes.items.map((r: BenchRunSummary) => ({
    run_id: r.runId,
    status: r.status,
    started_at: r.startedAt,
    ended_at: r.endedAt ?? null,
    tigris_prefix: process.env.TIGRIS_STORAGE_BUCKET
      ? `s3://${process.env.TIGRIS_STORAGE_BUCKET}/${r.runId}/`
      : null,
  })),
};

// ─── pretty-print ────────────────────────────────────────────────────────
// The report mirrors the metric data we pull: a full percentile table per phase
// (allocate / readiness / time-to-interactive), the status split, submission-
// order fairness, and a failure-by-code breakdown — not just headline p50/p99.
const rule = '═'.repeat(67);
const num = (n: number | null | undefined): string => (n == null ? '-' : Math.round(n).toLocaleString());
const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(2)}%` : '-');

// One-line percentile summary for a *_distribution block (keys are *_ms).
type Dist = { count: number; min_ms: number | null; p50_ms: number | null; p90_ms?: number | null;
  p95_ms: number | null; p99_ms: number | null; p999_ms?: number | null; max_ms: number | null; mean_ms: number | null };
const distBlock = (title: string, d: Dist | null): void => {
  if (!d || !d.count) return;
  console.log(`  ${title}`);
  console.log(`    count=${d.count.toLocaleString()}  min=${num(d.min_ms)}  p50=${num(d.p50_ms)}  ` +
    `p90=${num(d.p90_ms)}  p95=${num(d.p95_ms)}  p99=${num(d.p99_ms)}  ` +
    `p999=${num(d.p999_ms)}  max=${num(d.max_ms)}  mean=${num(d.mean_ms)}`);
};

console.log('');
console.log(rule);
console.log(` aggregate :: ${groupId}`);
console.log(rule);
console.log(`  provider:         ${provider}`);
console.log(`  shards:           ${shardsTerminal}/${progress.runs.length} ` +
  (shardsRunning > 0 ? `(${shardsRunning} still running)` : '(all terminal)') +
  (shardsStalled > 0 ? ` — ${shardsStalled} stalled (${(sandboxesAttempted - sandboxesDone).toLocaleString()} progress heartbeat(s) unreported; success/fail counts below come from sandbox_result metrics)` : ''));
console.log(`  attempted:        ${final.sandboxes_attempted.toLocaleString()}`);
console.log(`  succeeded:        ${num(succeeded)} (${pct(succeeded, sandboxesAttempted)})`);

// Full status split — partial/readiness_failed are distinct from outright failures.
console.log('');
console.log(`  status:           success=${num(succeeded)}  partial=${num(partials)}  ` +
  `readiness_failed=${num(readinessFailures)}  failed=${num(failed)}`);
if (create_failure_class) {
  console.log(`  create-fail class: timeout=${num(timeouts)}  http=${num(httpErrors)}  network=${num(networkErrors)}`);
}

// Per-phase latency distributions (only print phases that have samples).
console.log('');
distBlock('allocate latency (ms):', aggregate.latency_distribution);
distBlock('readiness / first-command (ms):', aggregate.first_command_distribution);
distBlock('time-to-interactive (ms):', aggregate.tti_distribution);

// Submission-order fairness: does the provider favour earlier-submitted requests?
const segments = latencyBySegmentRaw as BenchGroupedMetricDistribution;
if (segments?.groups?.length) {
  const order = ['first_25pct', 'middle_50pct', 'last_25pct'];
  const sorted = [...segments.groups].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  console.log('');
  console.log(`  submission order (allocate ms):`);
  for (const g of sorted) {
    console.log(`    ${g.key.padEnd(13)} count=${g.count.toLocaleString()}  ` +
      `p50=${num(g.p50)}  p95=${num(g.p95)}  p99=${num(g.p99)}`);
  }
}

// Failure-by-error-code, busiest first (skip the null bucket from successes).
const codeRows = errorCodeCounts.counts
  .filter(c => c.key && c.key !== 'null')
  .sort((a, b) => b.count - a.count);
if (codeRows.length > 0) {
  console.log('');
  console.log(`  failure by code:`);
  for (const c of codeRows) console.log(`    ${c.key.padEnd(24)} ${c.count.toLocaleString()}`);
}

// Fleet-wide coordinator health and concurrency (null on short runs / no timeline).
if (metrics_summary || concurrency_summary) console.log('');
if (metrics_summary) {
  const eloop = metrics_summary.peak_event_loop_p99_ms;
  console.log(`  fleet health:     peak_rss=${metrics_summary.peak_mem_rss_mb}MB  ` +
    `peak_eloop_p99=${typeof eloop === 'number' ? eloop.toFixed(1) : '-'}ms  ` +
    `peak_fds=${metrics_summary.peak_open_fds}  peak_tcp=${metrics_summary.peak_tcp_inuse}  ` +
    `peak_load=${metrics_summary.peak_loadavg_1m}  (${metrics_summary.sample_count} samples across fleet)`);
} else {
  console.log(`  fleet health:     — (no coordinator_metrics samples; run shorter than the 5s sample interval)`);
}
if (concurrency_summary) {
  console.log(`  concurrency:      peak=${concurrency_summary.peak_concurrent}  mean=${concurrency_summary.mean_concurrent}  ` +
    `(over ${(concurrency_summary.total_run_ms / 1000).toFixed(0)}s)`);
}

console.log('');
console.log(`  source: sandbox totals roll up per-shard progress counters; status,`);
console.log(`          latency/first-command/tti, submission segments, failure-by-code,`);
console.log(`          failure-class and fleet health come from the bench metric streams.`);
console.log(`          Per-shard cpu/heap series live in each shard's Tigris meta.json.`);

// ─── local file ──────────────────────────────────────────────────────────
if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(aggregate, null, 2));
  console.log('');
  console.log(`[aggregate] wrote ${args.out}`);
}

// ─── persist to Tigris (groups/<id>/meta.json + manifest.json) ────────────
if (args.writeTigris) {
  const endpoint = process.env.TIGRIS_STORAGE_ENDPOINT;
  const bucket = process.env.TIGRIS_STORAGE_BUCKET;
  const accessKeyId = process.env.TIGRIS_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TIGRIS_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.warn('[aggregate] Tigris env vars missing — skipping Tigris upload. ' +
      'Set TIGRIS_STORAGE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY ' +
      'or pass --no-tigris to silence.');
  } else {
    const s3 = new S3Client({
      endpoint,
      region: 'auto',
      credentials: { accessKeyId, secretAccessKey },
    });
    const metaKey = `groups/${groupId}/meta.json`;
    const manifestKey = `groups/${groupId}/manifest.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: metaKey,
      Body: JSON.stringify(aggregate, null, 2),
      ContentType: 'application/json',
    }));
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: 'application/json',
    }));
    console.log(`[aggregate] uploaded s3://${bucket}/${metaKey}`);
    console.log(`[aggregate] uploaded s3://${bucket}/${manifestKey}`);
  }
}

process.exit(0);
