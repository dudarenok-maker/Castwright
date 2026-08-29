const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  latestReleaseTag,
  highestSemverTag,
  renormalizeRequirementsCrlf,
} = require('./resolve-release.js');

test('200 with tag_name → resolves that tag', () => {
  const out = latestReleaseTag({ status: 200, body: { tag_name: 'v1.7.0' } });
  assert.deepEqual(out, { kind: 'tag', tag: 'v1.7.0' });
});

test('404 → "none" (no published release), never main', () => {
  const out = latestReleaseTag({ status: 404, body: null });
  assert.deepEqual(out, { kind: 'none' });
});

test('network/other error → fallback signal', () => {
  assert.deepEqual(latestReleaseTag({ status: 0, body: null }), { kind: 'fallback' });
  assert.deepEqual(latestReleaseTag({ status: 500, body: null }), { kind: 'fallback' });
});

test('200 but malformed body → fallback (defensive)', () => {
  assert.deepEqual(latestReleaseTag({ status: 200, body: {} }), { kind: 'fallback' });
});

test('highestSemverTag picks the max vX.Y.Z, ignores non-semver', () => {
  assert.equal(highestSemverTag(['v1.2.0', 'v1.10.1', 'nightly', 'v1.9.9']), 'v1.10.1');
});

test('highestSemverTag returns null when no semver tags', () => {
  assert.equal(highestSemverTag(['main', 'latest']), null);
});

test('renormalizeRequirementsCrlf rewrites a stale on-disk CRLF requirements file to LF', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-release-crlf-'));
  const reqDir = path.join(repo, 'server', 'tts-sidecar', 'requirements');
  fs.mkdirSync(reqDir, { recursive: true });
  const reqFile = path.join(reqDir, 'base.txt');

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // core.autocrlf=true reproduces the pre-.gitattributes-pin clone described in
  // .gitattributes: it writes CRLF into the working tree on checkout even
  // though the blob/index content is LF.
  git('config', 'core.autocrlf', 'true');

  fs.writeFileSync(reqFile, 'torch==2.4.0\nnumpy==1.26.0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  // Simulate the stale clone: delete + checkout writes CRLF bytes to disk
  // (autocrlf's smudge filter) *before* the eol=lf pin exists.
  fs.rmSync(reqFile);
  git('checkout', '--', 'server/tts-sidecar/requirements/base.txt');
  assert.match(fs.readFileSync(reqFile, 'utf8'), /\r\n/, 'precondition: file is CRLF on disk');

  // Now the eol=lf pin lands (as it did in this repo's real history) and a
  // plain `git checkout <ref>` runs against the already-CRLF file.
  fs.writeFileSync(
    path.join(repo, '.gitattributes'),
    'server/tts-sidecar/requirements/*.txt text eol=lf\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'pin eol=lf');
  git('checkout', 'HEAD', '--', 'server/tts-sidecar/requirements');
  assert.match(
    fs.readFileSync(reqFile, 'utf8'),
    /\r\n/,
    'precondition: plain checkout is a no-op for an already-CRLF file, per .gitattributes',
  );
  assert.equal(git('status', '--porcelain'), '', 'precondition: git considers the tree clean');

  renormalizeRequirementsCrlf(repo);

  const after = fs.readFileSync(reqFile, 'utf8');
  assert.doesNotMatch(after, /\r/, 'requirements file must be LF on disk after renormalization');
  assert.equal(after, 'torch==2.4.0\nnumpy==1.26.0\n');

  fs.rmSync(repo, { recursive: true, force: true });
});
