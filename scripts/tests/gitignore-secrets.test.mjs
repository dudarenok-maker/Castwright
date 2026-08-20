// Regression tests for .gitignore secret patterns.
// Ensures that secret files (env, backups, credentials) are properly gitignored
// and cannot be accidentally staged into the public repository.
//
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scrubGitEnv } from '../git-env.mjs';

const repoRoot = process.cwd();

/**
 * Check whether a path matches .gitignore's patterns, independent of
 * whether that path happens to be tracked. Uses `--no-index` (#2531 review,
 * finding 2): without it, `git check-ignore` skips pattern-matching
 * entirely for a path that is already in the index and reports "not
 * ignored" regardless of what the patterns say — the negative control below
 * would then report "not ignored" just because the file is tracked, not
 * because pattern matching actually ran and found no match. `scrubGitEnv`
 * (#2532 review round 3, finding 1) stops an ambient GIT_DIR/GIT_WORK_TREE
 * from silently redirecting this call to a different repository than the
 * `cwd` it's pinned to — the #2169/#2216 class `scripts/lib/module-graph.mjs`'s
 * own `check-ignore` caller already guards against.
 */
function isGitIgnored(filePath) {
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', filePath], {
    cwd: repoRoot,
    env: scrubGitEnv(),
  });
  if (result.error || result.status === null) {
    throw new Error(
      `git check-ignore failed to run for ${filePath}: ${result.error?.message ?? `signal ${result.signal}`}`
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore exited ${result.status} for ${filePath}: ${result.stderr}`);
  }
  // Exit code 0 = file is ignored; exit code 1 = file is not ignored
  return result.status === 0;
}

test('gitignore: .env is ignored', () => {
  assert.equal(isGitIgnored('.env'), true, '.env should be gitignored');
});

test('gitignore: .env.local is ignored', () => {
  assert.equal(isGitIgnored('.env.local'), true, '.env.local should be gitignored');
});

test('gitignore: .env.development.local is ignored', () => {
  assert.equal(
    isGitIgnored('.env.development.local'),
    true,
    '.env.*.local should be gitignored'
  );
});

test('gitignore: .env.bak is ignored', () => {
  assert.equal(isGitIgnored('.env.bak'), true, '.env.bak should be gitignored');
});

test('gitignore: server/.env.bak is ignored', () => {
  assert.equal(
    isGitIgnored('server/.env.bak'),
    true,
    'server/.env.bak should be gitignored (e.g. backed up in place before an edit)'
  );
});

test('gitignore: server/.env.bak.1 is ignored (rotateBackups() spelling)', () => {
  assert.equal(
    isGitIgnored('server/.env.bak.1'),
    true,
    'server/.env.bak.1 should be gitignored — rotateBackups() in state-io.ts uses this suffix'
  );
});

test('gitignore: server/.env~ is ignored (editor backup)', () => {
  assert.equal(
    isGitIgnored('server/.env~'),
    true,
    'server/.env~ should be gitignored — vim/emacs write this on save'
  );
});

test('gitignore: server/.env.backup is ignored', () => {
  assert.equal(isGitIgnored('server/.env.backup'), true, 'server/.env.backup should be gitignored');
});

test('gitignore: server/.env.old is ignored', () => {
  assert.equal(isGitIgnored('server/.env.old'), true, 'server/.env.old should be gitignored');
});

test('gitignore: server/.env.save is ignored', () => {
  assert.equal(isGitIgnored('server/.env.save'), true, 'server/.env.save should be gitignored');
});

test('gitignore: server/.env.example is NOT matched by the ignore patterns', () => {
  assert.equal(
    isGitIgnored('server/.env.example'),
    false,
    'server/.env.example is an intentional tracked file and must not match any secret pattern'
  );
});
