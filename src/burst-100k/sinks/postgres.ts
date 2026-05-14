import pg from 'pg';
import type { SandboxResult, ProgressStats, FinalStats } from '../types.js';

const { Client } = pg;

const BATCH_SIZE = 1000;
const BATCH_TIMEOUT_MS = 2000;

export class PostgresSink {
  private client: InstanceType<typeof Client>;
  private runId: string;
  private buffer: SandboxResult[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(connectionString: string, runId: string) {
    this.client = new Client({ connectionString });
    this.runId = runId;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  /**
   * Idempotently create the 'running' row for this run. Safe to call even if
   * launch.sh has already inserted the row — ON CONFLICT DO NOTHING.
   */
  async bootstrap(provider: string, commit_sha: string, instance_id: string, tigris_prefix: string): Promise<void> {
    await this.client.query(
      `INSERT INTO runs (id, provider, commit_sha, instance_id, started_at, status, tigris_prefix)
       VALUES ($1, $2, $3, $4, now(), 'running', $5)
       ON CONFLICT (id) DO NOTHING`,
      [this.runId, provider, commit_sha, instance_id, tigris_prefix],
    );
  }

  async write(result: SandboxResult): Promise<void> {
    this.buffer.push(result);
    if (this.buffer.length >= BATCH_SIZE) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch(err => console.error('[pg] timed flush failed:', err.message));
      }, BATCH_TIMEOUT_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.inFlight) await this.inFlight;
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    this.inFlight = this.doFlush(batch);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async doFlush(batch: SandboxResult[]): Promise<void> {
    const values: any[] = [];
    const placeholders: string[] = [];
    let pi = 1;
    for (const r of batch) {
      placeholders.push(
        `($${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++}, $${pi++})`,
      );
      values.push(
        this.runId,
        r.sandbox_idx,
        r.started_at,
        r.completed_at,
        r.latency_ms,
        r.status,
        r.http_status,
        r.error_code,
        r.provider_metadata == null ? null : JSON.stringify(r.provider_metadata),
      );
    }
    const sql = `
      INSERT INTO sandbox_results
        (run_id, sandbox_idx, started_at, completed_at, latency_ms, status, http_status, error_code, provider_metadata)
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (run_id, sandbox_idx) DO NOTHING
    `;
    await this.client.query(sql, values);
  }

  async heartbeat(_stats: ProgressStats): Promise<void> {
    await this.client.query(`UPDATE runs SET last_heartbeat = now() WHERE id = $1`, [this.runId]);
  }

  async complete(stats: FinalStats): Promise<void> {
    await this.client.query(
      `UPDATE runs
       SET status = 'done',
           ended_at = now(),
           last_heartbeat = now(),
           sandboxes_attempted = $2,
           sandboxes_succeeded = $3,
           timeouts = $4,
           http_errors = $5,
           network_errors = $6,
           p50_latency_ms = $7,
           p99_latency_ms = $8
       WHERE id = $1`,
      [
        this.runId,
        stats.sandboxes_attempted,
        stats.sandboxes_succeeded,
        stats.timeouts,
        stats.http_errors,
        stats.network_errors,
        stats.p50_latency_ms,
        stats.p99_latency_ms,
      ],
    );
  }

  async fail(message: string): Promise<void> {
    await this.client.query(
      `UPDATE runs SET status = 'failed', ended_at = now(), error_message = $2 WHERE id = $1`,
      [this.runId, message.slice(0, 4000)],
    );
  }

  async close(): Promise<void> {
    await this.flush();
    await this.client.end();
  }
}
