// #2137 — pin scripts/release-body.mjs, which decides the string
// release.yml actually publishes as the GitHub release body.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// Strategy mirrors scripts/tests/bump-version.test.mjs: a throwaway git repo
// per test, with scripts/release-body.mjs + scripts/release-notes-gate.mjs
// (its one dependency) mirrored in so the spawned CLI can resolve its own
// imports. Every fixture tag is deliberately NOT `v*`-shaped — this repo's
// real release.yml triggers on a `v*.*.*` tag push, and a stray one here
// must never be mistakable for a real release tag even though these tags
// never leave the throwaway repo / never get pushed to origin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalise, readTagAnnotation } from '../release-body.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bodyScript = resolve(here, '..', 'release-body.mjs');
const gateScript = resolve(here, '..', 'release-notes-gate.mjs');
const gitEnvScript = resolve(here, '..', 'git-env.mjs');

// Built via fromCharCode, not an embedded literal, so this file — which
// specifically tests BOM handling — never carries a raw BOM in its own
// source bytes. Same rationale as release-notes-gate.mjs's own BOM const.
const BOM_CHAR = String.fromCharCode(0xfeff);

// Same literal used by release-notes-gate.test.mjs / bump-version.test.mjs's
// mojibake fixtures: "â€”" reads back as a mangled em dash, standing alone
// between spaces so it is not allowlistable (see release-notes-gate.mjs's
// suggestLiteral 'standalone' branch) — exactly the shape that must fail.
const MOJIBAKE_EM_DASH = 'â€”';

// Same literal used by release-notes-gate.test.mjs / bump-version.test.mjs's
// mojibake fixtures: a legitimate, word-embedded false positive (an accented
// letter immediately adjacent to punctuation) — allowlistable, unlike the
// standalone MOJIBAKE_EM_DASH above.
const CAFE = 'CAFÉ™';

const CONFLICT_FIXTURE =
  '- **Line before.**\n' +
  '<<<<<<< HEAD\n' +
  '- **Ours.**\n' +
  '=======\n' +
  '- **Theirs.**\n' +
  '>>>>>>> origin/main\n' +
  '- **Line after.**\n';

// Strip GIT_* env vars before spawning git in a throwaway repo. When this
// suite runs from inside husky's pre-commit hook, the parent `git commit`
// sets GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX, which a child
// process inherits unless explicitly overridden — redirecting a "throwaway"
// git write at the REAL calling repo instead (bump-version.test.mjs hit
// this for real: a stray tag landed in this worktree). Every git
// invocation below, and every spawned `node release-body.mjs` process,
// passes this explicit env instead of inheriting process.env.
// Thin wrapper over the shared, broader-than-scrubGitEnv() helper — see
// git-env.mjs's scrubGitEnv() docstring for the case-insensitivity rationale,
// and why this needs a separate helper from scrubGitEnv().
function cleanGitEnv() {
  return scrubGitEnvForThrowawayRepo();
}

function gitExec(args, opts = {}) {
  return execFileSync('git', args, { ...opts, env: cleanGitEnv(), windowsHide: true });
}

function setupRepo() {
  const dir = mkdtempSync(resolve(tmpdir(), 'release-body-test-'));
  mkdirSync(resolve(dir, 'scripts'));
  mkdirSync(resolve(dir, 'docs'));
  writeFileSync(resolve(dir, 'scripts', 'release-body.mjs'), readFileSync(bodyScript, 'utf8'));
  writeFileSync(resolve(dir, 'scripts', 'release-notes-gate.mjs'), readFileSync(gateScript, 'utf8'));
  // #2169 — release-body.mjs also imports ./git-env.mjs; mirror it too, or
  // the spawned CLI crashes on module resolution.
  writeFileSync(resolve(dir, 'scripts', 'git-env.mjs'), readFileSync(gitEnvScript, 'utf8'));
  // #2291 — release-body.mjs (and release-notes-gate.mjs) now import
  // ./lib/is-main-module.mjs (the shared direct-execution guard); mirror it
  // too, or the spawned CLI crashes on module resolution.
  mkdirSync(resolve(dir, 'scripts', 'lib'));
  writeFileSync(
    resolve(dir, 'scripts', 'lib', 'is-main-module.mjs'),
    readFileSync(resolve(here, '..', 'lib', 'is-main-module.mjs'), 'utf8'),
  );

  const env = cleanGitEnv();
  gitExec(['init', '-q', '-b', 'main'], { cwd: dir, env });
  gitExec(['config', 'user.email', 'test@example.com'], { cwd: dir, env });
  gitExec(['config', 'user.name', 'Test'], { cwd: dir, env });
  gitExec(['add', '.'], { cwd: dir, env });
  gitExec(['commit', '-q', '-m', 'chore: seed'], { cwd: dir, env });
  return dir;
}

// `--cleanup=verbatim` mirrors bump-version.mjs's own createAnnotatedTag —
// keeps the message byte-for-byte (no `#`-comment stripping), which matters
// for the conflict-marker fixture above (a bare `-F -`/default cleanup mode
// would not mangle it either, but verbatim is what production actually
// uses, so the fixture matches the real call shape).
function makeAnnotatedTag(dir, tagName, message) {
  execFileSync('git', ['tag', '--cleanup=verbatim', '-a', tagName, '-F', '-'], {
    cwd: dir,
    input: message,
    encoding: 'utf8',
    env: cleanGitEnv(),
    windowsHide: true,
  });
}

// #2169 — a second, independent throwaway repo carrying a tag of the SAME
// name as the real one but distinguishable content, standing in for
// "whatever repository an inherited GIT_DIR happens to point at".
function setupDecoyRepoWithTag(tagName, message) {
  const dir = mkdtempSync(resolve(tmpdir(), 'release-body-decoy-'));
  const env = cleanGitEnv();
  gitExec(['init', '-q', '-b', 'main'], { cwd: dir, env });
  gitExec(['config', 'user.email', 'test@example.com'], { cwd: dir, env });
  gitExec(['config', 'user.name', 'Test'], { cwd: dir, env });
  writeFileSync(resolve(dir, 'seed.txt'), 'seed\n');
  gitExec(['add', '.'], { cwd: dir, env });
  gitExec(['commit', '-q', '-m', 'chore: seed decoy'], { cwd: dir, env });
  execFileSync('git', ['tag', '--cleanup=verbatim', '-a', tagName, '-F', '-'], {
    cwd: dir,
    input: message,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  return dir;
}

function writeNotesFile(dir, text) {
  writeFileSync(resolve(dir, 'docs', 'release-notes-next.md'), text, 'utf8');
}

// Always spawns a fresh `node` process with an explicit, sanitised env —
// never calls an exported function from release-body.mjs in-process, which
// is exactly the shape that leaked GIT_* into a throwaway repo elsewhere in
// this codebase (see cleanGitEnv's comment above).
function runReleaseBody(dir, tag, outRelPath) {
  return spawnSync('node', [resolve(dir, 'scripts', 'release-body.mjs'), tag, outRelPath], {
    cwd: dir,
    encoding: 'utf8',
    env: cleanGitEnv(),
    windowsHide: true,
  });
}

test('annotation with a BOM blocks publish, naming the annotation', () => {
  const dir = setupRepo();
  try {
    makeAnnotatedTag(dir, 'release-body-test-bom', `${BOM_CHAR}Castwright notes\n`);
    const out = runReleaseBody(dir, 'release-body-test-bom', 'out.md');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /tag annotation/);
    assert.match(out.stderr, /byte-order mark/);
    assert.equal(existsSync(resolve(dir, 'out.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('annotation with an unresolved conflict marker blocks publish, naming the annotation', () => {
  const dir = setupRepo();
  try {
    makeAnnotatedTag(dir, 'release-body-test-conflict', CONFLICT_FIXTURE);
    const out = runReleaseBody(dir, 'release-body-test-conflict', 'out.md');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /tag annotation/);
    assert.match(out.stderr, /unresolved git conflict marker/);
    assert.equal(existsSync(resolve(dir, 'out.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('annotation with mojibake blocks publish, naming the annotation', () => {
  const dir = setupRepo();
  try {
    makeAnnotatedTag(
      dir,
      'release-body-test-mojibake',
      `Shipped a fix ${MOJIBAKE_EM_DASH} details inside.\n`,
    );
    const out = runReleaseBody(dir, 'release-body-test-mojibake', 'out.md');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /tag annotation/);
    assert.match(out.stderr, /double-UTF-8-encoded mojibake/);
    assert.equal(existsSync(resolve(dir, 'out.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2168 review, Important 1 — resolveReleaseBody must compute the mojibake
// echo BEFORE either early-exit check (BOM, conflict) returns, mirroring
// release-notes-gate.mjs's own CLI ordering (its comment states this is
// "load-bearing, not incidental", PR #2049 review F5, and names the exact
// defect: a file carrying both a conflict marker and an armed marker died
// naming only the conflict, with the armed marker never echoed that run).
// This script is the ONLY place an armed marker in an annotation can ever
// surface — the gate never reads the annotation at all, and Rule 2
// (file-absent) has no file to echo from either.
test('annotation with both an armed mojibake marker and a conflict marker fails on the conflict, but still echoes the marker', () => {
  const dir = setupRepo();
  try {
    const combined =
      `<!-- release-notes-gate: allow "${CAFE}" -->\n` +
      `- Ships with a ${CAFE} badge.\n` +
      CONFLICT_FIXTURE;
    makeAnnotatedTag(dir, 'release-body-test-combined', combined);
    const out = runReleaseBody(dir, 'release-body-test-combined', 'out.md');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /tag annotation/);
    assert.match(out.stderr, /unresolved git conflict marker/);
    assert.match(out.stdout, /^\[allow\] the tag annotation honoured 1 literal\(s\): "CAFÉ™"/m);
    assert.equal(existsSync(resolve(dir, 'out.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs/release-notes-next.md absent -> body is the annotation, exit 0', () => {
  const dir = setupRepo();
  try {
    const message = 'Castwright release-body-test-absent\n\n- A clean fix.\n';
    makeAnnotatedTag(dir, 'release-body-test-absent', message);
    const out = runReleaseBody(dir, 'release-body-test-absent', 'out.md');
    assert.equal(out.status, 0, out.stderr);
    const written = readFileSync(resolve(dir, 'out.md'), 'utf8');
    // Body is `%(contents)` verbatim, which appends exactly one trailing
    // newline beyond what was fed to `git tag -F -` (measured fact, see
    // release-body.mjs's header comment) — assert against THAT, not the
    // input message, so this doesn't silently start comparing byte-for-byte
    // if the appended-newline behaviour ever changed.
    assert.equal(written, `${message}\n`);
    // #2168 review, Minor 4/5 — the success line names an explicit `source`
    // (resolveReleaseBody's own label, not a value re-derivation) and the
    // published byte count, so an operator can compare without a full `cat`.
    assert.match(out.stdout, /\[release-body\] OK — wrote out\.md from the tag annotation \(\d+ bytes\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs/release-notes-next.md present and normalised-equal to the annotation -> body is the FILE, exit 0', () => {
  const dir = setupRepo();
  try {
    // No trailing newline in the file — %(contents) appends exactly one
    // when the tag is read back, so this also exercises the normalisation
    // this rule depends on rather than a byte-identical fixture.
    const fileText = '## Fixes\n- Something shipped.\n- Something else shipped.';
    writeNotesFile(dir, fileText);
    makeAnnotatedTag(dir, 'release-body-test-equal', fileText);

    const out = runReleaseBody(dir, 'release-body-test-equal', 'out.md');
    assert.equal(out.status, 0, out.stderr);
    const written = readFileSync(resolve(dir, 'out.md'), 'utf8');
    // Body is the FILE verbatim, not the annotation (which would carry the
    // extra trailing newline %(contents) appends).
    assert.equal(written, fileText);
    // #2168 review, Minor 4/5 — source is explicitly 'file' here, not
    // 'the tag annotation' (see the sibling absent-file test above).
    assert.match(
      out.stdout,
      /\[release-body\] OK — wrote out\.md from docs\/release-notes-next\.md \(\d+ bytes\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs/release-notes-next.md present and differing from the annotation blocks publish, naming both', () => {
  const dir = setupRepo();
  try {
    const fileText = '## Fixes\n- The file says this shipped.\n';
    const annotationText = '## Fixes\n- The annotation says something else shipped.\n';
    writeNotesFile(dir, fileText);
    makeAnnotatedTag(dir, 'release-body-test-diverge', annotationText);

    const out = runReleaseBody(dir, 'release-body-test-diverge', 'out.md');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /docs\/release-notes-next\.md/);
    assert.match(out.stderr, /tag annotation/);
    assert.match(out.stderr, /disagree/);
    assert.equal(existsSync(resolve(dir, 'out.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The v1.8.0 regression, reproduced exactly: bump-version.mjs's own
// placeholder annotation (`Castwright <tag>\n`, its --notes-file-less
// fallback) alongside a PRESENT, DIFFERING docs/release-notes-next.md
// (in the real incident, the previous cycle's stale notes). This really
// shipped; it is not hypothetical (see release-body.mjs's header comment).
test('the v1.8.0 regression shape — placeholder annotation + stale present file — blocks publish', () => {
  const dir = setupRepo();
  try {
    const tag = 'release-body-test-v180-shape';
    const placeholderAnnotation = `Castwright ${tag}\n`;
    const staleFile = '# Castwright v1.7.0\n\n## Fixes\n- Notes from the PREVIOUS cycle.\n';
    writeNotesFile(dir, staleFile);
    makeAnnotatedTag(dir, tag, placeholderAnnotation);

    const out = runReleaseBody(dir, tag, 'out.md');
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /disagree/);
    assert.equal(existsSync(resolve(dir, 'out.md')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The round-trip control (brief: "not optional — without it the divergence
// check is equally likely to fire always or never, and no other test
// distinguishes those"). Creates a tag FROM a file's exact text, reads
// `%(contents)` back with a directly sanitised git call (not through
// release-body.mjs's own readTagAnnotation, to avoid calling an exported
// git-shelling function in-process — see cleanGitEnv's comment), and
// asserts the normalised comparison this script relies on reports equal.
// #2168 review, Minor 3 — mutation-confirmed dead until this test: every
// other fixture in this file is pure LF on both sides of the comparison, so
// deleting normalise's `.replace(/\r\n/g, '\n')` fold left all 8 prior tests
// green (the "test that cannot fail" shape this repo keeps shipping). This
// is genuine defence for a future EOL disagreement, not a live requirement —
// v1.14.0's real annotation and blob are both pure LF — so it's exercised
// directly against the pure function rather than via a fresh git-tag fixture.
test('normalise: CRLF on one side and LF on the other compare equal', () => {
  const crlf = '## Fixes\r\n- Something shipped.\r\n- Something else shipped.\r\n';
  const lf = '## Fixes\n- Something shipped.\n- Something else shipped.\n';
  assert.notEqual(crlf, lf);
  assert.equal(normalise(crlf), normalise(lf));
});

test('round-trip control: a tag created from a file normalises equal when read back via %(contents)', () => {
  const dir = setupRepo();
  try {
    const fileText = '## Engineering\n- Refactored the thing.\n- Fixed the other thing.';
    makeAnnotatedTag(dir, 'release-body-test-roundtrip', fileText);
    const annotation = gitExec(
      ['tag', '-l', '--format=%(contents)', 'release-body-test-roundtrip'],
      { cwd: dir, encoding: 'utf8' },
    );

    // Measured fact: %(contents) appends exactly one trailing newline —
    // raw bytes differ by exactly that much, proving normalisation is
    // doing real work here rather than comparing already-identical strings.
    assert.notEqual(annotation, fileText);
    assert.equal(annotation, `${fileText}\n`);
    assert.equal(normalise(annotation), normalise(fileText));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2169 — readTagAnnotation (release-body.mjs:70, the line release.yml's
// publish step actually calls) had the same GIT_DIR/GIT_WORK_TREE-inherits-
// silently shape as bump-version.mjs. The decoy carries a tag of the SAME
// NAME as the real repo's but distinguishable content, so a misdirected read
// returns the wrong text rather than merely an empty/absent one — a stronger
// signal than "present vs absent", and not satisfiable by a no-op fix that
// happens to also succeed against the real repo.
test('readTagAnnotation resolves repoRoot even with an inherited GIT_DIR pointing at a decoy repo carrying the same tag name (#2169)', () => {
  const dir = setupRepo();
  const tagName = 'release-body-test-gitdir-decoy';
  const realMessage = 'Castwright real notes\n\n- from the real repo\n';
  makeAnnotatedTag(dir, tagName, realMessage);

  const decoyMessage = 'DECOY notes -- if you read this, GIT_DIR leaked\n';
  const decoy = setupDecoyRepoWithTag(tagName, decoyMessage);

  const savedGitEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      savedGitEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  process.env.GIT_DIR = resolve(decoy, '.git');
  try {
    const annotation = readTagAnnotation(dir, tagName);
    assert.match(annotation, /from the real repo/);
    assert.doesNotMatch(annotation, /DECOY notes/);
  } finally {
    delete process.env.GIT_DIR;
    for (const [k, v] of Object.entries(savedGitEnv)) process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

// #2841 — this file's cleanGitEnv() is a byte-identical copy of
// bump-version.test.mjs's, which had the same case-sensitivity gap fixed
// there. Mirrors that file's regression test directly against the local
// helper. Deliberately mixed-case-only: cannot pass against a
// `startsWith('GIT_')` filter.
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
