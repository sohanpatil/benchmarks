import fs from 'fs';
import os from 'os';
import type { ProviderConfig, Stats } from './types.js';
import { computeStats } from '../util/stats.js';
import { withTimeout } from '../util/timeout.js';
import { randomUUID } from 'node:crypto';

export interface ReliabilityOptions {
  samples?: number;
  durationMs?: number;
  intervalMs?: number;
  probeProfile?: ProbeProfile;
}

export interface ReliabilityProbeResult {
  [key: string]: string | number | boolean | undefined;
}

export interface ReliabilityIteration {
  startedAt: string;
  createMs: number;
  probeMs: number;
  totalMs: number;
  probes: ReliabilityProbeResult;
  error?: string;
}

export interface ReliabilityBenchmarkResult {
  provider: string;
  mode: ProbeProfile;
  iterations: ReliabilityIteration[];
  summary: {
    availability: number;
    status: 'healthy' | 'degraded' | 'outage';
    failures: number;
    longestFailureStreak: number;
    outageEvents: ReliabilityOutageEvent[];
    featureMatrix: Record<string, ReliabilityFeatureSummary>;
    totalMs: Stats;
    createMs: Stats;
    probeMs: Stats;
    fsIsolationFailures: number;
    processIsolationFailures: number;
  };
  skipped?: boolean;
  skipReason?: string;
}

export interface ReliabilityFeatureSummary {
  supportedSamples: number;
  totalSamples: number;
  supportRate: number;
}

const FEATURE_KEYS = [
  'shell',
  'hasNode',
  'hasPython',
  'hasGit',
  'hasCurl',
  'hasWget',
  'hasNpm',
  'hasPnpm',
  'hasYarn',
  'hasPip',
  'hasUv',
  'hasApt',
  'hasApk',
  'hasDnf',
  'hasCargo',
  'hasGo',
  'hasDocker',
  'dockerUsable',
  'tmpWrite',
  'tmpRead',
  'varTmpWrite',
  'homeWrite',
  'cwdWrite',
  'devShmWrite',
  'dnsExample',
  'httpExample',
  'tcpExample',
  'udpDns',
  'localhostTcp',
  'perfProbeOk',
  'fsIsolationOk',
  'processIsolationOk',
] as const;

export interface ReliabilityOutageEvent {
  startedAt: string;
  endedAt: string;
  samples: number;
  errors: string[];
}

type RunCommandResult = { exitCode: number; stdout?: string; stderr?: string };
type ProbeProfile = 'reliability' | 'features';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_SAMPLES = 1;
const PROBE_TIMEOUT_MS = 30_000;

export async function runReliabilityBenchmark(
  config: ProviderConfig,
  options: ReliabilityOptions = {},
): Promise<ReliabilityBenchmarkResult> {
  const { name, timeout = 120_000, requiredEnvVars, sandboxOptions, destroyTimeoutMs } = config;
  const probeProfile = options.probeProfile ?? 'reliability';
  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    return {
      provider: name,
      mode: probeProfile,
      iterations: [],
      summary: emptySummary(),
      skipped: true,
      skipReason: `Missing: ${missingVars.join(', ')}`,
    };
  }

  const compute = config.createCompute();
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = options.durationMs ? Date.now() + options.durationMs : undefined;
  const runId = randomUUID().split('-').join('');
  const iterations: ReliabilityIteration[] = [];

  console.log(`\n--- ${probeProfile === 'features' ? 'Feature matrix' : 'Reliability'} benchmarking: ${name} ---`);
  console.log(`  Samples: ${deadline ? `until ${new Date(deadline).toISOString()}` : samples}`);
  console.log(`  Interval: ${(intervalMs / 1000).toFixed(1)}s`);

  for (let i = 0; shouldRunSample(i, samples, deadline); i++) {
    if (i > 0 && intervalMs > 0) {
      await sleepUntilNextSample(intervalMs, deadline);
      if (deadline && Date.now() >= deadline) break;
    }

    console.log(`  Sample ${i + 1}...`);
    const result = await runReliabilityIteration(
      compute,
      timeout,
      sandboxOptions,
      destroyTimeoutMs,
      `${runId}_${i}`,
      i > 0 ? `${runId}_${i - 1}` : undefined,
      probeProfile,
    );
    iterations.push(result);

    if (result.error) {
      console.log(`    FAILED: ${result.error}`);
    } else {
      console.log(`    OK: ${(result.totalMs / 1000).toFixed(2)}s`);
    }
  }

  return {
    provider: name,
    mode: probeProfile,
    iterations,
    summary: summarize(iterations),
  };
}

export async function runFeatureMatrixBenchmark(
  config: ProviderConfig,
  options: Omit<ReliabilityOptions, 'probeProfile'> = {},
): Promise<ReliabilityBenchmarkResult> {
  return runReliabilityBenchmark(config, { ...options, probeProfile: 'features' });
}

async function runReliabilityIteration(
  compute: any,
  timeout: number,
  sandboxOptions: Record<string, any> | undefined,
  destroyTimeoutMs: number = 15_000,
  markerToken: string,
  previousMarkerToken?: string,
  probeProfile: ProbeProfile = 'reliability',
): Promise<ReliabilityIteration> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let sandbox: any = null;
  let createMs = 0;
  let probeMs = 0;
  let probes: ReliabilityProbeResult = {};

  try {
    const createStart = performance.now();
    sandbox = await withTimeout(compute.sandbox.create(sandboxOptions), timeout, 'Sandbox creation timed out');
    createMs = performance.now() - createStart;

    const probeStart = performance.now();
    const probe = await withTimeout(
      sandbox.runCommand(buildProbeCommand(markerToken, previousMarkerToken, probeProfile)),
      PROBE_TIMEOUT_MS,
      `${probeProfile === 'features' ? 'Feature matrix' : 'Reliability'} probe timed out`,
    ) as RunCommandResult;
    probeMs = performance.now() - probeStart;

    probes = parseProbeOutput(probe.stdout || '');
    const totalMs = performance.now() - start;

    if (probe.exitCode !== 0) {
      throw new Error(`Reliability probe failed with exit code ${probe.exitCode}: ${probe.stderr || 'Unknown error'}`);
    }
    if (probeProfile === 'features' && probes.fsIsolationOk === false) {
      throw new Error(`Filesystem isolation failed: previous marker at ${probes.previousFsMarkerPath}`);
    }
    if (probeProfile === 'features' && probes.processIsolationOk === false) {
      throw new Error('Process isolation failed: previous in-memory marker process is visible');
    }

    return { startedAt, createMs, probeMs, totalMs, probes };
  } catch (err) {
    return {
      startedAt,
      createMs,
      probeMs,
      totalMs: performance.now() - start,
      probes,
      error: err instanceof Error ? err.message : String(err),
    };
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

function buildProbeCommand(markerToken: string, previousMarkerToken?: string, probeProfile: ProbeProfile = 'reliability'): string {
  if (probeProfile === 'reliability') return buildReliabilityProbeCommand();

  const fsMarker = '/tmp/.computesdk_reliability_fs_marker';
  const varTmpMarker = '/var/tmp/.computesdk_reliability_fs_marker';
  const processMarker = `computesdk_reliability_process_${markerToken}`;
  const previousProcessMarker = previousMarkerToken ? `computesdk_reliability_process_${previousMarkerToken}` : '';
  const token = shellQuote(markerToken);
  const processToken = shellQuote(processMarker);
  const previousProcessToken = shellQuote(previousProcessMarker);
  const perfScript = Buffer.from(buildPerfScript()).toString('base64');
  const perfCommand = shellQuote(`eval(Buffer.from('${perfScript}', 'base64').toString())`);

  return [
    'set +e',
    `token=${token}`,
    `process_marker=${processToken}`,
    `previous_process_marker=${previousProcessToken}`,
    `fs_marker=${shellQuote(fsMarker)}`,
    `var_tmp_marker=${shellQuote(varTmpMarker)}`,
    'previous_fs_marker_path=',
    'previous_fs_marker_value=',
    'for p in "$fs_marker" "$var_tmp_marker"; do if [ -f "$p" ]; then previous_fs_marker_path=$p; previous_fs_marker_value=$(tr -d "\\n" < "$p" 2>/dev/null || true); break; fi; done',
    'process_marker_seen=false',
    'process_isolation_ok=',
    'if [ -n "$previous_process_marker" ] && command -v ps >/dev/null 2>&1; then ps_output=$(ps axww 2>/dev/null || ps auxww 2>/dev/null || true); case "$ps_output" in *"$previous_process_marker"*) process_marker_seen=true;; esac; if [ "$process_marker_seen" = false ]; then process_isolation_ok=true; else process_isolation_ok=false; fi; fi',
    'tmp_write=false; tmp_read=false; tmp_file=/tmp/computesdk_reliability_probe_$$; printf "%s" "$token" > "$tmp_file" 2>/dev/null && tmp_write=true; [ "$(cat "$tmp_file" 2>/dev/null)" = "$token" ] && tmp_read=true; rm -f "$tmp_file" 2>/dev/null',
    'var_tmp_write=false; var_tmp_file=/var/tmp/computesdk_reliability_probe_$$; printf "%s" "$token" > "$var_tmp_file" 2>/dev/null && var_tmp_write=true; rm -f "$var_tmp_file" 2>/dev/null',
    'home_write=false; home_file="$HOME/.computesdk_reliability_probe_$$"; if [ -n "$HOME" ]; then printf "%s" "$token" > "$home_file" 2>/dev/null && home_write=true; rm -f "$home_file" 2>/dev/null; fi',
    'cwd_write=false; cwd_file="./.computesdk_reliability_probe_$$"; printf "%s" "$token" > "$cwd_file" 2>/dev/null && cwd_write=true; rm -f "$cwd_file" 2>/dev/null',
    'dev_shm_write=false; if [ -d /dev/shm ]; then shm_file=/dev/shm/computesdk_reliability_probe_$$; printf "%s" "$token" > "$shm_file" 2>/dev/null && dev_shm_write=true; rm -f "$shm_file" 2>/dev/null; fi',
    'dns_example=false; (getent hosts example.com >/dev/null 2>&1 || nslookup example.com >/dev/null 2>&1 || host example.com >/dev/null 2>&1) && dns_example=true',
    'http_example=false; (curl -fsS --max-time 5 https://example.com >/dev/null 2>&1 || wget -q -T 5 -O /dev/null https://example.com >/dev/null 2>&1) && http_example=true',
    'mem_total_kb=$(awk "/MemTotal/ {print \\$2}" /proc/meminfo 2>/dev/null || true)',
    'cpu_count=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || true)',
    'disk_free_kb=$(df -Pk /tmp 2>/dev/null | awk "NR==2 {print \\$4}" || true)',
    'uname_value=$(uname -a 2>/dev/null || true)',
    'node_version=$(node -v 2>/dev/null || true)',
    'python_version=$(python3 --version 2>/dev/null || python --version 2>/dev/null || true)',
    'git_version=$(git --version 2>/dev/null || true)',
    'npm_version=$(npm --version 2>/dev/null || true)',
    'pnpm_version=$(pnpm --version 2>/dev/null || true)',
    'yarn_version=$(yarn --version 2>/dev/null || true)',
    'pip_version=$(pip3 --version 2>/dev/null || pip --version 2>/dev/null || true)',
    'uv_version=$(uv --version 2>/dev/null || true)',
    'apt_version=$(apt-get --version 2>/dev/null | sed -n "1p" || apt --version 2>/dev/null | sed -n "1p" || true)',
    'apk_version=$(apk --version 2>/dev/null | sed -n "1p" || true)',
    'dnf_version=$(dnf --version 2>/dev/null | sed -n "1p" || true)',
    'cargo_version=$(cargo --version 2>/dev/null || true)',
    'go_version=$(go version 2>/dev/null || true)',
    'docker_version=$(docker --version 2>/dev/null || true)',
    'docker_usable=false; if [ -n "$docker_version" ] && docker version >/dev/null 2>&1; then docker_usable=true; fi',
    `if [ -n "$node_version" ]; then node -e ${perfCommand} 2>/dev/null || printf "perfProbeOk=false\\n"; else printf "perfProbeOk=false\\n"; fi`,
    'printf "%s" "$token" > "$fs_marker" 2>/dev/null || true',
    'printf "%s" "$token" > "$var_tmp_marker" 2>/dev/null || true',
    '(sh -c "while true; do sleep 300; done" "$process_marker" >/dev/null 2>&1 &)',
    'printf "shell=true\\n"',
    'printf "hasNode=%s\\n" "$([ -n "$node_version" ] && printf true || printf false)"',
    'printf "hasPython=%s\\n" "$([ -n "$python_version" ] && printf true || printf false)"',
    'printf "hasGit=%s\\n" "$([ -n "$git_version" ] && printf true || printf false)"',
    'printf "hasCurl=%s\\n" "$(command -v curl >/dev/null 2>&1 && printf true || printf false)"',
    'printf "hasWget=%s\\n" "$(command -v wget >/dev/null 2>&1 && printf true || printf false)"',
    'printf "hasNpm=%s\\n" "$([ -n "$npm_version" ] && printf true || printf false)"',
    'printf "hasPnpm=%s\\n" "$([ -n "$pnpm_version" ] && printf true || printf false)"',
    'printf "hasYarn=%s\\n" "$([ -n "$yarn_version" ] && printf true || printf false)"',
    'printf "hasPip=%s\\n" "$([ -n "$pip_version" ] && printf true || printf false)"',
    'printf "hasUv=%s\\n" "$([ -n "$uv_version" ] && printf true || printf false)"',
    'printf "hasApt=%s\\n" "$([ -n "$apt_version" ] && printf true || printf false)"',
    'printf "hasApk=%s\\n" "$([ -n "$apk_version" ] && printf true || printf false)"',
    'printf "hasDnf=%s\\n" "$([ -n "$dnf_version" ] && printf true || printf false)"',
    'printf "hasCargo=%s\\n" "$([ -n "$cargo_version" ] && printf true || printf false)"',
    'printf "hasGo=%s\\n" "$([ -n "$go_version" ] && printf true || printf false)"',
    'printf "hasDocker=%s\\n" "$([ -n "$docker_version" ] && printf true || printf false)"',
    'printf "dockerUsable=%s\\n" "$docker_usable"',
    'printf "tmpWrite=%s\\n" "$tmp_write"',
    'printf "tmpRead=%s\\n" "$tmp_read"',
    'printf "varTmpWrite=%s\\n" "$var_tmp_write"',
    'printf "homeWrite=%s\\n" "$home_write"',
    'printf "cwdWrite=%s\\n" "$cwd_write"',
    'printf "devShmWrite=%s\\n" "$dev_shm_write"',
    'printf "dnsExample=%s\\n" "$dns_example"',
    'printf "httpExample=%s\\n" "$http_example"',
    'printf "fsIsolationOk=%s\\n" "$([ -z "$previous_fs_marker_path" ] && printf true || printf false)"',
    'if [ -n "$process_isolation_ok" ]; then printf "processIsolationOk=%s\\n" "$process_isolation_ok"; fi',
    'printf "previousFsMarkerPath=%s\\n" "$previous_fs_marker_path"',
    'printf "previousFsMarkerValue=%s\\n" "$previous_fs_marker_value"',
    'printf "memTotalKb=%s\\n" "$mem_total_kb"',
    'printf "cpuCount=%s\\n" "$cpu_count"',
    'printf "diskFreeKb=%s\\n" "$disk_free_kb"',
    'printf "uname=%s\\n" "$uname_value"',
    'printf "nodeVersion=%s\\n" "$node_version"',
    'printf "pythonVersion=%s\\n" "$python_version"',
    'printf "gitVersion=%s\\n" "$git_version"',
    'printf "npmVersion=%s\\n" "$npm_version"',
    'printf "pnpmVersion=%s\\n" "$pnpm_version"',
    'printf "yarnVersion=%s\\n" "$yarn_version"',
    'printf "pipVersion=%s\\n" "$pip_version"',
    'printf "uvVersion=%s\\n" "$uv_version"',
    'printf "aptVersion=%s\\n" "$apt_version"',
    'printf "apkVersion=%s\\n" "$apk_version"',
    'printf "dnfVersion=%s\\n" "$dnf_version"',
    'printf "cargoVersion=%s\\n" "$cargo_version"',
    'printf "goVersion=%s\\n" "$go_version"',
    'printf "dockerVersion=%s\\n" "$docker_version"',
  ].join('; ');
}

function buildReliabilityProbeCommand(): string {
  return [
    'set +e',
    'started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)',
    'node_version=$(node -v 2>/dev/null || true)',
    'printf "commandOk=true\\n"',
    'printf "shell=true\\n"',
    'printf "hasNode=%s\\n" "$([ -n "$node_version" ] && printf true || printf false)"',
    'printf "nodeVersion=%s\\n" "$node_version"',
    'printf "sandboxTime=%s\\n" "$started_at"',
  ].join('; ');
}

function buildPerfScript(): string {
  return `
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

function emit(key, value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = Math.round(value * 100) / 100;
  process.stdout.write(key + '=' + String(value) + '\\n');
}

async function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      const ms = performance.now() - started;
      socket.destroy();
      resolve({ ok, ms });
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function udpDns(timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = dgram.createSocket('udp4');
    const query = Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001', 'hex');
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      const ms = performance.now() - started;
      socket.close();
      resolve({ ok, ms });
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('message', () => { clearTimeout(timer); done(true); });
    socket.once('error', () => { clearTimeout(timer); done(false); });
    socket.send(query, 53, '1.1.1.1');
  });
}

async function localhostTcp(timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    const server = net.createServer((socket) => socket.end('ok'));
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      const ms = performance.now() - started;
      server.close(() => resolve({ ok, ms }));
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    server.once('error', () => { clearTimeout(timer); resolve({ ok: false, ms: performance.now() - started }); });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); done(true); });
      socket.once('error', () => { clearTimeout(timer); done(false); });
    });
  });
}

(async () => {
  try {
    const cpuBuffer = Buffer.alloc(1024, 7);
    let started = performance.now();
    for (let i = 0; i < 5000; i++) crypto.createHash('sha256').update(cpuBuffer).digest();
    const cpuMs = performance.now() - started;
    emit('cpuSha256Ms', cpuMs);
    emit('cpuSha256OpsPerSecond', 5000 / (cpuMs / 1000));

    started = performance.now();
    const memoryBuffer = Buffer.alloc(8 * 1024 * 1024);
    memoryBuffer.fill(3);
    let checksum = 0;
    for (let i = 0; i < memoryBuffer.length; i += 4096) checksum += memoryBuffer[i];
    emit('memoryFill8MbMs', performance.now() - started);
    emit('memoryChecksum', checksum);

    const dir = '/tmp/computesdk_perf_' + process.pid + '_' + Date.now();
    fs.mkdirSync(dir, { recursive: true });
    const oneMb = Buffer.alloc(1024 * 1024, 5);
    const file = dir + '/one_mb.bin';
    started = performance.now();
    fs.writeFileSync(file, oneMb);
    emit('fsWrite1MbMs', performance.now() - started);
    started = performance.now();
    fs.readFileSync(file);
    emit('fsRead1MbMs', performance.now() - started);
    started = performance.now();
    for (let i = 0; i < 50; i++) fs.writeFileSync(dir + '/small_' + i, 'x');
    for (let i = 0; i < 50; i++) fs.readFileSync(dir + '/small_' + i);
    for (let i = 0; i < 50; i++) fs.unlinkSync(dir + '/small_' + i);
    emit('fsSmallFiles50Ms', performance.now() - started);
    fs.rmSync(dir, { recursive: true, force: true });

    const tcp = await tcpConnect('example.com', 443, 5000);
    emit('tcpExample', tcp.ok);
    emit('tcpExampleMs', tcp.ms);
    const udp = await udpDns(5000);
    emit('udpDns', udp.ok);
    emit('udpDnsMs', udp.ms);
    const local = await localhostTcp(5000);
    emit('localhostTcp', local.ok);
    emit('localhostTcpMs', local.ms);
    emit('perfProbeOk', true);
  } catch (error) {
    emit('perfProbeOk', false);
    emit('perfProbeError', error && error.message ? error.message : String(error));
  }
})();
`;
}

function parseProbeOutput(stdout: string): ReliabilityProbeResult {
  const parsed: ReliabilityProbeResult = {};
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const raw = line.slice(index + 1).trim();
    if (raw === 'true') parsed[key] = true;
    else if (raw === 'false') parsed[key] = false;
    else if (/^\d+(\.\d+)?$/.test(raw)) parsed[key] = Number(raw);
    else parsed[key] = raw;
  }
  return parsed;
}

function summarize(iterations: ReliabilityIteration[]): ReliabilityBenchmarkResult['summary'] {
  const successful = iterations.filter(i => !i.error);
  const stats = successful.length > 0
    ? {
      totalMs: computeStats(successful.map(i => i.totalMs)),
      createMs: computeStats(successful.map(i => i.createMs)),
      probeMs: computeStats(successful.map(i => i.probeMs)),
    }
    : {
      totalMs: zeroStats(),
      createMs: zeroStats(),
      probeMs: zeroStats(),
    };

  return {
    availability: iterations.length === 0 ? 0 : successful.length / iterations.length,
    status: computeStatus(iterations),
    failures: iterations.length - successful.length,
    longestFailureStreak: computeLongestFailureStreak(iterations),
    outageEvents: computeOutageEvents(iterations),
    featureMatrix: computeFeatureMatrix(iterations),
    ...stats,
    fsIsolationFailures: iterations.filter(i => i.probes.fsIsolationOk === false).length,
    processIsolationFailures: iterations.filter(i => i.probes.processIsolationOk === false).length,
  };
}

function emptySummary(): ReliabilityBenchmarkResult['summary'] {
  return {
    availability: 0,
    status: 'outage',
    failures: 0,
    longestFailureStreak: 0,
    outageEvents: [],
    featureMatrix: {},
    totalMs: zeroStats(),
    createMs: zeroStats(),
    probeMs: zeroStats(),
    fsIsolationFailures: 0,
    processIsolationFailures: 0,
  };
}

function computeFeatureMatrix(iterations: ReliabilityIteration[]): Record<string, ReliabilityFeatureSummary> {
  const matrix: Record<string, ReliabilityFeatureSummary> = {};

  for (const key of FEATURE_KEYS) {
    const samples = iterations.filter(i => typeof i.probes[key] === 'boolean');
    const supportedSamples = samples.filter(i => i.probes[key] === true).length;
    matrix[key] = {
      supportedSamples,
      totalSamples: samples.length,
      supportRate: samples.length === 0 ? 0 : supportedSamples / samples.length,
    };
  }

  return matrix;
}

function computeStatus(iterations: ReliabilityIteration[]): ReliabilityBenchmarkResult['summary']['status'] {
  if (iterations.length === 0) return 'outage';
  const failures = iterations.filter(i => i.error).length;
  if (failures === 0) return 'healthy';
  if (failures === iterations.length) return 'outage';
  return 'degraded';
}

function computeLongestFailureStreak(iterations: ReliabilityIteration[]): number {
  let longest = 0;
  let current = 0;
  for (const iteration of iterations) {
    if (iteration.error) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function computeOutageEvents(iterations: ReliabilityIteration[]): ReliabilityOutageEvent[] {
  const events: ReliabilityOutageEvent[] = [];
  let current: ReliabilityOutageEvent | undefined;

  for (const iteration of iterations) {
    if (!iteration.error) {
      current = undefined;
      continue;
    }

    if (!current) {
      current = {
        startedAt: iteration.startedAt,
        endedAt: iteration.startedAt,
        samples: 0,
        errors: [],
      };
      events.push(current);
    }

    current.endedAt = iteration.startedAt;
    current.samples++;
    if (!current.errors.includes(iteration.error)) {
      current.errors.push(iteration.error);
    }
  }

  return events;
}

function zeroStats(): Stats {
  return { median: 0, p95: 0, p99: 0 };
}

function shouldRunSample(index: number, samples: number, deadline?: number): boolean {
  if (deadline) return Date.now() < deadline;
  return index < samples;
}

async function sleepUntilNextSample(intervalMs: number, deadline?: number): Promise<void> {
  const delay = deadline ? Math.min(intervalMs, Math.max(0, deadline - Date.now())) : intervalMs;
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function printReliabilityResultsTable(results: ReliabilityBenchmarkResult[]): void {
  const title = results.some(r => r.mode === 'features')
    ? 'SANDBOX FEATURE MATRIX RESULTS'
    : 'SANDBOX RELIABILITY BENCHMARK RESULTS';
  console.log(`\n${'='.repeat(100)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(100));
  console.log(['Provider', 'State', 'Availability', 'Median Total', 'Median Create', 'Failures', 'Status']
    .map((h, i) => h.padEnd([14, 10, 14, 14, 14, 10, 10][i]))
    .join(' | '));
  console.log([14, 10, 14, 14, 14, 10, 10].map(w => '-'.repeat(w)).join('-+-'));

  for (const result of [...results].sort((a, b) => b.summary.availability - a.summary.availability)) {
    if (result.skipped) {
      console.log([result.provider.padEnd(14), '--'.padEnd(10), '--'.padEnd(14), '--'.padEnd(14), '--'.padEnd(14), '--'.padEnd(10), 'SKIPPED'.padEnd(10)].join(' | '));
      continue;
    }
    const ok = result.iterations.filter(i => !i.error).length;
    const total = result.iterations.length;
    console.log([
      result.provider.padEnd(14),
      result.summary.status.padEnd(10),
      `${(result.summary.availability * 100).toFixed(1)}%`.padEnd(14),
      `${(result.summary.totalMs.median / 1000).toFixed(2)}s`.padEnd(14),
      `${(result.summary.createMs.median / 1000).toFixed(2)}s`.padEnd(14),
      String(result.summary.failures).padEnd(10),
      `${ok}/${total} OK`.padEnd(10),
    ].join(' | '));
  }
  console.log('='.repeat(100));
}

export async function writeReliabilityResultsJson(
  results: ReliabilityBenchmarkResult[],
  outPath: string,
  config: Record<string, unknown> = {},
): Promise<void> {
  const cleanResults = results.map(r => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map(i => ({
      startedAt: i.startedAt,
      createMs: round(i.createMs),
      probeMs: round(i.probeMs),
      totalMs: round(i.totalMs),
      probes: i.probes,
      ...(i.error ? { error: i.error } : {}),
    })),
    summary: {
      availability: round(r.summary.availability),
      status: r.summary.status,
      failures: r.summary.failures,
      longestFailureStreak: r.summary.longestFailureStreak,
      outageEvents: r.summary.outageEvents,
      featureMatrix: Object.fromEntries(
        Object.entries(r.summary.featureMatrix).map(([key, value]) => [
          key,
          {
            supportedSamples: value.supportedSamples,
            totalSamples: value.totalSamples,
            supportRate: round(value.supportRate),
          },
        ]),
      ),
      totalMs: roundStats(r.summary.totalMs),
      createMs: roundStats(r.summary.createMs),
      probeMs: roundStats(r.summary.probeMs),
      fsIsolationFailures: r.summary.fsIsolationFailures,
      processIsolationFailures: r.summary.processIsolationFailures,
    },
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config,
    results: cleanResults,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}

function roundStats(stats: Stats): Stats {
  return {
    median: round(stats.median),
    p95: round(stats.p95),
    p99: round(stats.p99),
  };
}
