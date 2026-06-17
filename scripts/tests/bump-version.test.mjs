// Plan 49 — pin the bump-version script's post-state.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Strategy: build a throwaway git repo in a tempdir with a minimal
// package.json + lockfile pair (root + server) carrying the SAME starting
// version, then shell out to `node <abs-path>/bump-version.mjs` and assert:
//   - both package.json versions advanced in lockstep
//   - both lockfiles regenerated (version field present)
//   - one new commit with subject "chore: bump version to X.Y.Z"
//   - one new annotated tag "vX.Y.Z" whose message contains "vX.Y.Z"
//
// `--dry-run` mode is asserted to print the plan WITHOUT mutating anything.
//
// `--force` is required because we're running from a throwaway branch
// (not main).

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Pure helper from the script (import is inert — the script's procedure is
// behind an import.meta-main guard, so loading it here doesn't run a release).
import { pickWorkflowRun, readSidecarVersion, writeSidecarVersion, sidecarVersionPath, readPubspecVersion, writePubspecVersion, pubspecPath, pubspecBuildNumber, resolveNotesFile, staleNotesVersion, DEFAULT_NOTES_FILE } from '../bump-version.mjs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bumpScript = resolve(here, '..', 'bump-version.mjs');

// Strip GIT_* env vars before spawning git in a throwaway repo. When this
// test runs from a git hook context (e.g. pre-commit via husky), the parent
// `git commit` sets GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX,
// which child processes inherit. Without sanitising, the test's `git commit`
// would write into the PARENT worktree's git instead of the temp fixture —
// silently creating bogus commits on whatever branch invoked the hook.
function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

// Wrap execFileSync to always pass the sanitised env. Every git invocation
// in this test goes through this helper.
function gitExec(args, opts = {}) {
  return execFileSync('git', args, { ...opts, env: cleanGitEnv() });
}

function mkLockfile(name, version) {
  return JSON.stringify(
    {
      name,
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name, version },
      },
    },
    null,
    2,
  );
}

function setupRepo(startVersion) {
  const dir = mkdtempSync(resolve(tmpdir(), 'bump-version-test-'));
  // Root package.json + lockfile
  writeFileSync(
    resolve(dir, 'package.json'),
    JSON.stringify({ name: 'fixture-root', version: startVersion, private: true }, null, 2),
  );
  writeFileSync(resolve(dir, 'package-lock.json'), mkLockfile('fixture-root', startVersion));
  // Server package.json + lockfile
  mkdirSync(resolve(dir, 'server'));
  writeFileSync(
    resolve(dir, 'server', 'package.json'),
    JSON.stringify({ name: 'fixture-server', version: startVersion, private: true }, null, 2),
  );
  writeFileSync(
    resolve(dir, 'server', 'package-lock.json'),
    mkLockfile('fixture-server', startVersion),
  );

  // Mirror the bump script + git history into the throwaway repo so it can
  // resolve its own scripts/ path with the same layout the real repo has.
  mkdirSync(resolve(dir, 'scripts'));
  writeFileSync(resolve(dir, 'scripts', 'bump-version.mjs'), readFileSync(bumpScript, 'utf8'));
  // bump-version.mjs imports ./release-notes-gate.mjs at load — mirror it too,
  // or the throwaway script crashes on module resolution (fe-37).
  writeFileSync(
    resolve(dir, 'scripts', 'release-notes-gate.mjs'),
    readFileSync(resolve(here, '..', 'release-notes-gate.mjs'), 'utf8'),
  );

  // Init throwaway git repo with a local identity so commits work in CI.
  // env: cleanGitEnv() so a parent git-hook context doesn't redirect these
  // commits into the calling worktree (see cleanGitEnv() above).
  const env = cleanGitEnv();
  gitExec( ['init', '-q', '-b', 'main'], { cwd: dir, env });
  gitExec( ['config', 'user.email', 'test@example.com'], { cwd: dir, env });
  gitExec( ['config', 'user.name', 'Test'], { cwd: dir, env });
  gitExec( ['add', '.'], { cwd: dir, env });
  gitExec( ['commit', '-q', '-m', 'chore: seed'], { cwd: dir, env });
  return dir;
}

function readVersion(dir, relative) {
  return JSON.parse(readFileSync(resolve(dir, relative), 'utf8')).version;
}

function runBump(dir, args) {
  return spawnSync('node', [resolve(dir, 'scripts', 'bump-version.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
}

test('bump-version --dry-run prints the plan and does not mutate', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'minor', '--dry-run']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[PLAN\] bump 1\.0\.0 -> 1\.1\.0/);
    assert.match(out.stdout, /cross-OS gate: ON/);
    assert.match(out.stdout, /DRY-RUN/);

    // Nothing mutated.
    assert.equal(readVersion(dir, 'package.json'), '1.0.0');
    assert.equal(readVersion(dir, 'server/package.json'), '1.0.0');
    const tags = gitExec( ['tag', '--list'], { cwd: dir, encoding: 'utf8' });
    assert.equal(tags.trim(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --level patch advances both versions, commits, tags', () => {
  const dir = setupRepo('1.2.3');
  try {
    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '1.2.4');
    assert.equal(readVersion(dir, 'server/package.json'), '1.2.4');
    assert.equal(readVersion(dir, 'package-lock.json'), '1.2.4');
    assert.equal(readVersion(dir, 'server/package-lock.json'), '1.2.4');

    const subject = gitExec( ['log', '-1', '--pretty=%s'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    assert.equal(subject, 'chore: bump version to 1.2.4');

    const tags = gitExec( ['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(tags, 'v1.2.4');

    const annotation = gitExec(['tag', '-l', '--format=%(contents)', 'v1.2.4'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.match(annotation, /v1\.2\.4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --level minor zeros the patch field', () => {
  const dir = setupRepo('2.4.7');
  try {
    const out = runBump(dir, ['--level', 'minor', '--skip-cross-os', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '2.5.0');
    assert.equal(readVersion(dir, 'server/package.json'), '2.5.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --level major zeros minor + patch', () => {
  const dir = setupRepo('3.4.5');
  try {
    const out = runBump(dir, ['--level', 'major', '--skip-cross-os', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '4.0.0');
    assert.equal(readVersion(dir, 'server/package.json'), '4.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses lockstep drift', () => {
  const dir = setupRepo('1.0.0');
  try {
    /* Manually drift the server version + commit so the working tree is
       clean. The bump script's lockstep pre-flight must reject this. */
    writeFileSync(
      resolve(dir, 'server', 'package.json'),
      JSON.stringify({ name: 'fixture-server', version: '1.0.1', private: true }, null, 2),
    );
    gitExec( ['add', 'server/package.json'], { cwd: dir });
    gitExec( ['commit', '-q', '-m', 'drift'], { cwd: dir });

    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os', '--allow-placeholder']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Lockstep invariant violated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --notes-file uses file content as the tag annotation', () => {
  const dir = setupRepo('1.0.0');
  try {
    /* Author the notes file OUTSIDE the repo so it doesn't show up as
       untracked in `git status` and trip the clean-tree pre-flight. The
       real workflow has the same shape: deployer keeps notes wherever
       (Desktop, Notes app), passes the path with --notes-file. */
    const notes = resolve(tmpdir(), `bump-notes-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- the bug\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);

    const annotation = gitExec(['tag', '-l', '--format=%(contents)', 'v1.0.1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.match(annotation, /Fixes:/);
    assert.match(annotation, /the bug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version rejects an unknown --level', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'wibble']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /--level must be patch \| minor \| major/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses a dirty tree (unless --dry-run)', () => {
  const dir = setupRepo('1.0.0');
  try {
    writeFileSync(resolve(dir, 'package.json'), '{"name":"fixture-root","version":"1.0.0","x":1}');
    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /Working tree is not clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Regression for the bump-version env-leak fix (plan 85): a polluted GIT_DIR / GIT_WORK_TREE /
   GIT_INDEX_FILE env (the shape husky's pre-commit hook produces when run
   inside a worktree) must NOT misdirect any subprocess call in this test
   to the parent repo. Before the fix, two bare execFileSync('git', …)
   callsites bypassed gitExec()'s env scrubbing — they read `git tag -l`
   from whichever repo the leaked GIT_DIR pointed at, which in worktree
   pre-commit was the parent .git (no v1.0.1 tag there → empty annotation
   → `assert.match(annotation, /Fixes:/)` fails with actual: ''). */
test('polluted GIT_* env cannot misdirect subprocess from throwaway repo', () => {
  const dir = setupRepo('1.0.0');
  const saved = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  try {
    process.env.GIT_DIR = resolve(tmpdir(), 'sentinel.git');
    process.env.GIT_WORK_TREE = resolve(tmpdir(), 'sentinel-worktree');
    process.env.GIT_INDEX_FILE = resolve(tmpdir(), 'sentinel-index');

    const notes = resolve(tmpdir(), `bump-notes-leak-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- the leak\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);

    /* Tag-annotation read was the canonical failing line pre-fix. */
    const annotation = gitExec(['tag', '-l', '--format=%(contents)', 'v1.0.1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.match(annotation, /Fixes:/);
    assert.match(annotation, /the leak/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Regression for the v1.4.0 ship: the bumper invoked `git tag -a -F` with
   git's default cleanup mode, which strips lines starting with `#` as
   commentary. The CONTRIBUTING.md "Release notes" spec mandates `##
   Features` / `## Fixes` / `## Engineering` section headers; default
   cleanup silently ate all three on the v1.4.0 tag, so the GitHub
   Release body rendered as one long blob. Fix is `--cleanup=verbatim`
   in scripts/bump-version.mjs. This test pins the survival of `##`
   headers so the regression can't sneak back. */
test('bump-version preserves ## section headers in the tag annotation', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-headers-${process.pid}-${Date.now()}.md`);
    writeFileSync(
      notes,
      'v1.0.1 — headline\n' +
        '\nIntro paragraph.\n' +
        '\n## Features\n' +
        '\n**Surface area.** Body paragraph.\n' +
        '\n## Fixes\n' +
        '\n- Bug fixed.\n' +
        '\n## Engineering\n' +
        '\n- Mechanical detail.\n',
    );
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);

    const annotation = gitExec(['tag', '-l', '--format=%(contents)', 'v1.0.1'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.match(annotation, /^## Features$/m, 'expected ## Features header to survive');
    assert.match(annotation, /^## Fixes$/m, 'expected ## Fixes header to survive');
    assert.match(annotation, /^## Engineering$/m, 'expected ## Engineering header to survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Plan 127 — cross-OS gate. The throwaway repo has no `gh` and no remote, so
   the gate-on path can't run here; --skip-cross-os reverts to the local-only
   flow and is what every post-state test above passes. This pins that the
   skip prints its notice AND still produces the bump + tag. */
test('bump-version --skip-cross-os skips the gate and still bumps + tags', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[SKIP\] cross-OS gate skipped/);
    assert.equal(readVersion(dir, 'package.json'), '1.0.1');
    const tags = gitExec(['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(tags, 'v1.0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* code-stats hook — bump-version refreshes the narrative stats best-effort.
   The throwaway fixture mirrors only bump-version.mjs (no scripts/code-stats.mjs,
   no docs/), so the refresh must SKIP cleanly: the dry-run plan reports it's
   skipped, and a real bump prints the [SKIP] notice while still bumping + tagging
   (i.e. a missing code-stats.mjs never blocks a release). */
test('bump-version reports code-stats skipped in --dry-run when the script is absent', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'patch', '--dry-run']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[PLAN\] refresh code stats: skipped \(scripts\/code-stats\.mjs absent\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version skips the code-stats refresh (script absent) but still bumps + tags', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[SKIP\] code-stats: scripts\/code-stats\.mjs not found/);
    assert.equal(readVersion(dir, 'package.json'), '1.0.1');
    const tags = gitExec(['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(tags, 'v1.0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Plan 127 — pickWorkflowRun is the pure run-discovery the gate uses to map a
   `gh workflow run` dispatch to the run it must `gh run watch`. It keys on the
   head SHA cross-OS is validating + a workflow_dispatch event + a freshness
   window, so it can't latch onto the weekly cron or a stale/concurrent run. */
const PICK_SHA = 'abc123def456';
const PICK_NOW = Date.UTC(2026, 4, 28, 12, 0, 0); // fixed dispatch instant
function mkRun(over = {}) {
  return {
    databaseId: 111,
    headSha: PICK_SHA,
    event: 'workflow_dispatch',
    status: 'queued',
    conclusion: null,
    createdAt: new Date(PICK_NOW + 1000).toISOString(), // just after dispatch
    ...over,
  };
}

test('pickWorkflowRun picks the fresh head-SHA workflow_dispatch run', () => {
  assert.equal(pickWorkflowRun([mkRun()], { headSha: PICK_SHA, sinceMs: PICK_NOW }), 111);
});

test('pickWorkflowRun ignores a run on a different head SHA', () => {
  assert.equal(
    pickWorkflowRun([mkRun({ headSha: 'othersha' })], { headSha: PICK_SHA, sinceMs: PICK_NOW }),
    null,
  );
});

test('pickWorkflowRun ignores non-workflow_dispatch events (e.g. the weekly cron)', () => {
  assert.equal(
    pickWorkflowRun([mkRun({ event: 'schedule' })], { headSha: PICK_SHA, sinceMs: PICK_NOW }),
    null,
  );
});

test('pickWorkflowRun ignores a stale run created before the dispatch window', () => {
  const stale = mkRun({ createdAt: new Date(PICK_NOW - 60_000).toISOString() });
  assert.equal(pickWorkflowRun([stale], { headSha: PICK_SHA, sinceMs: PICK_NOW }), null);
});

test('pickWorkflowRun tolerates a small clock skew (timestamp just before sinceMs)', () => {
  const skewed = mkRun({ databaseId: 222, createdAt: new Date(PICK_NOW - 5000).toISOString() });
  assert.equal(pickWorkflowRun([skewed], { headSha: PICK_SHA, sinceMs: PICK_NOW }), 222);
});

test('pickWorkflowRun picks the newest among multiple matches', () => {
  const older = mkRun({ databaseId: 1, createdAt: new Date(PICK_NOW + 1000).toISOString() });
  const newer = mkRun({ databaseId: 2, createdAt: new Date(PICK_NOW + 9000).toISOString() });
  assert.equal(pickWorkflowRun([older, newer], { headSha: PICK_SHA, sinceMs: PICK_NOW }), 2);
});

test('pickWorkflowRun returns null for empty or non-array input', () => {
  assert.equal(pickWorkflowRun([], { headSha: PICK_SHA, sinceMs: PICK_NOW }), null);
  assert.equal(pickWorkflowRun(null, { headSha: PICK_SHA, sinceMs: PICK_NOW }), null);
});

// fs-1 — sidecar version.py lockstep helpers.
test('readSidecarVersion / writeSidecarVersion round-trip and preserve the docstring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bump-sidecar-'));
  try {
    const py = sidecarVersionPath(dir);
    mkdirSync(dirname(py), { recursive: true });
    writeFileSync(py, '"""docstring."""\n\n__version__ = "1.5.1"\n');
    assert.equal(readSidecarVersion(dir), '1.5.1');

    writeSidecarVersion(dir, '1.6.0');
    assert.equal(readSidecarVersion(dir), '1.6.0');
    // The docstring above the version line survives the rewrite.
    assert.match(readFileSync(py, 'utf8'), /"""docstring\."""/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSidecarVersion returns null when version.py is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bump-sidecar-none-'));
  try {
    assert.equal(readSidecarVersion(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// plan 188 — companion pubspec lockstep helpers.
test('pubspec version helpers round-trip with a monotonic build number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bump-pubspec-'));
  try {
    const p = pubspecPath(dir);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'name: x\nversion: 1.0.0+1\nenvironment:\n  sdk: ^3.0.0\n');
    assert.equal(readPubspecVersion(dir), '1.0.0'); // drops the +build
    // ×1000 reserves a 3-digit build-iteration band (base+1, base+2, … for
    // successive Play uploads of the same marketing version) without colliding
    // with the next patch's base.
    assert.equal(pubspecBuildNumber('1.6.0'), 10600000);
    assert.equal(pubspecBuildNumber('2.13.4'), 21304000);
    // Iteration band stays below the next patch's base — no overlap.
    assert.ok(pubspecBuildNumber('1.6.0') + 999 < pubspecBuildNumber('1.6.1'));

    writePubspecVersion(dir, '1.6.0');
    assert.equal(readPubspecVersion(dir), '1.6.0');
    assert.match(readFileSync(p, 'utf8'), /^version: 1\.6\.0\+10600000$/m);
    assert.match(readFileSync(p, 'utf8'), /sdk: \^3\.0\.0/); // other lines survive
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPubspecVersion returns null when pubspec is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bump-pubspec-none-'));
  try {
    assert.equal(readPubspecVersion(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Release-notes safeguards (so a cut can't ship a placeholder body) ──

test('resolveNotesFile: explicit --notes-file always wins', () => {
  assert.equal(
    resolveNotesFile('custom/notes.md', () => true),
    'custom/notes.md',
  );
  // wins even if the default also exists
  assert.equal(
    resolveNotesFile('custom/notes.md', (p) => p === DEFAULT_NOTES_FILE),
    'custom/notes.md',
  );
});

test('resolveNotesFile: defaults to the canonical file when present', () => {
  assert.equal(
    resolveNotesFile(null, (p) => p === DEFAULT_NOTES_FILE),
    DEFAULT_NOTES_FILE,
  );
});

test('resolveNotesFile: null when nothing supplied and the default is absent', () => {
  // null is the "placeholder territory" main() refuses without --allow-placeholder
  assert.equal(
    resolveNotesFile(null, () => false),
    null,
  );
});

test('staleNotesVersion: flags a marker that does not match the cut version', () => {
  const notes = '<!--\nrelease-notes-next-version: 1.7.0\n-->\n# body';
  assert.equal(staleNotesVersion(notes, '1.8.0'), '1.7.0');
});

test('staleNotesVersion: null when the marker matches (v-prefix tolerated)', () => {
  assert.equal(staleNotesVersion('release-notes-next-version: v1.8.0', '1.8.0'), null);
});

test('staleNotesVersion: null when no marker is present (cannot verify, do not block)', () => {
  // The `vA.B.C...vX.Y.Z` changelog footer must NOT be mistaken for the marker.
  assert.equal(staleNotesVersion('body\n\n**Full changelog:** `v1.7.0...v1.8.0`', '1.8.0'), null);
});

test('bump-version refuses to cut without notes (no placeholder by default)', () => {
  const dir = setupRepo('1.0.0');
  try {
    // No docs/release-notes-next.md in the fixture, no --notes-file, no
    // --allow-placeholder → it must refuse rather than ship an empty body.
    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /No release notes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
