import { config as loadDotenv } from 'dotenv';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BenchReporter } from './bench-reporter.js';
import { getProvider } from './providers.js';
import { log } from './logger.js';
import { TigrisSink } from './sinks/tigris.js';
import { BurstLifecycle } from './runner.js';
import type { ProgressStats, MetricsSample } from './types.js';

// dotenv only matters for local invocation. In production the env is set by
// scripts/start.ts via the uploaded /root/start.sh (`export VAR=...`).
loadDotenv();

async function main() {
  const RUN_ID = required('RUN_ID');
  const PROVIDER = required('PROVIDER');
  const TIGRIS_STORAGE_ENDPOINT = required('TIGRIS_STORAGE_ENDPOINT');
  const TIGRIS_STORAGE_BUCKET = required('TIGRIS_STORAGE_BUCKET');
  const TIGRIS_STORAGE_ACCESS_KEY_ID = required('TIGRIS_STORAGE_ACCESS_KEY_ID');
  const TIGRIS_STORAGE_SECRET_ACCESS_KEY = required('TIGRIS_STORAGE_SECRET_ACCESS_KEY');

  const commit_sha = process.env.GITHUB_SHA ?? 'local';
  const instance_id = process.env.INSTANCE_ID ?? 'local';
  const tigris_prefix = `s3://${TIGRIS_STORAGE_BUCKET}/${RUN_ID}/`;

  // Sharded-burst metadata. Set by src/scale/scripts/start.ts when a
  // logical burst is spread across multiple VMs. Unset for single-VM runs.
  const shard = (() => {
    const group_id = process.env.GROUP_ID;
    const shard_index_raw = process.env.SHARD_INDEX;
    const shard_count_raw = process.env.SHARD_COUNT;
    if (!group_id || shard_index_raw === undefined || shard_count_raw === undefined) {
      return undefined;
    }
    const shard_index = parseInt(shard_index_raw, 10);
    const shard_count = parseInt(shard_count_raw, 10);
    if (!Number.isFinite(shard_index) || !Number.isFinite(shard_count)) return undefined;
    return { group_id, shard_index, shard_count };
  })();

  const provider = getProvider(PROVIDER);
  const benchApiKey = process.env.COMPUTESDK_API_KEY ?? process.env.COMPUTESDK_ADMIN_API_KEY;
  const LABEL = process.env.LABEL ?? `scale.${PROVIDER}`;

  // Platform orchestration target. start.ts creates the run + plans the workers,
  // then injects these so each VM claims one worker assignment. When unset (e.g.
  // a bare local run with no run created), platform reporting is skipped and the
  // burst still runs + writes Tigris exactly as before — bench ingest is optional.
  const BENCHMARK_SLUG = process.env.BENCHMARK_SLUG ?? 'scale';
  const BENCHMARK_RUN_ID = process.env.BENCHMARK_RUN_ID;
  const PARTICIPANT_SLUG = process.env.PARTICIPANT_SLUG ?? PROVIDER;

  // Allow env override of concurrencyTarget for local smoke tests.
  const override = process.env.CONCURRENCY_TARGET;
  if (override) {
    provider.concurrencyTarget = parseInt(override, 10);
  }

  log.phase('scale coordinator starting');
  log.info(`run_id=${RUN_ID}`);
  log.info(`label=${LABEL}`);
  log.info(`provider=${PROVIDER} (requires: ${provider.requiredEnvVars.join(', ') || 'none'})`);
  log.info(`concurrency=${provider.concurrencyTarget} timeout=${provider.perRequestTimeoutMs ?? 120_000}ms`);
  log.info(`commit_sha=${commit_sha} instance_id=${instance_id}`);
  log.info(`tigris_prefix=${tigris_prefix}`);
  if (override) log.info(`(CONCURRENCY_TARGET overridden via env)`);
  if (shard) {
    log.info(`shard ${shard.shard_index + 1}/${shard.shard_count} of group=${shard.group_id}`);
  }

  // Validate provider-specific requiredEnvVars
  log.phase('validating environment');
  const missing = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    const msg = `Missing required env vars for ${PROVIDER}: ${missing.join(', ')}`;
    log.error(msg);
    process.exit(1);
  }
  log.ok(`all ${provider.requiredEnvVars.length} provider env var(s) present`);

  log.phase('opening sinks');

  log.info('Tigris: opening multipart upload for raw.jsonl');
  const tigris = new TigrisSink(
    {
      endpoint: TIGRIS_STORAGE_ENDPOINT,
      bucket: TIGRIS_STORAGE_BUCKET,
      accessKeyId: TIGRIS_STORAGE_ACCESS_KEY_ID,
      secretAccessKey: TIGRIS_STORAGE_SECRET_ACCESS_KEY,
    },
    RUN_ID,
  );
  log.ok('Tigris: sink ready');

  let lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };
  // Track per-success-sandbox phase timings for the analytical outputs.
  //   ms                = allocate phase (sandbox.create() time, == latency_ms)
  //   first_command_ms  = readiness phase (`node -v` after create); null when cmd failed
  // Only fully-successful sandboxes contribute to the latency distributions —
  // a `partial` sandbox's create may have been fast but the sandbox died
  // mid-test, so its timings would skew the headline number.
  const okResults: Array<{ idx: number; ms: number; first_command_ms: number | null }> = [];
  // Track every sandbox's start/end (epoch ms) — including errors — so we
  // can reconstruct concurrency-over-time after the burst.
  const intervals: Array<{ start: number; end: number }> = [];
  // Counts per final status. `failure_class` (timeout/http_error/network_error)
  // is tracked separately so it works across all non-success statuses.
  const statusCounts = { success: 0, partial: 0, readiness_failed: 0, failed: 0 };
  // Sub-classification of create-failures only (status === 'failed').
  const createFailureClass = { timeout: 0, http_error: 0, network_error: 0 };
  const emittedSegmentCounts = { first_25pct: 0, middle_50pct: 0, last_25pct: 0 };

  // Claim one platform worker for this VM. Reporting is best-effort and fully
  // optional: a missing key/run, an unclaimable worker, or any telemetry error
  // degrades to a Tigris-only run rather than failing the burst.
  const bench = benchApiKey && BENCHMARK_RUN_ID
    ? await BenchReporter.claim({
        apiKey: benchApiKey,
        benchmarkSlug: BENCHMARK_SLUG,
        runId: BENCHMARK_RUN_ID,
        participantSlug: PARTICIPANT_SLUG,
        processKind: 'container',
        processKey: instance_id,
      })
    : null;

  // The platform plans each worker's task range; honour its count when present
  // so progressTotal and global task indexes line up across the fleet. Falls
  // back to the env-provided concurrencyTarget for unreported runs.
  const burstSize = bench?.taskCount ?? provider.concurrencyTarget;
  if (bench && bench.taskCount !== provider.concurrencyTarget) {
    log.warn(
      `bench: planned task count ${bench.taskCount} != CONCURRENCY_TARGET ` +
      `${provider.concurrencyTarget}; using planned count for the burst`,
    );
    provider.concurrencyTarget = burstSize;
  }

  // System-metrics sampling. Event-loop delay needs an enabled histogram;
  // /proc/self/fd and /proc/net/sockstat are Linux-only (silent null elsewhere).
  const METRICS_SAMPLE_MS = 5_000;
  const eloopHist = monitorEventLoopDelay({ resolution: 20 });
  eloopHist.enable();
  const cpuBaseline = process.cpuUsage();
  const metricsStartedAt = Date.now();
  const metricsSamples: MetricsSample[] = [];

  const readSockstat = (): Record<string, number> | null => {
    try {
      const data = fs.readFileSync('/proc/net/sockstat', 'utf-8');
      const out: Record<string, number> = {};
      for (const line of data.split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const section = line.slice(0, idx).trim().toLowerCase();
        const parts = line.slice(idx + 1).trim().split(/\s+/);
        for (let i = 0; i + 1 < parts.length; i += 2) {
          const n = parseInt(parts[i + 1], 10);
          if (!Number.isNaN(n)) out[`${section}_${parts[i]}`] = n;
        }
      }
      return out;
    } catch {
      return null;
    }
  };
  const countOpenFds = (): number | null => {
    try { return fs.readdirSync('/proc/self/fd').length; } catch { return null; }
  };
  const sampleMetrics = (): MetricsSample => {
    const cpu = process.cpuUsage(cpuBaseline);
    const mem = process.memoryUsage();
    const load = os.loadavg();
    const sample: MetricsSample = {
      ts: new Date().toISOString(),
      uptime_ms: Date.now() - metricsStartedAt,
      cpu_user_us: cpu.user,
      cpu_system_us: cpu.system,
      mem_rss_mb: Math.round(mem.rss / 1024 / 1024),
      mem_heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      mem_heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      mem_external_mb: Math.round(mem.external / 1024 / 1024),
      event_loop_p50_ms: eloopHist.percentile(50) / 1e6,
      event_loop_p99_ms: eloopHist.percentile(99) / 1e6,
      event_loop_max_ms: eloopHist.max / 1e6,
      loadavg_1m: load[0],
      loadavg_5m: load[1],
      loadavg_15m: load[2],
      open_fds: countOpenFds(),
      sockstat: readSockstat(),
    };
    eloopHist.reset();
    metricsSamples.push(sample);
    return sample;
  };
  // The coordinator_metrics stream has no equivalent in the orchestrator API
  // (no generic metric ingestion), so system health lives solely in Tigris
  // metrics.jsonl. We reuse this 5s tick to send the platform a progress +
  // in-flight-concurrency heartbeat (surfaced via getRunTimeline).
  const metricsInterval = setInterval(() => {
    sampleMetrics();
    if (bench) void bench.heartbeat(lastStats.in_flight);
  }, METRICS_SAMPLE_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.phase(`${signal} received — flushing`);
    clearInterval(metricsInterval);
    try {
      await tigris.close();
      if (metricsSamples.length > 0) await tigris.writeMetrics(metricsSamples);
      await tigris.writeLog(log.dump());
      log.ok('flushed all sinks');
    } catch (e: any) {
      log.error(`shutdown flush failed: ${e?.message ?? e}`);
    }
    process.exit(1);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.phase('initializing compute client');
  const compute = provider.createCompute();
  log.ok(`compute client ready for ${PROVIDER}`);
  if (benchApiKey) {
    log.info('bench ingest enabled');
  }

  const pauseMs = (() => {
    const raw = process.env.LIFECYCLE_PAUSE_MS;
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  })();

  try {
    const flow = new BurstLifecycle(provider, compute, {
      async onResult(result) {
        statusCounts[result.status]++;
        if (result.status === 'success') {
          okResults.push({
            idx: result.sandbox_idx,
            ms: result.latency_ms,
            first_command_ms: result.first_command_ms,
          });
        } else if (result.status === 'failed' && result.failure_class) {
          createFailureClass[result.failure_class]++;
        }
        intervals.push({
          start: Date.parse(result.started_at),
          end: Date.parse(result.completed_at),
        });
        const segmentOf = (idx: number): 'first_25pct' | 'middle_50pct' | 'last_25pct' => {
          const n = provider.concurrencyTarget;
          const normalized = ((idx % n) + n) % n;
          const q1 = Math.floor(n * 0.25);
          const q3 = Math.floor(n * 0.75);
          if (normalized < q1) return 'first_25pct';
          if (normalized < q3) return 'middle_50pct';
          return 'last_25pct';
        };
        const submission_segment = segmentOf(result.sandbox_idx);
        emittedSegmentCounts[submission_segment]++;

        // Stream the per-sandbox result to the platform as a task record. The
        // four-state status, create-failure class and submission segment ride
        // along in status/errorCode/data so getRunResults / getRunTaskResults
        // can roll them up; Tigris raw.jsonl remains the lossless record.
        bench?.recordResult(result, {
          submission_segment,
          failure_class: result.status === 'failed' ? result.failure_class : null,
        });
        tigris.writeResult(result);
      },
      onProgress(stats) {
        lastStats = stats;
        bench?.setStats(stats);
      },
    });

    // Two-phase, barriered burst (see runner.ts). Every stage fires all
    // `burstSize` task indexes at t=0 (concurrency == iterations, no pool) and
    // we await the whole stage before the next — this is the global barrier the
    // success/partial distinction depends on. The per-sandbox methods catch
    // their own errors (recording status + emitting), so a stage never throws
    // from a sandbox failure; `destroy` therefore always runs (the old
    // `runOnFailed` behaviour) and survivors are torn down regardless of phase-1
    // outcome.
    const indices = Array.from({ length: burstSize }, (_, i) => i);
    const runStage = (fn: (idx: number) => Promise<void>): Promise<void[]> =>
      Promise.all(indices.map(fn));

    log.phase(`create — firing ${burstSize} requests at t=0 (no stagger)`);
    await runStage((i) => flow.createOne(i));
    await runStage((i) => flow.execInitialOne(i));
    if (pauseMs > 0) {
      log.phase(`pause — waiting ${pauseMs}ms`);
      await flow.pause(pauseMs);
    }
    await runStage((i) => flow.execAfterPauseOne(i));
    await runStage((i) => flow.destroyOne(i));

    log.phase(`create complete — ${flow.countSurvivors()}/${burstSize} sandboxes alive`);

    const latencies = okResults.map(r => r.ms).sort((a, b) => a - b);
    const pct = (q: number) =>
      latencies.length === 0 ? 0 : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];

    const final = {
      sandboxes_attempted: provider.concurrencyTarget,
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

    // Per-status counts for Tigris meta.json. Uses the wire status names so
    // the four-state taxonomy is visible at-a-glance in raw output.
    const status_histogram = {
      success: statusCounts.success,
      partial: statusCounts.partial,
      readiness_failed: statusCounts.readiness_failed,
      failed: statusCounts.failed,
    };
    // Sub-classification of create-failures only (sums to status_histogram.failed).
    const create_failure_class = {
      timeout: createFailureClass.timeout,
      http_error: createFailureClass.http_error,
      network_error: createFailureClass.network_error,
    };

    // Full latency distribution, written to Tigris meta.json for retrospective
    // analysis of tail behaviour. `latency_distribution` covers the
    // allocate phase only — the "first_command" and combined "tti"
    // distributions are computed below.
    const distributionOf = (values: number[]) => {
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
    };
    const latency_distribution = distributionOf(latencies);
    const first_command_values = okResults
      .map(r => r.first_command_ms)
      .filter((v): v is number => v != null);
    const first_command_distribution = distributionOf(first_command_values);
    const tti_values = okResults
      .filter(r => r.first_command_ms != null)
      .map(r => r.ms + (r.first_command_ms as number));
    const tti_distribution = distributionOf(tti_values);

    // Submission-order segments: bucket OK results by sandbox_idx (the order
    // tasks were pushed onto the event loop at t=0). With no ramp, all
    // submissions happen within milliseconds, so this isolates whether the
    // provider's queueing favours earlier-submitted requests.
    const totalN = provider.concurrencyTarget;
    const segmentDefs = [
      { name: 'first_25pct',  lo: 0,                        hi: Math.floor(totalN * 0.25) },
      { name: 'middle_50pct', lo: Math.floor(totalN * 0.25), hi: Math.floor(totalN * 0.75) },
      { name: 'last_25pct',   lo: Math.floor(totalN * 0.75), hi: totalN },
    ];
    const submission_segments: Record<string, unknown> = {};
    for (const seg of segmentDefs) {
      const segLatencies = okResults
        .filter(r => r.idx >= seg.lo && r.idx < seg.hi)
        .map(r => r.ms)
        .sort((a, b) => a - b);
      const segPct = (q: number) =>
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

    // Concurrency-over-time. Build an interval-overlap timeline so we can
    // tell where the burst peaked and how long the provider stayed saturated.
    // All intervals are relative to the earliest start.
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
        sample_interval_ms: SAMPLE_MS,
      };
    }

    // System-metrics summary for the meta.json. The full series is in
    // <run_id>/metrics.jsonl; this is the at-a-glance view.
    clearInterval(metricsInterval);
    sampleMetrics();
    const metrics_summary = metricsSamples.length === 0 ? null : {
      sample_count: metricsSamples.length,
      sample_interval_ms: METRICS_SAMPLE_MS,
      peak_mem_rss_mb: Math.max(...metricsSamples.map(s => s.mem_rss_mb)),
      peak_mem_heap_used_mb: Math.max(...metricsSamples.map(s => s.mem_heap_used_mb)),
      peak_event_loop_p99_ms: Math.max(...metricsSamples.map(s => s.event_loop_p99_ms)),
      peak_event_loop_max_ms: Math.max(...metricsSamples.map(s => s.event_loop_max_ms)),
      peak_open_fds: Math.max(...metricsSamples.map(s => s.open_fds ?? 0)),
      peak_tcp_inuse: Math.max(...metricsSamples.map(s => s.sockstat?.tcp_inuse ?? 0)),
      peak_tcp_tw: Math.max(...metricsSamples.map(s => s.sockstat?.tcp_tw ?? 0)),
      total_cpu_user_us: metricsSamples[metricsSamples.length - 1].cpu_user_us,
      total_cpu_system_us: metricsSamples[metricsSamples.length - 1].cpu_system_us,
    };

    log.phase('flushing sinks and writing summary');
    log.info('Tigris: closing multipart upload for raw.jsonl');
    await tigris.close();
    log.info('Tigris: writing metrics.jsonl');
    await tigris.writeMetrics(metricsSamples);
    log.info('Tigris: writing meta.json');
    await tigris.writeMeta({
      ...final,
      latency_distribution,
      first_command_distribution,
      tti_distribution,
      status_histogram,
      create_failure_class,
      submission_segments,
      concurrency_summary,
      concurrency_timeline,
      metrics_summary,
      run_id: RUN_ID,
      provider: PROVIDER,
      ended_at: new Date().toISOString(),
      ...(shard ? { group_id: shard.group_id, shard_index: shard.shard_index, shard_count: shard.shard_count } : {}),
    });

    log.phase('run complete');
    log.info(`submission_segment emitted counts: first=${emittedSegmentCounts.first_25pct} middle=${emittedSegmentCounts.middle_50pct} last=${emittedSegmentCounts.last_25pct}`);
    log.ok(`${final.sandboxes_succeeded}/${final.sandboxes_attempted} succeeded ` +
      `(${((final.sandboxes_succeeded / final.sandboxes_attempted) * 100).toFixed(1)}%) ` +
      `partial=${final.partials} readiness_failed=${final.readiness_failures} failed=${final.failures}`);
    log.info(`latency p50=${final.p50_latency_ms}ms p99=${final.p99_latency_ms}ms`);
    if (final.timeouts + final.http_errors + final.network_errors > 0) {
      log.warn(`create-failure class: timeouts=${final.timeouts} http_errors=${final.http_errors} network_errors=${final.network_errors}`);
    }
    log.phase('flushing complete');
    // Flush any buffered task records and mark this worker complete. Per-sandbox
    // failures are expected data, not a worker failure, so the worker is
    // "completed" whenever the burst ran end-to-end (only an outright coordinator
    // crash, handled in the catch below, fails the worker).
    if (bench) await bench.finish(false);
    await tigris.writeLog(log.dump());
    // No explicit teardown: the coordinator is the container's PID 1, so when
    // this process exits the Namespace instance auto-reaps (see start.ts).
  } catch (err: any) {
    clearInterval(metricsInterval);
    log.error(`run failed: ${err?.message ?? err}`);
    try {
      if (bench) await bench.finish(true);
      await tigris.close();
      if (metricsSamples.length > 0) await tigris.writeMetrics(metricsSamples);
      await tigris.writeLog(log.dump());
    } catch (e: any) {
      log.error(`failed to record failure: ${e?.message ?? e}`);
    }
    // Exit non-zero: as PID 1 this stops the container, the Namespace instance
    // reaps, and the non-zero exit is visible in DescribeInstance shutdownReasons
    // (so start.ts can flag the shard).
    process.exit(1);
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    log.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

main().catch(err => {
  log.error(`crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
