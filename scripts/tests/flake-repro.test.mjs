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
import { resolveTarget } from '../flake-repro.mjs';

// Test a slow-lane server file in all three Windows/POSIX path forms
test('resolveTarget: slow-lane server file with forward slashes', () => {
  const result = resolveTarget('server/src/routes/book-state.test.ts');
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/book-state.test.ts',
    isSlow: true,
  });
});

test('resolveTarget: slow-lane server file with backslashes (regression)', () => {
  const result = resolveTarget('server\\src\\routes\\book-state.test.ts');
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/book-state.test.ts',
    isSlow: true,
  });
});

test('resolveTarget: slow-lane server file with ./ prefix and backslashes (regression)', () => {
  const result = resolveTarget('.\\server\\src\\routes\\book-state.test.ts');
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/book-state.test.ts',
    isSlow: true,
  });
});

// Test a non-slow server file in all three forms
test('resolveTarget: non-slow server file with forward slashes', () => {
  const result = resolveTarget('server/src/routes/voices.route.test.ts');
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/voices.route.test.ts',
    isSlow: false,
  });
});

test('resolveTarget: non-slow server file with backslashes (regression)', () => {
  const result = resolveTarget('server\\src\\routes\\voices.route.test.ts');
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/voices.route.test.ts',
    isSlow: false,
  });
});

test('resolveTarget: non-slow server file with ./ prefix and backslashes (regression)', () => {
  const result = resolveTarget('.\\server\\src\\routes\\voices.route.test.ts');
  assert.deepStrictEqual(result, {
    cwd: 'server',
    rel: 'src/routes/voices.route.test.ts',
    isSlow: false,
  });
});

// Test a frontend file
test('resolveTarget: frontend file with forward slashes', () => {
  const result = resolveTarget('src/views/listen.test.tsx');
  assert.deepStrictEqual(result, {
    cwd: '.',
    rel: 'src/views/listen.test.tsx',
    isSlow: false,
  });
});

test('resolveTarget: frontend file with backslashes (regression)', () => {
  const result = resolveTarget('src\\views\\listen.test.tsx');
  assert.deepStrictEqual(result, {
    cwd: '.',
    rel: 'src/views/listen.test.tsx',
    isSlow: false,
  });
});
