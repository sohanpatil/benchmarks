/**
 * Runs the sequential sandbox lifecycle (create → first command → destroy)
 * through the platform's real orchestrator API instead of the local-only
 * loop in benchmark.ts — so a local `--report` run shows up on the
 * benchmarks-platform dashboard as it happens, using the exact same
 * benchmark/run/worker/task-result pipeline the "scale" coordinator uses
 * (see src/scale/bench-reporter.ts for the distributed-burst equivalent of
 * this same client).
 */
import { createBenchmarkClient, defineStep, defineTask } from '@computesdk/bench';
import type { TaskResultRecord } from '@computesdk/bench';
import { withTimeout } from '../util/timeout.js';
import type { ProviderConfig } from './types.js';

export interface PlatformReportConfig {
  benchmarkSlug: string;
  apiKey?: string;
  baseUrl: string;
  /** Org slug to build the "view at" dashboard link — cosmetic only. */
  orgSlug: string;
}

type LifecycleState = { sandbox?: any };

export async function runSequentialWithPlatformReport(
  config: ProviderConfig,
  iterations: number,
  report: PlatformReportConfig,
): Promise<void> {
  const { name, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs = 15_000, createCompute } = config;

  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    console.log(`\nSkipping ${name}: missing ${missingVars.join(', ')}`);
    return;
  }

  const compute = createCompute();
  const client = createBenchmarkClient({ apiKey: report.apiKey, baseUrl: report.baseUrl });

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  MODE: SEQUENTIAL (reporting to platform)`);
  console.log(`  Provider: ${name}  Iterations: ${iterations}`);
  console.log(`  Benchmark: ${report.benchmarkSlug}`);
  console.log('='.repeat(70));

  await client.upsertBenchmark(report.benchmarkSlug, {
    name: 'Sandbox TTI (local)',
    kind: 'sandbox',
  });

  const { run } = await client.createRun(report.benchmarkSlug, {
    name: `${name} sequential — ${iterations} iterations`,
    totalTasks: iterations,
    workerCount: 1,
    participants: [name],
  });
  await client.planWorkers(report.benchmarkSlug, run.id, name);

  const dashboardUrl = `${report.baseUrl.replace(/\/api\/v1\/?$/, '')}/${report.orgSlug}/benchmarks/${report.benchmarkSlug}/runs/${run.id}`;
  console.log(`  Run created: ${run.id}`);
  console.log(`  View at: ${dashboardUrl}\n`);

  const task = defineTask<LifecycleState>('sandbox.lifecycle', [
    defineStep<LifecycleState>('create', async ({ state }) => {
      state.sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
    }),
    defineStep<LifecycleState>('exec.first-command', async ({ state }) => {
      const result = (await withTimeout(
        (state.sandbox as any).runCommand('node -v'),
        30_000,
        'First command execution timed out',
      )) as { exitCode: number; stderr?: string };
      if (result.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
      }
    }),
    defineStep<LifecycleState>('destroy', { reportConcurrency: false }, async ({ state }) => {
      if (!state.sandbox) return;
      await Promise.race([
        (state.sandbox as any).destroy(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs)),
      ]);
    }),
  ]);

  const result = await client.runWorker({
    benchmarkSlug: report.benchmarkSlug,
    runId: run.id,
    participantSlug: name,
    concurrency: 1,
    task,
    onResult: (record: TaskResultRecord) => {
      const n = record.taskIndex + 1;
      if (record.status === 'success') {
        console.log(`  Iteration ${n}/${iterations}... TTI: ${((record.latencyMs ?? 0) / 1000).toFixed(2)}s`);
      } else {
        console.log(`  Iteration ${n}/${iterations}... FAILED: ${record.errorCode ?? 'unknown error'}`);
      }
    },
  });

  if (!result.assignment) {
    console.error(`  No pending worker to claim for run ${run.id} — it may already be fully claimed.`);
    return;
  }

  const ok = result.records.filter((r) => r.status === 'success').length;
  console.log(`\n  Done: ${ok}/${result.records.length} succeeded.`);
  console.log(`  View at: ${dashboardUrl}`);
}
