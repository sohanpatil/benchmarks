/**
 * Thin reporting layer over the platform-orchestrated `@computesdk/bench`
 * client (v0.1.7+).
 *
 * Why the low-level client and not `defineWorker`/`defineStep`: the scale burst
 * is a *two-phase, barriered* lifecycle (create + readiness for all N, then a
 * coordinated liveness probe + destroy for the survivors — see runner.ts). The
 * SDK's `defineStep` model runs an independent create→…→destroy chain per task
 * index with no cross-task barrier, and its `readiness: "poll"` gate would
 * deadlock here because failed sandboxes never reach the barrier step (active
 * concurrency can never equal the target). So the coordinator keeps owning the
 * burst (BurstLifecycle) and uses this reporter purely to:
 *   - claim one platform worker assignment per VM,
 *   - stream per-sandbox results as `task_results` batches,
 *   - heartbeat progress + in-flight concurrency, and
 *   - mark the worker complete/failed.
 *
 * Tigris remains the source of truth for the fine-grained analytics
 * (raw.jsonl / meta.json / metrics.jsonl); the platform is the orchestration +
 * live-progress + cross-worker rollup layer that watch.ts / aggregate.ts read.
 *
 * All platform calls are best-effort: a telemetry failure must never take down
 * the burst, so network errors are swallowed (mirroring the old bench SDK's
 * internal behaviour).
 */
import { createBenchmarkClient } from '@computesdk/bench';
import type {
  BenchmarkAssignment,
  BenchmarkClient,
  JsonObject,
  TaskResultRecord,
  TaskStepRecord,
} from '@computesdk/bench';
import type { ProgressStats, SandboxResult } from './types.js';
import { log } from './logger.js';

const DEFAULT_BATCH_SIZE = 500;

export interface BenchReporterConfig {
  apiKey?: string;
  baseUrl?: string;
  benchmarkSlug: string;
  runId: string;
  participantSlug: string;
  processKind?: string;
  processKey?: string;
  /** Records buffered before a `sendTaskResults` flush. Default 500. */
  batchSize?: number;
}

/** Maps one finalized SandboxResult onto the platform's task-result shape. */
function toTaskRecord(r: SandboxResult, baseIdx: number, extraData?: JsonObject): TaskResultRecord {
  // Per-step records let `getRunResults().steps[]` report create / readiness
  // latency summaries even though we don't drive the SDK's step machinery.
  const steps: TaskStepRecord[] = [
    {
      name: 'create',
      status: r.status === 'failed' ? 'error' : 'success',
      latencyMs: r.latency_ms,
      ...(r.status === 'failed' && r.error_code ? { errorCode: r.error_code } : {}),
    },
  ];
  if (r.first_command_ms != null) {
    steps.push({ name: 'exec.initial', status: 'success', latencyMs: r.first_command_ms });
  } else if (r.status === 'readiness_failed') {
    steps.push({ name: 'exec.initial', status: 'error', ...(r.error_code ? { errorCode: r.error_code } : {}) });
  }

  const data: JsonObject = {
    failure_class: r.failure_class,
    http_status: r.http_status,
    error_message: r.error_message,
    ...(typeof r.provider_metadata?.sandboxId === 'string' ? { sandboxId: r.provider_metadata.sandboxId } : {}),
    ...extraData,
  };

  return {
    taskIndex: baseIdx + r.sandbox_idx,
    // Carries the full four-state taxonomy (success/partial/readiness_failed/
    // failed). The platform buckets these into success/error/other, so the fine
    // split is recoverable only from this raw status or from Tigris.
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    latencyMs: r.latency_ms,
    firstCommandMs: r.first_command_ms,
    errorCode: r.error_code,
    steps,
    data,
  };
}

export class BenchReporter {
  private readonly client: BenchmarkClient;
  private readonly cfg: Required<Pick<BenchReporterConfig, 'benchmarkSlug' | 'runId' | 'participantSlug' | 'batchSize'>>;
  private readonly assignment: BenchmarkAssignment;
  private readonly baseIdx: number;
  private readonly total: number;

  private pending: TaskResultRecord[] = [];
  private sequenceNumber = 0;
  private flushChain: Promise<void> = Promise.resolve();
  private lastStats: ProgressStats = { done: 0, in_flight: 0, errors: 0 };

  private constructor(client: BenchmarkClient, cfg: BenchReporterConfig, assignment: BenchmarkAssignment) {
    this.client = client;
    this.assignment = assignment;
    this.baseIdx = assignment.taskRange.start;
    this.total = assignment.taskRange.count;
    this.cfg = {
      benchmarkSlug: cfg.benchmarkSlug,
      runId: cfg.runId,
      participantSlug: cfg.participantSlug,
      batchSize: cfg.batchSize ?? DEFAULT_BATCH_SIZE,
    };
  }

  /**
   * Claim one pending worker for this run/participant. Returns null when the
   * platform has no pending worker to assign (e.g. all already claimed) — the
   * caller should then run the burst without platform reporting.
   */
  static async claim(cfg: BenchReporterConfig): Promise<BenchReporter | null> {
    const client = createBenchmarkClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    try {
      const assignment = await client.claimWorker(cfg.benchmarkSlug, cfg.runId, cfg.participantSlug, {
        processKind: cfg.processKind,
        processKey: cfg.processKey,
      });
      if (!assignment) {
        log.warn('bench: no pending worker to claim — running without platform reporting');
        return null;
      }
      log.ok(
        `bench: claimed worker ${assignment.workerIndex + 1}/${assignment.workerCount} ` +
        `(tasks ${assignment.taskRange.start}..${assignment.taskRange.end - 1}, ` +
        `target=${assignment.targetConcurrency})`,
      );
      return new BenchReporter(client, cfg, assignment);
    } catch (err: any) {
      log.warn(`bench: claimWorker failed (${err?.message ?? err}) — running without platform reporting`);
      return null;
    }
  }

  /** Number of task indexes the platform assigned this worker. */
  get taskCount(): number {
    return this.total;
  }

  /** Global task index of this worker's first sandbox (for cross-worker uniqueness). */
  get taskIndexStart(): number {
    return this.baseIdx;
  }

  /** Buffer one finalized sandbox; flush when the batch fills. */
  recordResult(result: SandboxResult, extraData?: JsonObject): void {
    this.pending.push(toTaskRecord(result, this.baseIdx, extraData));
    if (this.pending.length >= this.cfg.batchSize) void this.flush(false);
  }

  /** Update the in-memory progress snapshot sent on the next heartbeat. */
  setStats(stats: ProgressStats): void {
    this.lastStats = stats;
  }

  /** Send a progress + concurrency heartbeat (best-effort). */
  async heartbeat(activeInFlight: number): Promise<void> {
    try {
      await this.client.heartbeatWorker(this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, {
        attemptId: this.assignment.attemptId,
        progressDone: this.lastStats.done,
        progressInFlight: this.lastStats.in_flight,
        progressErrors: this.lastStats.errors,
        progressTotal: this.total,
        ...(activeInFlight > 0
          ? { currentStep: 'lifecycle', concurrency: [{ step: 'lifecycle', active: activeInFlight, target: this.total }] }
          : { concurrency: [] }),
      });
    } catch {
      /* best-effort */
    }
  }

  /** Serialize `sendTaskResults` so sequenceNumbers stay ordered. */
  private flush(isFinal: boolean): Promise<void> {
    this.flushChain = this.flushChain.then(async () => {
      const batchSize = this.cfg.batchSize;
      while (this.pending.length >= batchSize || (isFinal && this.pending.length > 0)) {
        const batch = this.pending.splice(0, batchSize);
        try {
          await this.client.sendTaskResults({
            benchmarkSlug: this.cfg.benchmarkSlug,
            runId: this.cfg.runId,
            workerId: this.assignment.workerId,
            attemptId: this.assignment.attemptId,
            sequenceNumber: this.sequenceNumber,
            isFinal: isFinal && this.pending.length === 0,
            records: batch,
          });
        } catch (err: any) {
          log.warn(`bench: sendTaskResults batch ${this.sequenceNumber} failed: ${err?.message ?? err}`);
        }
        this.sequenceNumber += 1;
      }
    });
    return this.flushChain;
  }

  /** Final flush + mark the worker completed (or failed). Best-effort. */
  async finish(failed: boolean): Promise<void> {
    await this.flush(true).catch(() => {});
    try {
      if (failed) {
        await this.client.failWorker(
          this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, this.assignment.attemptId,
          new Error('burst reported one or more failures'),
        );
      } else {
        await this.client.completeWorker(
          this.cfg.benchmarkSlug, this.cfg.runId, this.assignment.workerId, this.assignment.attemptId,
        );
      }
    } catch (err: any) {
      log.warn(`bench: ${failed ? 'failWorker' : 'completeWorker'} failed: ${err?.message ?? err}`);
    }
  }
}
