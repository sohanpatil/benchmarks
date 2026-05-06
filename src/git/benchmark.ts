import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { computeStats } from '../util/stats.js';
import type { GitBenchmarkResult, GitIterationResult } from './types.js';

const execFileAsync = promisify(execFile);

interface GitRunConfig {
  iterations: number;
  fixtureCommitCount: number;
}

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function seedFixture(remoteDir: string, workDir: string, commitCount: number): Promise<void> {
  fs.mkdirSync(workDir, { recursive: true });
  await git(['init'], workDir);
  await git(['config', 'user.name', 'Benchmark Bot'], workDir);
  await git(['config', 'user.email', 'bench@example.com'], workDir);
  fs.writeFileSync(path.join(workDir, 'README.md'), '# git fixture\n');
  await git(['add', '.'], workDir);
  await git(['commit', '-m', 'chore: initial commit'], workDir);

  const historyFile = path.join(workDir, 'history.txt');
  for (let i = 0; i < commitCount; i++) {
    fs.appendFileSync(historyFile, `line-${i}\n`);
    await git(['add', 'history.txt'], workDir);
    await git(['commit', '-m', `chore: seed ${i + 1}`], workDir);
  }

  await git(['branch', '-M', 'main'], workDir);
  await git(['remote', 'add', 'origin', remoteDir], workDir);
  await git(['push', '-u', 'origin', 'main'], workDir);
}

export async function runGitBenchmark(config: GitRunConfig): Promise<GitBenchmarkResult> {
  const { iterations, fixtureCommitCount } = config;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bench-'));
  const remote = path.join(root, 'remote.git');
  const fixtureWriter = path.join(root, 'fixture-writer');
  const stableClone = path.join(root, 'stable-clone');
  const results: GitIterationResult[] = [];

  try {
    await git(['init', '--bare', remote], root);
    await seedFixture(remote, fixtureWriter, fixtureCommitCount);
    await git(['clone', remote, stableClone], root);

    for (let i = 0; i < iterations; i++) {
      const coldTarget = path.join(root, `cold-${i}`);
      let start = performance.now();
      try {
        await git(['clone', remote, coldTarget], root);
        results.push({ operation: 'cold_clone', latencyMs: performance.now() - start });
      } catch (err) {
        results.push({ operation: 'cold_clone', latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
      }

      const churnFile = path.join(fixtureWriter, 'churn.txt');
      fs.appendFileSync(churnFile, `tick-${i}\n`);
      await git(['add', 'churn.txt'], fixtureWriter);
      await git(['commit', '-m', `chore: churn ${i + 1}`], fixtureWriter);
      await git(['push', 'origin', 'main'], fixtureWriter);

      start = performance.now();
      try {
        await git(['fetch', 'origin'], stableClone);
        results.push({ operation: 'incremental_fetch', latencyMs: performance.now() - start });
      } catch (err) {
        results.push({ operation: 'incremental_fetch', latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
      }

      const commitFile = path.join(stableClone, 'agent.log');
      fs.appendFileSync(commitFile, `push-${i}\n`);
      await git(['add', 'agent.log'], stableClone);
      await git(['commit', '-m', `feat: agent commit ${i + 1}`], stableClone);

      start = performance.now();
      try {
        await git(['pull', '--rebase', 'origin', 'main'], stableClone);
        await git(['push', 'origin', 'main'], stableClone);
        results.push({ operation: 'commit_push', latencyMs: performance.now() - start });
      } catch (err) {
        results.push({ operation: 'commit_push', latencyMs: 0, error: err instanceof Error ? err.message : String(err) });
      }

      fs.rmSync(coldTarget, { recursive: true, force: true });
      console.log(`  Iteration ${i + 1}/${iterations} complete`);
    }

    const successful = results.filter(r => !r.error);
    const operationValues = (op: GitIterationResult['operation']) =>
      results.filter(r => r.operation === op && !r.error).map(r => r.latencyMs);

    return {
      provider: 'local-git',
      mode: 'git',
      fixtureCommitCount,
      iterations,
      results,
      summary: {
        coldCloneMs: computeStats(operationValues('cold_clone')),
        incrementalFetchMs: computeStats(operationValues('incremental_fetch')),
        commitPushMs: computeStats(operationValues('commit_push')),
      },
      successRate: results.length ? successful.length / results.length : 0,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export async function writeGitResultsJson(result: GitBenchmarkResult, outPath: string): Promise<void> {
  const rounded = {
    ...result,
    summary: {
      coldCloneMs: roundStats(result.summary.coldCloneMs),
      incrementalFetchMs: roundStats(result.summary.incrementalFetchMs),
      commitPushMs: roundStats(result.summary.commitPushMs),
    },
    results: result.results.map(r => ({
      ...r,
      latencyMs: round(r.latencyMs),
    })),
    successRate: round(result.successRate),
  };

  fs.writeFileSync(outPath, JSON.stringify({
    version: '1.0',
    timestamp: new Date().toISOString(),
    result: rounded,
  }, null, 2));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundStats(stats: { median: number; p95: number; p99: number }) {
  return {
    median: round(stats.median),
    p95: round(stats.p95),
    p99: round(stats.p99),
  };
}
