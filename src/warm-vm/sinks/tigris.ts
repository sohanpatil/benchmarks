import { tigris } from '@computesdk/tigris';

/**
 * Minimal Tigris sink for the warm-ops coordinator.
 *
 * Layout written per run:
 *   <run_id>/results.json      — accumulated results, rewritten after each provider
 *   <run_id>/coordinator.log   — captured stdout, uploaded on heartbeat + at end
 *   <run_id>/done.json         — completion marker; collector polls for this
 */
export class WarmTigrisSink {
  private storage: ReturnType<typeof tigris>;
  private bucket: string;
  private prefix: string;

  constructor(config: {
    endpoint?: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  }, runId: string) {
    this.storage = tigris({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    this.bucket = config.bucket;
    this.prefix = `warm-ops/${runId}/`;
  }

  get tigrisPrefix(): string {
    return `s3://${this.bucket}/${this.prefix}`;
  }

  async writeResults(payload: unknown): Promise<void> {
    await this.storage.upload(
      this.bucket,
      `${this.prefix}results.json`,
      Buffer.from(JSON.stringify(payload, null, 2)),
    );
  }

  async writeLog(content: string): Promise<void> {
    await this.storage.upload(
      this.bucket,
      `${this.prefix}coordinator.log`,
      Buffer.from(content),
    );
  }

  async writeDone(summary: unknown): Promise<void> {
    await this.storage.upload(
      this.bucket,
      `${this.prefix}done.json`,
      Buffer.from(JSON.stringify(summary, null, 2)),
    );
  }
}
