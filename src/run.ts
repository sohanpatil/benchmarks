// Load .env before any other imports so env vars are available at module evaluation time
import './env.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runBenchmark } from './sandbox/benchmark.js';
import { runConcurrentBenchmark } from './sandbox/concurrent.js';
import { runStaggeredBenchmark } from './sandbox/staggered.js';
import { runStorageBenchmark, writeStorageResultsJson } from './storage/benchmark.js';
import { runBrowserBenchmark, writeBrowserResultsJson } from './browser/benchmark.js';
import {
  emptySummary,
  runThroughputBenchmark,
  runThroughputIteration,
  summarizeIterations,
  writeThroughputResultsJson,
} from './browser/throughput-benchmark.js';
import { printResultsTable, writeResultsJson } from './sandbox/table.js';
import { providers } from './sandbox/providers.js';
import { storageProviders } from './storage/providers.js';
import { browserProviders } from './browser/providers.js';
import { throughputProviders } from './browser/throughput-providers.js';
import { computeCompositeScores } from './sandbox/scoring.js';
import { computeStorageCompositeScores } from './storage/scoring.js';
import { computeBrowserCompositeScores } from './browser/scoring.js';
import { computeThroughputCompositeScores } from './browser/throughput-scoring.js';
import type { BenchmarkResult, BenchmarkMode } from './sandbox/types.js';
import type { StorageBenchmarkResult } from './storage/types.js';
import type { BrowserBenchmarkResult } from './browser/types.js';
import type { ThroughputBenchmarkResult, ThroughputTimingResult } from './browser/throughput-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
const providerFilter = getArgValue(args, '--provider');
const iterationsArg = getArgValue(args, '--iterations');
const iterations = parseInt(iterationsArg || '100', 10);
const rawMode = getArgValue(args, '--mode');
const concurrency = parseInt(getArgValue(args, '--concurrency') || '100', 10);
const storageConcurrency = parseInt(getArgValue(args, '--storage-concurrency') || '1', 10);
const staggerDelay = parseInt(getArgValue(args, '--stagger-delay') || '200', 10);
const fileSizeArg = getArgValue(args, '--file-size') || '10MB';

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/** Resolve which modes to run */
function getModesToRun(): BenchmarkMode[] | ['storage'] | ['browser'] | ['browser-throughput'] {
  if (!rawMode) return ['sequential', 'staggered', 'burst'];
  if (rawMode === 'storage') return ['storage'];
  if (rawMode === 'browser') return ['browser'];
  if (rawMode === 'browser-throughput') return ['browser-throughput'];
  const m = rawMode === 'concurrent' ? 'burst' : rawMode as BenchmarkMode;
  return [m];
}

/** Map mode to results subdirectory name */
function modeToDir(m: BenchmarkMode | 'storage' | 'browser-throughput'): string {
  switch (m) {
    case 'sequential': return 'sequential_tti';
    case 'staggered': return 'staggered_tti';
    case 'burst':
    case 'concurrent': return 'burst_tti';
    case 'storage': return 'storage';
    case 'browser-throughput': return 'browser-throughput';
    default: return `${m}_tti`;
  }
}

async function runMode(mode: BenchmarkMode, toRun: typeof providers): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log(`  MODE: ${mode.toUpperCase()}`);
  if (mode === 'sequential') {
    console.log(`  Iterations per provider: ${iterations}`);
  } else {
    console.log(`  Concurrency: ${concurrency} sandboxes`);
    if (mode === 'staggered') {
      console.log(`  Stagger delay: ${staggerDelay}ms`);
    }
  }
  console.log('='.repeat(70));

  const results: BenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    switch (mode) {
      case 'sequential': {
        const result = await runBenchmark({ ...providerConfig, iterations });
        results.push(result);
        break;
      }
      case 'staggered': {
        const result = await runStaggeredBenchmark({
          ...providerConfig,
          concurrency,
          staggerDelayMs: staggerDelay,
        });
        results.push(result);
        break;
      }
      case 'burst':
      case 'concurrent': {
        const result = await runConcurrentBenchmark({ ...providerConfig, concurrency });
        results.push(result);
        break;
      }
    }
  }

  // Compute composite scores
  computeCompositeScores(results);

  // Print comparison table
  printResultsTable(results);

  // Write JSON results to mode-specific subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir(mode);
  const resultsDir = path.resolve(__dirname, `../results/${subDir}`);
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runStorage(toRun: typeof storageProviders, fileSizeLabel: string): Promise<void> {
  const { FILE_SIZE_BYTES } = await import('./storage/types.js');
  const validSizes = Object.keys(FILE_SIZE_BYTES);
  if (!(fileSizeLabel in FILE_SIZE_BYTES)) {
    console.error(`Invalid --file-size "${fileSizeLabel}". Valid sizes: ${validSizes.join(', ')}`);
    process.exit(1);
  }
  const fileSizeBytes = FILE_SIZE_BYTES[fileSizeLabel as keyof typeof FILE_SIZE_BYTES];

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: STORAGE');
  console.log(`  File size: ${fileSizeLabel}`);
  console.log(`  Iterations per provider: ${iterations}`);
  console.log(`  Concurrency per provider: ${storageConcurrency}`);
  console.log('='.repeat(70));

  const results: StorageBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runStorageBenchmark({ ...providerConfig, iterations, concurrency: storageConcurrency }, fileSizeBytes);
    results.push(result);
  }

  // Compute composite scores
  computeStorageCompositeScores(results);

  // Print comparison table (TODO: add storage-specific table printer)
  console.log('\n--- Storage Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Download: ${(r.summary.downloadMs.median / 1000).toFixed(2)}s (median), ${r.summary.throughputMbps.median.toFixed(2)} Mbps`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to storage subdirectory with file size
  const timestamp = new Date().toISOString().slice(0, 10);
  const subDir = modeToDir('storage');
  const sizeDir = path.resolve(__dirname, `../results/${subDir}/${fileSizeLabel.toLowerCase()}`);
  fs.mkdirSync(sizeDir, { recursive: true });

  const outPath = path.join(sizeDir, `${timestamp}.json`);
  await writeStorageResultsJson(results, outPath);

  // Copy results to latest.json
  const latestPath = path.join(sizeDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runBrowser(toRun: typeof browserProviders): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('  MODE: BROWSER');
  console.log(`  Iterations per provider: ${iterations}`);
  console.log('='.repeat(70));

  const results: BrowserBenchmarkResult[] = [];

  for (const providerConfig of toRun) {
    const result = await runBrowserBenchmark({ ...providerConfig, iterations });
    results.push(result);
  }

  // Compute composite scores
  computeBrowserCompositeScores(results);

  // Print summary
  console.log('\n--- Browser Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const ok = r.iterations.filter(i => !i.error).length;
    const total = r.iterations.length;
    console.log(`${r.provider}:`);
    console.log(`  Total: ${(r.summary.totalMs.median / 1000).toFixed(2)}s (median) — create ${(r.summary.createMs.median / 1000).toFixed(2)}s + connect ${(r.summary.connectMs.median / 1000).toFixed(2)}s + navigate ${(r.summary.navigateMs.median / 1000).toFixed(2)}s + release ${(r.summary.releaseMs.median / 1000).toFixed(2)}s`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${ok}/${total} OK)`);
  }

  // Write JSON results to browser subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../results/browser');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  const timeoutMs = toRun.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
  await writeBrowserResultsJson(results, outPath, { timeoutMs });

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function runBrowserThroughput(toRun: typeof throughputProviders): Promise<void> {
  // Only override when --iterations was explicitly passed; otherwise let
  // runThroughputBenchmark apply its own default (100 sessions per provider).
  const throughputIterations = iterationsArg ? iterations : undefined;
  const iterationsToRun = throughputIterations ?? 100;

  console.log('\n' + '='.repeat(70));
  console.log('  MODE: BROWSER THROUGHPUT');
  console.log(`  Iterations per provider: ${iterationsToRun}`);
  console.log('='.repeat(70));

  const results: ThroughputBenchmarkResult[] = [];

  if (providerFilter || toRun.length === 1) {
    for (const providerConfig of toRun) {
      const result = await runThroughputBenchmark(
        throughputIterations !== undefined
          ? { ...providerConfig, iterations: throughputIterations }
          : providerConfig,
      );
      results.push(result);
    }
  } else {
    const resultByProvider = new Map<string, ThroughputBenchmarkResult>();
    const active: Array<{
      name: string;
      provider: any;
      timeout: number;
      sessionCreateOptions: Record<string, unknown>;
      iterations: ThroughputTimingResult[];
    }> = [];

    for (const providerConfig of toRun) {
      const missingVars = providerConfig.requiredEnvVars.filter(v => !process.env[v]);
      if (missingVars.length > 0) {
        resultByProvider.set(providerConfig.name, {
          provider: providerConfig.name,
          mode: 'browser-throughput',
          iterations: [],
          summary: emptySummary(),
          skipped: true,
          skipReason: `Missing: ${missingVars.join(', ')}`,
        });
        continue;
      }

      active.push({
        name: providerConfig.name,
        provider: providerConfig.createBrowserProvider(),
        timeout: providerConfig.timeout ?? 120_000,
        sessionCreateOptions: providerConfig.sessionCreateOptions ?? {},
        iterations: [],
      });
    }

    console.log(`\n--- Interleaved Throughput Benchmark (${iterationsToRun} rounds × ${active.length} providers) ---`);
    console.log('Provider      Sess  Create   Connect  Task     Release  Total    APS    Actions');
    console.log('────────────  ────  ───────  ───────  ───────  ───────  ───────  ─────  ───────');

    for (let i = 0; i < iterationsToRun; i++) {
      for (const state of active) {
        const result = await runThroughputIteration(state.provider, state.timeout, state.sessionCreateOptions);
        state.iterations.push(result);

        const pad = (n: number) => `${Math.round(n)}ms`.padStart(7);
        const aps = result.actionsPerSecond.toFixed(1).padStart(5);
        const status = `${result.actionsCompleted}/50`;
        const errSuffix = result.error ? `  ✗ ${result.error.slice(0, 50)}` : '';
        console.log(
          `${state.name.padEnd(12)}  ${String(i + 1).padStart(4)}  ${pad(result.createMs)}  ${pad(result.connectMs)}  ${pad(result.taskMs)}  ${pad(result.releaseMs)}  ${pad(result.totalMs)}  ${aps}  ${status}${errSuffix}`,
        );
      }
    }

    for (const state of active) {
      resultByProvider.set(state.name, {
        provider: state.name,
        mode: 'browser-throughput',
        iterations: state.iterations,
        summary: summarizeIterations(state.iterations),
      });
    }

    for (const providerConfig of toRun) {
      const result = resultByProvider.get(providerConfig.name);
      if (result) results.push(result);
    }
  }

  // Compute composite scores
  computeThroughputCompositeScores(results);

  // Print summary
  console.log('\n--- Browser Throughput Benchmark Results ---');
  for (const r of results) {
    if (r.skipped) {
      console.log(`${r.provider}: SKIPPED (${r.skipReason})`);
      continue;
    }
    const expectedActions = 50;
    const fullSuccess = r.iterations.filter(i => !i.error && i.actionsCompleted === expectedActions).length;
    const total = r.iterations.length;
    const aps = r.summary.actionsPerSecond.median;
    const taskMed = r.summary.taskMs.median;
    const screenshotMed = r.summary.perActionType.screenshot?.median ?? 0;
    console.log(`${r.provider}:`);
    console.log(`  APS: ${aps.toFixed(2)}/s (median) — task ${(taskMed / 1000).toFixed(2)}s, screenshot ${Math.round(screenshotMed)}ms`);
    console.log(`  Score: ${r.compositeScore?.toFixed(1) || '--'} (${fullSuccess}/${total} OK)`);
  }

  // Write JSON results to browser-throughput subdirectory
  const timestamp = new Date().toISOString().slice(0, 10);
  const resultsDir = path.resolve(__dirname, '../results/browser-throughput');
  fs.mkdirSync(resultsDir, { recursive: true });

  const outPath = path.join(resultsDir, `${timestamp}.json`);
  const timeoutMs = toRun.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;
  await writeThroughputResultsJson(results, outPath, { timeoutMs });

  // Copy results to latest.json
  const latestPath = path.join(resultsDir, 'latest.json');
  fs.copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}

async function main() {
  const modes = getModesToRun();

  // Handle browser-throughput mode separately
  if (modes[0] === 'browser-throughput') {
    console.log('ComputeSDK Browser Throughput Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const toRun = providerFilter
      ? throughputProviders.filter(p => p.name === providerFilter)
      : throughputProviders;

    if (toRun.length === 0) {
      if (providerFilter) {
        console.error(`Unknown browser-throughput provider: ${providerFilter}`);
        console.error(`Available: ${throughputProviders.map(p => p.name).join(', ')}`);
      } else {
        console.error('No browser-throughput providers configured. Add entries to src/browser/throughput-providers.ts.');
      }
      process.exit(1);
    }

    await runBrowserThroughput(toRun);
    console.log('\nAll browser-throughput tests complete.');
    return;
  }

  // Handle browser mode separately
  if (modes[0] === 'browser') {
    console.log('ComputeSDK Browser Provider Benchmarks');
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Filter browser providers
    const toRun = providerFilter
      ? browserProviders.filter(p => p.name === providerFilter)
      : browserProviders;

    if (toRun.length === 0) {
      if (providerFilter) {
        console.error(`Unknown browser provider: ${providerFilter}`);
        console.error(`Available: ${browserProviders.map(p => p.name).join(', ')}`);
      } else {
        console.error('No browser providers configured. Add entries to src/browser/providers.ts.');
      }
      process.exit(1);
    }

    await runBrowser(toRun);
    console.log('\nAll browser tests complete.');
    return;
  }

  // Handle storage mode separately
  if (modes[0] === 'storage') {
    console.log('ComputeSDK Storage Provider Benchmarks');
    console.log(`File size: ${fileSizeArg}`);
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Filter storage providers
    const toRun = providerFilter
      ? storageProviders.filter(p => p.name === providerFilter)
      : storageProviders;

    if (toRun.length === 0) {
      console.error(`Unknown storage provider: ${providerFilter}`);
      console.error(`Available: ${storageProviders.map(p => p.name).join(', ')}`);
      process.exit(1);
    }

    await runStorage(toRun, fileSizeArg);
    console.log('\nAll storage tests complete.');
    return;
  }

  console.log('ComputeSDK Sandbox Provider Benchmarks');
  console.log(`Tests to run: ${modes.join(', ')}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  // Filter sandbox providers
  const toRun = providerFilter
    ? providers.filter(p => p.name === providerFilter)
    : providers;

  if (toRun.length === 0) {
    console.error(`Unknown provider: ${providerFilter}`);
    console.error(`Available: ${providers.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  for (const mode of modes) {
    await runMode(mode as BenchmarkMode, toRun);
  }

  console.log('\nAll tests complete.');
}

main().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
