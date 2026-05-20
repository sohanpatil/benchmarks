// Collector for warm-ops runs.
//
// Polls the Tigris bucket for `warm-ops/<run_id>/done.json`, then pulls
// `results.json` and `coordinator.log` down to the local results dir so the
// SVG generator can render them and a commit step can publish them.
//
// Usage:
//   tsx src/warm-vm/collect.ts --run-id <id> [--timeout-seconds 5400]
//
// If --run-id is omitted, the most recent warm-ops/<id>/done.json is used.

import '../env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tigris } from '@computesdk/tigris';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results', 'warm_ops');

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[collect] FATAL: required env var ${name} is missing`);
    process.exit(1);
  }
  return v;
}

function getArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  // Default to the project's standard warm-ops bucket; allow override.
  // Matches the launch script's default so a fresh `npm run warm:collect`
  // works against the latest run without any inline env overrides.
  const bucket = process.env.TIGRIS_STORAGE_BUCKET || 'sandbox-benchmarks';
  const accessKeyId = required('TIGRIS_STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = required('TIGRIS_STORAGE_SECRET_ACCESS_KEY');

  const explicitRunId = getArg('--run-id');
  const timeoutSeconds = parseInt(getArg('--timeout-seconds') ?? '5400', 10);
  const pollIntervalSeconds = parseInt(getArg('--poll-interval-seconds') ?? '30', 10);
  const noWait = process.argv.includes('--no-wait');

  const storage = tigris({ accessKeyId, secretAccessKey });

  const runId = explicitRunId ?? await findLatestRunId(storage, bucket);
  if (!runId) {
    console.error('[collect] FATAL: no run-id specified and no warm-ops runs found in bucket');
    process.exit(1);
  }
  console.log(`[collect] target run_id=${runId}`);

  let inProgress = false;
  if (noWait) {
    console.log(`[collect] --no-wait: fetching current snapshot without polling done.json`);
    inProgress = true;
  } else {
    console.log(`[collect] polling s3://${bucket}/warm-ops/${runId}/done.json (timeout ${timeoutSeconds}s)`);
    const deadline = Date.now() + timeoutSeconds * 1000;
    let donePayload: Buffer | null = null;
    while (Date.now() < deadline) {
      donePayload = await tryDownload(storage, bucket, `warm-ops/${runId}/done.json`);
      if (donePayload) break;
      const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`[collect]   not yet — sleeping ${pollIntervalSeconds}s (${remainingSec}s remaining)`);
      await sleep(pollIntervalSeconds * 1000);
    }
    if (!donePayload) {
      console.error(`[collect] FATAL: timed out after ${timeoutSeconds}s waiting for done.json`);
      process.exit(2);
    }
    console.log(`[collect] done.json received — fetching results.json + coordinator.log`);
  }

  const resultsBuf = await tryDownload(storage, bucket, `warm-ops/${runId}/results.json`);
  if (!resultsBuf) {
    console.error(
      inProgress
        ? `[collect] FATAL: no results.json yet — has the coordinator written its first heartbeat? Try again in ~60s.`
        : `[collect] FATAL: done.json present but results.json missing`,
    );
    process.exit(3);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const datedPath = path.join(RESULTS_DIR, `${timestamp}.json`);
  const latestPath = path.join(RESULTS_DIR, 'latest.json');
  fs.writeFileSync(datedPath, resultsBuf);
  fs.copyFileSync(datedPath, latestPath);
  console.log(`[collect] wrote ${datedPath}`);
  console.log(`[collect] wrote ${latestPath}`);

  // The coordinator log is best-effort — if it didn't get uploaded yet we
  // still have results, so don't fail the whole collect over it.
  const logBuf = await tryDownload(storage, bucket, `warm-ops/${runId}/coordinator.log`);
  if (logBuf) {
    const logPath = path.join(RESULTS_DIR, `${timestamp}.coordinator.log`);
    fs.writeFileSync(logPath, logBuf);
    console.log(`[collect] wrote ${logPath}`);
  } else {
    console.warn(`[collect] coordinator.log not available — skipping`);
  }

  console.log(inProgress ? `[collect] OK (in-progress snapshot)` : `[collect] OK`);
}

async function findLatestRunId(storage: ReturnType<typeof tigris>, bucket: string): Promise<string | null> {
  const list = await storage.list(bucket, { prefix: 'warm-ops/' });
  // Match either done.json (finished runs) or results.json (in-progress runs).
  // The polling loop in main() handles waiting for done.json regardless of
  // which one we matched here, so callers can `npm run warm:collect`
  // immediately after `npm run warm:launch` and just wait.
  const runIds = new Set<string>();
  for (const obj of list.objects as { key: string }[]) {
    const match = obj.key.match(/^warm-ops\/([^/]+)\/(?:done|results)\.json$/);
    if (match) runIds.add(match[1]);
  }
  if (runIds.size === 0) return null;
  // Run IDs are `warm-<UTC-timestamp>-<sha>`, so lexicographic sort = newest last.
  return [...runIds].sort().pop() ?? null;
}

async function tryDownload(storage: ReturnType<typeof tigris>, bucket: string, key: string): Promise<Buffer | null> {
  try {
    const res = await storage.download(bucket, key);
    return Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such key|not\s*found|404/i.test(message)) return null;
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(`[collect] FATAL: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
