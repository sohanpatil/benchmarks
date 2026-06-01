#!/usr/bin/env node
/**
 * Watch one or more scale runs until they reach a terminal state.
 *
 * Accuracy note — why this leans on metrics, not the progress heartbeat:
 * the bench API exposes no run lifecycle status, and the per-run progress
 * heartbeat (done/total) is lossy: the coordinator increments `done` then emits
 * the heartbeat (runner.ts emit()), and the progress API keeps only the latest
 * snapshot per run, so a VM torn down at `--duration` drops its trailing
 * heartbeat and `done` permanently stops short of `total` (see ./progress.ts).
 *
 * The authoritative signal is the per-sandbox `sandbox_result` metric the
 * coordinator emits once per finalized sandbox (coordinator.ts) — the SAME
 * source aggregate.ts trusts. It is cumulative, not last-write-wins, so it does
 * not lose the tail. So for a sharded burst (a "batch"/group) we count finalized
 * sandboxes and their status split straight from `getBatchMetricCounts`, exactly
 * like aggregate, and the live view agrees with the final aggregate report.
 *
 * Those metric endpoints are batch-scoped, so we resolve every target to its
 * batch when one exists. A truly single-VM (batch-less) run has no batch and no
 * metric rollup, so it falls back to the heartbeat counters — clearly labeled
 * best-effort.
 *
 * Exits when every watched target is terminal. Exit code: 0 if all completed
 * cleanly, 1 if any failed or lost sandboxes, 2 on bad args / missing env.
 *
 * Loads .env via dotenv so COMPUTESDK_API_KEY works the same way as the
 * runtime sees it.
 *
 * Usage:
 *   tsx src/scale/scripts/watch.ts <RUN_ID> [<RUN_ID> ...]
 *   tsx src/scale/scripts/watch.ts --recent 5
 *   tsx src/scale/scripts/watch.ts --batch group_abc123
 *   tsx src/scale/scripts/watch.ts --batch group_abc123 --expected 100000
 *   tsx src/scale/scripts/watch.ts --recent 5 --interval 10
 *   npm run bench:scale:watch -- --recent 5
 */

import 'dotenv/config';
import { createBenchQueryClient } from '@computesdk/bench';
import type { BenchRunSummary, BenchMetricDistribution, BenchMetricCounts } from '@computesdk/bench';
import { resolveStaleMs, terminalState } from './progress.js';

interface Args {
  runIds: string[];
  recent: number | null;
  batchId: string | null;
  expected: number | null;
  intervalMs: number;
  staleSec: number | null;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/watch.ts [options] [<RUN_ID> ...]',
    '',
    'Options:',
    '  --recent <n>, -n <n>   Watch the latest <n> runs from the bench API',
    '  --batch <id>           Watch all runs in a batch/group',
    '  --expected <n>         Total sandboxes expected across the batch; pins the',
    '                         completion denominator (default: sum of shard totals)',
    '  --interval <sec>, -i   Poll interval in seconds (default: 15)',
    '  --stale <sec>          Treat a shard with no progress for <sec> as',
    '                         terminal/stalled (default: 300; or SCALE_STALE_SEC).',
    '                         Must exceed LIFECYCLE_PAUSE_MS.',
    '  --help, -h             Print this help',
    '',
    'Exit code:',
    '  0 — all watched targets completed cleanly',
    '  1 — at least one target failed or lost sandboxes',
    '  2 — bad arguments / missing env',
    '',
    'Either pass RUN_IDs, --batch, or --recent. RUN_IDs and --recent resolve to',
    'their batch when one exists (the accurate, metric-driven path); a batch-less',
    'single-VM run falls back to the heartbeat counters (best-effort).',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { runIds: [], recent: null, batchId: null, expected: null, intervalMs: 15_000, staleSec: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) { console.error(`missing value for ${a}`); process.exit(2); }
      return v;
    };
    if (a === '--recent' || a === '-n') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--recent must be a positive integer'); process.exit(2); }
      out.recent = v;
    } else if (a === '--batch') {
      out.batchId = next();
    } else if (a === '--expected') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--expected must be a positive integer'); process.exit(2); }
      out.expected = v;
    } else if (a === '--interval' || a === '-i') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--interval must be a positive integer'); process.exit(2); }
      out.intervalMs = v * 1000;
    } else if (a === '--stale') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--stale must be a positive integer'); process.exit(2); }
      out.staleSec = v;
    } else if (a === '--help' || a === '-h') {
      console.log(usage()); process.exit(0);
    } else if (a.startsWith('--') || a.startsWith('-')) {
      console.error(`unknown flag: ${a}\n${usage()}`); process.exit(2);
    } else {
      out.runIds.push(a);
    }
  }
  if (out.runIds.length === 0 && out.recent === null && out.batchId === null) {
    console.error(`error: provide RUN_IDs, --batch, or --recent N\n\n${usage()}`); process.exit(2);
  }
  return out;
}

const args = parseArgs();
const staleMs = resolveStaleMs(args.staleSec ?? undefined);

const query = createBenchQueryClient({
  baseUrl: 'https://platform.computesdk.com/api/v1',
  apiKey: process.env.COMPUTESDK_API_KEY,
});

// The SDK throws `Bench query failed: <status> <statusText>` on non-2xx. Pull
// the numeric status back out so 404 (target not known to the API) reads
// differently from 401/403 (bad/missing key) instead of a blanket miss.
function classifyError(err: unknown): { status: string; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const code = msg.match(/\b(\d{3})\b/)?.[1];
  if (code === '404') return { status: 'not-found', detail: msg };
  if (code === '401' || code === '403') return { status: 'unauthorized', detail: msg };
  return { status: 'error', detail: msg };
}

// ─── target resolution (batch-first) ────────────────────────────────────────

// A batch target uses the authoritative metric rollup; a run target is the
// best-effort heartbeat fallback for a batch-less single-VM run. A bad target
// (unknown RUN_ID, auth failure) is surfaced as a one-off error row.
type Target =
  | { kind: 'batch'; id: string }
  | { kind: 'run'; id: string }
  | { kind: 'error'; id: string; status: string; detail: string };

async function resolveTargets(): Promise<Target[]> {
  const targets: Target[] = [];
  const batchSeen = new Set<string>();
  const addBatch = (id: string): void => { if (!batchSeen.has(id)) { batchSeen.add(id); targets.push({ kind: 'batch', id }); } };

  if (args.batchId) addBatch(args.batchId);

  // Positional RUN_IDs: look up each run's batch. Local shard RUN_IDs are never
  // sent to the API (start.ts mints them only for `nsc run --name`), so an
  // unknown id classifies as not-found with a hint rather than a hard failure.
  for (const id of args.runIds) {
    try {
      const detail = await query.getRun(id);
      if (detail.batch) addBatch(detail.batch);
      else targets.push({ kind: 'run', id });
    } catch (err) {
      const { status, detail } = classifyError(err);
      targets.push({ kind: 'error', id, status, detail });
    }
  }

  if (args.recent !== null) {
    const { items } = await query.listRuns({ limit: args.recent });
    if (items.length === 0 && targets.length === 0) {
      console.error('no runs found in bench API');
      process.exit(1);
    }
    for (const r of items as BenchRunSummary[]) {
      if (r.batch) addBatch(r.batch);
      else targets.push({ kind: 'run', id: r.runId });
    }
  }

  return targets;
}

const targets = await resolveTargets();

// ─── per-poll state ─────────────────────────────────────────────────────────

interface WatchRow {
  id: string;
  kind: Target['kind'];
  status: string;
  finalized: number;
  expected: number;
  success: number;
  partial: number;
  readinessFailed: number;
  failed: number;
  inFlight: number;
  p50: number | null;
  p99: number | null;
  ratePerSec: number | null;
  detail?: string;
}

// Previous-poll finalized count + wall time per target, for throughput.
const lastSeen = new Map<string, { finalized: number; atMs: number }>();

const countMap = (rows: Array<{ key: string; count: number }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.key] = row.count;
  return out;
};

// Each metric call is wrapped: early in a run there may be no events yet (or a
// transient blip), and a live poll must never crash on one missing signal.
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

async function fetchBatchRow(id: string, nowMs: number): Promise<WatchRow> {
  const [progress, statusCountsRaw, errorCodeCountsRaw, latencyRaw] = await Promise.all([
    safe(() => query.getBatchProgress(id), { runs: [], latestProgressAt: null }),
    safe(() => query.getBatchMetricCounts(id, { name: 'sandbox_result', field: 'status' }) as Promise<BenchMetricCounts>,
      { field: 'status', total: 0, counts: [] }),
    safe(() => query.getBatchMetricCounts(id, { name: 'sandbox_result', field: 'error_code' }) as Promise<BenchMetricCounts>,
      { field: 'error_code', total: 0, counts: [] }),
    safe(() => query.getBatchMetricStats(id, { name: 'latency_ms', field: 'value' }) as Promise<BenchMetricDistribution>,
      null),
  ]);

  const statusMap = countMap(statusCountsRaw.counts);
  // `finalized` is the authoritative count of sandboxes that emitted a result —
  // not the lossy heartbeat `done`.
  const finalized = statusCountsRaw.total;
  const success = statusMap.success ?? 0;
  const partial = statusMap.partial ?? 0;
  const readinessFailed = statusMap.readiness_failed ?? 0;
  const failed = statusMap.failed ?? 0;

  // Denominator: explicit --expected, else the sum of per-shard totals the
  // heartbeat reports (each shard sets `total` on its first heartbeat).
  const summedTotal = progress.runs.reduce((s, r) => s + r.total, 0);
  const expected = args.expected ?? summedTotal;
  const inFlight = progress.runs.reduce((s, r) => s + r.inFlight, 0);
  const shardsRegistered = progress.runs.length;
  const shardsReporting = progress.runs.filter(r => r.total > 0).length;

  // Terminal: authoritative finalized >= expected is a clean finish. Otherwise,
  // if every shard has gone quiet past the stale threshold, the batch is
  // terminal-but-degraded — and because `finalized` is authoritative, the
  // missing `expected - finalized` sandboxes genuinely never finalized (their VM
  // was torn down mid-flight / leaked), so they are lost, not merely unreported.
  const allStale = shardsReporting > 0 && progress.runs.every(r => terminalState(r, nowMs, staleMs).terminal);
  const complete = expected > 0 && finalized >= expected;
  const lostCount = Math.max(0, expected - finalized);

  let status: string;
  if (complete) status = failed > 0 ? 'failed' : 'completed';
  else if (allStale) status = lostCount > 0 ? 'lost' : (failed > 0 ? 'failed' : 'completed');
  else status = 'running';

  // Throughput between polls, from the authoritative finalized count.
  const prev = lastSeen.get(id);
  let ratePerSec: number | null = null;
  if (prev) {
    const dt = (nowMs - prev.atMs) / 1000;
    if (dt > 0) ratePerSec = Math.max(0, (finalized - prev.finalized) / dt);
  }
  lastSeen.set(id, { finalized, atMs: nowMs });

  const latency = latencyRaw as BenchMetricDistribution | null;

  const detailBits: string[] = [];
  const terminal = status !== 'running';
  if (terminal && lostCount > 0) {
    detailBits.push(`${lostCount.toLocaleString()} sandbox(es) never finalized (no sandbox_result) — VM(s) torn down mid-flight`);
  }
  if (!terminal && shardsRegistered > shardsReporting) {
    detailBits.push(`${shardsRegistered - shardsReporting}/${shardsRegistered} shard(s) registered but not yet reporting`);
  }
  if (errorCodeCountsRaw.counts.length > 0) {
    const codes = errorCodeCountsRaw.counts
      .filter(c => c.key && c.key !== 'null')
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(c => `${c.key}=${c.count}`);
    if (codes.length > 0) detailBits.push(`error codes: ${codes.join(' ')}`);
  }

  return {
    id, kind: 'batch', status,
    finalized, expected, success, partial, readinessFailed, failed,
    inFlight,
    p50: latency?.p50 ?? null,
    p99: latency?.p99 ?? null,
    ratePerSec,
    detail: detailBits.length > 0 ? detailBits.join(' | ') : undefined,
  };
}

// Best-effort fallback for a batch-less single-VM run. No metric rollup exists,
// so this leans on the lossy heartbeat counters — see the header note.
async function fetchRunRow(id: string, nowMs: number): Promise<WatchRow> {
  try {
    const p = await query.getRunProgress(id);
    const { terminal, stalled } = terminalState(p, nowMs, staleMs);
    const status = !terminal ? 'running' : stalled ? 'stalled' : (p.errors > 0 ? 'failed' : 'completed');
    const prev = lastSeen.get(id);
    let ratePerSec: number | null = null;
    if (prev) {
      const dt = (nowMs - prev.atMs) / 1000;
      if (dt > 0) ratePerSec = Math.max(0, (p.done - prev.finalized) / dt);
    }
    lastSeen.set(id, { finalized: p.done, atMs: nowMs });
    return {
      id, kind: 'run', status,
      finalized: p.done, expected: p.total,
      success: Math.max(0, p.done - p.errors), partial: 0, readinessFailed: 0, failed: p.errors,
      inFlight: p.inFlight, p50: null, p99: null, ratePerSec,
      detail: 'heartbeat-based (best-effort): batch-less run has no sandbox_result rollup' +
        (stalled ? `; no heartbeat for >${Math.round(staleMs / 1000)}s` : ''),
    };
  } catch (err) {
    const { status, detail } = classifyError(err);
    return {
      id, kind: 'run', status,
      finalized: 0, expected: 0, success: 0, partial: 0, readinessFailed: 0, failed: 0,
      inFlight: 0, p50: null, p99: null, ratePerSec: null, detail,
    };
  }
}

function errorRow(t: Extract<Target, { kind: 'error' }>): WatchRow {
  return {
    id: t.id, kind: 'error', status: t.status,
    finalized: 0, expected: 0, success: 0, partial: 0, readinessFailed: 0, failed: 0,
    inFlight: 0, p50: null, p99: null, ratePerSec: null, detail: t.detail,
  };
}

async function fetchRows(): Promise<WatchRow[]> {
  const now = Date.now();
  return Promise.all(targets.map(t =>
    t.kind === 'batch' ? fetchBatchRow(t.id, now)
      : t.kind === 'run' ? fetchRunRow(t.id, now)
        : Promise.resolve(errorRow(t)),
  ));
}

// ─── table ──────────────────────────────────────────────────────────────────

function pad(s: string | number | null, n: number, align: 'l' | 'r' = 'l'): string {
  const v = s == null ? '-' : String(s);
  return align === 'l' ? v.padEnd(n) : v.padStart(n);
}

const TERMINAL = new Set(['completed', 'failed', 'lost', 'stalled', 'not-found', 'unauthorized', 'error']);
const ID_COL_WIDTH = Math.max(36, ...targets.map(t => t.id.length));

function pctOf(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '-';
}

function printTable(rows: WatchRow[], pollNum: number): void {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}]  poll ${pollNum}`);
  console.log(
    '  ' + pad('TARGET', ID_COL_WIDTH) +
    '  ' + pad('status', 10) +
    '  ' + pad('finalized/expected', 20, 'r') +
    '  ' + pad('ok', 7, 'r') +
    '  ' + pad('part', 6, 'r') +
    '  ' + pad('rdyF', 6, 'r') +
    '  ' + pad('fail', 6, 'r') +
    '  ' + pad('inFlt', 6, 'r') +
    '  ' + pad('p50/p99 ms', 14, 'r') +
    '  ' + pad('rate/s', 8, 'r'),
  );
  for (const r of rows) {
    const frac = `${r.finalized.toLocaleString()}/${r.expected.toLocaleString()} ${pctOf(r.finalized, r.expected)}`;
    const lat = r.p50 != null || r.p99 != null ? `${r.p50 ?? '-'}/${r.p99 ?? '-'}` : '-';
    console.log(
      '  ' + pad(r.id, ID_COL_WIDTH) +
      '  ' + pad(r.status, 10) +
      '  ' + pad(frac, 20, 'r') +
      '  ' + pad(r.success, 7, 'r') +
      '  ' + pad(r.partial, 6, 'r') +
      '  ' + pad(r.readinessFailed, 6, 'r') +
      '  ' + pad(r.failed, 6, 'r') +
      '  ' + pad(r.inFlight, 6, 'r') +
      '  ' + pad(lat, 14, 'r') +
      '  ' + pad(r.ratePerSec == null ? '-' : r.ratePerSec.toFixed(1), 8, 'r'),
    );
  }
  for (const r of rows.filter(r => r.detail)) {
    console.log(`    ! ${r.id}: ${r.detail}`);
  }
  if (rows.some(r => r.status === 'not-found')) {
    console.log('    hint: pass the API run_… id, or watch the whole run with --batch <group_id> / --recent N');
  }
}

// ─── poll loop ──────────────────────────────────────────────────────────────

let pollNum = 0;
let finalRows: WatchRow[] = [];
while (true) {
  pollNum++;
  finalRows = await fetchRows();
  printTable(finalRows, pollNum);

  if (finalRows.every(r => TERMINAL.has(r.status))) break;
  await new Promise(res => setTimeout(res, args.intervalMs));
}

const anyFailed = finalRows.some(r => r.status === 'failed' || r.status === 'lost');
const anyDegraded = finalRows.some(r => r.status === 'stalled' || r.status === 'not-found' || r.status === 'unauthorized' || r.status === 'error');
console.log(`\nall watched target(s) reached terminal state` +
  (anyFailed ? ' (some failed/lost)' : anyDegraded ? ' (some degraded)' : ''));
process.exit(anyFailed ? 1 : 0);
