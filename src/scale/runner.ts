import pLimit from 'p-limit';
import { log } from './logger.js';
import type {
  BurstProviderConfig,
  SandboxResult,
  FailureClass,
  ProgressStats,
} from './types.js';

const FIRST_COMMAND_TIMEOUT_MS = 30_000;
const LIVENESS_CHECK_TIMEOUT_MS = 30_000;

export interface RunnerCallbacks {
  onResult: (result: SandboxResult) => Promise<void> | void;
  onProgress: (stats: ProgressStats) => void;
}

/**
 * Run the 100k burst in two coordinated phases so we can distinguish
 * "stayed alive until end-of-test" from "died mid-test":
 *
 *   Phase 1 (per-sandbox, fully parallel):
 *     - call `sandbox.create()`           → on failure: status='failed'
 *     - call `sandbox.runCommand('node -v')` (readiness)
 *                                         → on failure: status='readiness_failed',
 *                                            destroy and emit immediately
 *     - on readiness success: keep the sandbox handle alive; defer emit to phase 2
 *
 *   Phase 2 (kicks off after every phase-1 task has settled):
 *     - for each surviving sandbox: re-run `node -v` as a final liveness probe
 *           → pass: status='success'
 *           → fail: status='partial'  (created OK, died before we got here)
 *     - destroy the sandbox, emit the result
 *
 * `latency_ms` keeps its existing meaning (allocate-phase time, or
 * time-to-failure on create-fail). `completed_at` is set to the moment this
 * sandbox's lifecycle ended (final destroy or earlier failure), so the
 * downstream concurrency-over-time view reflects how long each sandbox was
 * actually held alive — not just how long create took.
 */
export async function runBurst(
  config: BurstProviderConfig,
  compute: any,
  callbacks: RunnerCallbacks,
): Promise<void> {
  const { concurrencyTarget, sandboxOptions, perRequestTimeoutMs = 120_000 } = config;
  const limit = pLimit(concurrencyTarget);

  let done = 0;
  let in_flight = 0;
  let errors = 0;
  const startTime = Date.now();

  // Milestone progress lines every ~10% of work done.
  const progressStep = Math.max(1, Math.floor(concurrencyTarget / 10));
  let nextProgressMilestone = progressStep;

  // Survivors of phase 1 (sandbox handle + partially-filled result). Indexed
  // by sandbox_idx so we can preserve submission-order in phase 2.
  type Pending = { sandbox: any; result: SandboxResult };
  const survivors: Array<Pending | null> = new Array(concurrencyTarget).fill(null);

  /**
   * Emit a finalised result: persist via callbacks, log, decrement in_flight,
   * advance milestones. Called from either phase 1 (failed / readiness_failed)
   * or phase 2 (success / partial).
   */
  const emit = async (result: SandboxResult): Promise<void> => {
    result.completed_at = new Date().toISOString();
    in_flight--;
    done++;
    try { await callbacks.onResult(result); } catch { /* swallow */ }
    callbacks.onProgress({ done, in_flight, errors });

    if (result.status === 'success') {
      const sb = result.provider_metadata?.sandboxId
        ? ` — sandboxId=${result.provider_metadata.sandboxId}`
        : '';
      log.ok(`sandbox ${result.sandbox_idx} success (allocate=${result.latency_ms}ms` +
        (result.first_command_ms != null ? ` ready=${result.first_command_ms}ms` : '') +
        `)${sb}`);
    } else {
      log.error(`sandbox ${result.sandbox_idx} ${result.status} ` +
        `(class=${result.failure_class ?? '-'} http=${result.http_status ?? '-'} ` +
        `code=${result.error_code ?? '-'}): ${result.error_message ?? '(no message)'}`);
    }
    log.data(result);

    if (done >= nextProgressMilestone && done < concurrencyTarget) {
      const elapsedMs = Date.now() - startTime;
      const rate = done / (elapsedMs / 1000);
      const etaSec = (concurrencyTarget - done) / Math.max(rate, 0.001);
      log.stat(
        `progress ${done}/${concurrencyTarget} ` +
        `(in_flight=${in_flight} errors=${errors}) ` +
        `rate=${rate.toFixed(1)}/s eta≈${etaSec.toFixed(0)}s`,
      );
      nextProgressMilestone += progressStep;
    }
  };

  // ─── Phase 1: create + readiness ─────────────────────────────────────────
  const phase1: Promise<void>[] = [];
  for (let idx = 0; idx < concurrencyTarget; idx++) {
    phase1.push(limit(async () => {
      in_flight++;
      const started_at = new Date().toISOString();
      const t0 = performance.now();

      const result: SandboxResult = {
        sandbox_idx: idx,
        started_at,
        completed_at: '',
        latency_ms: 0,
        first_command_ms: null,
        status: 'success', // optimistic; finalized below or in phase 2
        failure_class: null,
        http_status: null,
        error_code: null,
        error_message: null,
        provider_metadata: null,
      };

      let sandbox: any = null;
      try {
        sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), perRequestTimeoutMs);
        result.latency_ms = Math.round(performance.now() - t0);
        result.provider_metadata = extractProviderMetadata(sandbox);
      } catch (err: any) {
        errors++;
        result.status = 'failed';
        result.failure_class = classifyError(err);
        result.http_status = numericHttpStatus(err);
        result.error_code = err?.code ?? null;
        result.error_message = truncate(err?.message ?? String(err), 500);
        result.latency_ms = Math.round(performance.now() - t0);
        await emit(result);
        return;
      }

      // Readiness check — same `node -v` the daily benchmark uses.
      const afterCreate = performance.now();
      try {
        await withTimeout(sandbox.runCommand('node -v'), FIRST_COMMAND_TIMEOUT_MS);
        result.first_command_ms = Math.round(performance.now() - afterCreate);
        // Survived phase 1 — keep alive; phase 2 will finalize and destroy.
        survivors[idx] = { sandbox, result };
      } catch (cmdErr: any) {
        errors++;
        result.status = 'readiness_failed';
        result.failure_class = classifyError(cmdErr);
        result.http_status = numericHttpStatus(cmdErr);
        result.error_code = cmdErr?.code ?? null;
        result.error_message = truncate(cmdErr?.message ?? String(cmdErr), 500);
        // Not usable — destroy now (fire-and-forget) and emit.
        if (sandbox?.destroy) {
          Promise.resolve(sandbox.destroy()).catch(() => {});
        }
        await emit(result);
      }
    }));
  }

  await Promise.all(phase1);

  const survivorCount = survivors.reduce((n, s) => n + (s ? 1 : 0), 0);
  log.phase(`phase 1 complete — ${survivorCount}/${concurrencyTarget} sandboxes alive, ` +
    `holding until end-of-test`);
  log.phase(`phase 2 — running end-of-test liveness check + destroying ${survivorCount} sandboxes`);

  // ─── Phase 2: end-of-test liveness + destroy ─────────────────────────────
  const phase2: Promise<void>[] = [];
  for (let idx = 0; idx < concurrencyTarget; idx++) {
    const pending = survivors[idx];
    if (!pending) continue;
    phase2.push(limit(async () => {
      const { sandbox, result } = pending;
      try {
        await withTimeout(sandbox.runCommand('node -v'), LIVENESS_CHECK_TIMEOUT_MS);
        result.status = 'success';
      } catch (livenessErr: any) {
        errors++;
        result.status = 'partial';
        result.failure_class = classifyError(livenessErr);
        result.http_status = numericHttpStatus(livenessErr);
        result.error_code = livenessErr?.code ?? null;
        result.error_message = truncate(livenessErr?.message ?? String(livenessErr), 500);
      }
      if (sandbox?.destroy) {
        Promise.resolve(sandbox.destroy()).catch(() => {});
      }
      await emit(result);
    }));
  }

  await Promise.all(phase2);
}

/**
 * Pull primitive props off the adapter's returned sandbox object so we can
 * cross-reference against the provider's own dashboards (sandbox id, region,
 * etc.). Skips anything that looks like a credential and any non-primitive
 * value to keep the JSON bounded.
 */
const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|credential)/i;
function extractProviderMetadata(sandbox: any): Record<string, unknown> | null {
  if (!sandbox || typeof sandbox !== 'object') return null;
  const meta: Record<string, unknown> = {};
  for (const key of Object.keys(sandbox)) {
    if (SECRET_KEY_RE.test(key)) continue;
    const val = (sandbox as any)[key];
    if (val == null) continue;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      meta[key] = val;
    }
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function classifyError(err: any): FailureClass {
  const msg = (err?.message ?? '').toString().toLowerCase();
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (typeof (err?.status ?? err?.statusCode) === 'number') return 'http_error';
  return 'network_error';
}

function numericHttpStatus(err: any): number | null {
  const s = err?.status ?? err?.statusCode;
  return typeof s === 'number' ? s : null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
