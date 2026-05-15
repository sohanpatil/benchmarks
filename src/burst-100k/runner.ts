import pLimit from 'p-limit';
import { log } from './logger.js';
import type { BurstProviderConfig, SandboxResult, SandboxResultStatus, ProgressStats } from './types.js';

export interface RunnerCallbacks {
  onResult: (result: SandboxResult) => Promise<void> | void;
  onProgress: (stats: ProgressStats) => void;
}

/**
 * Issue `config.concurrencyTarget` sandbox-creation requests against `compute`,
 * spreading task starts linearly over `config.rampSeconds` (provider-side overload
 * artefacts swamp the signal at true t=0 starts).
 *
 * Each task records a per-request latency; on failure, classifies the error.
 * Sandbox.destroy() is fire-and-forget after the latency is recorded, so it
 * doesn't pollute the measurement.
 */
export async function runBurst(
  config: BurstProviderConfig,
  compute: any,
  callbacks: RunnerCallbacks,
): Promise<void> {
  const { concurrencyTarget, rampSeconds, sandboxOptions, perRequestTimeoutMs = 120_000 } = config;
  const limit = pLimit(concurrencyTarget);

  let done = 0;
  let in_flight = 0;
  let errors = 0;
  const startTime = Date.now();

  // Milestone progress lines every ~10% of work done.
  const progressStep = Math.max(1, Math.floor(concurrencyTarget / 10));
  let nextProgressMilestone = progressStep;

  const tasks: Promise<void>[] = [];
  for (let idx = 0; idx < concurrencyTarget; idx++) {
    const rampDelayMs = Math.floor((idx / concurrencyTarget) * rampSeconds * 1000);

    tasks.push(limit(async () => {
      const waitMs = rampDelayMs - (Date.now() - startTime);
      if (waitMs > 0) await sleep(waitMs);

      in_flight++;
      const started_at = new Date().toISOString();
      const t0 = performance.now();

      const result: SandboxResult = {
        sandbox_idx: idx,
        started_at,
        completed_at: '',
        latency_ms: 0,
        status: 'ok',
        http_status: null,
        error_code: null,
        error_message: null,
        provider_metadata: null,
      };

      let sandbox: any = null;
      try {
        sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), perRequestTimeoutMs);
        result.provider_metadata = extractProviderMetadata(sandbox);
      } catch (err: any) {
        errors++;
        result.status = classifyError(err);
        result.http_status = numericHttpStatus(err);
        result.error_code = err?.code ?? null;
        result.error_message = truncate(err?.message ?? String(err), 500);
      } finally {
        result.latency_ms = Math.round(performance.now() - t0);
        result.completed_at = new Date().toISOString();
        in_flight--;
        done++;
        try { await callbacks.onResult(result); } catch (e) { /* swallow */ }
        callbacks.onProgress({ done, in_flight, errors });

        // Per-sandbox log line — every sandbox at every N, plus every error.
        if (result.status === 'ok') {
          const sb = result.provider_metadata?.sandboxId
            ? ` — sandboxId=${result.provider_metadata.sandboxId}`
            : '';
          log.ok(`sandbox ${idx} created in ${result.latency_ms}ms${sb}`);
        } else {
          log.error(`sandbox ${idx} ${result.status} (http=${result.http_status ?? '-'} ` +
            `code=${result.error_code ?? '-'}): ${result.error_message ?? '(no message)'}`);
        }

        // Milestone progress lines (~10% increments)
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

        // Fire-and-forget destroy. The sandbox auto-destroys on its own
        // timeoutMs too; this is just a courtesy cleanup.
        if (sandbox?.destroy) {
          Promise.resolve(sandbox.destroy()).catch(() => {});
        }
      }
    }));
  }

  await Promise.all(tasks);
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

function classifyError(err: any): SandboxResultStatus {
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
