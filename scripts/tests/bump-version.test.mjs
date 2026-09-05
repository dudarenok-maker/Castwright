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
import { pickWorkflowRun, readSidecarVersion, writeSidecarVersion, sidecarVersionPath, readPubspecVersion, writePubspecVersion, pubspecPath, pubspecBuildNumber, resolveNotesFile, staleNotesVersion, DEFAULT_NOTES_FILE, buildTagMessage, createAnnotatedTag, execGit } from '../bump-version.mjs';
import { scrubGitEnv, scrubGitEnvForThrowawayRepo } from '../git-env.mjs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bumpScript = resolve(here, '..', 'bump-version.mjs');

// PR #2007 review, Major 2 — same literal used by release-notes-gate.test.mjs's
// mojibake fixtures: "É™" reads as a mangled "ə", so "CAFÉ™" is a legitimate,
// word-embedded false positive the allowlist marker exists for.
const CAFE = 'CAFÉ™';
const MOJIBAKE_EM_DASH = 'â€”'; // should decode to U+2014 —, standalone == unallowlistable

// Strip GIT_* env vars before spawning git in a throwaway repo. When this
// test runs from a git hook context (e.g. pre-commit via husky), the parent
// `git commit` sets GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX,
// which child processes inherit. Without sanitising, the test's `git commit`
// would write into the PARENT worktree's git instead of the temp fixture —
// silently creating bogus commits on whatever branch invoked the hook.
// Thin wrapper over the shared, broader-than-scrubGitEnv() helper — see
// git-env.mjs's scrubGitEnv() docstring for the case-insensitivity rationale,
// and why this needs a separate helper from scrubGitEnv().
function cleanGitEnv() {
  return scrubGitEnvForThrowawayRepo();
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
  // #2169/#2170 — bump-version.mjs also imports ./git-env.mjs (the shared
  // GIT_* env scrub) and ./release-body.mjs (the shared normaliser); mirror
  // both, or the throwaway script crashes on module resolution.
  writeFileSync(
    resolve(dir, 'scripts', 'git-env.mjs'),
    readFileSync(resolve(here, '..', 'git-env.mjs'), 'utf8'),
  );
  writeFileSync(
    resolve(dir, 'scripts', 'release-body.mjs'),
    readFileSync(resolve(here, '..', 'release-body.mjs'), 'utf8'),
  );
  // #2184 — bump-version.mjs also imports ./gh.mjs (the shared gh() chokepoint);
  // mirror it too, or the throwaway script crashes on module resolution.
  writeFileSync(
    resolve(dir, 'scripts', 'gh.mjs'),
    readFileSync(resolve(here, '..', 'gh.mjs'), 'utf8'),
  );
  // #2291 — bump-version.mjs (and release-notes-gate.mjs, release-body.mjs)
  // now import ./lib/is-main-module.mjs (the shared direct-execution guard);
  // mirror it too, or the throwaway script crashes on module resolution.
  mkdirSync(resolve(dir, 'scripts', 'lib'));
  writeFileSync(
    resolve(dir, 'scripts', 'lib', 'is-main-module.mjs'),
    readFileSync(resolve(here, '..', 'lib', 'is-main-module.mjs'), 'utf8'),
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

// #2169 — unlike runBump above (which always scrubs GIT_* from the child's
// env, so it can never exercise the production script's OWN internal
// scrub), this starts from the same clean baseline and then deliberately
// re-adds exactly the env vars under test — so a passing assertion proves
// bump-version.mjs's own git()/execGit scrub protected the run, not the test
// harness.
function runBumpWithEnv(dir, args, envOverrides) {
  return spawnSync('node', [resolve(dir, 'scripts', 'bump-version.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), ...envOverrides },
  });
}

// A second, independent throwaway git repo standing in for "whatever
// repository an inherited GIT_DIR/GIT_WORK_TREE happens to point at" —
// deliberately on a NON-'main' branch by default so a misdirected
// `git rev-parse --abbrev-ref HEAD` (bump-version's own pre-flight 2) fails
// loudly and unambiguously rather than coincidentally reading 'main' too.
function setupDecoyRepo(branchName = 'decoy-branch') {
  const dir = mkdtempSync(resolve(tmpdir(), 'bump-version-decoy-'));
  const env = cleanGitEnv();
  gitExec(['init', '-q', '-b', branchName], { cwd: dir, env });
  gitExec(['config', 'user.email', 'test@example.com'], { cwd: dir, env });
  gitExec(['config', 'user.name', 'Test'], { cwd: dir, env });
  writeFileSync(resolve(dir, 'seed.txt'), 'seed\n');
  gitExec(['add', '.'], { cwd: dir, env });
  gitExec(['commit', '-q', '-m', 'chore: seed decoy'], { cwd: dir, env });
  return dir;
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

/* Regression for #2140: the manual fallback recipe printed when there's no
   notes file (placeholder-tag branch) omitted --cleanup=verbatim, silently
   re-issuing the v1.4.0 header-stripping regression as advice. This pins
   the printed hint, not just the real tag call the test above already
   covers. Also pins the adjacent BOM caveat (round 1 review: keep the
   recipe a plain, typeable `git tag` line — a long inline BOM-strip
   pipeline is realistically mistyped under release pressure, which is the
   exact failure this hint exists to prevent). */
test('bump-version placeholder-tag fallback hint includes --cleanup=verbatim and the BOM note', () => {
  const dir = setupRepo('1.2.3');
  try {
    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[NOTE\] Tag annotation is a placeholder/);
    assert.match(out.stdout, /git tag -a v1\.2\.4 --cleanup=verbatim -F <path-to-notes\.md>/);
    assert.match(out.stdout, /must not carry a UTF-8 BOM/);
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

// #2170 (decided 2026-08-06, superseding the #2168-review WARNING-only shape) —
// release.yml's release-body.mjs publishes the GitHub release body from
// DEFAULT_NOTES_FILE only, never from whatever --notes-file supplied the tag
// annotation. A genuine divergence guarantees resolveReleaseBody's Rule 4
// fails the tag at PUBLISH time (after verify/cross-os-verify/mobile-e2e/
// companion-apk-build have all run, tag already pushed) — refuse at cut time
// instead, comparing under release-body.mjs's own `normalise`.
test('bump-version refuses at cut time when --notes-file genuinely diverges from the default', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the default file version.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const notes = resolve(tmpdir(), `bump-notes-nondefault-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- a DIFFERENT file entirely.\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /--notes-file .* and docs\/release-notes-next\.md disagree after normalising/);
    assert.match(out.stderr, /--allow-notes-divergence/);
    // Refuses BEFORE any of the expensive pre-flights (e.g. the clean-tree
    // check) even run — no working-tree mutation, no [PLAN] output at all.
    assert.doesNotMatch(out.stdout, /\[PLAN\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The identical-content-modulo-normalisation case: this is also the trap
// test for "same normaliser as release-body.mjs" (#2170 acceptance) — the
// two files differ RAW (CRLF vs LF line endings) but agree once normalised.
// If the implementation were ever swapped for a raw `===` comparison instead
// of the imported `normalise()`, this run would incorrectly refuse and this
// test would go red.
test('bump-version does not refuse when --notes-file normalise-equals the default (CRLF-only difference)', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the same content.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const notes = resolve(tmpdir(), `bump-notes-crlf-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\r\n\r\nFixes:\r\n- the same content.\r\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stderr, /disagree after normalising/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version --allow-notes-divergence permits a genuine divergence, with a warning', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the default file version.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const notes = resolve(tmpdir(), `bump-notes-override-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- a DIFFERENT file entirely.\n');
    const out = runBump(dir, [
      '--level',
      'patch',
      '--notes-file',
      notes,
      '--skip-cross-os',
      '--allow-notes-divergence',
    ]);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[WARN\] --allow-notes-divergence:.*disagree after normalising/);
    assert.equal(readVersion(dir, 'package.json'), '1.0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2175 review, Finding 3 — the divergence check above must resolve
// DEFAULT_NOTES_FILE against repoRoot, not the invocation's process.cwd().
// Run from server/ (a subdirectory of the repo root), mirroring `cd server
// && node ../scripts/bump-version.mjs … --notes-file <path>`: a bare-relative
// `existsSync(DEFAULT_NOTES_FILE)` resolves to `<repo>/server/docs/…`, which
// doesn't exist, so the unfixed check silently skips — the run succeeds with
// a genuinely divergent --notes-file, exactly the outcome #2170 exists to
// prevent. This test's --notes-file is an absolute tmpdir path (unaffected by
// cwd) so the only variable under test is DEFAULT_NOTES_FILE's resolution.
test('bump-version resolves DEFAULT_NOTES_FILE against repoRoot, not the invocation cwd, when checking notes divergence', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the default file version.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const notes = resolve(tmpdir(), `bump-notes-subdir-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- a DIFFERENT file entirely.\n');
    const out = spawnSync(
      'node',
      [resolve(dir, 'scripts', 'bump-version.mjs'), '--level', 'patch', '--notes-file', notes, '--skip-cross-os'],
      { cwd: resolve(dir, 'server'), encoding: 'utf8', env: cleanGitEnv() },
    );
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stderr, /--notes-file .* and docs\/release-notes-next\.md disagree after normalising/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2175 review, Finding 4 — every other CONDITIONAL pre-flight in main()
// reports rather than dies under --dry-run; a dry run mutates nothing, so
// refusing protects nothing while destroying the preview, and a dry run is
// exactly when an operator wants to be TOLD the real run would refuse.
// Asserts BOTH the downgrade (exit 0, [DRY-RUN][WARN] naming the escape
// hatch) AND that the run actually continued past the refusal ([PLAN] output
// follows) — a fix that merely swallowed the die() without continuing would
// pass the first assertion and fail the second.
test('bump-version --dry-run reports a notes-file divergence instead of refusing', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the default file version.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const notes = resolve(tmpdir(), `bump-notes-dryrun-divergence-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, '# v1.0.1\n\nFixes:\n- a DIFFERENT file entirely.\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--dry-run']);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /\[DRY-RUN\]\[WARN\].*disagree after normalising/);
    assert.match(out.stdout, /--allow-notes-divergence/);
    assert.match(out.stdout, /\[PLAN\]/, 'the run must continue past the refusal under --dry-run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2175 review, Finding 5 — the divergence check must compare
// buildTagMessage(explicitText) (BOM-stripped, matching what actually becomes
// the tag annotation), not raw explicitText, against the default file's raw
// text (matching what release-body.mjs reads at publish time). A BOM-prefixed
// --notes-file that is otherwise identical to the default must NOT report a
// (misleading) divergence — pre-flight 6c still refuses it, but with the
// accurate BOM diagnostic rather than the divergence one.
test('bump-version divergence check compares the BOM-stripped explicit text, not raw, so a BOM-only difference reports the accurate BOM message', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the same content.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const notes = resolve(tmpdir(), `bump-notes-bom-divergence-${process.pid}-${Date.now()}.md`);
    // Real EF BB BF bytes on disk (writeBOMFile, defined below) — not a JS
    // string escape — so this proves detection of the actual defect. See
    // writeBOMFile's own doc comment.
    writeBOMFile(notes, '# v1.0.1\n\nFixes:\n- the same content.\n');
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0, out.stdout);
    assert.doesNotMatch(out.stderr, /disagree after normalising/);
    assert.match(out.stderr, /BOM/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version does not warn on the default path (no --notes-file given)', () => {
  const dir = setupRepo('1.0.0');
  try {
    mkdirSync(resolve(dir, 'docs'));
    writeFileSync(
      resolve(dir, 'docs', 'release-notes-next.md'),
      '# v1.0.1\n\nFixes:\n- the default file version.\n',
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add default notes file'], { cwd: dir });

    const out = runBump(dir, ['--level', 'patch', '--skip-cross-os']);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /\[WARN\] --notes-file/);
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

// #2169 — pure unit test of the scrub itself: every repository-discovery
// override git checks BEFORE falling back to `cwd` gets stripped, and
// nothing else does. Mutation-sensitive per key: dropping any one entry from
// GIT_ENV_SCRUB_KEYS fails exactly that assertion.
//
// #2216 correction: GIT_INDEX_FILE is deliberately NOT one of these keys and
// this test now pins that as an explicit assertion, not an omission. It
// answers "which index", not "which repository" — the other four vars'
// class — and a caller reading the staged set (verify-cache.mjs's
// stagedDiffFiles()) must honour whichever index git handed it (a hook's
// temporary index for `git commit -a` / `git commit -- <path>`), not the
// one this repo assumes. Scrubbing it doesn't prevent redirection; it
// manufactures a wrong (or silently empty) answer. See git-env.mjs's header
// for the measured evidence.
test('scrubGitEnv strips every git repository-discovery override, preserves GIT_INDEX_FILE and everything else', () => {
  const fakeEnv = {
    PATH: '/usr/bin',
    GIT_DIR: '/decoy/.git',
    GIT_WORK_TREE: '/decoy',
    GIT_INDEX_FILE: '/decoy/.git/index',
    GIT_OBJECT_DIRECTORY: '/decoy/.git/objects',
    GIT_COMMON_DIR: '/decoy/.git',
    GIT_AUTHOR_NAME: 'Someone', // NOT a discovery override — must survive
  };
  const scrubbed = scrubGitEnv(fakeEnv);
  assert.equal(scrubbed.GIT_DIR, undefined);
  assert.equal(scrubbed.GIT_WORK_TREE, undefined);
  assert.equal(scrubbed.GIT_OBJECT_DIRECTORY, undefined);
  assert.equal(scrubbed.GIT_COMMON_DIR, undefined);
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.GIT_AUTHOR_NAME, 'Someone');
  // Deliberately preserved — see the #2216 correction above.
  assert.equal(scrubbed.GIT_INDEX_FILE, '/decoy/.git/index');
});

// Case-insensitivity regression for THIS file's own cleanGitEnv(), the same
// trap scrubGitEnv() was hardened against below (#2175 review, Finding 1).
// cleanGitEnv() hand-rolls its own filter rather than delegating to
// scrubGitEnv() (it must also strip GIT_INDEX_FILE, which scrubGitEnv()
// deliberately preserves — see the #2216 note above), so it needs its own
// case-insensitive regression. Deliberately mixed-case-only: cannot pass
// against a `key.startsWith('GIT_')` filter.
test('cleanGitEnv strips a git env override regardless of stored casing', () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('GIT_')) delete process.env[key];
    }
    process.env.git_dir = '/decoy/.git';
    process.env.Git_Index_File = '/decoy/.git/index';

    const cleaned = cleanGitEnv();
    assert.equal(cleaned.git_dir, undefined);
    assert.equal(cleaned.Git_Index_File, undefined);
    // Non-GIT_ keys are untouched — spot-check against whichever casing this
    // OS actually stores the PATH var under (Windows: "Path").
    const pathKey = Object.keys(cleaned).find((k) => k.toUpperCase() === 'PATH');
    assert.ok(pathKey, 'PATH must survive the scrub');
    assert.equal(cleaned[pathKey], saved[pathKey]);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

// #2175 review, Finding 1 — Windows env lookup is case-insensitive, but
// `{ ...process.env }` snapshots whatever casing the OS happened to store a
// variable under. A `delete out[key]` keyed on the canonical uppercase name
// alone leaves a `git_dir`-cased survivor in the scrubbed object, and git
// (case-insensitively, on Windows) still honours it — a no-op fix for
// exactly this case. This fixture is deliberately mixed-case-only (unlike
// the uppercase-only fixture above) so it cannot pass against the
// pre-fix implementation.
test('scrubGitEnv strips a git repo-discovery override regardless of stored casing', () => {
  const fakeEnv = {
    PATH: '/usr/bin',
    git_dir: '/decoy/.git',
    Git_Work_Tree: '/decoy',
    GIT_AUTHOR_NAME: 'Someone', // NOT a discovery override — must survive
  };
  const scrubbed = scrubGitEnv(fakeEnv);
  assert.equal(scrubbed.git_dir, undefined);
  assert.equal(scrubbed.Git_Work_Tree, undefined);
  assert.ok(!Object.keys(scrubbed).some((k) => k.toUpperCase() === 'GIT_DIR'));
  assert.ok(!Object.keys(scrubbed).some((k) => k.toUpperCase() === 'GIT_WORK_TREE'));
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.GIT_AUTHOR_NAME, 'Someone');
});

// #2175 review, Finding 6 — execGit spread `...options` THEN set
// `env: scrubGitEnv()`, so a caller-supplied `options.env` was silently
// discarded rather than merged into the scrub. No live bug today (no call
// site passes one), but it breaks the file's own stated contract ("a git
// call added later inherits the fix" — see execGit's doc comment): a future
// call site passing its own env would have that env thrown away instead of
// scrubbed-and-honoured. Proven by an observable side effect of the child
// process (GIT_AUTHOR_DATE / GIT_COMMITTER_DATE change what `git log`
// reports) rather than by inspecting execFileSync's call arguments, so this
// can't be satisfied by a mock that merely records what it was passed.
test('execGit merges a caller-supplied env with the scrub rather than discarding it', () => {
  const dir = setupRepo('1.0.0');
  try {
    writeFileSync(resolve(dir, 'extra.txt'), 'x\n');
    execGit(['add', 'extra.txt'], { cwd: dir, env: cleanGitEnv() });
    const customDate = 'Wed, 15 Jan 2020 00:00:00 +0000';
    execGit(['commit', '-m', 'chore: custom-date commit'], {
      cwd: dir,
      env: { ...cleanGitEnv(), GIT_AUTHOR_DATE: customDate, GIT_COMMITTER_DATE: customDate },
      stdio: 'ignore',
    });
    const authorDate = execGit(['log', '-1', '--format=%aD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    assert.equal(authorDate, customDate);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2175 review, Finding 2 — `gh` resolves its target repository the same
// GIT_DIR-first way git does, so every `gh` call site needs the same scrub
// the git() helper already gets. bump-version.mjs used to carry its own
// local gh()/ghAvailable()/`gh run watch` trio and this file asserted each
// one scrubbed its env by slicing the source around those three names.
// #2184 replaced ALL of that with a single shared chokepoint
// (scripts/gh.mjs's gh()/ghSpawn(), which unconditionally scrub) that every
// gh-calling script under scripts/ — including this one — now imports
// instead of growing its own copy. The enumerating, three-names-only check
// this comment used to guard is gone; scripts/tests/gh-chokepoint.test.mjs
// asserts the stronger, repo-wide invariant instead: no script anywhere
// under scripts/ may call the `gh` binary directly except gh.mjs itself.

// #2169's own regression test, as specified on the ticket: set GIT_DIR to a
// decoy repo, call createAnnotatedTag({ repoRoot: realRepo, … }) DIRECTLY
// (bypassing main()'s spawn, the same shape as the BOM direct-call test
// above), and assert the tag exists in the real repo and is ABSENT from the
// decoy — not merely present in the real one, which a no-op fix could also
// satisfy if git happened to write to both. Empirically confirmed before
// writing this test (`git tag -a` with only GIT_DIR set, cwd elsewhere,
// writes into whatever GIT_DIR names — the tag never reaches the real repo
// at all when unfixed, it doesn't just ALSO land in the decoy).
test('createAnnotatedTag resolves repoRoot even with an inherited GIT_DIR pointing at a decoy repo (#2169)', () => {
  const dir = setupRepo('1.0.0');
  const decoy = setupDecoyRepo();
  const notes = resolve(tmpdir(), `bump-notes-gitdir-decoy-${process.pid}-${Date.now()}.md`);
  writeFileSync(notes, '# v9.9.8\n\nFixes:\n- the GIT_DIR leak\n');
  const savedGitEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      savedGitEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.GIT_DIR = resolve(decoy, '.git');
  try {
    createAnnotatedTag({
      repoRoot: dir,
      newTag: 'bump-version-test-gitdir-decoy',
      notesFile: notes,
    });

    const realTags = gitExec(['tag', '--list', 'bump-version-test-gitdir-decoy'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
    assert.equal(realTags, 'bump-version-test-gitdir-decoy');

    const decoyTags = gitExec(['tag', '--list', 'bump-version-test-gitdir-decoy'], {
      cwd: decoy,
      encoding: 'utf8',
    }).trim();
    assert.equal(decoyTags, '', 'the tag must NOT land in the decoy repo GIT_DIR pointed at');
  } finally {
    delete process.env.GIT_DIR;
    for (const [k, v] of Object.entries(savedGitEnv)) process.env[k] = v;
    rmSync(notes, { force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

// #2169's GIT_WORK_TREE half, deliberately NOT shaped like the GIT_DIR test
// above. Empirically verified (see this PR's own investigation, not
// asserted from memory): `git tag -a` reads/writes only the ref + object
// database, which GIT_DIR controls — GIT_WORK_TREE alone does not affect it
// at all, with or without a fix, so a createAnnotatedTag-shaped test for
// GIT_WORK_TREE would be exactly the "test that cannot fail" shape this
// repo's history warns about (it would pass identically whether or not the
// scrub strips GIT_WORK_TREE). What GIT_WORK_TREE alone DOES misdirect is
// any git call that reads/writes working-tree files — `git status
// --porcelain`, the shared git() helper's pre-flight 1 clean-tree check —
// confirmed empirically: from a clean real repo, `GIT_WORK_TREE=<empty
// decoy dir> git status --porcelain` reports every tracked file as deleted.
// This test drives that through the real script end-to-end (runBumpWithEnv,
// not runBump — see its own comment) so a passing run proves the git()
// helper's scrub, not the createAnnotatedTag one.
test('bump-version resolves the working tree from repoRoot even with an inherited GIT_WORK_TREE (#2169)', () => {
  const dir = setupRepo('1.0.0');
  const decoy = mkdtempSync(resolve(tmpdir(), 'bump-version-decoy-worktree-'));
  try {
    const out = runBumpWithEnv(
      dir,
      ['--level', 'patch', '--skip-cross-os', '--allow-placeholder'],
      { GIT_WORK_TREE: decoy },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '1.0.1');
    const tags = gitExec(['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(tags, 'v1.0.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

// The GIT_DIR counterpart to the GIT_WORK_TREE test above, driven through
// the same runBumpWithEnv path so it exercises the shared git() helper (used
// by EVERY other git call in main() — status, rev-parse, tag --list) rather
// than only createAnnotatedTag's own call site. The decoy is on a
// non-'main' branch so an unfixed run can't accidentally read a coincidental
// 'main' back off it. Mutation-confirmed failure mode (GIT_ENV_SCRUB_KEYS
// with GIT_DIR removed): with GIT_WORK_TREE unset, git treats `cwd` (the
// real repo) as the work tree but the DECOY's `.git` as the index/ref
// database — so `git status --porcelain` (pre-flight 1) compares the real
// repo's files against the decoy's index and reports every real file as
// untracked/deleted, dying "Working tree is not clean" before pre-flight 2's
// branch check is even reached. Either die is proof of misdirection; this
// test only asserts the fixed run succeeds end-to-end.
test('bump-version resolves the repository from repoRoot even with an inherited GIT_DIR pointing at a decoy repo on another branch (#2169)', () => {
  const dir = setupRepo('1.0.0');
  const decoy = setupDecoyRepo('decoy-branch');
  try {
    const out = runBumpWithEnv(
      dir,
      ['--level', 'patch', '--skip-cross-os', '--allow-placeholder'],
      { GIT_DIR: resolve(decoy, '.git') },
    );
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readVersion(dir, 'package.json'), '1.0.1');

    const realTags = gitExec(['tag', '--list'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(realTags, 'v1.0.1');

    const decoyTags = gitExec(['tag', '--list'], { cwd: decoy, encoding: 'utf8' }).trim();
    assert.equal(decoyTags, '', 'the tag must NOT land in the decoy repo GIT_DIR pointed at');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
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

// PR #2007 review, Major 2 — bump-version.mjs's own pre-flight 6b call site
// (`formatHonouredEcho(args.notesFile, mojibakeCheck.honoured)` +
// `if (echo) info(echo)`) had no test at all: release-notes-gate.test.mjs
// only ever calls checkMojibake()/formatHonouredEcho() directly, never
// through this script's actual wiring. Deleting that call site is invisible
// to every other test in the suite (verified: the whole 76-test
// release-notes-gate.test.mjs + bump-version.test.mjs pair stays green with
// all three of this feature's call sites deleted at once).
test('bump-version echoes an honoured marker in --notes-file on stdout', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-marker-${process.pid}-${Date.now()}.md`);
    writeFileSync(
      notes,
      `<!-- release-notes-gate: allow "${CAFE}" -->\n\n# v1.0.1\n\nFixes:\n- ships with a ${CAFE} badge.\n`,
    );
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^\[allow\] .*honoured 1 literal\(s\): "CAFÉ™"$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2025 — the echo's ORDERING relative to its failure branch was untested:
// the test above only ever exercises a PASSING run (a clean --notes-file
// with just the allowlisted CAFÉ™ span). Verified during the PR #2007
// re-review: moving `if (echo) info(echo)` to sit AFTER the
// `if (!mojibakeCheck.ok)` block leaves the whole suite green while
// genuinely silencing the echo whenever the gate goes on to die/warn. This
// fixture pairs an armed CAFÉ™ marker with a SEPARATE, unallowlistable
// standalone mangle, so the run still fails overall but must still echo the
// marker it DID honour along the way.
test('bump-version echoes an honoured --notes-file marker even when the gate still fails', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-marker-fail-${process.pid}-${Date.now()}.md`);
    writeFileSync(
      notes,
      `<!-- release-notes-gate: allow "${CAFE}" -->\n\n# v1.0.1\n\nFixes:\n` +
        `- ships with a ${CAFE} badge.\n` +
        `- a ${MOJIBAKE_EM_DASH} standing alone.\n`,
    );
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0);
    assert.match(out.stdout, /^\[allow\] .*honoured 1 literal\(s\): "CAFÉ™"$/m);
    assert.match(out.stderr, /Mojibake gate.*1 double-UTF-8-encoded mojibake span/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PR #2007 review, Major 2 — bump-version.mjs's OTHER checkMojibake call site
// (pre-flight 5c, against the committed RELEASE_NOTES.md itself) is provably
// dead for a positive echo: the label there is always the literal string
// 'RELEASE_NOTES.md', and checkMojibake refuses outright as soon as any
// marker exists for that label (#1985), so `mojibakeCheck.honoured` can never
// be non-empty on this path — confirmed by running this exact scenario
// end-to-end. The `formatHonouredEcho`/`if (echo) info(echo)` pair was
// removed from that call site rather than tested with a fake positive case;
// this test pins the actual, only-possible behaviour instead: a marker in
// RELEASE_NOTES.md still produces the #1985 refusal (downgraded to a warning
// by --force here) and never an `[allow]` line.
test('bump-version never echoes a RELEASE_NOTES.md marker — it is refused instead', () => {
  const dir = setupRepo('1.0.0');
  try {
    writeFileSync(
      resolve(dir, 'RELEASE_NOTES.md'),
      `# v1.0.1\n\nFixes:\n<!-- release-notes-gate: allow "${CAFE}" -->\n- ships with a ${CAFE} badge.\n`,
    );
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add release notes'], { cwd: dir });

    const out = runBump(dir, ['--level', 'patch', '--force', '--allow-placeholder', '--skip-cross-os']);
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /^\[allow\]/m);
    assert.match(out.stdout, /mojibake gate \(--force\).*refused in RELEASE_NOTES\.md \(#1985\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2018 — unresolved git conflict markers must never ship. Unlike the
// mojibake gate above, this one has NO --force / --dry-run downgrade path:
// checkConflictMarkers' doc comment explains why (there is no legitimate
// reason for a marker to be here), and these three tests pin that bump-version
// actually enforces it unconditionally rather than routing it through the
// same force/dry-run branches as every other pre-flight in this file.
const CONFLICT_FIXTURE =
  '# v1.0.1\n\nFixes:\n<<<<<<< HEAD\n- Ours.\n=======\n- Theirs.\n>>>>>>> origin/main\n';

test('bump-version refuses on a conflict marker in RELEASE_NOTES.md, even with --force', () => {
  const dir = setupRepo('1.0.0');
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), CONFLICT_FIXTURE);
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add release notes'], { cwd: dir });

    const out = runBump(dir, [
      '--level',
      'patch',
      '--force',
      '--allow-placeholder',
      '--skip-cross-os',
    ]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /RELEASE_NOTES\.md contains 2 unresolved git conflict marker/);
    assert.match(out.stderr, /line\(s\) 4, 8/);
    assert.match(out.stderr, /no allowlist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses on a conflict marker in RELEASE_NOTES.md even with --dry-run', () => {
  const dir = setupRepo('1.0.0');
  try {
    writeFileSync(resolve(dir, 'RELEASE_NOTES.md'), CONFLICT_FIXTURE);
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add release notes'], { cwd: dir });

    const out = runBump(dir, ['--level', 'patch', '--dry-run', '--allow-placeholder']);
    assert.notEqual(out.status, 0);
    assert.doesNotMatch(out.stdout, /DRY-RUN.*conflict/i);
    assert.match(out.stderr, /unresolved git conflict marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses on a conflict marker in --notes-file, even with --force', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-conflict-${process.pid}-${Date.now()}.md`);
    writeFileSync(notes, CONFLICT_FIXTURE);
    const out = runBump(dir, [
      '--level',
      'patch',
      '--notes-file',
      notes,
      '--force',
      '--allow-placeholder',
      '--skip-cross-os',
    ]);
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /unresolved git conflict marker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PR #2049 review, F5 — the conflict check (#2018) was a NEW early exit
// added in this same PR, and it originally ran BEFORE pre-flight 6b's
// mojibake echo: a --notes-file carrying both a conflict marker and an
// armed `allow` marker died naming only the conflict, with the armed marker
// never echoed that run — silently regressing #1990's "an armed marker is
// never silent" property. Fixed by computing 6b (and its echo) before 6a.
test('bump-version echoes an armed marker even when a conflict marker is what fails the run', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-conflict-and-marker-${process.pid}-${Date.now()}.md`);
    writeFileSync(
      notes,
      `<!-- release-notes-gate: allow "${CAFE}" -->\n\n# v1.0.1\n\nFixes:\n` +
        `- ships with a ${CAFE} badge.\n\n${CONFLICT_FIXTURE}`,
    );
    const out = runBump(dir, ['--level', 'patch', '--notes-file', notes, '--skip-cross-os']);
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /unresolved git conflict marker/);
    assert.match(out.stdout, /^\[allow\] .*honoured 1 literal\(s\): "CAFÉ™"$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version does not false-positive on a RELEASE_NOTES.md with no conflict markers', () => {
  const dir = setupRepo('1.0.0');
  try {
    const out = runBump(dir, ['--level', 'patch', '--dry-run', '--allow-placeholder']);
    assert.equal(out.status, 0, out.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2114 — a UTF-8 BOM must never lead RELEASE_NOTES.md or a --notes-file:
// docs/release-notes-next.md (the default --notes-file) is fed verbatim into
// the annotated tag message, which release.yml publishes as the public
// GitHub release body. Real EF BB BF bytes are written on disk (not a JS
// string via 'utf8' encoding) so these tests prove detection of the actual
// defect, not a string-level stand-in a BOM-stripping reader could silently
// normalise away.
function writeBOMFile(path, text) {
  writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
}

test('bump-version refuses on a BOM in RELEASE_NOTES.md, even with --force', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notesPath = resolve(dir, 'RELEASE_NOTES.md');
    writeBOMFile(notesPath, '# v1.0.1\n\n- Something shipped.\n');
    assert.deepEqual([...readFileSync(notesPath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add release notes'], { cwd: dir });

    const out = runBump(dir, [
      '--level',
      'patch',
      '--force',
      '--allow-placeholder',
      '--skip-cross-os',
    ]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /RELEASE_NOTES\.md begins with a UTF-8 byte-order mark/);
    assert.match(out.stderr, /EF BB BF/);
    assert.match(out.stderr, /no allowlist or --force/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses on a BOM in RELEASE_NOTES.md even with --dry-run', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notesPath = resolve(dir, 'RELEASE_NOTES.md');
    writeBOMFile(notesPath, '# v1.0.1\n\n- Something shipped.\n');
    gitExec(['add', '.'], { cwd: dir });
    gitExec(['commit', '-q', '-m', 'chore: add release notes'], { cwd: dir });

    const out = runBump(dir, ['--level', 'patch', '--dry-run', '--allow-placeholder']);
    assert.notEqual(out.status, 0);
    assert.doesNotMatch(out.stdout, /DRY-RUN.*byte-order mark/i);
    assert.match(out.stderr, /byte-order mark/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump-version refuses on a BOM in --notes-file, even with --force', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-bom-${process.pid}-${Date.now()}.md`);
    writeBOMFile(notes, '# v1.0.1\n\nFixes:\n- the bug\n');
    const out = runBump(dir, [
      '--level',
      'patch',
      '--notes-file',
      notes,
      '--force',
      '--allow-placeholder',
      '--skip-cross-os',
    ]);
    rmSync(notes, { force: true });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /begins with a UTF-8 byte-order mark/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Direct unit test of the defensive strip (#2114): even though the
// unconditional pre-flight above already refuses to reach the tag-creation
// step with a BOM-prefixed --notes-file, buildTagMessage is the seam that
// actually decides what git receives — this pins that it strips the BOM
// regardless, independent of whether the pre-flight ran at all. BOM_CHAR is
// built via fromCharCode, not an embedded literal, so this test file itself
// carries no raw BOM source bytes outside the deliberate byte-level fixture
// above.
const BOM_CHAR = String.fromCharCode(0xfeff);

test('buildTagMessage produces BOM-free output from BOM-prefixed input', () => {
  assert.equal(buildTagMessage(`${BOM_CHAR}# v1.0.1\n\n- the bug\n`), '# v1.0.1\n\n- the bug\n');
  assert.equal(buildTagMessage('# v1.0.1\n\n- the bug\n'), '# v1.0.1\n\n- the bug\n'); // no-op
});

// Direct unit test of createAnnotatedTag itself (#2139). Pre-flight 6c
// already refuses to reach the tag step with a BOM-prefixed --notes-file, so
// a run through main() can never legitimately drive a BOM through to the tag
// call — the test above only pins buildTagMessage in isolation, not the
// actual `git tag` call site. This test calls createAnnotatedTag directly,
// bypassing main() (and so bypassing pre-flight 6c) on purpose: that bypass
// is exactly what lets a test exercise the tag-creation unit's own stated
// guarantee — "even if the pre-flight is reordered or bypassed, a BOM cannot
// get through here" — independent of whether the pre-flight ran. Real
// EF BB BF bytes on disk (writeBOMFile above), not a JS string, for the same
// reason the pre-flight tests use them.
//
// Historical note (pre-#2169): createAnnotatedTag's own execFileSync used to
// have no `env` override at all — called DIRECTLY, in-process, it inherited
// process.env verbatim, so when this suite ran from inside a `git commit`
// (husky's pre-commit hook), the parent commit's GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE leaked straight through and redirected the tag write at the
// REAL calling repo instead of the throwaway fixture (caught during this
// test's own development: it left a stray tag in this repo). #2169 fixed
// createAnnotatedTag to scrub those vars itself (via the shared
// scrubGitEnv(), see git-env.mjs and the dedicated GIT_DIR-decoy test
// above), so this manual sanitise-around-the-call is now redundant
// belt-and-suspenders rather than load-bearing — kept anyway so this test
// still passes unmodified even if a future change ever narrowed the
// production scrub back down.
test('createAnnotatedTag strips a BOM even when called directly, bypassing pre-flight 6c', () => {
  const dir = setupRepo('1.0.0');
  try {
    const notes = resolve(tmpdir(), `bump-notes-direct-bom-${process.pid}-${Date.now()}.md`);
    writeBOMFile(notes, '# v9.9.9\n\nFixes:\n- the bug\n');
    const savedGitEnv = {};
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('GIT_')) {
        savedGitEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    try {
      createAnnotatedTag({ repoRoot: dir, newTag: 'bump-version-test-direct-bom', notesFile: notes });
      const annotation = gitExec(
        ['tag', '-l', '--format=%(contents)', 'bump-version-test-direct-bom'],
        { cwd: dir, encoding: 'utf8' },
      );
      assert.ok(!annotation.startsWith(BOM_CHAR), 'tag annotation must not start with a BOM');
      assert.match(annotation, /# v9\.9\.9/);
      assert.match(annotation, /Fixes:/);
    } finally {
      for (const [k, v] of Object.entries(savedGitEnv)) process.env[k] = v;
      rmSync(notes, { force: true });
    }
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
