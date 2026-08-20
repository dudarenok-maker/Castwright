// Regression tests for .gitignore secret patterns.
// Ensures that secret files (env, backups, credentials) are properly gitignored
// and cannot be accidentally staged into the public repository.
//
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();

/**
 * Check if a path is gitignored by running `git check-ignore`.
 * Returns true if the path is ignored, false if it would be tracked.
 */
function isGitIgnored(filePath) {
  const result = spawnSync('git', ['check-ignore', '-q', filePath], {
    cwd: repoRoot,
  });
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

test('gitignore: .env.bak is ignored (covers env-cleanup backups)', () => {
  assert.equal(isGitIgnored('.env.bak'), true, '.env.bak should be gitignored');
});

test('gitignore: server/.env.bak is ignored (covers env-cleanup backups)', () => {
  assert.equal(
    isGitIgnored('server/.env.bak'),
    true,
    'server/.env.bak should be gitignored (e.g., from POST /api/config/env-cleanup)'
  );
});

test('gitignore: .env.example is NOT ignored (is tracked)', () => {
  assert.equal(isGitIgnored('.env.example'), false, '.env.example is an intentional tracked file');
});
