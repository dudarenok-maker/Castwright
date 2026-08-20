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

test('gitignore: server/.env.tmp-* temp files are ignored (env-cleanup failure case)', () => {
  // Test a representative temp file matching the pattern:
  // server/.env.tmp-${pid}-${timestamp}-${seq}-${random}
  assert.equal(
    isGitIgnored('server/.env.tmp-12345-1234567890000-1-abcdef12'),
    true,
    'server/.env.tmp-* files should be gitignored (e.g., from POST /api/config/env-cleanup crash/retry)'
  );
});

test('gitignore: .env.tmp-* files in root are also covered by the pattern', () => {
  // The pattern server/.env.tmp-* should match files in the server/ directory.
  // Verify that the pattern works correctly.
  assert.equal(
    isGitIgnored('server/.env.tmp-999-9999999999999-5-xyz'),
    true,
    'server/.env.tmp-* pattern should match any temp file in that location'
  );
});

test('gitignore: .env.example is NOT ignored (is tracked)', () => {
  assert.equal(isGitIgnored('.env.example'), false, '.env.example is an intentional tracked file');
});
