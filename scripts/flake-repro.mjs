// scripts/flake-repro.mjs — measure a test file's runtime under induced load.
// Usage: node scripts/flake-repro.mjs --file <test-file> --runs <N> [--cpu-load] [--io-load]
//
// --file accepts a relative or absolute path to a test file (not a vitest filter).
//   Relative paths are resolved against the repo root. Absolute paths are accepted
//   only if they resolve to a file within the repo; paths outside the repo are refused.
//   Test files must exist and match the test-file glob patterns from the vitest configs.
//   Partial path filters (e.g., 'src/routes/voices') are no longer accepted as of #3081.
//
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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

// Pure function: resolve a --file argument into { cwd, rel, isSlow, fullPath }.
// PowerShell tab-completion produces backslash paths on Windows (the ordinary
// way paths are typed on this repo's primary platform), but three separate
// consumers below — cwd routing, server/ prefix strip, and SLOW exact-match —
// all expect POSIX separators. Normalizing here once fixes all three; a
// mismatch in any one leaves the others silently broken. The run goes to the
// wrong config and still reports a timing, making the silent failure hard to
// spot (issue #3081). The three consumers are:
//   - `cwd` choice: checks startsWith('server/')
//   - `rel` production: strips a leading `server/` (for vitest)
//   - `isSlow` lookup: EXACT match against SLOW's POSIX paths
//
// Absolute paths (drive-letter, UNC, or POSIX) are relativised against repoRoot.
// Paths that resolve outside the repo are returned as-is for validation by the
// caller (which will refuse them with an appropriate diagnostic).
//
// `fullPath` is the relative or relativised path (before server/ stripping),
// suitable for file-existence checks. `rel` is after stripping, for vitest filters.
export function resolveTarget(file, repoRoot) {
  // Normalize separators (Windows backslash, UNC) and strip leading ./
  let normalized = file.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  // If absolute, relativise against repo root (or leave as absolute if outside repo)
  if (isAbsolute(file)) {
    const abs = resolve(file); // Resolve to absolute form
    const repoAbs = resolve(repoRoot);
    const relativeToRepo = relative(repoAbs, abs).replace(/\\/g, '/');
    // If relative() returned a path with ../, it's outside the repo
    if (!relativeToRepo.startsWith('..')) {
      normalized = relativeToRepo;
    } else {
      // Return as-is; the caller will refuse it as outside the repo
      const absPath = abs.replace(/\\/g, '/');
      return { cwd: null, rel: absPath, fullPath: absPath, isSlow: false, isOutsideRepo: true };
    }
  }

  const cwd = normalized.startsWith('server/') ? 'server' : '.';
  const rel = normalized.replace(/^server\//, '');
  const isSlow = SLOW.includes(rel);

  return { cwd, rel, isSlow, fullPath: normalized, isOutsideRepo: false };
}

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

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const has = (k) => args.includes(k);
  const file = get('--file');
  const runsArg = get('--runs', '3');
  const runs = Number(runsArg);

  if (!file) { console.error('--file <relpath> required'); process.exitCode = 2; return; }
  if (!Number.isInteger(runs) || runs <= 0) {
    console.error(`flake-repro: --runs must be a positive integer, got '${runsArg}'`);
    process.exitCode = 2;
    return;
  }

  // Resolve the repo root from this script's location
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(scriptDir, '..');

  const { cwd, rel, isSlow, fullPath, isOutsideRepo } = resolveTarget(file, repoRoot);

  if (isOutsideRepo) {
    console.error('flake-repro: path resolves outside the repository');
    console.error(`  --file      ${file}`);
    console.error(`  resolved to ${fullPath}`);
    console.error(`  repo root   ${repoRoot}`);
    process.exitCode = 2;
    return;
  }

  const filePath = resolve(repoRoot, fullPath);
  if (!existsSync(filePath)) {
    console.error('flake-repro: no such test file');
    console.error(`  --file      ${file}`);
    console.error(`  resolved to ${filePath}`);
    process.exitCode = 2;
    return;
  }

  // Require a real file (not a directory) that matches test-file pattern
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    console.error('flake-repro: cannot stat file');
    console.error(`  --file      ${file}`);
    console.error(`  resolved to ${filePath}`);
    process.exitCode = 2;
    return;
  }

  if (!stats.isFile()) {
    console.error('flake-repro: not a regular file');
    console.error(`  --file      ${file}`);
    console.error(`  resolved to ${filePath}`);
    process.exitCode = 2;
    return;
  }

  // Check that the filename matches a test-file pattern
  // Pattern: (test|spec).[cm]?[tj]sx?
  if (!/\.(test|spec)\.[cm]?[tj]sx?$/.test(filePath)) {
    console.error('flake-repro: not a test file (must match .(test|spec).[cm]?[tj]sx?)');
    console.error(`  --file      ${file}`);
    console.error(`  resolved to ${filePath}`);
    process.exitCode = 2;
    return;
  }

  // Note: process.exitCode = 2 before starting the load-inducer children is safe
  // because the children's event loop keeps the process alive. A return after
  // startCpuLoad() would hang (the main process exits but children keep running).
  // Keep this early-exit block and comment together.

  if (has('--cpu-load')) startCpuLoad();
  if (has('--io-load')) startIoLoad();

  const cmd = isSlow
    ? ['vitest', 'run', '--config', 'vitest.config.slow.ts', rel]
    : ['vitest', 'run', rel];

  // Use absolute cwd so spawn resolves correctly from any working directory
  const absoluteCwd = resolve(repoRoot, cwd);

  const results = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('npx', cmd, { cwd: absoluteCwd, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
      env: { ...process.env, RUN_QUARANTINE: '1' } }); // RUN_QUARANTINE=1 so quarantined cases run
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // If the spawn itself failed (r.error set or r.status is null), do not report it as a measurement
    if (r.error || r.status === null) {
      stopCpuLoad(); stopIoLoad();
      console.error('flake-repro: spawn failed to start');
      if (r.error) console.error(`  error: ${r.error.message}`);
      process.exitCode = 1;
      return;
    }

    results.push({ run: i + 1, ms: Math.round(ms), code: r.status });
    console.log(`run ${i + 1}: ${Math.round(ms)}ms exit=${r.status}`);
  }
  stopCpuLoad(); stopIoLoad();
  console.log('SUMMARY', JSON.stringify(results));
}

if (isDirectlyInvoked(import.meta.url)) {
  main();
}
