// Behavioural regression coverage for the #2291 direct-execution-guard fix,
// for scripts with PROVEN production blast radius:
//
//  - ci-scope.mjs: reviewer-demonstrated live —
//    `node <junction>/scripts/ci-scope.mjs --files=src/app.tsx` exited 0
//    with 0 bytes of stdout. Consequence there is worse than silence: the
//    `detect` job emits nothing, so every downstream `if:` evaluates false
//    and legs silently do not run.
//  - check-import-cycles.mjs: same guard shape, same silent-exit-0 failure
//    mode, gating server/src's import-cycle allowlist.
//  - build-release-zip.mjs: the resolve()/fileURLToPath equality shape (a
//    second broken spelling of the same #2291 bug, found + fixed in the
//    follow-up sweep that migrated 14 more sites past the original 22). A
//    guard miss here means `npm run release` silently produces NO zip and
//    exits 0 — a release that looks like it shipped but didn't.
//  - start-app-prod.mjs: same resolve()/fileURLToPath shape. A guard miss
//    here means `npm run start:prod` silently does nothing — no server, no
//    error, exit 0 — the exact failure mode #2291 exists to catch.
//
// Each gets TWO real-subprocess assertions:
//  1. invoked through a genuine symlink (POSIX) / junction (Windows) still
//     runs main() — proven via OBSERVABLE STDOUT, not merely a zero exit
//     code (a script that silently does nothing also exits 0).
//  2. imported as a module (no argv[1] match) does NOT execute main() as a
//     side effect of the import.
//
// check-import-cycles.mjs's real main() spawns `npx madge` over server/src —
// its own test file documents that this is deliberately excluded from
// test:hooks (a real madge pass is not free, and this repo keeps it out of
// the pre-commit/pre-push/CI hot path on purpose). So its junction test uses
// the same technique run-golden-audio.mjs already established for the
// identical problem: an internal, undocumented probe-only env hook
// (CHECK_IMPORT_CYCLES_PROBE_GUARD_ONLY) that proves the guard resolved
// true and exits before madge is spawned. ci-scope.mjs's main() is pure
// stdout — no subprocess, no network — so it is invoked for real with no
// hook needed, exactly as the reviewer did.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, rmdirSync, unlinkSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

function removeLink(linkPath) {
  try {
    if (IS_WIN) rmdirSync(linkPath);
    else unlinkSync(linkPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function probeLinkSupport() {
  const dir = mkdtempSync(join(tmpdir(), 'entry-point-guards-linkcheck-'));
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  try {
    mkdirSync(target);
    symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
    removeLink(link);
    return null;
  } catch (err) {
    return `cannot create a ${IS_WIN ? 'junction' : 'directory symlink'} on this filesystem (the #2291 guard is untested on this run, not confirmed passing): ${err.message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LINK_SKIP_REASON = probeLinkSupport();

// Generalized over withRepoLink's original hardcoded REPO_ROOT so
// start-app-prod.mjs's fixture (below) can be junctioned too — same
// container/link/cleanup shape, just parameterized on which real directory
// the link points at.
function withLinkTo(realRoot, fn) {
  const container = mkdtempSync(join(tmpdir(), 'entry-point-guards-link-'));
  const linkPath = join(container, 'repo-link');
  try {
    symlinkSync(realRoot, linkPath, IS_WIN ? 'junction' : 'dir');
    return fn(linkPath);
  } finally {
    removeLink(linkPath);
    rmSync(container, { recursive: true, force: true });
  }
}

function withRepoLink(fn) {
  return withLinkTo(REPO_ROOT, fn);
}

// --- ci-scope.mjs ---

test('ci-scope.mjs invoked through a junction/symlink still runs main() (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  withRepoLink((linkPath) => {
    const target = join(linkPath, 'scripts', 'ci-scope.mjs');
    const r = spawnSync(process.execPath, [target, '--files=src/app.tsx'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // The reviewer's exact repro was 0 bytes of stdout through a junction.
    // A real run must emit the scopes=...  / ok=true payload render() builds.
    assert.notEqual(r.stdout.length, 0, 'expected non-empty stdout; got 0 bytes (the #2291 silent no-op)');
    assert.match(r.stdout, /^scopes=\{.*\}\nok=true\n$/s, `unexpected stdout shape: ${JSON.stringify(r.stdout)}`);
  });
});

test('ci-scope.mjs imported as a module does not execute main() (no argv[1] match, no CLI output)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ci-scope-import-'));
  try {
    const entry = join(root, 'entry.mjs');
    writeFileSync(
      entry,
      `import ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'scripts', 'ci-scope.mjs')).href)};\n` +
        "console.log('IMPORT-OK');\n",
    );
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // main()'s own output is `scopes=...\nok=true\n` — that must NOT appear;
    // only the entry script's own marker should.
    assert.doesNotMatch(r.stdout, /^scopes=/m);
    assert.match(r.stdout, /IMPORT-OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- check-import-cycles.mjs ---

test('check-import-cycles.mjs invoked through a junction/symlink still runs main() (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  withRepoLink((linkPath) => {
    const target = join(linkPath, 'scripts', 'check-import-cycles.mjs');
    const r = spawnSync(process.execPath, [target], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_IMPORT_CYCLES_PROBE_GUARD_ONLY: '1' },
      windowsHide: true,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(
      r.stdout,
      /direct-invocation guard resolved TRUE/,
      `the guard must have resolved TRUE through the junction — empty/silent stdout means it silently no-op'd. stdout was: ${JSON.stringify(r.stdout)}`,
    );
  });
});

test('check-import-cycles.mjs imported as a module does not execute main() (no argv[1] match, no CLI output)', () => {
  const root = mkdtempSync(join(tmpdir(), 'check-import-cycles-import-'));
  try {
    const entry = join(root, 'entry.mjs');
    writeFileSync(
      entry,
      `import ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'scripts', 'check-import-cycles.mjs')).href)};\n` +
        "console.log('IMPORT-OK');\n",
    );
    const r = spawnSync(process.execPath, [entry], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_IMPORT_CYCLES_PROBE_GUARD_ONLY: '1' },
      windowsHide: true,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /direct-invocation guard resolved TRUE/);
    assert.match(r.stdout, /IMPORT-OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- build-release-zip.mjs (resolve()/fileURLToPath equality shape) ---
//
// --dry-run + --version is real, side-effect-free CLI usage (no zip
// written, no archiver import triggered) — no probe hook needed, same as
// ci-scope.mjs.

test('build-release-zip.mjs invoked through a junction/symlink still runs main() (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  withRepoLink((linkPath) => {
    const target = join(linkPath, 'scripts', 'build-release-zip.mjs');
    const r = spawnSync(process.execPath, [target, '--dry-run', '--version', 'v0.0.0-test'], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // The pre-fix bug through a junction was 0 bytes of stdout, exit 0 —
    // indistinguishable from success without checking the byte count.
    assert.notEqual(r.stdout.length, 0, 'expected non-empty stdout; got 0 bytes (the #2291 silent no-op)');
    assert.match(r.stdout, /\[SCAN\] walking repo from/);
    assert.match(r.stdout, /\[DRY-RUN\] No zip written\.\s*$/);
  });
});

test('build-release-zip.mjs imported as a module does not execute main() (no argv[1] match, no CLI output)', () => {
  const root = mkdtempSync(join(tmpdir(), 'build-release-zip-import-'));
  try {
    const entry = join(root, 'entry.mjs');
    writeFileSync(
      entry,
      `import ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'scripts', 'build-release-zip.mjs')).href)};\n` +
        "console.log('IMPORT-OK');\n",
    );
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /\[SCAN\]/);
    assert.match(r.stdout, /IMPORT-OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- start-app-prod.mjs (resolve()/fileURLToPath equality shape) ---
//
// main() spawns a real production server once past its dist/server bundle
// checks — not something a unit test should risk triggering for real. The
// "dist/index.html missing" failure path is deterministic and side-effect-free
// (no port probe, no spawn — it returns before either), so it's used as the
// observable proof that main() ran through the junction.
//
// Previously this test SKIPPED whenever the real checkout's dist/index.html
// existed (i.e. after `npm run build`) — which is essentially every developer
// box, so the coverage evaporated everywhere but a pristine clone. Node's ESM
// loader realpaths the main entry module before computing import.meta.url
// (see scripts/lib/is-main-module.mjs's own comment on this), so
// start-app-prod.mjs's own __dirname — and therefore its repoRoot and its
// dist/index.html check — always resolves to the REAL location of the
// invoked file, not the junction path. Junctioning only a *container* around
// the real script can't relocate that. So instead this builds a standalone
// fixture: a real copy of start-app-prod.mjs plus its one relative import
// (lib/is-main-module.mjs) and a minimal package.json, at a fresh temp root
// that provably has no dist/ folder — then junctions TO that fixture root.
// This still exercises the #2291 guard through a real junction exactly like
// the other four tests in this file; it just no longer depends on whether
// this checkout happens to have been built.
function buildStartAppProdFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'start-app-prod-fixture-'));
  mkdirSync(join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
  cpSync(
    join(REPO_ROOT, 'scripts', 'start-app-prod.mjs'),
    join(fixtureRoot, 'scripts', 'start-app-prod.mjs'),
  );
  cpSync(
    join(REPO_ROOT, 'scripts', 'lib', 'is-main-module.mjs'),
    join(fixtureRoot, 'scripts', 'lib', 'is-main-module.mjs'),
  );
  // start-app-prod.mjs reads package.json's version at import time.
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
  return fixtureRoot;
}

test(
  'start-app-prod.mjs invoked through a junction/symlink still runs main() (#2291)',
  { skip: LINK_SKIP_REASON ?? false },
  () => {
    const fixtureRoot = buildStartAppProdFixture();
    try {
      withLinkTo(fixtureRoot, (linkPath) => {
        const target = join(linkPath, 'scripts', 'start-app-prod.mjs');
        const runDir = mkdtempSync(join(tmpdir(), 'start-app-prod-run-'));
        const logDir = mkdtempSync(join(tmpdir(), 'start-app-prod-log-'));
        try {
          const r = spawnSync(process.execPath, [target], {
            encoding: 'utf8',
            env: {
              ...process.env,
              LAN_HTTPS: '0', // opt out of mkcert provisioning — no system side effects
              APP_RUN_DIR: runDir,
              APP_LOG_DIR: logDir,
            },
            windowsHide: true,
          });
          // The pre-fix bug through a junction was exit 0 with zero output — a
          // launcher that silently does nothing, which is worse than a crash.
          assert.equal(r.status, 1, `expected the deterministic dist-missing failure; stdout: ${r.stdout} stderr: ${r.stderr}`);
          assert.notEqual(r.stderr.length, 0, 'expected non-empty stderr; got 0 bytes (the #2291 silent no-op)');
          assert.match(r.stderr, /\[FAIL\] Frontend bundle missing at dist\/index\.html/);
        } finally {
          rmSync(runDir, { recursive: true, force: true });
          rmSync(logDir, { recursive: true, force: true });
        }
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);

test('start-app-prod.mjs imported as a module does not execute main() (no argv[1] match, no CLI output)', () => {
  const root = mkdtempSync(join(tmpdir(), 'start-app-prod-import-'));
  try {
    const entry = join(root, 'entry.mjs');
    writeFileSync(
      entry,
      `import ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'scripts', 'start-app-prod.mjs')).href)};\n` +
        "console.log('IMPORT-OK');\n",
    );
    const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\[FAIL\]/);
    assert.match(r.stdout, /IMPORT-OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
