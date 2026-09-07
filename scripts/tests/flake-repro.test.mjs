// Regression coverage for scripts/flake-repro.mjs path resolution (#3081).
//
// The bug: Windows paths with backslashes (arrived via tab-completion in
// PowerShell) were not normalized before matching against the server/
// prefix logic and the SLOW list. On Windows:
//   - 'server\src\routes\book-state.test.ts' → cwd stays '.' (wrong, should be 'server')
//   - rel keeps the backslashes and server\ prefix (wrong, should be normalized)
//   - SLOW.includes(rel) is false (wrong, should be true for a slow file)
//
// The tool then ran the test under the frontend config and reported a
// (false) timing, silently misrepresenting zero tests as a valid measurement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTarget } from '../flake-repro.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = resolve(here, '..', 'flake-repro.mjs');

// === Unit tests: resolveTarget pure function ===

// Test a slow-lane server file in all three Windows/POSIX path forms
test('resolveTarget: slow-lane server file with forward slashes', () => {
  const result = resolveTarget('server/src/routes/book-state.test.ts', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/book-state.test.ts',
    fullPath: 'server/src/routes/book-state.test.ts',
    isSlow: true,
    isOutsideRepo: false,
  });
});

test('resolveTarget: slow-lane server file with backslashes (regression)', () => {
  const result = resolveTarget('server\\src\\routes\\book-state.test.ts', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/book-state.test.ts',
    fullPath: 'server/src/routes/book-state.test.ts',
    isSlow: true,
    isOutsideRepo: false,
  });
});

test('resolveTarget: slow-lane server file with ./ prefix and backslashes (regression)', () => {
  const result = resolveTarget('.\\server\\src\\routes\\book-state.test.ts', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/book-state.test.ts',
    fullPath: 'server/src/routes/book-state.test.ts',
    isSlow: true,
    isOutsideRepo: false,
  });
});

// Test a non-slow server file in all three forms (use a real file)
test('resolveTarget: non-slow server file with forward slashes', () => {
  const result = resolveTarget('server/src/routes/voices.test.ts', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/voices.test.ts',
    fullPath: 'server/src/routes/voices.test.ts',
    isSlow: false,
    isOutsideRepo: false,
  });
});

test('resolveTarget: non-slow server file with backslashes (regression)', () => {
  const result = resolveTarget('server\\src\\routes\\voices.test.ts', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/voices.test.ts',
    fullPath: 'server/src/routes/voices.test.ts',
    isSlow: false,
    isOutsideRepo: false,
  });
});

test('resolveTarget: non-slow server file with ./ prefix and backslashes (regression)', () => {
  const result = resolveTarget('.\\server\\src\\routes\\voices.test.ts', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/voices.test.ts',
    fullPath: 'server/src/routes/voices.test.ts',
    isSlow: false,
    isOutsideRepo: false,
  });
});

// Test a frontend file
test('resolveTarget: frontend file with forward slashes', () => {
  const result = resolveTarget('src/views/listen.test.tsx', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: '.',
    rel: 'src/views/listen.test.tsx',
    fullPath: 'src/views/listen.test.tsx',
    isSlow: false,
    isOutsideRepo: false,
  });
});

test('resolveTarget: frontend file with backslashes (regression)', () => {
  const result = resolveTarget('src\\views\\listen.test.tsx', repoRoot);
  assert.deepStrictEqual(result, {
    cwd: '.',
    rel: 'src/views/listen.test.tsx',
    fullPath: 'src/views/listen.test.tsx',
    isSlow: false,
    isOutsideRepo: false,
  });
});

// === CLI-level tests: spawn subprocess and check behavior ===

function runFlakeRepro(args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    // Required tree-wide outside server/src by server/src/spawn-windows-hide.test.ts.
    windowsHide: true,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('CLI: nonexistent file is refused with exit 2 and no SUMMARY', () => {
  const { exitCode, stdout, stderr } = runFlakeRepro(['--file', 'nonexistent.test.ts', '--runs', '1']);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('no such test file'), true, 'stderr should mention the error');
});

test('CLI: absolute path outside repo is refused with exit 2 and no SUMMARY', () => {
  // Use process.platform to construct a portable outside-repo path
  const outsidePath = process.platform === 'win32'
    ? 'C:\\fake\\outside\\repo\\test.test.ts'
    : '/tmp/outside-repo-test.test.ts';
  const { exitCode, stdout, stderr } = runFlakeRepro([
    '--file',
    outsidePath,
    '--runs',
    '1',
  ]);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('outside the repository'), true, 'stderr should mention the error');
});

// Deliberately a SMALL directory. If the isFile() guard ever regresses, this
// test still fails -- but it fails by spawning vitest against whatever the
// argument names first. Pointed at server/src/routes (137 test files) that
// took minutes and looked like a hang; scripts/lib matches no vitest include
// glob, so the regression surfaces in milliseconds instead.
test('CLI: directory is refused with exit 2 and no SUMMARY', () => {
  const { exitCode, stdout, stderr } = runFlakeRepro(['--file', 'scripts/lib', '--runs', '1']);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('not a regular file'), true, 'stderr should mention it is a directory');
});

test('CLI: non-test file is refused with exit 2 and no SUMMARY', () => {
  const { exitCode, stdout, stderr } = runFlakeRepro(['--file', 'server/src/routes/voices.ts', '--runs', '1']);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('not a test file'), true, 'stderr should mention the pattern');
});

test('CLI: missing --file is refused with exit 2 and no SUMMARY', () => {
  const { exitCode, stdout, stderr } = runFlakeRepro(['--runs', '1']);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('--file <relpath> required'), true, 'stderr should mention missing --file');
});

test('CLI: --runs 0 is refused with exit 2 and no SUMMARY', () => {
  const { exitCode, stdout, stderr } = runFlakeRepro(['--file', 'src/views/listen.test.tsx', '--runs', '0']);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('positive integer'), true, 'stderr should mention the validation');
});

test('CLI: --runs non-numeric is refused with exit 2 and no SUMMARY', () => {
  const { exitCode, stdout, stderr } = runFlakeRepro(['--file', 'src/views/listen.test.tsx', '--runs', 'banana']);
  assert.strictEqual(exitCode, 2, `expected exit 2, got ${exitCode}`);
  assert.strictEqual(stdout.includes('SUMMARY'), false, 'stdout should not contain SUMMARY');
  assert.strictEqual(stderr.includes('positive integer'), true, 'stderr should mention the validation');
});

test('CLI: missing --runs defaults to 3 (no error)', () => {
  const { stdout, stderr } = runFlakeRepro(['--file', 'server/src/analyzer/ru-diminutives.test.ts']);
  // With default --runs=3, should run 3 times and NOT complain about --runs
  assert.strictEqual(
    stderr.includes('positive integer'),
    false,
    'should not complain about missing --runs (defaults to 3)',
  );
  // Assert that exactly 3 runs occurred by checking the SUMMARY array
  const summaryMatch = stdout.match(/SUMMARY\s+(\[.*?\])/);
  assert.ok(summaryMatch, 'stdout should contain SUMMARY array');
  const summary = JSON.parse(summaryMatch[1]);
  assert.strictEqual(summary.length, 3, `expected 3 runs, got ${summary.length}`);
});

test('CLI: outside-repo diagnostic does not print undefined', () => {
  // Use a path outside the repo that's portable across platforms
  const outsidePath = process.platform === 'win32'
    ? 'C:\\Windows\\System32\\hosts.test.ts'
    : '/etc/passwd.test.ts';
  const { exitCode, stderr } = runFlakeRepro([
    '--file',
    outsidePath,
    '--runs',
    '1',
  ]);
  assert.strictEqual(exitCode, 2);
  assert.strictEqual(stderr.includes('outside the repository'), true);
  assert.strictEqual(stderr.includes('undefined'), false, 'should not print undefined in diagnostic');
});

test('CLI: invoked from subdirectory (server/) still runs with correct config', () => {
  // Change to server directory, then run flake-repro with an absolute path to a test file
  const serverDir = resolve(repoRoot, 'server');
  const result = spawnSync(process.execPath, [scriptPath, '--file', 'server/src/routes/book-state.test.ts', '--runs', '1'], {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: serverDir,
    windowsHide: true,
  });
  // Should succeed even when invoked from a subdirectory
  assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}`);
  assert.strictEqual(result.stdout.includes('SUMMARY'), true, 'should print SUMMARY');
  assert.strictEqual(result.stdout.includes('RUN'), true, 'should run vitest');
});
