import { declaw } from '@computesdk/declaw';
import { e2b } from '@computesdk/e2b';
import { modal } from '@computesdk/modal';
import { runloop } from '@computesdk/runloop';
import { tensorlake } from '@computesdk/tensorlake';
import type { BurstProviderConfig } from './types.js';

/**
 * Providers opted into the 100k burst benchmark.
 *
 * A provider participates iff it has an entry here. This mirrors the
 * convention in src/sandbox/providers.ts; presence is the opt-in signal.
 */
export const providers: BurstProviderConfig[] = [
  {
    name: 'e2b',
    requiredEnvVars: ['E2B_API_KEY'],
    createCompute: () => e2b({ apiKey: process.env.E2B_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    // timeoutMs auto-destroys sandbox after this duration; avoids leaking
    // 100k live sandboxes if we don't explicitly destroy each one.
    sandboxOptions: { timeoutMs: 60_000 },
  },
  {
    name: 'modal',
    requiredEnvVars: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    createCompute: () => modal({
      tokenId: process.env.MODAL_TOKEN_ID!,
      tokenSecret: process.env.MODAL_TOKEN_SECRET!,
    }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
    // Modal adapter doesn't expose a sandbox-level timeoutMs option; the
    // runner's fire-and-forget destroy after recording latency is what
    // cleans up. Worth re-verifying at full 100k scale.
  },
  {
    name: 'runloop',
    requiredEnvVars: ['RUNLOOP_API_KEY'],
    createCompute: () => runloop({ apiKey: process.env.RUNLOOP_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
  },
  {
    name: 'tensorlake',
    requiredEnvVars: ['TENSORLAKE_API_KEY'],
    createCompute: () => tensorlake({ apiKey: process.env.TENSORLAKE_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
  },
  {
    name: 'declaw',
    requiredEnvVars: ['DECLAW_API_KEY'],
    createCompute: () => declaw({ apiKey: process.env.DECLAW_API_KEY! }),
    concurrencyTarget: 100_000,
    perRequestTimeoutMs: 120_000,
  },
];

export function getProvider(name: string): BurstProviderConfig {
  const found = providers.find(p => p.name === name);
  if (!found) {
    const available = providers.map(p => p.name).join(', ');
    throw new Error(`Provider not opted in: ${name}. Available: ${available}`);
  }
  return found;
}
