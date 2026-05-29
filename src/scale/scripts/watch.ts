#!/usr/bin/env node
/**
 * Watch one or more scale runs until they reach a terminal state.
 *
 * Polls the bench API for the given RUN_IDs (or the latest N runs via --recent)
 * at a fixed interval, prints a status table, and exits when every watched
 * run is terminal. Exit code: 0 if all succeeded, 1 if any failed.
 *
 * Loads .env via dotenv so BENCHMARK_INGEST_URL works the same way as the
 * runtime sees it.
 *
 * Usage:
 *   tsx src/scale/scripts/watch.ts <RUN_ID> [<RUN_ID> ...]
 *   tsx src/scale/scripts/watch.ts --recent 5
 *   tsx src/scale/scripts/watch.ts --batch group_abc123
 *   tsx src/scale/scripts/watch.ts --recent 5 --interval 10
 *   npm run bench:scale:watch -- --recent 5
 */

import 'dotenv/config';
import { createBenchQueryClient } from '@computesdk/bench';
import type { BenchRunSummary } from '@computesdk/bench';

const DEFAULT_QUERY_URL = 'https://platform.computesdk.com/api/v1';

interface Args {
  runIds: string[];
  recent: number | null;
  batchId: string | null;
  intervalMs: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/watch.ts [options] [<RUN_ID> ...]',
    '',
    'Options:',
    '  --recent <n>, -n <n>   Watch the latest <n> runs from the bench API',
    '  --batch <id>           Watch all runs in a batch/group',
    '  --interval <sec>, -i   Poll interval in seconds (default: 15)',
    '  --help, -h             Print this help',
    '',
    'Exit code:',
    '  0 — all watched runs reached terminal state',
    '  1 — at least one watched run failed',
    '  2 — bad arguments / missing env',
    '',
    'Either pass RUN_IDs, --batch, or --recent.',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { runIds: [], recent: null, batchId: null, intervalMs: 15_000 };
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
    } else if (a === '--interval' || a === '-i') {
      const v = parseInt(next(), 10);
      if (!Number.isFinite(v) || v <= 0) { console.error('--interval must be a positive integer'); process.exit(2); }
      out.intervalMs = v * 1000;
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

const queryUrl = process.env.BENCHMARK_QUERY_URL
  ?? process.env.BENCHMARK_INGEST_URL?.replace(/\/events\/?$/, '')
  ?? DEFAULT_QUERY_URL;
const apiKey = process.env.COMPUTESDK_API_KEY;
const query = createBenchQueryClient(queryUrl, apiKey);

// Resolve --recent into RUN_IDs
let watchIds = [...args.runIds];
if (args.recent !== null) {
  const { items } = await query.listRuns({ limit: args.recent });
  if (items.length === 0) {
    console.error('no runs found in bench API');
    process.exit(1);
  }
  watchIds = [...new Set([...items.map((r: BenchRunSummary) => r.runId), ...watchIds])];
}

interface WatchRow {
  id: string;
  status: string;
  done: number;
  total: number;
  errors: number;
  inFlight: number;
}

async function fetchRuns(ids: string[]): Promise<WatchRow[]> {
  const rows: WatchRow[] = [];
  for (const id of ids) {
    try {
      const progress = await query.getRunProgress(id);
      // getRun does not expose status in the current SDK, so we infer terminal
      // state from progress counters. The backend may add status later.
      const isTerminal = progress.done === progress.total;
      const status = isTerminal
        ? (progress.errors > 0 ? 'failed' : 'completed')
        : 'running';
      rows.push({
        id,
        status,
        done: progress.done,
        total: progress.total,
        errors: progress.errors,
        inFlight: progress.inFlight,
      });
    } catch (err: any) {
      rows.push({ id, status: 'MISSING', done: 0, total: 0, errors: 0, inFlight: 0 });
    }
  }
  return rows;
}

async function fetchBatch(batchId: string): Promise<WatchRow[]> {
  const progress = await query.getBatchProgress(batchId);

  // One synthetic row for the whole batch
  return [{
    id: batchId,
    status: progress.runBreakdown.failed > 0 ? 'failed'
      : progress.runBreakdown.running > 0 ? 'running'
      : 'completed',
    done: progress.done,
    total: progress.total,
    errors: progress.errors,
    inFlight: progress.inFlight,
  }];
}

function pad(s: string | number | null, n: number, align: 'l' | 'r' = 'l'): string {
  const v = s == null ? '-' : String(v);
  return align === 'l' ? v.padEnd(n) : v.padStart(n);
}

const TERMINAL = new Set(['completed', 'failed']);
const ID_COL_WIDTH = Math.max(36, ...watchIds.map(s => s.length), args.batchId?.length ?? 0);

function printTable(rows: WatchRow[], pollNum: number): void {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}]  poll ${pollNum}`);
  console.log(
    '  ' + pad('ID', ID_COL_WIDTH) +
    '  ' + pad('status', 10) +
    '  ' + pad('done/total', 12, 'r') +
    '  ' + pad('errors', 7, 'r') +
    '  ' + pad('inFlight', 8, 'r'),
  );
  for (const r of rows) {
    console.log(
      '  ' + pad(r.id, ID_COL_WIDTH) +
      '  ' + pad(r.status, 10) +
      '  ' + pad(`${r.done}/${r.total}`, 12, 'r') +
      '  ' + pad(r.errors, 7, 'r') +
      '  ' + pad(r.inFlight, 8, 'r'),
    );
  }
}

let pollNum = 0;
let finalRows: WatchRow[] = [];
while (true) {
  pollNum++;
  finalRows = args.batchId
    ? await fetchBatch(args.batchId)
    : await fetchRuns(watchIds);
  printTable(finalRows, pollNum);

  const allTerminal = finalRows.every(r => TERMINAL.has(r.status));
  if (allTerminal) break;
  await new Promise(res => setTimeout(res, args.intervalMs));
}

const anyFailed = finalRows.some(r => r.status === 'failed');
console.log(`\nall watched item(s) reached terminal state` +
  (anyFailed ? ' (some failed)' : ''));
process.exit(anyFailed ? 1 : 0);
