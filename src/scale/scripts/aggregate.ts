#!/usr/bin/env node
/**
 * Aggregate sandbox_results across every shard in a sharded-burst group via
 * the bench API query client and emit the same metrics shape an unsharded
 * burst would emit in its meta.json.
 *
 * Does not touch Postgres. Relies on the bench API backend having computed
 * and stored the per-batch aggregates from ingested span / progress events.
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
import type { BenchRunSummary } from '@computesdk/bench';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const DEFAULT_QUERY_URL = 'https://platform.computesdk.com/api/v1';

interface Args {
  groupId?: string;
  recent: boolean;
  out?: string;
  requireTerminal: boolean;
  writeTigris: boolean;
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
    '  --no-tigris            Do not upload meta.json to Tigris',
    '  --help, -h             Print this help',
    '',
    'Required env:',
    '  BENCHMARK_INGEST_URL  (or BENCHMARK_QUERY_URL)',
    '  COMPUTESDK_API_KEY    (optional if query endpoint is public)',
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
    else if (a === '--no-tigris') out.writeTigris = false;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.groupId && !out.recent) { console.error(`pass --group <id> or --recent\n${usage()}`); process.exit(2); }
  return out;
}

const args = parseArgs();

const queryUrl = process.env.BENCHMARK_QUERY_URL
  ?? process.env.BENCHMARK_INGEST_URL?.replace(/\/events\/?$/, '')
  ?? DEFAULT_QUERY_URL;
const apiKey = process.env.COMPUTESDK_API_KEY;
const query = createBenchQueryClient(queryUrl, apiKey);

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

// Fetch batch stats, progress, and runs in parallel
const [stats, progress, runsRes] = await Promise.all([
  query.getBatchStats(groupId),
  query.getBatchProgress(groupId),
  query.listRuns({ batch: groupId, limit: 1000 }),
]);

if (progress.runBreakdown.running > 0 && args.requireTerminal) {
  console.error(
    `batch ${groupId} has ${progress.runBreakdown.running} shard(s) still running; ` +
    `pass --allow-running to aggregate anyway`,
  );
  console.error(`still-running shards:`);
  for (const r of runsRes.items.filter((r: BenchRunSummary) => r.status !== 'completed' && r.status !== 'failed')) {
    console.error(`  ${r.runId} (status=${r.status})`);
  }
  process.exit(1);
}

const totalSpans = stats.totalSpans;
const statusCounts = stats.statusCounts;
const latencyDistribution = stats.latencyDistribution;
const failureBreakdown = stats.failureBreakdown;

const provider = [...new Set(runsRes.items.map((r: BenchRunSummary) => r.provider).filter(Boolean))].join(',') || 'unknown';

const final = {
  sandboxes_attempted: totalSpans,
  sandboxes_succeeded: statusCounts.success ?? 0,
  partials: statusCounts.partial ?? 0,
  readiness_failures: statusCounts.readiness_failed ?? 0,
  failures: statusCounts.failed ?? 0,
  timeouts: failureBreakdown.timeout ?? 0,
  http_errors: failureBreakdown.http_error ?? 0,
  network_errors: failureBreakdown.network_error ?? 0,
  p50_latency_ms: latencyDistribution.p50 ?? 0,
  p99_latency_ms: latencyDistribution.p99 ?? 0,
};

const aggregate = {
  ...final,
  latency_distribution: latencyDistribution,
  status_histogram: {
    success: statusCounts.success ?? 0,
    partial: statusCounts.partial ?? 0,
    readiness_failed: statusCounts.readiness_failed ?? 0,
    failed: statusCounts.failed ?? 0,
  },
  create_failure_class: {
    timeout: failureBreakdown.timeout ?? 0,
    http_error: failureBreakdown.http_error ?? 0,
    network_error: failureBreakdown.network_error ?? 0,
  },
  // TODO: backend currently does not expose first_command_distribution,
  // tti_distribution, submission_segments, or concurrency timeline.
  // Once the API adds them, map them in here.
  first_command_distribution: null,
  tti_distribution: null,
  submission_segments: null,
  concurrency_summary: null,
  concurrency_timeline: null,
  group_id: groupId,
  provider,
  shard_count: runsRes.items.length,
  shards: runsRes.items.map((r: BenchRunSummary) => ({
    run_id: r.runId,
    shard_index: r.batch ?? null,
    status: r.status,
    started_at: r.startedAt,
    ended_at: r.endedAt ?? null,
  })),
  started_at: runsRes.items.reduce<string | null>((m: string | null, r: BenchRunSummary) =>
    (m == null || r.startedAt < m ? r.startedAt : m), null),
  ended_at: runsRes.items.reduce<string | null>((m: string | null, r: BenchRunSummary) =>
    (r.endedAt && (m == null || r.endedAt > m) ? r.endedAt : m), null),
  aggregated_at: new Date().toISOString(),
  tigris_prefix: null,
};

// ─── pretty-print ────────────────────────────────────────────────────────
const rule = '═'.repeat(67);
console.log('');
console.log(rule);
console.log(` aggregate :: ${groupId}`);
console.log(rule);
console.log(`  provider:         ${provider}`);
console.log(`  shards:           ${progress.runBreakdown.completed + progress.runBreakdown.failed}/${progress.runBreakdown.completed + progress.runBreakdown.failed + progress.runBreakdown.running} ` +
  (progress.runBreakdown.running > 0 ? `(${progress.runBreakdown.running} still running)` : '(all terminal)'));
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
if (latencyDistribution) {
  console.log(`    min/mean/max: ${latencyDistribution.min}/${latencyDistribution.mean}/${latencyDistribution.max}ms`);
}

// ─── local file ──────────────────────────────────────────────────────────
if (args.out) {
  fs.writeFileSync(args.out, JSON.stringify(aggregate, null, 2));
  console.log('');
  console.log(`[aggregate] wrote ${args.out}`);
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
    const key = `groups/${groupId}/meta.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(aggregate, null, 2),
      ContentType: 'application/json',
    }));
    console.log(`[aggregate] uploaded s3://${bucket}/${key}`);
  }
}

process.exit(0);
