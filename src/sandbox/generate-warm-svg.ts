import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { WarmBenchmarkResult, WarmOpName } from './warm-types.js';
import { computeWarmCompositeScores, sortWarmByCompositeScore } from './warm-scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const RESULTS_DIR = path.join(ROOT, 'results');
const SPONSORS_DIR_TIER1 = path.join(ROOT, 'sponsors', 'tier-1');
const SPONSORS_DIR_TIER2 = path.join(ROOT, 'sponsors', 'tier-2');

const LOGO_C_PATH = `M1036.26,1002.28h237.87l-.93,19.09c-8.38,110.32-49.81,198.3-123.82,262.07-73.09,63.31-170.84,95.43-290.48,95.43-130.81,0-235.55-44.69-311.43-133.6-74.48-87.98-112.65-209.48-112.65-361.23v-60.51c0-96.83,17.7-183.41,51.68-257.43,34.91-74.95,85.19-133.61,149.89-173.63,64.7-40.04,140.12-60.52,225.3-60.52,117.77,0,214.13,32.12,286.29,95.9,72.62,63.3,114.98,153.61,126.15,267.67l1.86,19.08h-238.34l-.93-15.83c-4.65-59.11-20.95-101.94-47.95-127.08-27-25.6-69.83-38.17-127.08-38.17-61.91,0-107.06,20.95-137.33,65.17-31.65,45.15-47.94,117.77-48.87,215.53v74.48c0,102.41,15.36,177.83,45.62,223.91,28.86,44.22,74.01,65.63,137.79,65.63,58.19,0,101.48-12.57,128.95-38.17,26.99-25.14,43.29-66.1,47.48-121.5l.93-16.3Z`;

const OP_ORDER: WarmOpName[] = [
  'runCommand_noop',
  'writeFile_1mb',
  'readFile_1mb',
  'readdir',
  'runCommand_1mb_stdout',
];

const OP_LABELS: Record<WarmOpName, string> = {
  runCommand_noop: 'cmd RTT',
  writeFile_1mb: 'write 1MB',
  readFile_1mb: 'read 1MB',
  readdir: 'readdir',
  runCommand_1mb_stdout: 'stdout 1MB',
};

// Per-op color thresholds in ms (median). These match the spirit of the TTI
// SVG palette: green / amber / red bands tuned to per-op ceilings.
const OP_THRESHOLDS: Record<WarmOpName, { fast: number; medium: number }> = {
  runCommand_noop: { fast: 200, medium: 700 },
  writeFile_1mb: { fast: 500, medium: 1500 },
  readFile_1mb: { fast: 500, medium: 1500 },
  readdir: { fast: 200, medium: 700 },
  runCommand_1mb_stdout: { fast: 500, medium: 1500 },
};

function loadSponsorImages(): { dataUri: string; name: string }[] {
  const allSponsors: { dataUri: string; name: string }[] = [];
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };
  const loadFromDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|svg)$/i.test(f)).sort();
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const mime = mimeTypes[ext] || 'image/png';
      const raw = fs.readFileSync(path.join(dir, file));
      allSponsors.push({ dataUri: `data:${mime};base64,${raw.toString('base64')}`, name: path.basename(file, ext) });
    }
  };
  loadFromDir(SPONSORS_DIR_TIER1);
  loadFromDir(SPONSORS_DIR_TIER2);
  return allSponsors;
}

interface ResultFile {
  timestamp: string;
  results: WarmBenchmarkResult[];
}

function getLatest(): ResultFile | null {
  const subDir = path.join(RESULTS_DIR, 'warm_ops');
  if (!fs.existsSync(subDir)) return null;
  const latestPath = path.join(subDir, 'latest.json');
  if (fs.existsSync(latestPath)) {
    return JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
  }
  const files = fs.readdirSync(subDir).filter(f => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
  if (files.length > 0) {
    return JSON.parse(fs.readFileSync(path.join(subDir, files[0]), 'utf-8'));
  }
  return null;
}

function formatMs(ms: number): string {
  if (ms === 0) return '--';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatProviderName(s: string): string {
  if (s.toLowerCase() === 'e2b') return 'E2B';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function speedClassFor(op: WarmOpName, ms: number, allFailed: boolean): string {
  if (allFailed || ms === 0) return 'slow';
  const t = OP_THRESHOLDS[op];
  if (ms <= t.fast) return 'fast';
  if (ms <= t.medium) return 'medium';
  return 'slow';
}

const sponsorImages = loadSponsorImages();

function generateSVG(results: WarmBenchmarkResult[], timestamp: string): string {
  if (!results.every(r => r.compositeScore !== undefined)) {
    computeWarmCompositeScores(results);
  }
  const sorted = sortWarmByCompositeScore(results).filter(r => !r.skipped);

  const rowHeight = 44;
  const headerHeight = 110;
  const tableHeaderHeight = 44;
  const padding = 24;
  const width = 1280;
  const tableTop = headerHeight + padding;
  const tableBottom = tableTop + tableHeaderHeight + (sorted.length * rowHeight);
  const footnoteHeight = 20;
  const height = tableBottom + padding + 30 + footnoteHeight;

  const cols = {
    rank: 40,
    provider: 80,
    score: 220,
    runCommand_noop: 320,
    writeFile_1mb: 460,
    readFile_1mb: 600,
    readdir: 740,
    runCommand_1mb_stdout: 880,
    status: 1040,
  };

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f6f8fa;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ffffff;stop-opacity:1" />
    </linearGradient>
  </defs>
  <style>
    .bg { fill: #ffffff; }
    .header-bg { fill: url(#headerGrad); }
    .table-header-bg { fill: #f6f8fa; }
    .table-header { font: 600 12px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; text-transform: uppercase; letter-spacing: 0.5px; }
    .row { font: 14px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
    .rank { font-weight: 700; fill: #57606a; }
    .rank-1 { fill: #d4a000; }
    .rank-2 { fill: #8a8a8a; }
    .rank-3 { fill: #a0522d; }
    .provider { font-weight: 600; fill: #0969da; }
    .median { font-weight: 700; font-size: 15px; }
    .fast { fill: #1a7f37; }
    .medium { fill: #9a6700; }
    .slow { fill: #cf222e; }
    .status { fill: #57606a; }
    .divider { stroke: #d0d7de; stroke-width: 1; }
    .timestamp { font: 11px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; }
    .title { font: bold 28px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #24292f; }
    .subtitle { font: 14px 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #57606a; }
  </style>

  <rect class="bg" width="${width}" height="${height}"/>

  <g transform="translate(${padding}, 24)">
    <rect width="60" height="60" fill="#000000"/>
    <g transform="scale(0.035) translate(0, 0)">
      <path fill="#ffffff" d="${LOGO_C_PATH}"/>
    </g>
  </g>

  <text class="title" x="${padding + 76}" y="55">Warm Sandbox Operations</text>
  <text class="subtitle" x="${padding + 76}" y="78">Steady-state op latency on an already-provisioned sandbox</text>
${sponsorImages.length > 0 ? (() => {
  const logoW = 100;
  const logoH = 32;
  const logoGap = 12;
  const totalLogosW = sponsorImages.length * logoW + (sponsorImages.length - 1) * logoGap;
  const logosStartX = width - padding - totalLogosW;
  return `
  <text font-size="11" font-family="Inter, SF Pro Display, sans-serif" fill="#8c959f" x="${logosStartX + totalLogosW / 2}" y="36" text-anchor="middle" letter-spacing="1">SPONSORED BY</text>
  ${sponsorImages.map((img, i) => `<image href="${img.dataUri}" x="${logosStartX + i * (logoW + logoGap)}" y="46" width="${logoW}" height="${logoH}" preserveAspectRatio="xMidYMid meet"/>`).join('\n  ')}`;
})()
 : ''}
  <rect class="table-header-bg" y="${tableTop}" width="${width}" height="${tableHeaderHeight}"/>

  <text class="table-header" x="${cols.rank}" y="${tableTop + 28}">#</text>
  <text class="table-header" x="${cols.provider}" y="${tableTop + 28}">Provider</text>
  <text class="table-header" x="${cols.score}" y="${tableTop + 28}">Score</text>
  <text class="table-header" x="${cols.runCommand_noop}" y="${tableTop + 28}">${OP_LABELS.runCommand_noop}</text>
  <text class="table-header" x="${cols.writeFile_1mb}" y="${tableTop + 28}">${OP_LABELS.writeFile_1mb}</text>
  <text class="table-header" x="${cols.readFile_1mb}" y="${tableTop + 28}">${OP_LABELS.readFile_1mb}</text>
  <text class="table-header" x="${cols.readdir}" y="${tableTop + 28}">${OP_LABELS.readdir}</text>
  <text class="table-header" x="${cols.runCommand_1mb_stdout}" y="${tableTop + 28}">${OP_LABELS.runCommand_1mb_stdout}</text>
  <text class="table-header" x="${cols.status}" y="${tableTop + 28}">Success</text>
`;

  sorted.forEach((r, i) => {
    const y = tableTop + tableHeaderHeight + (i * rowHeight) + 30;
    const rank = i + 1;
    const score = r.compositeScore !== undefined ? r.compositeScore.toFixed(1) : '--';
    const successPct = r.successRate !== undefined ? `${(r.successRate * 100).toFixed(0)}%` : '--';
    const allFailed = (r.successRate ?? 0) === 0;

    let rankClass = 'rank';
    if (rank === 1) rankClass = 'rank rank-1';
    else if (rank === 2) rankClass = 'rank rank-2';
    else if (rank === 3) rankClass = 'rank rank-3';

    svg += `
  <text class="${rankClass}" x="${cols.rank}" y="${y}">${rank}</text>
  <text class="row provider" x="${cols.provider}" y="${y}">${formatProviderName(r.provider)}</text>
  <text class="row median" x="${cols.score}" y="${y}">${score}</text>
`;
    for (const op of OP_ORDER) {
      const ms = r.ops[op]?.summary.median ?? 0;
      const cls = speedClassFor(op, ms, allFailed);
      svg += `  <text class="row median ${cls}" x="${cols[op]}" y="${y}">${formatMs(ms)}</text>
`;
    }
    svg += `  <text class="row status" x="${cols.status}" y="${y}">${successPct}</text>
`;

    if (i < sorted.length - 1) {
      const lineY = tableTop + tableHeaderHeight + ((i + 1) * rowHeight);
      svg += `  <line class="divider" x1="${padding}" y1="${lineY}" x2="${width - padding}" y2="${lineY}"/>
`;
    }
  });

  const date = new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const samplesPerOp = results[0]?.samplesPerOp ?? 100;
  const payloadMb = ((results[0]?.payloadBytes ?? 1_048_576) / (1024 * 1024)).toFixed(0);

  svg += `
  <text class="timestamp" x="${width - padding}" y="${height - 28}" text-anchor="end">Last updated: ${date}</text>
  <text class="timestamp" x="${padding}" y="${height - 14}">Warm mode: ${samplesPerOp} samples/op on a single warm sandbox per provider, ${payloadMb}MB payload. Median shown.</text>

</svg>`;

  return svg;
}

function main() {
  const data = getLatest();
  if (!data) {
    console.error('No warm-ops results found');
    process.exit(1);
  }
  const svg = generateSVG(data.results, data.timestamp);
  const svgPath = path.join(ROOT, 'warm_ops.svg');
  fs.writeFileSync(svgPath, svg);
  console.log(`SVG written to ${svgPath}`);
}

main();
