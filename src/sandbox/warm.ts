import { randomUUID } from 'node:crypto';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import type {
  WarmBenchmarkResult,
  WarmConfig,
  WarmOpName,
  WarmOpResult,
  WarmSampleResult,
} from './warm-types.js';

const DEFAULT_SAMPLES_PER_OP = 100;
const DEFAULT_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_OP_TIMEOUT_MS = 10_000;

const OP_ORDER: WarmOpName[] = [
  'runCommand_noop',
  'writeFile_1mb',
  'readFile_1mb',
  'readdir',
  'runCommand_1mb_stdout',
];

/**
 * Run the warm-sandbox operation benchmark for a single provider.
 *
 * Provisions one sandbox, drains the cold start with a throwaway `node -v`,
 * then loops each op N times measuring per-call latency. The sandbox is
 * reused across all ops so we isolate steady-state RTT / throughput from
 * provisioning costs (which the TTI suite already covers).
 */
export async function runWarmBenchmark(config: WarmConfig): Promise<WarmBenchmarkResult> {
  const {
    name,
    samplesPerOp = DEFAULT_SAMPLES_PER_OP,
    payloadBytes = DEFAULT_PAYLOAD_BYTES,
    opTimeoutMs = DEFAULT_OP_TIMEOUT_MS,
    timeout = 120_000,
    requiredEnvVars,
    sandboxOptions,
    destroyTimeoutMs = 15_000,
  } = config;

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.log(`\n--- Warm Ops Benchmark: ${name} — SKIPPED (missing: ${missingVars.join(', ')}) ---`);
    return emptyResult(name, samplesPerOp, payloadBytes, {
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    });
  }

  console.log(`\n--- Warm Ops Benchmark: ${name} (${samplesPerOp} samples/op, payload ${payloadBytes} bytes) ---`);

  const compute = config.createCompute();
  let sandbox: any = null;

  try {
    console.log(`  Creating sandbox...`);
    sandbox = await withTimeout(
      compute.sandbox.create(sandboxOptions),
      timeout,
      'Sandbox creation timed out',
    );

    // Drain the cold start with `node -v` so we're not measuring provisioning.
    console.log(`  Warm-up: node -v`);
    try {
      await withTimeout(
        sandbox.runCommand('node -v'),
        opTimeoutMs,
        'Warm-up command timed out',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  SKIPPED: warm-up runCommand failed — ${message}`);
      return emptyResult(name, samplesPerOp, payloadBytes, {
        skipped: true,
        skipReason: `Warm-up runCommand failed: ${message}`,
      });
    }

    // Some adapters don't expose a filesystem surface. Detect once and bail
    // out gracefully rather than poisoning the score.
    if (!sandbox.filesystem || typeof sandbox.filesystem.writeFile !== 'function') {
      console.log(`  SKIPPED: sandbox.filesystem not supported by this provider`);
      return emptyResult(name, samplesPerOp, payloadBytes, {
        skipped: true,
        unsupportedReason: 'sandbox.filesystem not supported by this provider',
      });
    }

    const ops: Partial<Record<WarmOpName, WarmOpResult>> = {};
    const runId = randomUUID().slice(0, 8);
    const payload = makePayload(payloadBytes);
    const readFixturePath = `/tmp/.bench_warm_${runId}_read_fixture.bin`;
    const readDirPath = '/tmp';
    const stdoutCommand = buildStdoutCommand(payloadBytes);

    // One-time setup: lay down a fixture file for readFile_1mb so the read
    // benchmark is independent of the (often more variable) write path.
    console.log(`  Setup: writing 1MB read fixture`);
    try {
      await withTimeout(
        sandbox.filesystem.writeFile(readFixturePath, payload),
        opTimeoutMs,
        'Read-fixture setup timed out',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  SKIPPED: failed to write read fixture — ${message}`);
      return emptyResult(name, samplesPerOp, payloadBytes, {
        skipped: true,
        skipReason: `Failed to write read fixture: ${message}`,
      });
    }

    // writeFile_1mb rotates paths so we never hit provider quirks where an
    // existing file can't be overwritten (e.g. e2b returns 500 perm-denied
    // on repeated writes to the same path).
    let writeCounter = 0;
    const ctx: OpContext = {
      payload,
      readFixturePath,
      nextWritePath: () => `/tmp/.bench_warm_${runId}_w_${writeCounter++}.bin`,
      readDirPath,
      stdoutCommand,
    };

    for (const op of OP_ORDER) {
      const fn = opFnFactory(op, sandbox, ctx);
      console.log(`  Op: ${op}`);
      ops[op] = await runOp(fn, samplesPerOp, opTimeoutMs);
      const summary = ops[op]!.summary;
      const samples = ops[op]!.samples;
      const errors = samples.filter(s => s.error);
      const errorTail = errors.length > 0 ? ` | ${errors.length}/${samples.length} errors (e.g. "${errors[0].error?.slice(0, 80)}")` : '';
      console.log(
        `    median ${summary.median.toFixed(0)}ms | p95 ${summary.p95.toFixed(0)}ms | p99 ${summary.p99.toFixed(0)}ms${errorTail}`,
      );
    }

    return {
      provider: name,
      mode: 'warm_ops',
      samplesPerOp,
      payloadBytes,
      ops,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  FAILED: ${message}`);
    return emptyResult(name, samplesPerOp, payloadBytes, {
      skipped: true,
      skipReason: `Sandbox setup failed: ${message}`,
    });
  } finally {
    if (sandbox) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sandbox.destroy(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Destroy timeout')), destroyTimeoutMs);
          }),
        ]);
      } catch (err) {
        console.warn(`    [cleanup] destroy failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}

interface OpContext {
  payload: string;
  /** Fixture file laid down once during setup, used by readFile_1mb. */
  readFixturePath: string;
  /** Returns a fresh write target. writeFile_1mb rotates paths to dodge
   *  provider quirks where existing files can't be overwritten. */
  nextWritePath: () => string;
  readDirPath: string;
  stdoutCommand: string;
}

type OpFn = () => Promise<void>;

function opFnFactory(op: WarmOpName, sandbox: any, ctx: OpContext): OpFn {
  switch (op) {
    case 'runCommand_noop':
      return async () => {
        const r = await sandbox.runCommand('true');
        if (r && typeof r.exitCode === 'number' && r.exitCode !== 0) {
          throw new Error(`runCommand exit ${r.exitCode}`);
        }
      };
    case 'writeFile_1mb':
      return async () => {
        await sandbox.filesystem.writeFile(ctx.nextWritePath(), ctx.payload);
      };
    case 'readFile_1mb':
      return async () => {
        const data = await sandbox.filesystem.readFile(ctx.readFixturePath);
        // Light sanity: result should be non-empty. We don't assert exact
        // bytes — adapters return string|Buffer inconsistently.
        if (data === undefined || data === null || (data as any).length === 0) {
          throw new Error('readFile returned empty result');
        }
      };
    case 'readdir':
      return async () => {
        const entries = await sandbox.filesystem.readdir(ctx.readDirPath);
        if (!entries || !Array.isArray(entries)) {
          throw new Error('readdir did not return an array');
        }
      };
    case 'runCommand_1mb_stdout':
      return async () => {
        const r = await sandbox.runCommand(ctx.stdoutCommand);
        const out = r?.stdout ?? '';
        // Tolerance for trailing newlines / chunking. Just confirm we received
        // most of the expected bytes through the streaming channel.
        if (out.length < ctx.payload.length * 0.9) {
          throw new Error(`stdout truncated: got ${out.length} bytes`);
        }
      };
  }
}

async function runOp(fn: OpFn, samples: number, timeoutMs: number): Promise<WarmOpResult> {
  const results: WarmSampleResult[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    try {
      await withTimeout(fn(), timeoutMs, 'Op timed out');
      const latencyMs = performance.now() - start;
      results.push({ latencyMs });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ latencyMs: 0, error });
    }
  }
  const successful = results.filter(r => !r.error).map(r => r.latencyMs);
  return {
    samples: results,
    summary: successful.length > 0
      ? computeStats(successful)
      : { median: 0, p95: 0, p99: 0 },
  };
}

function makePayload(bytes: number): string {
  // ComputeSDK's documented writeFile content type is `string`. Adapters
  // that accept Buffer (e2b, cloudflare) do it as a courtesy, but blaxel's
  // API JSON-encodes the content and rejects anything that's not a JSON
  // string — a Buffer fails the fixture write with HTTP 400. A string of
  // printable ASCII round-trips through every adapter we test.
  let s = '';
  const chunkSize = 65_536;
  const chunk = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(Math.ceil(chunkSize / 26)).slice(0, chunkSize);
  const full = Math.floor(bytes / chunkSize);
  for (let i = 0; i < full; i++) s += chunk;
  s += chunk.slice(0, bytes - full * chunkSize);
  return s;
}

function buildStdoutCommand(bytes: number): string {
  // Generate ~`bytes` of printable output in a single command so we measure
  // streaming throughput from the agent without invoking the FS.
  return `head -c ${bytes} /dev/urandom | base64 -w0 | head -c ${bytes}`;
}

function emptyResult(
  provider: string,
  samplesPerOp: number,
  payloadBytes: number,
  extras: Partial<WarmBenchmarkResult>,
): WarmBenchmarkResult {
  return {
    provider,
    mode: 'warm_ops',
    samplesPerOp,
    payloadBytes,
    ops: {},
    ...extras,
  };
}
