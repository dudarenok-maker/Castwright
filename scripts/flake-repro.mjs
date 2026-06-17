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

// Decide config: slow files run via the slow config.
const SLOW = ['analysis-pipelining', 'gemini', 'book-state', 'chapters-restructure',
  'generation', 'generation-boundary-recycle', 'pdf-real', 'setup-readiness.route',
  'kokoro-install.route', 'venv-bootstrap.route'];
const isSlow = SLOW.some((s) => file.includes(s));
const cwd = file.startsWith('server/') ? 'server' : '.';
const rel = file.replace(/^server\//, '');

let cpuBurners = [];
function startCpuLoad() {
  const n = Math.max(1, cpus().length - 1);
  for (let i = 0; i < n; i++) {
    cpuBurners.push(spawn(process.execPath, ['-e', 'while(true){Math.sqrt(Math.random())}'], { stdio: 'ignore' }));
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
  ioBurner = spawn(process.execPath, ['-e', burn], { stdio: 'ignore' });
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
  const r = spawnSync('npx', cmd, { cwd, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, RUN_QUARANTINE: '1' } }); // RUN_QUARANTINE=1 so quarantined cases run
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  results.push({ run: i + 1, ms: Math.round(ms), code: r.status });
  console.log(`run ${i + 1}: ${Math.round(ms)}ms exit=${r.status}`);
}
stopCpuLoad(); stopIoLoad();
console.log('SUMMARY', JSON.stringify(results));
