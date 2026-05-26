#!/usr/bin/env node
/**
 * Aggregate sandbox_results across every shard in a sharded-burst group and
 * recompute the same metrics shape an unsharded burst would emit in its
 * meta.json.
 *
 * Pulls everything from Postgres — does not touch Tigris. That keeps the
 * tool fast and dependency-free; the per-VM Tigris meta.json files are
 * still available for the raw / metrics_summary slices that don't aggregate
 * meaningfully across VMs.
 *
 * Usage:
 *   tsx scripts/burst-100k-aggregate.ts --group <GROUP_ID>
 *   tsx scripts/burst-100k-aggregate.ts --recent
 *   tsx scripts/burst-100k-aggregate.ts --group <GROUP_ID> --out meta.json
 *   npm run bench:burst-100k:aggregate -- --group <GROUP_ID>
 *
 * Exit code:
 *   0 — group found and aggregated (status is reported in the output)
 *   1 — at least one shard in the group is non-terminal (still running) and
 *       --wait was not passed
 *   2 — bad arguments / missing env / no matching group
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import pg from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const { Client } = pg;

interface Args {
  groupId?: string;
  recent: boolean;
  out?: string;
  requireTerminal: boolean;
  writePg: boolean;
  writeTigris: boolean;
}

function usage(): string {
  return [
    'Usage: tsx scripts/burst-100k-aggregate.ts [options]',
    '',
    'One of:',
    '  --group <id>           Aggregate the named group',
    '  --recent               Aggregate the most-recently-started group',
    '',
    'Optional:',
    '  --out <file>           Also write the aggregate meta.json to <file>',
    '  --allow-running        Aggregate even if some shards are still running',
    '                         (default: refuse and exit 1)',
    '  --no-pg                Do not UPSERT into run_groups',
    '  --no-tigris            Do not upload meta.json to Tigris',
    '  --help, -h             Print this help',
    '',
    'Persistence (default ON; required env if enabled):',
    '  Postgres → run_groups (PG_URL)',
    '  Tigris   → s3://<bucket>/groups/<group_id>/meta.json',
    '             (TIGRIS_STORAGE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY)',
  ].join('\n');
}

function parseArgs(): Args {
  const out: Args = { recent: false, requireTerminal: true, writePg: true, writeTigris: true };
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
    else if (a === '--no-pg') out.writePg = false;
    else if (a === '--no-tigris') out.writeTigris = false;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.groupId && !out.recent) { console.error(`pass --group <id> or --recent\n${usage()}`); process.exit(2); }
  return out;
}

const args = parseArgs();
const pgUrl = process.env.PG_URL;
if (!pgUrl) { console.error('PG_URL not set (check .env)'); process.exit(2); }

const client = new Client({ connectionString: pgUrl });
await client.connect();

let groupId = args.groupId;
if (!groupId) {
  const res = await client.query<{ group_id: string }>(
    `SELECT group_id FROM runs
     WHERE group_id IS NOT NULL
     GROUP BY group_id
     ORDER BY MAX(started_at) DESC
     LIMIT 1`,
  );
  if (res.rows.length === 0) {
    console.error('no sharded groups found in Postgres');
    await client.end();
    process.exit(2);
  }
  groupId = res.rows[0].group_id;
  console.log(`[aggregate] --recent → group_id=${groupId}`);
}

interface RunRow {
  id: string;
  provider: string;
  shard_index: number | null;
  shard_count: number | null;
  status: string;
  started_at: Date;
  ended_at: Date | null;
}

const runsRes = await client.query<RunRow>(
  `SELECT id, provider, shard_index, shard_count, status, started_at, ended_at
   FROM runs WHERE group_id = $1
   ORDER BY shard_index NULLS LAST, started_at`,
  [groupId],
);
if (runsRes.rows.length === 0) {
  console.error(`no runs found for group_id=${groupId}`);
  await client.end();
  process.exit(2);
}

const providers = [...new Set(runsRes.rows.map(r => r.provider))];
const provider = providers.length === 1 ? providers[0] : providers.join(',');
const nonTerminal = runsRes.rows.filter(r => r.status === 'running');
if (nonTerminal.length > 0 && args.requireTerminal) {
  console.error(
    `group ${groupId} has ${nonTerminal.length} shard(s) still running; ` +
    `pass --allow-running to aggregate anyway`,
  );
  console.error(`still-running shards:`);
  for (const r of nonTerminal) console.error(`  ${r.id} (shard ${r.shard_index})`);
  await client.end();
  process.exit(1);
}

const runIds = runsRes.rows.map(r => r.id);
const shardCount = runsRes.rows[0].shard_count ?? runIds.length;

console.log(`[aggregate] group=${groupId} provider=${provider} shards=${runIds.length}/${shardCount}`);

interface ResultRow {
  run_id: string;
  sandbox_idx: number;
  started_at: Date;
  completed_at: Date | null;
  latency_ms: number | null;
  first_command_ms: number | null;
  status: 'success' | 'partial' | 'readiness_failed' | 'failed';
  failure_class: 'timeout' | 'http_error' | 'network_error' | null;
}

console.log(`[aggregate] querying sandbox_results...`);
const resultsRes = await client.query<ResultRow>(
  `SELECT run_id, sandbox_idx, started_at, completed_at, latency_ms,
          first_command_ms, status, failure_class
   FROM sandbox_results
   WHERE run_id = ANY($1::text[])`,
  [runIds],
);
console.log(`[aggregate] ${resultsRes.rows.length.toLocaleString()} sandbox rows loaded`);

// Per-shard ordering for submission segments. Map run_id → shard_index so we
// can sort `(shard_index, sandbox_idx)` for the global submission order.
const shardOf = new Map<string, number>();
for (const r of runsRes.rows) shardOf.set(r.id, r.shard_index ?? 0);

const statusCounts = { success: 0, partial: 0, readiness_failed: 0, failed: 0 };
const createFailureClass = { timeout: 0, http_error: 0, network_error: 0 };
const okResults: Array<{ shard: number; idx: number; ms: number; first_command_ms: number | null }> = [];
const intervals: Array<{ start: number; end: number }> = [];

for (const r of resultsRes.rows) {
  statusCounts[r.status]++;
  if (r.status === 'success' && r.latency_ms != null) {
    okResults.push({
      shard: shardOf.get(r.run_id) ?? 0,
      idx: r.sandbox_idx,
      ms: r.latency_ms,
      first_command_ms: r.first_command_ms,
    });
  } else if (r.status === 'failed' && r.failure_class) {
    createFailureClass[r.failure_class]++;
  }
  const start = r.started_at.getTime();
  const end = r.completed_at ? r.completed_at.getTime() : start;
  intervals.push({ start, end });
}

const totalAttempted = resultsRes.rows.length;
const latencies = okResults.map(r => r.ms).sort((a, b) => a - b);
const pct = (q: number): number =>
  latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

const final = {
  sandboxes_attempted: totalAttempted,
  sandboxes_succeeded: statusCounts.success,
  partials: statusCounts.partial,
  readiness_failures: statusCounts.readiness_failed,
  failures: statusCounts.failed,
  timeouts: createFailureClass.timeout,
  http_errors: createFailureClass.http_error,
  network_errors: createFailureClass.network_error,
  p50_latency_ms: pct(0.5),
  p99_latency_ms: pct(0.99),
};

const status_histogram = {
  success: statusCounts.success,
  partial: statusCounts.partial,
  readiness_failed: statusCounts.readiness_failed,
  failed: statusCounts.failed,
};
const create_failure_class = {
  timeout: createFailureClass.timeout,
  http_error: createFailureClass.http_error,
  network_error: createFailureClass.network_error,
};

function distributionOf(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    count: sorted.length,
    min_ms:  sorted[0],
    p10_ms:  p(0.10),
    p25_ms:  p(0.25),
    p50_ms:  p(0.50),
    p75_ms:  p(0.75),
    p90_ms:  p(0.90),
    p95_ms:  p(0.95),
    p99_ms:  p(0.99),
    p999_ms: p(0.999),
    max_ms:  sorted[sorted.length - 1],
    mean_ms: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
  };
}

const latency_distribution = distributionOf(latencies);
const first_command_values = okResults.map(r => r.first_command_ms).filter((v): v is number => v != null);
const first_command_distribution = distributionOf(first_command_values);
const tti_values = okResults
  .filter(r => r.first_command_ms != null)
  .map(r => r.ms + (r.first_command_ms as number));
const tti_distribution = distributionOf(tti_values);

// Submission-order segments. Submission order across shards is concurrent
// (every shard fires at t=0 in its own process), so the union sorted by
// (shard, sandbox_idx) approximates "all sandboxes by global submission
// rank" — the first 25% means "first 25% of each shard's submissions".
const okSorted = [...okResults].sort((a, b) => a.shard - b.shard || a.idx - b.idx);
const segmentDefs = [
  { name: 'first_25pct',  lo: 0,                              hi: Math.floor(totalAttempted * 0.25) },
  { name: 'middle_50pct', lo: Math.floor(totalAttempted * 0.25), hi: Math.floor(totalAttempted * 0.75) },
  { name: 'last_25pct',   lo: Math.floor(totalAttempted * 0.75), hi: totalAttempted },
];
const submission_segments: Record<string, unknown> = {};
for (const seg of segmentDefs) {
  const segLatencies = okSorted
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => i >= seg.lo && i < seg.hi)
    .map(({ r }) => r.ms)
    .sort((a, b) => a - b);
  const segPct = (q: number): number =>
    segLatencies.length === 0 ? 0
      : segLatencies[Math.min(segLatencies.length - 1, Math.floor(segLatencies.length * q))];
  submission_segments[seg.name] = {
    idx_range: [seg.lo, seg.hi - 1],
    count_ok: segLatencies.length,
    p50_ms: segPct(0.50),
    p95_ms: segPct(0.95),
    p99_ms: segPct(0.99),
    max_ms: segLatencies.length ? segLatencies[segLatencies.length - 1] : 0,
    mean_ms: segLatencies.length
      ? Math.round(segLatencies.reduce((s, v) => s + v, 0) / segLatencies.length)
      : 0,
  };
}

// Concurrency timeline over the group. Same algorithm the coordinator uses.
let concurrency_summary: unknown = null;
let concurrency_timeline: Array<{ t_ms: number; active: number }> = [];
if (intervals.length > 0) {
  const minStart = intervals.reduce((m, i) => Math.min(m, i.start), Infinity);
  const maxEnd   = intervals.reduce((m, i) => Math.max(m, i.end),   -Infinity);
  const durationMs = maxEnd - minStart;

  const events: Array<{ t: number; delta: number }> = [];
  for (const i of intervals) {
    events.push({ t: i.start - minStart, delta: 1 });
    events.push({ t: i.end   - minStart, delta: -1 });
  }
  events.sort((a, b) => a.t - b.t || b.delta - a.delta);

  let active = 0, peakActive = 0, peakT = 0;
  const SAMPLE_MS = 1000;
  let ei = 0;
  for (let t = 0; t <= durationMs; t += SAMPLE_MS) {
    while (ei < events.length && events[ei].t <= t) {
      active += events[ei].delta;
      if (active > peakActive) { peakActive = active; peakT = events[ei].t; }
      ei++;
    }
    concurrency_timeline.push({ t_ms: t, active });
  }
  while (ei < events.length) {
    active += events[ei].delta;
    if (active > peakActive) { peakActive = active; peakT = events[ei].t; }
    ei++;
  }
  const meanActive = concurrency_timeline.reduce((s, p) => s + p.active, 0)
    / Math.max(1, concurrency_timeline.length);
  concurrency_summary = {
    peak_concurrent: peakActive,
    peak_t_ms: peakT,
    mean_concurrent: Math.round(meanActive),
    total_run_ms: durationMs,
    sample_interval_ms: SAMPLE_MS,
  };
}

const earliestStart = runsRes.rows.reduce<Date | null>(
  (m, r) => (m == null || r.started_at < m ? r.started_at : m), null);
const latestEnd = runsRes.rows.reduce<Date | null>(
  (m, r) => (r.ended_at && (m == null || r.ended_at > m) ? r.ended_at : m), null);

// Tigris key for the aggregated meta.json: YYYY-MM-DD/<provider>/meta.json
const tigrisBucket = process.env.TIGRIS_STORAGE_BUCKET;
const runDate = earliestStart ? earliestStart.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
const tigrisPrefix = tigrisBucket ? `s3://${tigrisBucket}/${runDate}/${provider}/` : null;

const aggregate = {
  ...final,
  latency_distribution,
  first_command_distribution,
  tti_distribution,
  status_histogram,
  create_failure_class,
  submission_segments,
  concurrency_summary,
  concurrency_timeline,
  group_id: groupId,
  provider,
  shard_count: shardCount,
  shards: runsRes.rows.map(r => ({
    run_id: r.id,
    shard_index: r.shard_index,
    status: r.status,
    started_at: r.started_at.toISOString(),
    ended_at: r.ended_at?.toISOString() ?? null,
  })),
  started_at: earliestStart?.toISOString() ?? null,
  ended_at: latestEnd?.toISOString() ?? null,
  aggregated_at: new Date().toISOString(),
  tigris_prefix: tigrisPrefix,
};

// ─── pretty-print ────────────────────────────────────────────────────────
const rule = '═'.repeat(67);
console.log('');
console.log(rule);
console.log(` aggregate :: ${groupId}`);
console.log(rule);
console.log(`  provider:         ${provider}`);
console.log(`  shards:           ${runIds.length}/${shardCount} ` +
  (nonTerminal.length > 0 ? `(${nonTerminal.length} still running)` : '(all terminal)'));
console.log(`  attempted:        ${final.sandboxes_attempted.toLocaleString()}`);
console.log(`  succeeded:        ${final.sandboxes_succeeded.toLocaleString()} ` +
  `(${((final.sandboxes_succeeded / Math.max(1, final.sandboxes_attempted)) * 100).toFixed(2)}%)`);
console.log(`  partial:          ${final.partials.toLocaleString()}`);
console.log(`  readiness_failed: ${final.readiness_failures.toLocaleString()}`);
console.log(`  failed (create):  ${final.failures.toLocaleString()} ` +
  `(timeouts=${final.timeouts} http=${final.http_errors} network=${final.network_errors})`);
console.log('');
console.log(`  allocate-phase latency (status='success' only):`);
console.log(`    p50:  ${final.p50_latency_ms}ms`);
console.log(`    p99:  ${final.p99_latency_ms}ms`);
if (latency_distribution) {
  console.log(`    min/mean/max: ${latency_distribution.min_ms}/${latency_distribution.mean_ms}/${latency_distribution.max_ms}ms`);
}
if (first_command_distribution) {
  console.log('');
  console.log(`  first_command (node -v after create):`);
  console.log(`    p50/p99: ${first_command_distribution.p50_ms}/${first_command_distribution.p99_ms}ms`);
}
if (concurrency_summary) {
  const s = concurrency_summary as { peak_concurrent: number; mean_concurrent: number; total_run_ms: number };
  console.log('');
  console.log(`  concurrency:`);
  console.log(`    peak:     ${s.peak_concurrent.toLocaleString()} concurrent`);
  console.log(`    mean:     ${s.mean_concurrent.toLocaleString()} concurrent`);
  console.log(`    duration: ${(s.total_run_ms / 1000).toFixed(1)}s`);
}

if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(aggregate, null, 2));
  console.log('');
  console.log(`[aggregate] wrote ${args.out}`);
}

// ─── persist to Postgres (run_groups) ────────────────────────────────────
if (args.writePg) {
  const concSummary = concurrency_summary as
    | { peak_concurrent: number; mean_concurrent: number; total_run_ms: number }
    | null;
  await client.query(
    `INSERT INTO run_groups (
        id, provider, shard_count, shards_terminal, started_at, ended_at, aggregated_at,
        sandboxes_attempted, sandboxes_succeeded, partials, readiness_failures,
        timeouts, http_errors, network_errors,
        p50_latency_ms, p99_latency_ms,
        peak_concurrent, mean_concurrent, total_run_ms,
        tigris_prefix, meta_json
     ) VALUES (
        $1, $2, $3, $4, $5, $6, now(),
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15,
        $16, $17, $18,
        $19, $20::jsonb
     )
     ON CONFLICT (id) DO UPDATE SET
        provider             = EXCLUDED.provider,
        shard_count          = EXCLUDED.shard_count,
        shards_terminal      = EXCLUDED.shards_terminal,
        started_at           = EXCLUDED.started_at,
        ended_at             = EXCLUDED.ended_at,
        aggregated_at        = now(),
        sandboxes_attempted  = EXCLUDED.sandboxes_attempted,
        sandboxes_succeeded  = EXCLUDED.sandboxes_succeeded,
        partials             = EXCLUDED.partials,
        readiness_failures   = EXCLUDED.readiness_failures,
        timeouts             = EXCLUDED.timeouts,
        http_errors          = EXCLUDED.http_errors,
        network_errors       = EXCLUDED.network_errors,
        p50_latency_ms       = EXCLUDED.p50_latency_ms,
        p99_latency_ms       = EXCLUDED.p99_latency_ms,
        peak_concurrent      = EXCLUDED.peak_concurrent,
        mean_concurrent      = EXCLUDED.mean_concurrent,
        total_run_ms         = EXCLUDED.total_run_ms,
        tigris_prefix        = EXCLUDED.tigris_prefix,
        meta_json            = EXCLUDED.meta_json`,
    [
      groupId,
      provider,
      shardCount,
      runsRes.rows.length - nonTerminal.length,
      earliestStart,
      nonTerminal.length === 0 ? latestEnd : null,
      final.sandboxes_attempted,
      final.sandboxes_succeeded,
      final.partials,
      final.readiness_failures,
      final.timeouts,
      final.http_errors,
      final.network_errors,
      final.p50_latency_ms,
      final.p99_latency_ms,
      concSummary?.peak_concurrent ?? null,
      concSummary?.mean_concurrent ?? null,
      concSummary?.total_run_ms ?? null,
      tigrisPrefix,
      JSON.stringify(aggregate),
    ],
  );
  console.log('');
  console.log(`[aggregate] upserted run_groups row id=${groupId}`);
}

// ─── persist to Tigris (groups/<id>/meta.json) ───────────────────────────
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
    const key = `${runDate}/${provider}/meta.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(aggregate, null, 2),
      ContentType: 'application/json',
    }));
    console.log(`[aggregate] uploaded s3://${bucket}/${key}`);
  }
}

await client.end();
process.exit(0);
