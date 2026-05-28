#!/usr/bin/env node
/**
 * Watch one or more scale runs until they reach a terminal state.
 *
 * Polls Postgres for the given RUN_IDs (or the latest N runs via --recent)
 * at a fixed interval, prints a status table, and exits when every watched
 * run is 'done' or 'failed'. Exit code: 0 if all 'done', 1 if any 'failed'.
 *
 * Loads .env via dotenv so PG_URL works the same way as the runtime sees it.
 *
 * Usage:
 *   tsx src/scale/scripts/watch.ts <RUN_ID> [<RUN_ID> ...]
 *   tsx src/scale/scripts/watch.ts --recent 5
 *   tsx src/scale/scripts/watch.ts --recent 5 --interval 10
 *   npm run bench:scale:watch -- --recent 5
 */

import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

interface Args {
  runIds: string[];
  recent: number | null;
  intervalMs: number;
}

function usage(): string {
  return [
    'Usage: tsx src/scale/scripts/watch.ts [options] [<RUN_ID> ...]',
    '',
    'Options:',
    '  --recent <n>, -n <n>   Watch the latest <n> runs from Postgres',
    '  --interval <sec>, -i   Poll interval in seconds (default: 15)',
    '  --help, -h             Print this help',
    '',
    'Exit code:',
    '  0 — all watched runs reached status=done',
    '  1 — at least one watched run reached status=failed',
    '  2 — bad arguments / missing env',
    '',
    'Either pass RUN_IDs as positional args or use --recent. You can combine',
    'both — explicit IDs are added to the --recent set with duplicates removed.',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { runIds: [], recent: null, intervalMs: 15_000 };
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
  if (out.runIds.length === 0 && out.recent === null) {
    console.error(`error: provide RUN_IDs or --recent N\n\n${usage()}`); process.exit(2);
  }
  return out;
}

const args = parseArgs();
const pgUrl = process.env.PG_URL;
if (!pgUrl) { console.error('PG_URL not set (check .env)'); process.exit(2); }

const client = new Client({ connectionString: pgUrl });
await client.connect();

// Resolve --recent into RUN_IDs, then merge with explicit args (dedup preserves order).
let watchIds = [...args.runIds];
if (args.recent !== null) {
  const res = await client.query<{ id: string }>(
    `SELECT id FROM runs ORDER BY started_at DESC LIMIT $1`,
    [args.recent],
  );
  if (res.rows.length === 0) {
    console.error('no runs found in Postgres');
    await client.end();
    process.exit(1);
  }
  watchIds = [...new Set([...res.rows.map(r => r.id), ...watchIds])];
}

interface RunRow {
  id: string;
  status: string;
  attempted: number;
  succeeded: number;
  partials: number;
  readiness_failures: number;
  failed: number;
  hb_secs_ago: number | null;
  error_message: string | null;
}

async function fetchRuns(ids: string[]): Promise<RunRow[]> {
  const res = await client.query<RunRow>(
    `SELECT id, status,
            COALESCE(sandboxes_attempted, 0)                    AS attempted,
            COALESCE(sandboxes_succeeded, 0)                    AS succeeded,
            COALESCE(partials, 0)                                AS partials,
            COALESCE(readiness_failures, 0)                      AS readiness_failures,
            COALESCE(timeouts + http_errors + network_errors, 0) AS failed,
            CASE WHEN last_heartbeat IS NULL THEN NULL
                 ELSE EXTRACT(EPOCH FROM (now() - last_heartbeat))::int
            END                                                  AS hb_secs_ago,
            error_message
     FROM runs
     WHERE id = ANY($1::text[])
     ORDER BY started_at`,
    [ids],
  );
  return res.rows;
}

function pad(s: string | number | null, n: number, align: 'l' | 'r' = 'l'): string {
  const v = s == null ? '-' : String(s);
  return align === 'l' ? v.padEnd(n) : v.padStart(n);
}

const TERMINAL = new Set(['done', 'failed']);
const ID_COL_WIDTH = Math.max(36, ...watchIds.map(s => s.length));

function printTable(rows: RunRow[], pollNum: number): void {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}]  poll ${pollNum}`);
  console.log(
    '  ' + pad('RUN_ID', ID_COL_WIDTH) +
    '  ' + pad('status',  8) +
    '  ' + pad('succ',    11, 'r') +
    '  ' + pad('partial', 8,  'r') +
    '  ' + pad('rdy_fail', 8, 'r') +
    '  ' + pad('failed',  7,  'r') +
    '  hb',
  );
  for (const id of watchIds) {
    const r = rows.find(x => x.id === id);
    if (!r) {
      console.log('  ' + pad(id, ID_COL_WIDTH) + '  ' + pad('MISSING', 8));
      continue;
    }
    const succ = `${r.succeeded}/${r.attempted}`;
    const hb = r.hb_secs_ago == null ? '-' : `${r.hb_secs_ago}s`;
    console.log(
      '  ' + pad(r.id,                 ID_COL_WIDTH) +
      '  ' + pad(r.status,             8) +
      '  ' + pad(succ,                 11, 'r') +
      '  ' + pad(r.partials,           8,  'r') +
      '  ' + pad(r.readiness_failures, 8,  'r') +
      '  ' + pad(r.failed,             7,  'r') +
      '  ' + hb,
    );
    if (r.status === 'failed' && r.error_message) {
      console.log('    ↳ ' + r.error_message.slice(0, 200));
    }
  }
}

let pollNum = 0;
let finalRows: RunRow[] = [];
while (true) {
  pollNum++;
  finalRows = await fetchRuns(watchIds);
  printTable(finalRows, pollNum);
  const allTerminal = watchIds.every(id => {
    const r = finalRows.find(x => x.id === id);
    return r != null && TERMINAL.has(r.status);
  });
  if (allTerminal) break;
  await new Promise(res => setTimeout(res, args.intervalMs));
}

await client.end();

const anyFailed = finalRows.some(r => r.status === 'failed');
console.log(`\nall ${watchIds.length} run(s) reached terminal state` +
  (anyFailed ? ' (some failed)' : ''));
process.exit(anyFailed ? 1 : 0);
