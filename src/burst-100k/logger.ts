/**
 * Structured stdout logger — GitHub Actions-style phase markers, timestamped
 * level-tagged lines, no colors (so the file uploaded to Tigris stays clean).
 *
 *   2026-05-14T18:54:25.123Z [info ]  ━━━ burst-100k coordinator starting ━━━
 *   2026-05-14T18:54:25.456Z [info ]  run_id=… provider=e2b
 *   2026-05-14T18:54:26.001Z [ok   ]  sandbox 0 created in 134ms — sandboxId=…
 *   2026-05-14T18:54:31.500Z [stat ]  progress 10/100 (in_flight=0 errors=0) eta ≈54s
 *   2026-05-14T18:55:25.890Z [error]  sandbox 12 network_error: connect ECONNREFUSED
 *   2026-05-14T18:55:25.890Z [info ]  ━━━ run complete ━━━
 */

type Level = 'info' | 'ok' | 'warn' | 'error' | 'stat' | 'debug';

function write(level: Level, msg: string): void {
  const ts = new Date().toISOString();
  const tag = `[${level}]`.padEnd(7);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${ts} ${tag} ${msg}\n`);
}

export const log = {
  info(msg: string): void { write('info', msg); },
  ok(msg: string): void { write('ok', msg); },
  warn(msg: string): void { write('warn', msg); },
  error(msg: string): void { write('error', msg); },
  stat(msg: string): void { write('stat', msg); },
  debug(msg: string): void {
    if (process.env.BURST_100K_DEBUG === '1') write('debug', msg);
  },
  phase(title: string): void { write('info', `━━━ ${title} ━━━`); },
};
