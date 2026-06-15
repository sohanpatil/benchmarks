import { config as loadDotenv } from 'dotenv';
import { defineStep, defineTask, runBenchmarkWorker } from '@computesdk/bench';
import type { JsonObject, TaskResultRecord, TaskStepRecord } from '@computesdk/bench';
import { getProvider } from './providers.js';
import { log } from './logger.js';
import type { FailureClass, SandboxResult, SandboxResultStatus } from './types.js';
import {
  FIRST_COMMAND_TIMEOUT_MS,
  LIVENESS_CHECK_TIMEOUT_MS,
  extractProviderMetadata,
  withTimeout,
} from './runner.js';

loadDotenv();

type SandboxState = {
  sandbox?: any;
};

async function main() {
  const PROVIDER = required('PROVIDER');
  const BENCHMARK_RUN_ID = required('BENCHMARK_RUN_ID');
  const provider = getProvider(PROVIDER);

  const instanceId = process.env.INSTANCE_ID ?? 'local';
  const benchmarkSlug = process.env.BENCHMARK_SLUG ?? 'scale';
  const participantSlug = process.env.PARTICIPANT_SLUG ?? PROVIDER;
  const commitSha = process.env.GITHUB_SHA ?? 'local';

  const override = process.env.CONCURRENCY_TARGET;
  if (override) provider.concurrencyTarget = parseInt(override, 10);

  const liveHoldMs = parsePositiveInt(process.env.LIFECYCLE_PAUSE_MS, 30_000, true);
  const barrierTimeoutMs = parsePositiveInt(process.env.SCALE_BARRIER_TIMEOUT_MS, 15 * 60_000);

  log.phase('scale sdk coordinator starting');
  log.info(`provider=${PROVIDER} (requires: ${provider.requiredEnvVars.join(', ') || 'none'})`);
  log.info(`concurrency=${provider.concurrencyTarget} timeout=${provider.perRequestTimeoutMs ?? 120_000}ms`);
  log.info(`live_hold_ms=${liveHoldMs} barrier_timeout_ms=${barrierTimeoutMs}`);
  log.info(`commit_sha=${commitSha} instance_id=${instanceId}`);

  log.phase('validating environment');
  const missing = provider.requiredEnvVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    log.error(`Missing required env vars for ${PROVIDER}: ${missing.join(', ')}`);
    process.exit(1);
  }
  log.ok(`all ${provider.requiredEnvVars.length} provider env var(s) present`);

  log.phase('initializing compute client');
  const compute = provider.createCompute();
  log.ok(`compute client ready for ${PROVIDER}`);

  const task = defineTask<SandboxState>('sandbox.lifecycle', [
    defineStep<SandboxState>('create', { reportConcurrency: false }, async ({ state, taskIndex }) => {
      state.sandbox = await withTimeout(
        compute.sandbox.create(provider.sandboxOptions),
        provider.perRequestTimeoutMs ?? 120_000,
      );
      const metadata = extractProviderMetadata(state.sandbox);
      return {
        sandbox_idx: taskIndex,
        ...(typeof metadata?.sandboxId === 'string' ? { sandboxId: metadata.sandboxId } : {}),
      };
    }),

    defineStep<SandboxState>('exec.initial', { reportConcurrency: false }, async ({ state }) => {
      await withTimeout(state.sandbox.runCommand('node -v'), FIRST_COMMAND_TIMEOUT_MS);
    }),

    defineStep<SandboxState>('sandbox.live', {
      reportConcurrency: true,
      readiness: 'poll',
      readyPollIntervalMs: 1_000,
      readyTimeoutMs: barrierTimeoutMs,
    }, async () => {
      if (liveHoldMs > 0) await new Promise(resolve => setTimeout(resolve, liveHoldMs));
    }),

    defineStep<SandboxState>('exec.final', { reportConcurrency: false }, async ({ state }) => {
      await withTimeout(state.sandbox.runCommand('node -v'), LIVENESS_CHECK_TIMEOUT_MS);
    }),
  ]);

  const result = await runBenchmarkWorker(
    { apiKey: process.env.COMPUTESDK_API_KEY ?? process.env.COMPUTESDK_ADMIN_API_KEY },
    {
      benchmarkSlug,
      runId: BENCHMARK_RUN_ID,
      participantSlug,
      processKind: 'container',
      processKey: instanceId,
      batchSize: 500,
      heartbeatIntervalMs: 1_000,
      readyPollIntervalMs: 1_000,
      task,
      onResult: normalizeTaskRecord,
    },
  );
  if (!result.assignment) {
    log.warn('bench: no pending worker to claim');
    process.exit(0);
  }

  const errors = result.records.filter(record => record.status !== 'success').length;
  log.phase('run complete');
  log.ok(`${result.records.length - errors}/${result.records.length} tasks succeeded`);
  if (errors > 0) log.warn(`${errors} task(s) failed before completing sandbox lifecycle`);
  process.exit(errors > 0 ? 1 : 0);
}

function normalizeTaskRecord(record: TaskResultRecord): void {
  const createStep = stepByName(record, 'create');
  const initialStep = stepByName(record, 'exec.initial');
  const liveStep = stepByName(record, 'sandbox.live');
  const finalStep = stepByName(record, 'exec.final');
  const failedStep = record.steps?.find(step => step.status === 'error');
  const lifecycleStatus = lifecycleStatusFor(failedStep?.name);

  record.status = lifecycleStatus;
  record.firstCommandMs = initialStep?.status === 'success' ? initialStep.latencyMs ?? null : null;
  record.errorCode = failedStep?.errorCode ?? null;

  const failureClass = lifecycleStatus === 'success' ? null : classifyFailure(failedStep?.errorCode);
  const data = (record.data ?? {}) as Record<string, unknown>;
  const sandboxResult: SandboxResult = {
    sandbox_idx: record.taskIndex,
    started_at: record.startedAt ?? createStep?.startedAt ?? new Date().toISOString(),
    completed_at: record.completedAt ?? new Date().toISOString(),
    latency_ms: createStep?.latencyMs ?? record.latencyMs ?? 0,
    first_command_ms: record.firstCommandMs ?? null,
    status: lifecycleStatus,
    failure_class: failureClass,
    http_status: null,
    error_code: failedStep?.errorCode ?? null,
    error_message: null,
    provider_metadata: typeof data.sandboxId === 'string' ? { sandboxId: data.sandboxId } : null,
  };

  record.data = {
    ...data,
    lifecycle_status: lifecycleStatus,
    failure_class: failureClass,
    http_status: null,
    error_message: null,
    create_ms: createStep?.latencyMs ?? null,
    first_command_ms: record.firstCommandMs,
    live_ms: liveStep?.latencyMs ?? null,
    final_command_ms: finalStep?.latencyMs ?? null,
    sandbox_result: sandboxResult as unknown as JsonObject,
  };
}

function stepByName(record: TaskResultRecord, name: string): TaskStepRecord | undefined {
  return record.steps?.find(step => step.name === name);
}

function lifecycleStatusFor(stepName: string | undefined): SandboxResultStatus {
  if (!stepName) return 'success';
  if (stepName === 'create') return 'failed';
  if (stepName === 'exec.initial') return 'readiness_failed';
  return 'partial';
}

function classifyFailure(errorCode: string | null | undefined): FailureClass {
  const value = (errorCode ?? '').toLowerCase();
  if (value.includes('timeout')) return 'timeout';
  if (value.includes('http') || value.includes('status')) return 'http_error';
  return 'network_error';
}

function parsePositiveInt(raw: string | undefined, fallback: number, allowZero = false): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : fallback;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    log.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

main().catch(err => {
  log.error(`crashed: ${err?.stack ?? err}`);
  process.exit(1);
});
