// VM-side entry point for the warm-ops benchmark.
//
// Iterates the provider list from src/sandbox/providers.ts, runs the same
// warm-ops benchmark a local `npm run bench:warm` would run, and writes
// the resulting JSON to Tigris under warm-ops/<run_id>/.
//
// Stays small on purpose: this file is bundled by esbuild into a single
// CJS file and uploaded to a fresh Namespace VM via scripts/warm-launch.sh.
//
// Required env:
//   RUN_ID
//   TIGRIS_STORAGE_BUCKET
//   TIGRIS_STORAGE_ACCESS_KEY_ID
//   TIGRIS_STORAGE_SECRET_ACCESS_KEY
//   ...plus provider-specific credentials, forwarded by the launch script.
//
// Optional env:
//   INSTANCE_ID        Stamped onto results for traceability
//   GITHUB_SHA         Stamped onto results for traceability
//   SAMPLES_PER_OP     Defaults to 100. Useful for smoke tests at SAMPLES_PER_OP=5.
//   PROVIDER_FILTER    If set, only run this single provider.
//   COORDINATOR_LOG_PATH  Path to the local log file to upload to Tigris.

import * as fs from 'node:fs';
import * as os from 'node:os';
import { runWarmBenchmark } from '../sandbox/warm.js';
import { providers } from '../sandbox/providers.js';
import { computeWarmCompositeScores } from '../sandbox/warm-scoring.js';
import type { WarmBenchmarkResult } from '../sandbox/warm-types.js';
import { WarmTigrisSink } from './sinks/tigris.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[coordinator] FATAL: required env var ${name} is missing`);
    process.exit(1);
  }
  return v;
}

const HEARTBEAT_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const RUN_ID = required('RUN_ID');
  const TIGRIS_BUCKET = required('TIGRIS_STORAGE_BUCKET');
  const TIGRIS_ACCESS_KEY = required('TIGRIS_STORAGE_ACCESS_KEY_ID');
  const TIGRIS_SECRET_KEY = required('TIGRIS_STORAGE_SECRET_ACCESS_KEY');
  const TIGRIS_ENDPOINT = process.env.TIGRIS_STORAGE_ENDPOINT;

  const commitSha = process.env.GITHUB_SHA ?? 'local';
  const instanceId = process.env.INSTANCE_ID ?? 'local';
  const samplesPerOp = parseInt(process.env.SAMPLES_PER_OP ?? '100', 10);
  const providerFilter = process.env.PROVIDER_FILTER;
  const logPath = process.env.COORDINATOR_LOG_PATH;

  const sink = new WarmTigrisSink({
    endpoint: TIGRIS_ENDPOINT,
    bucket: TIGRIS_BUCKET,
    accessKeyId: TIGRIS_ACCESS_KEY,
    secretAccessKey: TIGRIS_SECRET_KEY,
  }, RUN_ID);

  console.log(`[coordinator] starting`);
  console.log(`[coordinator] run_id=${RUN_ID} instance=${instanceId} commit=${commitSha}`);
  console.log(`[coordinator] tigris_prefix=${sink.tigrisPrefix}`);
  console.log(`[coordinator] samples_per_op=${samplesPerOp}`);
  if (providerFilter) console.log(`[coordinator] provider_filter=${providerFilter}`);

  const toRun = providerFilter
    ? providers.filter(p => p.name === providerFilter)
    : providers;

  if (toRun.length === 0) {
    console.error(`[coordinator] FATAL: no providers matched filter "${providerFilter}"`);
    process.exit(1);
  }

  console.log(`[coordinator] running ${toRun.length} provider(s)`);

  const started = new Date();
  const results: WarmBenchmarkResult[] = [];

  // Periodically rewrite the partial results.json + upload the latest log so
  // observers can `aws s3 cp` mid-run without waiting for the marker.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const tickHeartbeat = async () => {
    try {
      await writeResults(sink, results, { runId: RUN_ID, commitSha, instanceId, samplesPerOp, started, status: 'running' });
      if (logPath && fs.existsSync(logPath)) {
        await sink.writeLog(fs.readFileSync(logPath, 'utf-8'));
      }
    } catch (err) {
      console.warn(`[coordinator] heartbeat upload failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  heartbeat = setInterval(tickHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    for (const providerConfig of toRun) {
      try {
        const result = await runWarmBenchmark({ ...providerConfig, samplesPerOp });
        results.push(result);
      } catch (err) {
        // runWarmBenchmark is supposed to catch its own errors and return a
        // skipped result. If something escapes, log and synthesize a skipped
        // record so the run doesn't die on one bad provider.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[coordinator] uncaught error from ${providerConfig.name}: ${message}`);
        results.push({
          provider: providerConfig.name,
          mode: 'warm_ops',
          samplesPerOp,
          payloadBytes: 1024 * 1024,
          ops: {},
          skipped: true,
          skipReason: `Uncaught error: ${message}`,
        });
      }
      // Flush partial results after each provider — much easier to recover
      // from a VM crash if the latest provider's data already landed.
      await tickHeartbeat();
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  computeWarmCompositeScores(results);

  const finalPayload = await writeResults(sink, results, {
    runId: RUN_ID,
    commitSha,
    instanceId,
    samplesPerOp,
    started,
    status: 'done',
  });

  // Upload final log capture before writing the done marker so collectors
  // that download both can rely on the log being current.
  if (logPath && fs.existsSync(logPath)) {
    try {
      await sink.writeLog(fs.readFileSync(logPath, 'utf-8'));
    } catch (err) {
      console.warn(`[coordinator] final log upload failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  await sink.writeDone({
    run_id: RUN_ID,
    instance_id: instanceId,
    commit_sha: commitSha,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    providers_run: results.length,
    providers_skipped: results.filter(r => r.skipped).length,
    samples_per_op: samplesPerOp,
    tigris_prefix: sink.tigrisPrefix,
    results_path: `${sink.tigrisPrefix}results.json`,
  });

  console.log(`[coordinator] done — ${results.length} providers, ${results.filter(r => !r.skipped).length} succeeded`);
  console.log(`[coordinator] results uploaded to ${sink.tigrisPrefix}results.json`);

  void finalPayload;
}

async function writeResults(
  sink: WarmTigrisSink,
  results: WarmBenchmarkResult[],
  meta: { runId: string; commitSha: string; instanceId: string; samplesPerOp: number; started: Date; status: 'running' | 'done' },
): Promise<unknown> {
  // Same shape as src/sandbox/warm-table.ts writeWarmResultsJson, plus
  // VM-specific provenance fields so the collector knows where the bytes
  // came from. Kept inline so the coordinator stays a single-file bundle.
  const round = (n: number) => Math.round(n * 100) / 100;
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    samplesPerOp: r.samplesPerOp,
    payloadBytes: r.payloadBytes,
    ops: Object.fromEntries(
      Object.entries(r.ops).map(([opName, data]) => [opName, {
        samples: data!.samples.map(s => ({
          latencyMs: round(s.latencyMs),
          ...(s.error ? { error: s.error } : {}),
        })),
        summary: {
          median: round(data!.summary.median),
          p95: round(data!.summary.p95),
          p99: round(data!.summary.p99),
        },
      }]),
    ),
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
    ...(r.unsupportedReason ? { unsupportedReason: r.unsupportedReason } : {}),
  }));

  const payload = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    run: {
      run_id: meta.runId,
      commit_sha: meta.commitSha,
      instance_id: meta.instanceId,
      started_at: meta.started.toISOString(),
      status: meta.status,
    },
    config: {
      samplesPerOp: meta.samplesPerOp,
      payloadBytes: results[0]?.payloadBytes ?? 1024 * 1024,
    },
    results: cleanResults,
  };

  await sink.writeResults(payload);
  return payload;
}

main().catch(err => {
  console.error(`[coordinator] FATAL: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
