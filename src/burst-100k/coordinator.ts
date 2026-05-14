import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import { getProvider } from './providers.js';
import { PostgresSink } from './sinks/postgres.js';
import { TigrisSink } from './sinks/tigris.js';
import { runBurst } from './runner.js';
import type { ProgressStats } from './types.js';

// dotenv only matters for local invocation. In production the env is set by
// launch.sh via `nsc ssh ... export VAR=...`.
loadDotenv();

const HEARTBEAT_INTERVAL_MS = 30_000;

async function main() {
  const RUN_ID = required('RUN_ID');
  const PROVIDER = required('PROVIDER');
  const PG_URL = required('PG_URL');
  const TIGRIS_STORAGE_ENDPOINT = required('TIGRIS_STORAGE_ENDPOINT');
  const TIGRIS_STORAGE_BUCKET = required('TIGRIS_STORAGE_BUCKET');
  const TIGRIS_STORAGE_ACCESS_KEY_ID = required('TIGRIS_STORAGE_ACCESS_KEY_ID');
  const TIGRIS_STORAGE_SECRET_ACCESS_KEY = required('TIGRIS_STORAGE_SECRET_ACCESS_KEY');

  const commit_sha = process.env.GITHUB_SHA ?? 'local';
  const instance_id = process.env.INSTANCE_ID ?? 'local';
  const tigris_prefix = `s3://${TIGRIS_STORAGE_BUCKET}/${RUN_ID}/`;

  const provider = getProvider(PROVIDER);

  // Allow env override of concurrencyTarget for local smoke tests.
  const override = process.env.CONCURRENCY_TARGET;
  if (override) {
    provider.concurrencyTarget = parseInt(override, 10);
    console.log(`[coordinator] override CONCURRENCY_TARGET=${provider.concurrencyTarget}`);
  }

  // Validate provider-specific requiredEnvVars
  const missing = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    const msg = `Missing required env vars for ${PROVIDER}: ${missing.join(', ')}`;
    console.error(`[coordinator] ${msg}`);
    await tryRecordFailure(PG_URL, RUN_ID, msg);
    process.exit(1);
  }

  console.log(`[coordinator] run_id=${RUN_ID} provider=${PROVIDER} concurrency=${provider.concurrencyTarget} ramp=${provider.rampSeconds}s`);

  const pg = new PostgresSink(PG_URL, RUN_ID);
  await pg.connect();
  await pg.bootstrap(PROVIDER, commit_sha, instance_id, tigris_prefix);

  const tigris = new TigrisSink(
    {
      endpoint: TIGRIS_STORAGE_ENDPOINT,
      bucket: TIGRIS_STORAGE_BUCKET,
      accessKeyId: TIGRIS_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: TIGRIS_STORAGE_SECRET_ACCESS_KEY,
    },
    RUN_ID,
  );

  let lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };
  // Track {idx, ms} for ok sandboxes so we can bucket by ramp position at
  // run-end. `latencies` (sorted ms array) is derived from this.
  const okResults: Array<{ idx: number; ms: number }> = [];
  // Track every sandbox's start/end (epoch ms) — including errors — so we
  // can reconstruct concurrency-over-time after the burst.
  const intervals: Array<{ start: number; end: number }> = [];
  const errorCounts = { timeout: 0, http_error: 0, network_error: 0 };

  // Periodically upload the coordinator's own stdout/stderr (redirected to a
  // file by launch.sh) to Tigris. Skipped silently when the env var is
  // unset (e.g. local `npm run bench:burst-100k:local` runs).
  const COORDINATOR_LOG_PATH = process.env.COORDINATOR_LOG_PATH;
  const uploadLog = async (): Promise<void> => {
    if (!COORDINATOR_LOG_PATH) return;
    try {
      const content = await fs.promises.readFile(COORDINATOR_LOG_PATH, 'utf-8');
      await tigris.writeLog(content);
    } catch (err: any) {
      console.error('[log-upload]', err?.message ?? err);
    }
  };

  const heartbeat = setInterval(() => {
    const ts = new Date().toISOString();
    pg.heartbeat(lastStats).catch(err => console.error('[heartbeat:pg]', err.message));
    tigris.writeHeartbeat({ ...lastStats, ts }).catch(err => console.error('[heartbeat:tigris]', err.message));
    uploadLog();
    console.log(`[heartbeat] done=${lastStats.done} in_flight=${lastStats.in_flight} errors=${lastStats.errors}`);
  }, HEARTBEAT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[coordinator] ${signal} received; flushing...`);
    clearInterval(heartbeat);
    try {
      await pg.flush();
      await tigris.close();
      await pg.fail(`Process received ${signal} at done=${lastStats.done}/${provider.concurrencyTarget}`);
      await pg.close();
      await uploadLog();
    } catch (e: any) {
      console.error('[coordinator] shutdown flush failed:', e?.message ?? e);
    }
    process.exit(1);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const compute = provider.createCompute();

  try {
    await runBurst(provider, compute, {
      async onResult(result) {
        if (result.status === 'ok') {
          okResults.push({ idx: result.sandbox_idx, ms: result.latency_ms });
        } else {
          errorCounts[result.status]++;
        }
        intervals.push({
          start: Date.parse(result.started_at),
          end: Date.parse(result.completed_at),
        });
        tigris.writeResult(result);
        await pg.write(result);
      },
      onProgress(stats) {
        lastStats = stats;
      },
    });

    clearInterval(heartbeat);

    const latencies = okResults.map(r => r.ms).sort((a, b) => a - b);
    const pct = (q: number) =>
      latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

    const final = {
      sandboxes_attempted: provider.concurrencyTarget,
      sandboxes_succeeded: latencies.length,
      timeouts: errorCounts.timeout,
      http_errors: errorCounts.http_error,
      network_errors: errorCounts.network_error,
      p50_latency_ms: pct(0.5),
      p99_latency_ms: pct(0.99),
    };

    // Per-status counts for Tigris meta.json. Mirrors the FinalStats fields
    // written to Postgres but uses the wire status names for clarity.
    const error_histogram = {
      ok: latencies.length,
      timeout: errorCounts.timeout,
      http_error: errorCounts.http_error,
      network_error: errorCounts.network_error,
    };

    // Full latency distribution, written to Tigris meta.json only. Postgres
    // keeps just p50/p99 for cheap filtering; this is for retrospective
    // analysis of tail behaviour.
    const latency_distribution = latencies.length === 0 ? null : {
      count: latencies.length,
      min_ms:  latencies[0],
      p10_ms:  pct(0.10),
      p25_ms:  pct(0.25),
      p50_ms:  pct(0.50),
      p75_ms:  pct(0.75),
      p90_ms:  pct(0.90),
      p95_ms:  pct(0.95),
      p99_ms:  pct(0.99),
      p999_ms: pct(0.999),
      max_ms:  latencies[latencies.length - 1],
      mean_ms: Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length),
    };

    // Ramp-phase segments. Sandbox starts are spread linearly over rampSeconds
    // by index, so bucketing by idx ranges is equivalent to bucketing by
    // ramp-position. Answers "does latency degrade as concurrency climbs?"
    const totalN = provider.concurrencyTarget;
    const segmentDefs = [
      { name: 'first_25pct',  lo: 0,                        hi: Math.floor(totalN * 0.25) },
      { name: 'middle_50pct', lo: Math.floor(totalN * 0.25), hi: Math.floor(totalN * 0.75) },
      { name: 'last_25pct',   lo: Math.floor(totalN * 0.75), hi: totalN },
    ];
    const ramp_segments: Record<string, unknown> = {};
    for (const seg of segmentDefs) {
      const segLatencies = okResults
        .filter(r => r.idx >= seg.lo && r.idx < seg.hi)
        .map(r => r.ms)
        .sort((a, b) => a - b);
      const segPct = (q: number) =>
        segLatencies.length === 0 ? 0
          : segLatencies[Math.min(segLatencies.length - 1, Math.floor(segLatencies.length * q))];
      ramp_segments[seg.name] = {
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

    // Concurrency-over-time. Build an interval-overlap timeline so we can
    // tell whether the ramp actually behaved as configured and where the
    // burst peaked. All intervals are relative to the earliest start.
    let concurrency_summary: unknown = null;
    let concurrency_timeline: Array<{ t_ms: number; active: number }> = [];
    if (intervals.length > 0) {
      const minStart = intervals.reduce((m, i) => Math.min(m, i.start), Infinity);
      const maxEnd   = intervals.reduce((m, i) => Math.max(m, i.end),   -Infinity);
      const durationMs = maxEnd - minStart;

      // Event stream: +1 at start, -1 at end (rel to minStart)
      const events: Array<{ t: number; delta: number }> = [];
      for (const i of intervals) {
        events.push({ t: i.start - minStart, delta: 1 });
        events.push({ t: i.end   - minStart, delta: -1 });
      }
      events.sort((a, b) => a.t - b.t || b.delta - a.delta);

      // Exact peak detection at events; timeline sampled at 1 Hz.
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
      // Flush any remaining events past the last sample (still tracks peak)
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
        ramp_seconds_configured: provider.rampSeconds,
        sample_interval_ms: SAMPLE_MS,
      };
    }

    await pg.flush();
    await tigris.close();
    await tigris.writeMeta({
      ...final,
      latency_distribution,
      error_histogram,
      ramp_segments,
      concurrency_summary,
      concurrency_timeline,
      run_id: RUN_ID,
      provider: PROVIDER,
      ended_at: new Date().toISOString(),
    });
    await pg.complete(final);
    await pg.close();

    console.log('[coordinator] run complete:', final);
    // Final log upload AFTER the completion message so it ends up in Tigris.
    await uploadLog();
  } catch (err: any) {
    clearInterval(heartbeat);
    console.error('[coordinator] run failed:', err?.message ?? err);
    try {
      await pg.flush();
      await tigris.close();
      await pg.fail(err?.message ?? String(err));
      await pg.close();
      await uploadLog();
    } catch (e: any) {
      console.error('[coordinator] failed to record failure:', e?.message ?? e);
    }
    process.exit(1);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[coordinator] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function tryRecordFailure(pgUrl: string, runId: string, message: string): Promise<void> {
  try {
    const pg = new PostgresSink(pgUrl, runId);
    await pg.connect();
    await pg.fail(message);
    await pg.close();
  } catch (e: any) {
    console.error('[coordinator] could not write failure row:', e?.message ?? e);
  }
}

main().catch(err => {
  console.error('[coordinator] crashed:', err);
  process.exit(1);
});
