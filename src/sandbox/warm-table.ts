import type { WarmBenchmarkResult, WarmOpName } from './warm-types.js';
import { sortWarmByCompositeScore } from './warm-scoring.js';

const OP_LABELS: Record<WarmOpName, string> = {
  runCommand_noop: 'cmd RTT',
  writeFile_1mb: 'write 1MB',
  readFile_1mb: 'read 1MB',
  readdir: 'readdir',
  runCommand_1mb_stdout: 'stdout 1MB',
};

const OP_ORDER: WarmOpName[] = [
  'runCommand_noop',
  'writeFile_1mb',
  'readFile_1mb',
  'readdir',
  'runCommand_1mb_stdout',
];

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function formatMs(ms: number): string {
  if (ms === 0) return '--';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function printWarmResultsTable(results: WarmBenchmarkResult[]): void {
  const nameWidth = 14;
  const colWidth = 12;

  const header = [
    pad('Provider', nameWidth),
    pad('Score', 8),
    ...OP_ORDER.map(op => pad(OP_LABELS[op], colWidth)),
    pad('Success', 10),
  ].join(' | ');

  const separator = [
    '-'.repeat(nameWidth),
    '-'.repeat(8),
    ...OP_ORDER.map(() => '-'.repeat(colWidth)),
    '-'.repeat(10),
  ].join('-+-');

  console.log('\n' + '='.repeat(separator.length));
  console.log('  SANDBOX PROVIDER BENCHMARK RESULTS - Warm Sandbox Ops (median)');
  console.log('='.repeat(separator.length));
  console.log(header);
  console.log(separator);

  const sorted = sortWarmByCompositeScore(results);

  for (const r of sorted) {
    if (r.skipped) {
      console.log([
        pad(r.provider, nameWidth),
        pad('--', 8),
        ...OP_ORDER.map(() => pad('--', colWidth)),
        pad('SKIPPED', 10),
      ].join(' | '));
      continue;
    }
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const successPct = r.successRate !== undefined ? `${(r.successRate * 100).toFixed(0)}%` : '--';
    console.log([
      pad(r.provider, nameWidth),
      pad(score, 8),
      ...OP_ORDER.map(op => pad(formatMs(r.ops[op]?.summary.median ?? 0), colWidth)),
      pad(successPct, 10),
    ].join(' | '));
  }

  console.log('='.repeat(separator.length));
  console.log('  Warm Ops = latency of common operations on an already-provisioned sandbox.\n');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function writeWarmResultsJson(
  results: WarmBenchmarkResult[],
  outPath: string,
): Promise<void> {
  const fs = await import('fs');
  const os = await import('os');

  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    samplesPerOp: r.samplesPerOp,
    payloadBytes: r.payloadBytes,
    ops: Object.fromEntries(
      OP_ORDER
        .filter(op => r.ops[op])
        .map(op => {
          const data = r.ops[op]!;
          return [op, {
            samples: data.samples.map(s => ({
              latencyMs: round(s.latencyMs),
              ...(s.error ? { error: s.error } : {}),
            })),
            summary: {
              median: round(data.summary.median),
              p95: round(data.summary.p95),
              p99: round(data.summary.p99),
            },
          }];
        }),
    ),
    ...(r.compositeScore !== undefined ? { compositeScore: round(r.compositeScore) } : {}),
    ...(r.successRate !== undefined ? { successRate: round(r.successRate) } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
    ...(r.unsupportedReason ? { unsupportedReason: r.unsupportedReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      samplesPerOp: results[0]?.samplesPerOp ?? 0,
      payloadBytes: results[0]?.payloadBytes ?? 0,
    },
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}
