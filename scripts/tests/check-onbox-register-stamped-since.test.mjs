// #3116: `--stamped-since <ref>` — did the live view's rendered content
// change since <ref> without the publish counter moving. Three layers,
// mirroring the split in check-onbox-register.mjs itself:
//   1. `checkStampedSince` — pure, no git. Content/token comparison only.
//   2. `resolveStampedSinceBaseline` — the git seam, with an injectable
//      runner AND real-git coverage against throwaway repos (per CLAUDE.md's
//      "a test's git spawns wrote to the real repo" incident: every git call
//      here scrubs GIT_* env and runs in a temp dir, never this repo).
//   3. The CLI flag itself, via a real spawned subprocess against a
//      standalone fixture tree (mirroring
//      check-onbox-register-cli-no-flags.test.mjs's own fixture pattern).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStampedSince, resolveStampedSinceBaseline } from '../check-onbox-register.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(HERE, '..');

const token = (n, nonce) => `<div hidden data-published-as="${n}" data-publish-id="${nonce}"></div>`;
const page = (n, nonce, body = '<p>hello</p>') =>
  `<title>t</title>\n${token(n, nonce)}\n${body}\n`;

// ---------------------------------------------------------------------------
// 1. checkStampedSince — pure
// ---------------------------------------------------------------------------

test('checkStampedSince: identical content (token-only diff aside) passes even with equal counters', () => {
  const workingHtml = page(5, 'nAAAAAA', '<p>same</p>');
  const baselineHtml = page(5, 'nAAAAAA', '<p>same</p>');
  assert.deepEqual(checkStampedSince({ workingHtml, baselineHtml }), []);
});

test('checkStampedSince: content identical except the token itself -> pass regardless of counter', () => {
  const workingHtml = page(6, 'nBBBBBB', '<p>same</p>');
  const baselineHtml = page(5, 'nAAAAAA', '<p>same</p>');
  assert.deepEqual(checkStampedSince({ workingHtml, baselineHtml }), []);
});

// This one specifically requires the token to be BLANKED, not merely left
// out of a coincidentally-passing counter comparison: same counter (5) on
// both sides, same body, only the NONCE differs. If the token weren't
// blanked before the content comparison, the nonce difference alone would
// make `blankToken(...) !== blankToken(...)` true (a false "content
// changed"), and — because the counters happen to be EQUAL here — the
// function would then wrongly report a stamping failure on content that is,
// per this check's own contract, unchanged.
test('checkStampedSince: only the nonce differs (same counter, same body) -> pass, not a false content-changed', () => {
  const workingHtml = page(5, 'nBBBBBB', '<p>same</p>');
  const baselineHtml = page(5, 'nAAAAAA', '<p>same</p>');
  assert.deepEqual(checkStampedSince({ workingHtml, baselineHtml }), []);
});

test('checkStampedSince: HTML comments are ignored, including the header comment and BEGIN GENERATED markers', () => {
  const workingHtml = page(5, 'nAAAAAA', '<!-- header comment v2 --><!-- BEGIN GENERATED:x --><p>same</p><!-- END GENERATED:x -->');
  const baselineHtml = page(5, 'nAAAAAA', '<!-- header comment v1 --><!-- BEGIN GENERATED:x --><p>same</p><!-- END GENERATED:x -->');
  assert.deepEqual(checkStampedSince({ workingHtml, baselineHtml }), []);
});

test('checkStampedSince: content between the GENERATED markers DOES count as rendered content', () => {
  const workingHtml = page(5, 'nAAAAAA', '<!-- BEGIN GENERATED:x -->16 owed<!-- END GENERATED:x -->');
  const baselineHtml = page(5, 'nAAAAAA', '<!-- BEGIN GENERATED:x -->15 owed<!-- END GENERATED:x -->');
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /counter \(data-published-as\) stayed at 5/);
});

test('checkStampedSince: content changed, counter unchanged -> fails, names both the fix and both counter values', () => {
  const workingHtml = page(5, 'nAAAAAA', '<p>changed</p>');
  const baselineHtml = page(5, 'nAAAAAA', '<p>original</p>');
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /npm run stamp:publish-token/);
  assert.match(errors[0], /stayed at 5/);
});

test('checkStampedSince: content changed AND counter differs (higher) -> passes', () => {
  const workingHtml = page(6, 'nBBBBBB', '<p>changed</p>');
  const baselineHtml = page(5, 'nAAAAAA', '<p>original</p>');
  assert.deepEqual(checkStampedSince({ workingHtml, baselineHtml }), []);
});

test('checkStampedSince: content changed, counter moved UP but nonce unchanged (hand-bumped) -> fails with hand-edit message', () => {
  const workingHtml = page(6, 'nAAAAAA', '<p>changed</p>');  // counter 5→6, but nonce stayed nAAAAAA
  const baselineHtml = page(5, 'nAAAAAA', '<p>original</p>');
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hand-edited counter/i);
  assert.match(errors[0], /5 → 6/);
  assert.match(errors[0], /npm run stamp:publish-token/);
  // Verify this message is distinct from the legitimate higher-counter message
  assert.doesNotMatch(errors[0], /BEHIND/);
});

test('checkStampedSince: content changed, counter is BEHIND (lower than baseline) -> fails with distinct "behind" message', () => {
  const workingHtml = page(16, 'nBBBBBB', '<p>changed</p>');
  const baselineHtml = page(17, 'nAAAAAA', '<p>original</p>');
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /BEHIND.*16 vs 17/i);
  assert.match(errors[0], /rebase or re-derive/);
  // Verify this message is distinct from the equal-counter message
  assert.doesNotMatch(errors[0], /stamp:publish-token/);
});

test('checkStampedSince: lower counter with same content stays green (no change detected)', () => {
  const workingHtml = page(16, 'nBBBBBB', '<p>same</p>');
  const baselineHtml = page(17, 'nAAAAAA', '<p>same</p>');
  assert.deepEqual(checkStampedSince({ workingHtml, baselineHtml }), []);
});

test('checkStampedSince: content changed, working side has no token at all -> fails closed', () => {
  const workingHtml = '<title>t</title>\n<p>changed, no token</p>\n';
  const baselineHtml = page(5, 'nAAAAAA', '<p>original</p>');
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no publish token at all/);
});

test('checkStampedSince: content changed, base-ref side has no token at all -> fails closed', () => {
  const workingHtml = page(5, 'nAAAAAA', '<p>changed</p>');
  const baselineHtml = '<title>t</title>\n<p>original, no token</p>\n';
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /base ref.*has no publish token/);
});

test('checkStampedSince: content changed, working token malformed (duplicated) -> fails closed', () => {
  const workingHtml = `<title>t</title>\n${token(5, 'nAAAAAA')}\n${token(6, 'nBBBBBB')}\n<p>changed</p>\n`;
  const baselineHtml = page(5, 'nAAAAAA', '<p>original</p>');
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Publish token \(tracked\)/);
});

test('checkStampedSince: content changed, base-ref token malformed (bad counter) -> fails closed', () => {
  const workingHtml = page(6, 'nBBBBBB', '<p>changed</p>');
  const baselineHtml = `<title>t</title>\n<div hidden data-published-as="abc" data-publish-id="nAAAAAA"></div>\n<p>original</p>\n`;
  const errors = checkStampedSince({ workingHtml, baselineHtml });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Publish token \(base ref\)/);
});

// ---------------------------------------------------------------------------
// 2a. resolveStampedSinceBaseline — injected runner (mirrors resolveBaselineTexts's own unit style)
// ---------------------------------------------------------------------------

test('resolveStampedSinceBaseline: a clean git show -> status ok, text is stdout', () => {
  const fakeRunner = (args) => {
    assert.deepEqual(args, ['show', 'abc123:docs/live.html']);
    return { status: 0, stdout: '<p>content</p>' };
  };
  const result = resolveStampedSinceBaseline('/fake/repo', 'docs/live.html', 'abc123', fakeRunner);
  assert.deepEqual(result, { status: 'ok', text: '<p>content</p>', message: null });
});

test('resolveStampedSinceBaseline: "does not exist in" stderr -> status missing, not an error', () => {
  const fakeRunner = () => ({
    status: 128,
    stdout: '',
    stderr: "fatal: path 'docs/live.html' does not exist in 'abc123'",
  });
  const result = resolveStampedSinceBaseline('/fake/repo', 'docs/live.html', 'abc123', fakeRunner);
  assert.equal(result.status, 'missing');
  assert.equal(result.text, null);
});

test('resolveStampedSinceBaseline: an unresolvable ref -> status error (fails closed, never "missing")', () => {
  const fakeRunner = () => ({
    status: 128,
    stdout: '',
    stderr: "fatal: invalid object name 'not-a-ref'.",
  });
  const result = resolveStampedSinceBaseline('/fake/repo', 'docs/live.html', 'not-a-ref', fakeRunner);
  assert.equal(result.status, 'error');
  assert.match(result.message, /invalid object name/);
});

test('resolveStampedSinceBaseline: a spawn error (git missing, or a timeout) -> status error', () => {
  const fakeRunner = () => ({ error: new Error('spawn git ENOENT') });
  const result = resolveStampedSinceBaseline('/fake/repo', 'docs/live.html', 'abc123', fakeRunner);
  assert.equal(result.status, 'error');
  assert.match(result.message, /ENOENT/);
});

// ---------------------------------------------------------------------------
// 2b. resolveStampedSinceBaseline — REAL git, throwaway repos
// ---------------------------------------------------------------------------

const LIVE = 'docs/live.html';
const cleanEnv = () => scrubGitEnvForThrowawayRepo();

const runner = (args, cwd) => {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: cleanEnv(), windowsHide: true });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.code === 'ENOENT' ? err : undefined };
  }
};

const git = (repo, ...args) =>
  execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: cleanEnv(), windowsHide: true });

function newRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'stamped-since-git-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

function writeLive(repo, content) {
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, LIVE), content);
}

test('git: resolveStampedSinceBaseline reads the real file content at a real ref', () => {
  const repo = newRepo();
  try {
    writeLive(repo, page(1, 'nBASE00', '<p>v1</p>'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();

    writeLive(repo, page(2, 'nNEXT00', '<p>v2</p>'));
    git(repo, 'commit', '-qam', 'next');

    const atBase = resolveStampedSinceBaseline(repo, LIVE, baseSha, runner);
    assert.equal(atBase.status, 'ok');
    assert.match(atBase.text, /v1/);
    assert.match(atBase.text, /nBASE00/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: resolveStampedSinceBaseline reports "missing" for a file added after the ref, real git', () => {
  const repo = newRepo();
  try {
    writeFileSync(join(repo, 'unrelated.txt'), 'x');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base, no live view yet');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();

    writeLive(repo, page(1, 'nNEW0000', '<p>brand new</p>'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'add live view');

    const result = resolveStampedSinceBaseline(repo, LIVE, baseSha, runner);
    assert.equal(result.status, 'missing');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('git: resolveStampedSinceBaseline fails closed (status error) for a ref that does not resolve, real git', () => {
  const repo = newRepo();
  try {
    writeLive(repo, page(1, 'nBASE00', '<p>v1</p>'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');

    const result = resolveStampedSinceBaseline(repo, LIVE, 'totally-not-a-real-ref', runner);
    assert.equal(result.status, 'error');
    assert.match(result.message, /totally-not-a-real-ref/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. CLI, real subprocess, standalone fixture tree (mirrors
//    check-onbox-register-cli-no-flags.test.mjs's own fixture builder)
// ---------------------------------------------------------------------------

function buildCliFixture() {
  const root = mkdtempSync(join(tmpdir(), 'onbox-stamped-since-cli-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'docs', 'testing'), { recursive: true });
  cpSync(join(SCRIPTS_DIR, 'check-onbox-register.mjs'), join(root, 'scripts', 'check-onbox-register.mjs'));
  cpSync(join(SCRIPTS_DIR, 'git-env.mjs'), join(root, 'scripts', 'git-env.mjs'));
  cpSync(join(SCRIPTS_DIR, 'publish-token.mjs'), join(root, 'scripts', 'publish-token.mjs'));
  cpSync(join(SCRIPTS_DIR, 'lib', 'is-main-module.mjs'), join(root, 'scripts', 'lib', 'is-main-module.mjs'));
  return root;
}

function runFixtureCli(root, args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'check-onbox-register.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
}

const LIVE_VIEW_REL = join('docs', 'testing', 'onbox-acceptance-register-live-view.html');

test('CLI --stamped-since, real subprocess: unstamped content drift exits 1', () => {
  const root = buildCliFixture();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, LIVE_VIEW_REL), page(5, 'nAAAAAA', '<p>original</p>'), 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();

    // Edit content WITHOUT re-stamping.
    writeFileSync(join(root, LIVE_VIEW_REL), page(5, 'nAAAAAA', '<p>changed</p>'), 'utf8');

    const r = runFixtureCli(root, ['--stamped-since', baseSha]);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /npm run stamp:publish-token/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: content changed AND stamped exits 0', () => {
  const root = buildCliFixture();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, LIVE_VIEW_REL), page(5, 'nAAAAAA', '<p>original</p>'), 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();

    writeFileSync(join(root, LIVE_VIEW_REL), page(6, 'nBBBBBB', '<p>changed</p>'), 'utf8');

    const r = runFixtureCli(root, ['--stamped-since', baseSha]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: no content change (token-only bump) exits 0', () => {
  const root = buildCliFixture();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, LIVE_VIEW_REL), page(5, 'nAAAAAA', '<p>unchanged</p>'), 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();

    // Bump only the token; body unchanged.
    writeFileSync(join(root, LIVE_VIEW_REL), page(6, 'nBBBBBB', '<p>unchanged</p>'), 'utf8');

    const r = runFixtureCli(root, ['--stamped-since', baseSha]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: file newly added since the ref exits 0', () => {
  const root = buildCliFixture();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'unrelated.txt'), 'x', 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base, no live view yet');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();

    writeFileSync(join(root, LIVE_VIEW_REL), page(1, 'nNEW0000', '<p>brand new</p>'), 'utf8');

    const r = runFixtureCli(root, ['--stamped-since', baseSha]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: an unresolvable ref exits 1, never reads as "no change"', () => {
  const root = buildCliFixture();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, LIVE_VIEW_REL), page(5, 'nAAAAAA', '<p>content</p>'), 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');

    const r = runFixtureCli(root, ['--stamped-since', 'not-a-real-ref']);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /unresolvable ref must never read as "no change"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: missing working-tree file exits 0', () => {
  const root = buildCliFixture();
  try {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'unrelated.txt'), 'x', 'utf8');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: cleanEnv(), windowsHide: true }).trim();
    // No live-view file ever written in the working tree.

    const r = runFixtureCli(root, ['--stamped-since', baseSha]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: no value given -> refused, exit 1', () => {
  const root = buildCliFixture();
  try {
    writeFileSync(join(root, 'docs', 'testing', 'onbox-acceptance-register-live-view.html'), page(1, 'nAAAAAA'), 'utf8');
    const r = runFixtureCli(root, ['--stamped-since']);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /requires a value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: passed twice -> refused, exit 1', () => {
  const root = buildCliFixture();
  try {
    writeFileSync(join(root, 'docs', 'testing', 'onbox-acceptance-register-live-view.html'), page(1, 'nAAAAAA'), 'utf8');
    const r = runFixtureCli(root, ['--stamped-since', 'HEAD', '--stamped-since', 'HEAD~1']);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /more than once/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: combined with --against-published -> refused, exit 1', () => {
  const root = buildCliFixture();
  try {
    writeFileSync(join(root, 'docs', 'testing', 'onbox-acceptance-register-live-view.html'), page(1, 'nAAAAAA'), 'utf8');
    const r = runFixtureCli(root, ['--stamped-since', 'HEAD', '--against-published', '/tmp/fake.html']);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /cannot be combined with --against-published/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI --stamped-since, real subprocess: combined with --discharging -> refused, exit 1', () => {
  const root = buildCliFixture();
  try {
    writeFileSync(join(root, 'docs', 'testing', 'onbox-acceptance-register-live-view.html'), page(1, 'nAAAAAA'), 'utf8');
    const r = runFixtureCli(root, ['--stamped-since', 'HEAD', '--discharging', 'A1']);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout + r.stderr, /cannot be combined with --discharging/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
