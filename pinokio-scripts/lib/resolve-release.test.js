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

test('renormalizeRequirementsCrlf recovers from git checkout failure via backup restore', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-release-fail-'));
  const reqDir = path.join(repo, 'server', 'tts-sidecar', 'requirements');
  fs.mkdirSync(reqDir, { recursive: true });
  const reqFile = path.join(reqDir, 'base.txt');
  const testContent = 'important-dependencies\n';

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  // Create an initial commit with a marker file but no requirements directory
  const marker = path.join(repo, 'marker.txt');
  fs.writeFileSync(marker, 'marker\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial (no requirements yet)');

  // Now create a requirements file on disk but DON'T add it to git.
  // This simulates a scenario where:
  // - A file exists in the working directory
  // - But the git index has no entry for it
  // - So "git checkout -- requirements/..." will fail with
  //   "error: pathspec 'server/tts-sidecar/requirements' did not match any files known to git"
  fs.writeFileSync(reqFile, testContent);

  // Call renormalizeRequirementsCrlf. It will:
  // 1. Find the file (directory exists, .txt file is there)
  // 2. Back it up to memory
  // 3. Delete it
  // 4. Try "git checkout -- server/tts-sidecar/requirements"
  // 5. Fail because the pathspec doesn't exist in the index
  // 6. Catch the error and restore from backup
  // 7. Throw an error with a clear message

  assert.throws(
    () => renormalizeRequirementsCrlf(repo),
    /Failed to normalize requirements CRLF|did not match any files known to git/,
    'should throw an error when git checkout fails'
  );

  // Most important: verify the file still exists (restored from backup)
  assert.ok(
    fs.existsSync(reqFile),
    'requirements file must be restored from backup after git checkout failure'
  );

  // Verify the file content was preserved
  const restoredContent = fs.readFileSync(reqFile, 'utf8');
  assert.equal(
    restoredContent,
    testContent,
    'backed-up file content must be intact after recovery'
  );

  fs.rmSync(repo, { recursive: true, force: true });
});

test('renormalizeRequirementsCrlf restores only unrestorable files, not all backup on verification failure', () => {
  // Regression test for PR #2799 pass-2 finding: when verification fails
  // (e.g. an untracked file can't be restored by git checkout), only that
  // file should be restored from backup. Files that git successfully
  // restored should NOT be overwritten with stale backup bytes.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-release-partial-'));
  const reqDir = path.join(repo, 'server', 'tts-sidecar', 'requirements');
  fs.mkdirSync(reqDir, { recursive: true });

  // Create tracked files
  const trackedFile1 = path.join(reqDir, 'tracked1.txt');
  const trackedFile2 = path.join(reqDir, 'tracked2.txt');
  // Create an untracked file that can't be restored by git checkout
  const untrackedFile = path.join(reqDir, 'untracked.txt');

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  // Write tracked files as LF and commit them
  fs.writeFileSync(trackedFile1, 'torch==2.4.0\nnumpy==1.26.0\n');
  fs.writeFileSync(trackedFile2, 'pandas==2.0.0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial with tracked files');

  // Pin eol=lf in gitattributes and commit
  fs.writeFileSync(
    path.join(repo, '.gitattributes'),
    'server/tts-sidecar/requirements/*.txt text eol=lf\n',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'pin eol=lf');

  // Now simulate a stale CRLF state by manually writing CRLF bytes to disk
  // (this represents what a stale clone would have)
  const staleCrlfContent1 = 'torch==2.4.0\r\nnumpy==1.26.0\r\n';
  const staleCrlfContent2 = 'pandas==2.0.0\r\n';
  fs.writeFileSync(trackedFile1, staleCrlfContent1);
  fs.writeFileSync(trackedFile2, staleCrlfContent2);

  // Now introduce an untracked file that will NOT be restored by git checkout
  fs.writeFileSync(untrackedFile, 'untracked-content\n');

  // Call renormalizeRequirementsCrlf. It will:
  // 1. Find all three .txt files (tracked1, tracked2, untracked)
  // 2. Back them up to memory (tracked1=stale CRLF, tracked2=stale CRLF, untracked=text)
  // 3. Delete all three
  // 4. Run git checkout -- requirements
  // 5. Git restores tracked1 and tracked2 with eol=lf pin → LF on disk
  // 6. Git cannot restore untracked (was never in index)
  // 7. Verification finds untracked missing and restores it from backup
  // OLD BUG: would restore ALL files from backup (overwriting tracked files with stale CRLF)
  // NEW FIX: should only restore untracked from backup, not overwrite tracked files

  assert.throws(
    () => renormalizeRequirementsCrlf(repo),
    /backed-up file.*missing|missing.*from/,
    'should throw because untracked file cannot be restored'
  );

  // The crucial assertion: tracked files must retain their fresh LF content
  // from git checkout, NOT stale CRLF bytes from the backup
  const tracked1After = fs.readFileSync(trackedFile1, 'utf8');
  const tracked2After = fs.readFileSync(trackedFile2, 'utf8');

  assert.doesNotMatch(
    tracked1After,
    /\r/,
    'tracked file 1 must remain LF, not be overwritten with stale CRLF backup'
  );
  assert.doesNotMatch(
    tracked2After,
    /\r/,
    'tracked file 2 must remain LF, not be overwritten with stale CRLF backup'
  );
  assert.equal(
    tracked1After,
    'torch==2.4.0\nnumpy==1.26.0\n',
    'tracked file 1 content must not be overwritten by stale backup'
  );
  assert.equal(
    tracked2After,
    'pandas==2.0.0\n',
    'tracked file 2 content must not be overwritten by stale backup'
  );

  fs.rmSync(repo, { recursive: true, force: true });
});

test('renormalizeRequirementsCrlf restores all missing files when multiple are unrestorable', () => {
  // Regression test for PR #2799 pass-3 finding: when multiple files cannot
  // be restored by git checkout (e.g., untracked files), the old code would
  // throw on the FIRST missing file, leaving subsequent ones unrestored and
  // unnamed in the error message. This test verifies that ALL missing files
  // are attempted restoration and that the error message names all of them.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-release-multi-fail-'));
  const reqDir = path.join(repo, 'server', 'tts-sidecar', 'requirements');
  fs.mkdirSync(reqDir, { recursive: true });

  const trackedFile = path.join(reqDir, 'base.txt');
  const untrackedFile1 = path.join(reqDir, 'untracked1.txt');
  const untrackedFile2 = path.join(reqDir, 'untracked2.txt');
  const testContent1 = 'untracked-package-1==1.0.0\n';
  const testContent2 = 'untracked-package-2==2.0.0\n';

  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');

  // Create and commit a tracked file so git checkout will succeed on that directory
  fs.writeFileSync(trackedFile, 'torch==2.4.0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial with requirements');

  // Now create two untracked files in the requirements directory.
  // These won't be in git, so 'git checkout -- requirements' cannot restore them.
  fs.writeFileSync(untrackedFile1, testContent1);
  fs.writeFileSync(untrackedFile2, testContent2);

  // Call renormalizeRequirementsCrlf. It will:
  // 1. Find all three files and back them up (tracked + 2 untracked)
  // 2. Delete all three
  // 3. Run 'git checkout -- server/tts-sidecar/requirements'
  //    - Git restores tracked file
  //    - Git cannot restore untracked files (not in index)
  // 4. Verification finds both untracked files missing
  // OLD BUG: would attempt to restore first untracked, then throw immediately
  //          without checking/restoring the second untracked file
  // NEW FIX: should restore both untracked and throw error naming both

  let caughtError;
  try {
    renormalizeRequirementsCrlf(repo);
  } catch (e) {
    caughtError = e;
  }

  assert.ok(caughtError, 'should throw an error when untracked files cannot be restored');

  // Verify the error message contains BOTH untracked filenames
  const errorMsg = caughtError.message;
  assert.match(errorMsg, /backed-up file.*missing|missing.*from/, 'error message format should match');
  assert.match(errorMsg, /untracked1\.txt/, 'error message must name first untracked file');
  assert.match(errorMsg, /untracked2\.txt/, 'error message must name second untracked file');

  // Verify BOTH files were restored from backup (not just the first)
  // This is the critical regression test: both should exist on disk
  assert.ok(
    fs.existsSync(untrackedFile1),
    'untracked file 1 must be restored from backup after renormalize'
  );
  assert.ok(
    fs.existsSync(untrackedFile2),
    'untracked file 2 must be restored from backup after renormalize'
  );

  // Verify the file contents are intact (restored from backup, not lost)
  const restored1 = fs.readFileSync(untrackedFile1, 'utf8');
  const restored2 = fs.readFileSync(untrackedFile2, 'utf8');
  assert.equal(
    restored1,
    testContent1,
    'untracked file 1 content must be intact after restore'
  );
  assert.equal(
    restored2,
    testContent2,
    'untracked file 2 content must be intact after restore'
  );

  fs.rmSync(repo, { recursive: true, force: true });
});
