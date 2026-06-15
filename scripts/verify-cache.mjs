#!/usr/bin/env node
// Verify-cache runner — replaces the &&-chain in `npm run verify`. Each step
// computes a SHA-256 of its inputs (filtered from `git ls-files`) + lockfile
// hashes + an optional tool fingerprint; matches against `.verify-cache.json`
// to skip steps whose inputs haven't changed since the last green run. See
// docs/features/archive/50-verify-cache.md for the design.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lowConcurrency } from './test-concurrency.mjs';

const SCHEMA_VERSION = 1;
const CACHE_FILENAME = '.verify-cache.json';

// Pipeline ordering — preserve today's `verify` chain exactly.
// Reorder with care; the same order is what shows up in the runner output.
export const STEPS = [
  {
    name: 'lint',
    inputs: {
      globs: ['**/*.{ts,tsx,js,jsx,cjs,mjs}'],
      extraFiles: ['eslint.config.js', '.prettierrc', '.prettierignore'],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'typecheck',
    inputs: {
      globs: ['src/**', 'server/src/**'],
      extraFiles: [
        'tsconfig.json',
        'server/tsconfig.json',
        'vite.config.ts',
        'vitest.config.ts',
      ],
      includeLockfiles: ['root', 'server'],
    },
  },
  {
    /* Drift guard: fails if server/.env.example is out of sync with the
       config registry. Cheap — just renders the block and diffs. Placed
       before tests so a divergent registry is caught early. */
    name: 'config:check',
    inputs: {
      globs: ['server/src/config/*.ts'],
      extraFiles: ['server/.env.example', 'server/scripts/sync-env-example.ts'],
      includeLockfiles: [],
    },
  },
  {
    name: 'test:hooks',
    inputs: {
      globs: ['scripts/tests/*.test.mjs'],
      extraFiles: ['scripts/validate-commit-msg.mjs'],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'test:pinokio',
    inputs: {
      globs: ['pinokio/**'],
      extraFiles: ['scripts/run-pinokio-tests.mjs'],
      includeLockfiles: [],
    },
  },
  {
    name: 'test',
    inputs: {
      globs: ['src/**'],
      extraFiles: [
        'vitest.config.ts',
        'vite.config.ts',
        'tailwind.config.ts',
        'postcss.config.js',
        'index.html',
      ],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'test:server',
    inputs: {
      globs: ['server/src/**'],
      extraFiles: ['server/vitest.config.ts', 'server/tsconfig.json'],
      includeLockfiles: ['server'],
    },
  },
  {
    /* Plan 45 (vitest pool tuning) — 5 hot files (analyzer/gemini + 4 routes test
       files) run serially in a separate vitest invocation so their
       mkdtempSync + module-import contention can't trip the main
       parallel test:server battery. Cache invalidates on the same
       inputs since the file list is wholly inside server/src/**. */
    name: 'test:server-slow',
    inputs: {
      globs: ['server/src/**'],
      extraFiles: ['server/vitest.config.slow.ts', 'server/vitest.config.ts', 'server/tsconfig.json'],
      includeLockfiles: ['server'],
    },
  },
  {
    name: 'test:scripts',
    inputs: {
      globs: ['scripts/lib/**', 'scripts/tests/**/*.Tests.ps1', 'scripts/tests/**/*.ps1'],
      extraFiles: ['scripts/tests/run.ps1'],
      includeLockfiles: ['root'],
    },
    toolFingerprint: pesterFingerprint,
  },
  {
    name: 'test:sidecar',
    inputs: {
      globs: ['server/tts-sidecar/**/*.py', 'server/tts-sidecar/requirements*.txt'],
      extraFiles: ['server/tts-sidecar/run-tests.ps1'],
      includeLockfiles: [],
    },
    toolFingerprint: sidecarFingerprint,
  },
  {
    name: 'test:e2e',
    inputs: {
      globs: ['src/**', 'e2e/**'],
      extraFiles: ['playwright.config.ts', 'vite.config.ts', '.env.e2e'],
      includeLockfiles: ['root'],
    },
  },
  {
    /* Plan 37 (visual baselines) — visual baselines run in a separate serial
       step so they can't race the parallel test:e2e battery for the
       Vite dev server. Same `globs` as test:e2e so the cache invalidates
       whenever a source file or e2e spec changes. */
    name: 'test:e2e:visual',
    inputs: {
      globs: ['src/**', 'e2e/**'],
      extraFiles: ['playwright.config.ts', 'vite.config.ts', '.env.e2e'],
      includeLockfiles: ['root'],
    },
  },
  {
    name: 'build',
    inputs: {
      globs: ['src/**', 'server/src/**'],
      extraFiles: [
        'vite.config.ts',
        'tsconfig.json',
        'server/tsconfig.json',
        'index.html',
      ],
      includeLockfiles: ['root', 'server'],
    },
  },
];

export function parseFlags(argv) {
  let steps = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--steps') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        steps = parseStepsCsv(next);
        i += 1;
      } else {
        steps = [];
      }
    } else if (a.startsWith('--steps=')) {
      steps = parseStepsCsv(a.slice('--steps='.length));
    }
  }
  return {
    noCache: argv.includes('--no-cache'),
    steps,
    scopeStaged: argv.includes('--scope-staged'),
  };
}

function parseStepsCsv(csv) {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Pure decision function — no I/O. Returns 'run' | 'skip'.
export function decide({ stepName, currentHash, cache, noCache }) {
  if (noCache) return 'run';
  const entry = cache?.steps?.[stepName];
  if (!entry || typeof entry.inputHash !== 'string') return 'run';
  return entry.inputHash === currentHash ? 'skip' : 'run';
}

// SHA-256 hex of a Buffer or string.
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// SHA-256 hex of a single file's bytes. Missing file → empty marker so a
// later add/delete flips the hash naturally without throwing.
export function hashFile(absPath) {
  try {
    return sha256Hex(readFileSync(absPath));
  } catch {
    return '__missing__';
  }
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// Pre-sorted [posixPath, fileHash] entries → SHA-256 of `${path}\0${hash}\n` joined.
export function hashEntries(entries) {
  const h = createHash('sha256');
  for (const [path, hash] of entries) {
    h.update(`${path}\0${hash}\n`);
  }
  return h.digest('hex');
}

// Compose a step's input hash. Pure function; takes all dependencies as args.
export function composeInputHash({
  stepName,
  sortedFileEntries,
  lockHashes,
  nodeVer,
  schemaVer,
  toolFingerprint,
}) {
  const block = [
    stepName,
    String(schemaVer),
    nodeVer,
    toolFingerprint ?? '',
    lockHashes?.root ?? '',
    lockHashes?.server ?? '',
    hashEntries(sortedFileEntries),
  ].join('\n');
  return sha256Hex(block);
}

// Tolerant load: missing or corrupt file → empty default cache.
export function loadCache(absPath) {
  const empty = { schemaVersion: SCHEMA_VERSION, steps: {} };
  if (!existsSync(absPath)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(absPath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.schemaVersion === SCHEMA_VERSION &&
      parsed.steps &&
      typeof parsed.steps === 'object'
    ) {
      return parsed;
    }
    return empty;
  } catch {
    return empty;
  }
}

// Atomic save: write `<path>.tmp` then rename. Retry once on EBUSY (Windows
// antivirus shadow). Cache is best-effort, not load-bearing — a failed save
// just means the next run won't have the latest entry.
export function saveCache(absPath, cache) {
  const tmp = `${absPath}.tmp`;
  const payload = JSON.stringify(cache, null, 2);
  writeFileSync(tmp, payload, 'utf8');
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    if (err && err.code === 'EBUSY') {
      const until = Date.now() + 60;
      while (Date.now() < until) {
        // tiny spin; <50ms total
      }
      try {
        renameSync(tmp, absPath);
      } catch {
        // give up — best-effort
      }
    }
  }
}

// Convert a glob list like `src/**` or `**/*.{ts,tsx}` into a single regex
// that matches against POSIX-normalized relative paths. Supports `**`, `*`,
// and a brace-list extension (`{ts,tsx,js}`); doesn't need to be a full
// glob implementation — our STEPS table only uses these forms.
function globToRegex(glob) {
  let i = 0;
  let out = '^';
  while (i < glob.length) {
    const c = glob[i];
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const parts = glob
        .slice(i + 1, close)
        .split(',')
        .map((s) => s.replace(/[.+^$|()[\]\\]/g, '\\$&'));
      out += `(?:${parts.join('|')})`;
      i = close + 1;
    } else if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; bare `**` matches anything
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (/[.+^$|()[\]\\]/.test(c)) {
      out += `\\${c}`;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  out += '$';
  return new RegExp(out);
}

// Filter a flat POSIX file list against a step's globs + extraFiles. Returns
// a sorted, deduped list of POSIX-normalized relative paths.
export function selectStepFiles({ fileList, step }) {
  const regexes = (step.inputs.globs ?? []).map(globToRegex);
  const set = new Set();
  for (const f of fileList) {
    for (const re of regexes) {
      if (re.test(f)) {
        set.add(f);
        break;
      }
    }
  }
  for (const extra of step.inputs.extraFiles ?? []) {
    set.add(toPosix(extra));
  }
  return [...set].sort();
}

// --- Scope filter (pre-commit) -------------------------------------------
// Diff-driven gate that sits IN FRONT of the input-hash cache: a step whose
// scope the staged diff never touched is skipped outright, regardless of cache
// state. This closes the hole where a flaked prior run (no green entry) forces
// an out-of-scope suite to re-run. Mirrors the scope detection in
// .github/workflows/verify.yml; the STEPS `inputs.globs` ARE the scope map.

// A root manifest change is treated as global — a dep/lock bump can affect
// every leg (mirrors verify.yml's `shared` scope).
export function computeShared(diffFiles) {
  return diffFiles.some((f) => f === 'package.json' || f === 'package-lock.json');
}

// Does any staged diff file fall inside this step's declared scope? Reuses the
// step's own globs + extraFiles + server lockfile. Deliberately NOT
// selectStepFiles — that always injects extraFiles into its result, so it can
// never report "untouched". This needs a real membership predicate.
export function stepTouchedByDiff(step, diffFiles) {
  const regexes = (step.inputs.globs ?? []).map(globToRegex);
  for (const f of diffFiles) {
    if (regexes.some((re) => re.test(f))) return true;
  }
  const extras = new Set((step.inputs.extraFiles ?? []).map(toPosix));
  for (const f of diffFiles) {
    if (extras.has(f)) return true;
  }
  if (
    (step.inputs.includeLockfiles ?? []).includes('server') &&
    diffFiles.includes('server/package-lock.json')
  ) {
    return true;
  }
  return false;
}

// Files staged for commit. Returns POSIX paths, or null if git fails (→ caller
// disables the scope filter and runs everything; never skip on uncertainty).
function stagedDiffFiles(cwd) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}

// --- Contention guard ----------------------------------------------------
// A co-running GPU generation hammers CPU/disk and is the documented cause of
// "Worker exited unexpectedly" crashes and 250s+ environment-setup stalls in
// the test legs. When we detect a busy GPU we throttle test concurrency (soft —
// warn + dial down, never block).

const GPU_BUSY_THRESHOLD = 40; // % utilization

// Parse the first GPU's utilization (%) from nvidia-smi CSV output. Returns a
// number, or null if unparseable / no GPU line.
export function parseNvidiaSmiUtil(stdout) {
  if (!stdout) return null;
  const firstLine = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (!firstLine) return null;
  const n = Number.parseInt(firstLine.split(',')[0].trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// Returns { busy, util }. nvidia-smi absent / errors → { busy:false, util:null }
// (e.g. CI ubuntu runners, non-NVIDIA boxes). Cheap (~100ms).
function detectGpuContention() {
  const r = spawnSync(
    'nvidia-smi',
    ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (r.error || r.status !== 0) return { busy: false, util: null };
  const util = parseNvidiaSmiUtil(r.stdout);
  return { busy: util !== null && util >= GPU_BUSY_THRESHOLD, util };
}

// Tool fingerprints — strings that change when the relevant tool's
// availability or version changes. Used to invalidate the cache when a user
// installs Pester or bootstraps the pytest venv after a previous skip.

function pesterFingerprint() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "$m = Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1; if ($m) { $m.Version.ToString() } else { 'unavailable' }",
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (r.error || r.status !== 0) return 'unavailable';
  return (r.stdout ?? '').trim() || 'unavailable';
}

function sidecarFingerprint() {
  const py = 'server/tts-sidecar/.venv/Scripts/python.exe';
  if (!existsSync(py)) return 'unavailable';
  let mtime = '';
  try {
    mtime = String(statSync(py).mtimeMs);
  } catch {
    mtime = '0';
  }
  const r = spawnSync(py, ['-m', 'pytest', '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.error || r.status !== 0) return `present:${mtime}:no-pytest`;
  const ver = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split(/\r?\n/)[0];
  return `${mtime}:${ver}`;
}

function gitFileList(cwd) {
  const r = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd, encoding: 'utf8' },
  );
  if (r.error || r.status !== 0) return null;
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(toPosix);
}

function pickLockHashes(absRoot, which) {
  const out = {};
  if (which.includes('root')) {
    out.root = hashFile(join(absRoot, 'package-lock.json'));
  }
  if (which.includes('server')) {
    out.server = hashFile(join(absRoot, 'server', 'package-lock.json'));
  }
  return out;
}

function formatSecs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Top-level orchestrator. Returns process exit code.
export function runPipeline({ argv = [], cwd = process.cwd(), env = process.env } = {}) {
  const flags = parseFlags(argv);
  const validNames = STEPS.map((s) => s.name);
  let activeSteps = STEPS;
  if (flags.steps && flags.steps.length > 0) {
    const unknown = flags.steps.filter((n) => !validNames.includes(n));
    if (unknown.length > 0) {
      console.error(
        `[verify-cache] unknown step name(s): ${unknown.join(', ')}\n` +
          `[verify-cache] valid steps: ${validNames.join(', ')}`,
      );
      return 2;
    }
    const selected = new Set(flags.steps);
    activeSteps = STEPS.filter((s) => selected.has(s.name));
  }

  // Contention guard — if a generation run is hammering the GPU, throttle the
  // child test runs (soft: warn + dial down, never block). Skip the probe when
  // already throttled or explicitly disabled.
  if (!env.SKIP_CONTENTION_CHECK && !lowConcurrency(env)) {
    const { busy, util } = detectGpuContention();
    if (busy) {
      console.log(
        `[contention] GPU busy (~${util}% util) — a generation run may be active.`,
      );
      console.log(
        '[contention] Throttling test concurrency (LOW_CONCURRENCY=1). Set SKIP_CONTENTION_CHECK=1 to disable.',
      );
      env.LOW_CONCURRENCY = '1';
    }
  }

  // Scope filter (pre-commit) — compute the staged diff once; per-step skip
  // happens at the top of the loop below.
  let scopeDiff = null;
  let scopeShared = false;
  if (flags.scopeStaged) {
    scopeDiff = stagedDiffFiles(cwd);
    if (scopeDiff === null) {
      console.log('[scope] git diff --cached failed; running all selected steps');
    } else if (computeShared(scopeDiff)) {
      scopeShared = true;
      console.log('[scope] root manifest changed — all selected steps in scope');
    }
  }

  const cachePath = join(cwd, CACHE_FILENAME);
  const fileList = gitFileList(cwd);
  const nodeVer = process.version;
  const schemaVer = SCHEMA_VERSION;
  const lockHashesAll = {
    root: hashFile(join(cwd, 'package-lock.json')),
    server: hashFile(join(cwd, 'server', 'package-lock.json')),
  };
  let cache = loadCache(cachePath);
  if (cache.schemaVersion !== schemaVer) {
    cache = { schemaVersion: schemaVer, steps: {} };
  }
  const fileHashes = new Map(); // memoize across steps

  if (!fileList) {
    console.log('[verify-cache] git ls-files failed; running uncached');
  }

  for (const step of activeSteps) {
    if (scopeDiff !== null && !scopeShared && !stepTouchedByDiff(step, scopeDiff)) {
      console.log(`[skip] ${step.name} (out of scope)`);
      continue;
    }
    const files = fileList ? selectStepFiles({ fileList, step }) : [];
    const entries = files.map((rel) => {
      let h = fileHashes.get(rel);
      if (!h) {
        h = hashFile(join(cwd, rel));
        fileHashes.set(rel, h);
      }
      return [rel, h];
    });
    const lockHashes = pickLockHashes(cwd, step.inputs.includeLockfiles ?? []);
    // Always reuse the universal lockHashesAll-derived values to avoid
    // re-reading the same file twice; pickLockHashes already memoizes via
    // hashFile, but cache the call site cheaply too.
    if (lockHashes.root === undefined && (step.inputs.includeLockfiles ?? []).includes('root')) {
      lockHashes.root = lockHashesAll.root;
    }
    if (
      lockHashes.server === undefined &&
      (step.inputs.includeLockfiles ?? []).includes('server')
    ) {
      lockHashes.server = lockHashesAll.server;
    }
    const fp = step.toolFingerprint ? step.toolFingerprint() : null;
    const currentHash = composeInputHash({
      stepName: step.name,
      sortedFileEntries: entries,
      lockHashes,
      nodeVer,
      schemaVer,
      toolFingerprint: fp,
    });

    const action =
      fileList === null
        ? 'run'
        : decide({
            stepName: step.name,
            currentHash,
            cache,
            noCache: flags.noCache,
          });

    if (action === 'skip') {
      console.log(`[cached] ${step.name} (input hash unchanged)`);
      continue;
    }

    console.log(`[run] ${step.name}`);
    const t0 = Date.now();
    const r = spawnSync('npm', ['run', step.name], {
      cwd,
      stdio: 'inherit',
      shell: true,
      env,
    });
    const dt = Date.now() - t0;
    const code = r.status ?? 1;
    if (code === 0) {
      console.log(`[pass] ${step.name} (took ${formatSecs(dt)})`);
      if (fileList !== null) {
        cache.steps[step.name] = {
          inputHash: currentHash,
          lastGreenAt: new Date().toISOString(),
          durationMs: dt,
        };
        saveCache(cachePath, cache);
      }
    } else {
      console.log(`[fail] ${step.name} (exit ${code}, took ${formatSecs(dt)})`);
      return code;
    }
  }
  return 0;
}

const isDirectInvocation = (() => {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return import.meta.url === pathToFileURL(arg1).href;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const code = runPipeline({ argv: process.argv.slice(2), cwd: repoRoot, env: process.env });
  process.exit(code);
}

// For tests that want to know the schema version / cache filename without
// hardcoding string literals.
export const _internals = { SCHEMA_VERSION, CACHE_FILENAME, toPosix, globToRegex };
