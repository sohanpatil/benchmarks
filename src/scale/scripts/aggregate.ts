#!/usr/bin/env node
/**
 * Aggregate sandbox_results across every shard in a sharded-burst group via
 * the bench API query client and emit the same metrics shape an unsharded
 * burst would emit in its meta.json.
 *
 * Does not touch Postgres. Sandbox-level counts are rolled up from the per-run
 * progress counters the coordinator emits (the same source watch.ts uses) — NOT
 * from getBatchStats, whose totalSpans/statusCounts count lifecycle-step spans
 * (create/exec/destroy) rather than sandboxes, and whose latencyDistribution is
 * step-span durations rather than per-sandbox allocate latency. The progress API
 * exposes only scalar counters, so per-sandbox latency and a failure-by-code
 * breakdown are not derivable here — those live in each shard's Tigris meta.json.
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
    else if (a === '--no-tigris') out.writeTigris = false;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`unknown arg: ${a}\n${usage()}`); process.exit(2); }
  }
  if (!out.groupId && !out.recent) { console.error(`pass --group <id> or --recent\n${usage()}`); process.exit(2); }
  return out;
}

const args = parseArgs();

const query = createBenchQueryClient('https://platform.computesdk.com/api/v1', process.env.COMPUTESDK_API_KEY);

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

// Fetch progress and runs in parallel. getBatchStats is deliberately not used
// (see header): its spans are lifecycle steps, not sandboxes.
const [progress, runsRes] = await Promise.all([
  query.getBatchProgress(groupId),
  query.listRuns({ batch: groupId, limit: 500 }),
]);

// BenchBatchProgress carries only per-run counters (no roll-up), so derive both
// the shard-level breakdown and the sandbox-level totals here. A run is terminal
// once done >= total — the same inference watch.ts uses, since run summaries
// don't expose lifecycle state. Each shard's `total` is its concurrencyTarget,
// `done` is sandboxes finalized, and `errors` increments once per non-success
// sandbox (failed + readiness_failed + partial), so done − errors == successes.
let shardsRunning = 0, shardsCompleted = 0, shardsFailed = 0;
let sandboxesAttempted = 0, sandboxesDone = 0, sandboxErrors = 0;
for (const r of progress.runs) {
  sandboxesAttempted += r.total;
  sandboxesDone += r.done;
  sandboxErrors += r.errors;
  const terminal = r.total > 0 && r.done >= r.total;
  if (!terminal) shardsRunning++;
  else if (r.errors > 0) shardsFailed++;
  else shardsCompleted++;
}
const shardsTerminal = shardsCompleted + shardsFailed;

if (shardsRunning > 0 && args.requireTerminal) {
  console.error(
    `batch ${groupId} has ${shardsRunning} shard(s) still running; ` +
    `pass --allow-running to aggregate anyway`,
  );
  console.error(`still-running shards:`);
  for (const r of progress.runs.filter(r => !(r.total > 0 && r.done >= r.total))) {
    console.error(`  ${r.runId} (${r.done}/${r.total} done, ${r.errors} errors)`);
  }
  process.exit(1);
}

// Sandbox-level counts come from the rolled-up progress counters above. The
// progress API exposes only scalar done/total/errors, so the finer
// 'partial' / 'readiness_failed' / failure-by-code splits the coordinator
// records per shard are not recoverable here — `failures` carries the full
// non-success count, and the sub-buckets plus per-sandbox latency are left null.
const succeeded = sandboxesDone - sandboxErrors;
const failed = sandboxErrors;

const provider = [...new Set(runsRes.items.map((r: BenchRunSummary) => r.provider).filter(Boolean))].join(',') || 'unknown';

const final = {
  sandboxes_attempted: sandboxesAttempted,
  sandboxes_succeeded: succeeded,
  partials: null,            // not separable from the progress error counter
  readiness_failures: null,  // not separable from the progress error counter
  failures: failed,
  timeouts: null,            // failure-by-code not exposed by the progress API
  http_errors: null,         // "
  network_errors: null,      // "
  p50_latency_ms: null,      // per-sandbox latency not exposed by the progress API
  p99_latency_ms: null,      // "
};

const aggregate = {
  ...final,
  // per-sandbox latency lives in each shard's Tigris meta.json — not derivable
  // from the progress counters this script reads.
  latency_distribution: null,
  status_histogram: {
    success: succeeded,
    failed,
  },
  create_failure_class: null,      // not exposed by the progress API
  failure_breakdown_by_code: null, // "
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
console.log(`  shards:           ${shardsTerminal}/${progress.runs.length} ` +
  (shardsRunning > 0 ? `(${shardsRunning} still running)` : '(all terminal)'));
console.log(`  attempted:        ${final.sandboxes_attempted.toLocaleString()}`);
console.log(`  succeeded:        ${final.sandboxes_succeeded.toLocaleString()} ` +
  `(${((final.sandboxes_succeeded / Math.max(1, final.sandboxes_attempted)) * 100).toFixed(2)}%)`);
console.log(`  failed:           ${final.failures.toLocaleString()}`);
console.log('');
console.log(`  note: counts are rolled up from per-shard progress counters.`);
console.log(`        per-sandbox latency and the failure-by-code breakdown are`);
console.log(`        not exposed by the bench progress API — see each shard's`);
console.log(`        Tigris <run_id>/meta.json for those.`);

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
