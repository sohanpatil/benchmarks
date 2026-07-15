/**
 * Runs the burst sandbox lifecycle (create → 3 commands → destroy) N-wide in
 * parallel through the platform's real orchestrator API, mirroring
 * report-run.ts's sequential+report path but using @computesdk/bench's
 * built-in `runWorker({ concurrency })` override instead of a one-at-a-time
 * loop — so a local `--report --mode burst` run shows up on the
 * benchmarks-platform dashboard with all sandboxes in flight simultaneously.
 */
import { createBenchmarkClient, defineStep, defineTask } from '@computesdk/bench';
import type { TaskResultRecord } from '@computesdk/bench';
import { withTimeout } from '../util/timeout.js';
import type { ProviderConfig } from './types.js';
import type { PlatformReportConfig } from './report-run.js';

type LifecycleState = { sandbox?: any };

export async function runBurstWithPlatformReport(
  config: ProviderConfig,
  concurrency: number,
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
  console.log(`  MODE: BURST (reporting to platform)`);
  console.log(`  Provider: ${name}  Concurrency: ${concurrency}`);
  console.log(`  Benchmark: ${report.benchmarkSlug}`);
  console.log('='.repeat(70));

  await client.upsertBenchmark(report.benchmarkSlug, {
    name: 'Sandbox burst TTI (local)',
    kind: 'sandbox',
  });

  const { run } = await client.createRun(report.benchmarkSlug, {
    name: `${name} burst — concurrency ${concurrency}`,
    totalTasks: concurrency,
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
    defineStep<LifecycleState>('First command: node -v', async ({ state }) => {
      const result = (await withTimeout(
        (state.sandbox as any).runCommand('node -v'),
        30_000,
        'First command execution timed out',
      )) as { exitCode: number; stderr?: string };
      if (result.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
      }
    }),
    defineStep<LifecycleState>('Second command: echo bench', async ({ state }) => {
      const result = (await withTimeout(
        (state.sandbox as any).runCommand('echo bench-placeholder-2'),
        30_000,
        'Second command execution timed out',
      )) as { exitCode: number; stderr?: string };
      if (result.exitCode !== 0) {
        throw new Error(`Command failed with exit code ${result.exitCode}: ${result.stderr || 'Unknown error'}`);
      }
    }),
    defineStep<LifecycleState>('Third command: node -e console.log', async ({ state }) => {
      const result = (await withTimeout(
        (state.sandbox as any).runCommand('node -e "console.log(1+1)"'),
        30_000,
        'Third command execution timed out',
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
    concurrency,
    task,
    onResult: (record: TaskResultRecord) => {
      const n = record.taskIndex + 1;
      if (record.status === 'success') {
        console.log(`  Sandbox ${n}/${concurrency} done — TTI: ${((record.latencyMs ?? 0) / 1000).toFixed(2)}s`);
      } else {
        console.log(`  Sandbox ${n}/${concurrency} FAILED: ${record.errorCode ?? 'unknown error'}`);
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
