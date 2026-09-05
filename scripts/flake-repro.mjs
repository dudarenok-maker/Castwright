// scripts/flake-repro.mjs — measure a test file's runtime under induced load.
// Usage: node scripts/flake-repro.mjs --file server/src/routes/analysis-pipelining.test.ts --runs 3 --cpu-load --io-load
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const file = get('--file');
const runs = Number(get('--runs', '3'));
if (!file) { console.error('--file <relpath> required'); process.exit(2); }

// Decide config: slow files run via the slow config. This list is the exact
// set of paths in server/vitest.config.slow.ts's SLOW_FILES, mirrored here
// verbatim (server/src/slow-lane-mirror.guard.test.ts enforces the mirror).
// Matched by EXACT equality against `rel` (the path with a leading `server/`
// stripped, same shape as SLOW_FILES itself) — a substring match here
// previously over-matched (e.g. 'generation' also matched
// generation-error.test.ts) and routed unrelated files to a config that
// doesn't declare them, which crashed the tool (PR #2998 review pass 2).
const SLOW = [
  'src/analyzer/gemini.test.ts',
  'src/routes/analysis-pipelining.test.ts',
  'src/routes/book-state.test.ts',
  'src/routes/chapters-restructure.test.ts',
  'src/routes/generation.test.ts',
  'src/routes/generation-boundary-recycle.test.ts',
  'src/parsers/pdf-real.test.ts',
  'src/routes/setup-readiness.route.test.ts',
  'src/routes/kokoro-install.route.test.ts',
  'src/routes/venv-bootstrap.route.test.ts',
  'src/routes/analysis.interim-prune-prohibition.e2e.test.ts',
];
const cwd = file.startsWith('server/') ? 'server' : '.';
const rel = file.replace(/^server\//, '');
const isSlow = SLOW.includes(rel);

let cpuBurners = [];
function startCpuLoad() {
  const n = Math.max(1, cpus().length - 1);
  for (let i = 0; i < n; i++) {
    cpuBurners.push(spawn(process.execPath, ['-e', 'while(true){Math.sqrt(Math.random())}'], { stdio: 'ignore', windowsHide: true }));
  }
}
function stopCpuLoad() { cpuBurners.forEach((c) => c.kill('SIGKILL')); cpuBurners = []; }

let ioBurner = null, ioDir = null;
function startIoLoad() {
  ioDir = mkdtempSync(join(tmpdir(), 'flake-io-'));
  // Run the I/O load in a SEPARATE child process. A setInterval in THIS process
  // never fires while the blocking spawnSync vitest run holds the event loop
  // (review C3 — verified: 0 ticks during a 300ms spawnSync), so an in-process
  // timer induces ZERO contention during the measured window.
  const burn =
    "const{writeFileSync}=require('fs');const{join}=require('path');" +
    `const d=${JSON.stringify(ioDir)};let n=0;` +
    "setInterval(()=>{try{writeFileSync(join(d,'f'+(n%50)+'.tmp'),'x'.repeat(65536));n++;}catch{}},2);";
  ioBurner = spawn(process.execPath, ['-e', burn], { stdio: 'ignore', windowsHide: true });
}
function stopIoLoad() { if (ioBurner) ioBurner.kill('SIGKILL'); if (ioDir) rmSync(ioDir, { recursive: true, force: true }); }

if (has('--cpu-load')) startCpuLoad();
if (has('--io-load')) startIoLoad();

const cmd = isSlow
  ? ['vitest', 'run', '--config', 'vitest.config.slow.ts', rel]
  : ['vitest', 'run', rel];

const results = [];
for (let i = 0; i < runs; i++) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync('npx', cmd, { cwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
    env: { ...process.env, RUN_QUARANTINE: '1' } }); // RUN_QUARANTINE=1 so quarantined cases run
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ run: i + 1, ms: Math.round(ms), code: r.status });
  console.log(`run ${i + 1}: ${Math.round(ms)}ms exit=${r.status}`);
}
stopCpuLoad(); stopIoLoad();
console.log('SUMMARY', JSON.stringify(results));
