import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINTABLE_EXTENSIONS,
  BUDGET_MS,
  parseStagedFiles,
  filterLintableFiles,
  classifyLintResult,
} from '../hooks/pre-commit-lint.mjs';

test('parseStagedFiles splits lines and drops blanks', () => {
  assert.deepEqual(
    parseStagedFiles('src/App.tsx\nserver/src/index.ts\n\n'),
    ['src/App.tsx', 'server/src/index.ts'],
  );
  assert.deepEqual(parseStagedFiles(''), []);
  assert.deepEqual(parseStagedFiles('\n\n'), []);
});

test('filterLintableFiles keeps only recognised JS/TS extensions', () => {
  const staged = [
    'src/App.tsx',
    'server/src/index.ts',
    'scripts/foo.mjs',
    'scripts/foo.cjs',
    'scripts/foo.mts',
    'scripts/foo.cts',
    'README.md',
    'docs/features/1-foo.md',
    'public/logo.png',
    'server/tts-sidecar/main.py',
  ];
  assert.deepEqual(filterLintableFiles(staged), [
    'src/App.tsx',
    'server/src/index.ts',
    'scripts/foo.mjs',
    'scripts/foo.cjs',
    'scripts/foo.mts',
    'scripts/foo.cts',
  ]);
});

test('filterLintableFiles on an all-non-JS/TS staged set returns empty (the empty-set short-circuit)', () => {
  assert.deepEqual(filterLintableFiles(['README.md', 'public/logo.png']), []);
});

test('LINTABLE_EXTENSIONS matches every extension the design specifies', () => {
  assert.deepEqual(
    [...LINTABLE_EXTENSIONS].sort(),
    ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.tsx', '.ts'].sort(),
  );
});

test('classifyLintResult: a missing eslint binary (ENOENT) passes with a warning, never blocks', () => {
  const result = { status: null, signal: null, error: { code: 'ENOENT', message: 'spawnSync eslint ENOENT' } };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warning);
});

test('classifyLintResult: a budget breach (ETIMEDOUT) passes with a warning, never blocks', () => {
  const result = { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT', message: 'spawnSync eslint ETIMEDOUT' } };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warning.includes(`${BUDGET_MS / 1000}s`));
});

test('classifyLintResult: real lint findings (nonzero exit, no spawn error) BLOCK the commit', () => {
  const result = { status: 1, signal: null, error: undefined, stdout: 'src/App.tsx\n  1:1  error  ...\n', stderr: '' };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, true);
  assert.ok(verdict.reason.includes('error'));
});

test('classifyLintResult: a clean run (exit 0) neither blocks nor warns', () => {
  const result = { status: 0, signal: null, error: undefined, stdout: '', stderr: '' };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.warning, undefined);
});
