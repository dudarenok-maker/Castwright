import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINTABLE_EXTENSIONS,
  MAX_FILES_PER_BATCH,
  parseStagedFiles,
  filterLintableFiles,
  classifyLintResult,
  chunkFiles,
  combineBatchVerdicts,
  combineBatchResults,
} from '../hooks/pre-commit-lint.mjs';

// === REAL CAPTURED ESLINT OUTPUT =========================================
//
// Every fixture below is verbatim stdout + the exit status from a real run of
//   node node_modules/eslint/bin/eslint.js \
//     --format json --max-warnings 0 --no-warn-ignored <file>
// from repo root (eslint 9.39.4), captured 2026-09-05. DO NOT hand-write an
// ESLint result shape here: two prior rounds shipped a broken hook precisely
// because their fixtures were invented. In particular real ESLint emits a
// NUMERIC `severity` (1/2), and emits one array entry per linted file even
// when that file is completely clean — the invented fixtures had neither.

/** A CLEAN file. Note `messages: []` inside a NON-EMPTY array, status 0.
 *  This is the regression: length-based blocking read this as findings. */
const REAL_CLEAN_STDOUT =
  '[{"filePath":"C:\\\\Claude\\\\Projects\\\\wt-2997-commit-gate\\\\scripts\\\\hooks\\\\pre-commit-lint.mjs","messages":[],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]}]\n';

/** An IGNORED tracked file (src/lib/api-types.ts) under --no-warn-ignored:
 *  the ONLY shape that yields a genuinely empty array. */
const REAL_IGNORED_STDOUT = '[]\n';

/** A file with real findings: one warning (no-unused-vars) + one error
 *  (no-undef), status 1. */
const REAL_FINDINGS_STDOUT =
  '[{"filePath":"C:\\\\Claude\\\\Projects\\\\wt-2997-commit-gate\\\\scripts\\\\__tmp_lint_dirty.mjs","messages":[{"ruleId":"@typescript-eslint/no-unused-vars","severity":1,"message":"\'unusedVariable\' is assigned a value but never used. Allowed unused vars must match /^_/u.","line":1,"column":7,"nodeType":"Identifier","messageId":"unusedVar","endLine":1,"endColumn":21},{"ruleId":"no-undef","severity":2,"message":"\'someUndefinedGlobalThing\' is not defined.","line":3,"column":10,"nodeType":"Identifier","messageId":"undef","endLine":3,"endColumn":34}],"suppressedMessages":[],"errorCount":1,"fatalErrorCount":0,"warningCount":1,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]}]\n';

/** A MULTI-FILE clean run (three real clean files in one invocation) — the
 *  shape a whole clean batch actually has: N entries, every `messages: []`,
 *  status 0. Captured from the same command as the fixtures above. */
const REAL_CLEAN_BATCH_STDOUT =
  '[{"filePath":"C:\\\\Claude\\\\Projects\\\\wt-2997-commit-gate\\\\scripts\\\\git-env.mjs","messages":[],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]},{"filePath":"C:\\\\Claude\\\\Projects\\\\wt-2997-commit-gate\\\\scripts\\\\hooks\\\\pre-commit-lint.mjs","messages":[],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]},{"filePath":"C:\\\\Claude\\\\Projects\\\\wt-2997-commit-gate\\\\scripts\\\\lib\\\\is-main-module.mjs","messages":[],"suppressedMessages":[],"errorCount":0,"fatalErrorCount":0,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"usedDeprecatedRules":[]}]\n';

/** A path matching no file: ESLint exits 2 with a non-JSON stderr banner and
 *  EMPTY stdout. (Measured — this is exit 2, not exit 1.) */
const REAL_MISSING_STDERR =
  '\nOops! Something went wrong! :(\n\nESLint: 9.39.4\n\nNo files matching the pattern "scripts/__does_not_exist__.mjs" were found.\nPlease check for typing mistakes in the pattern.\n\n';

// === Pure helpers ========================================================

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

test('filterLintableFiles on an all-non-JS/TS staged set returns empty', () => {
  assert.deepEqual(filterLintableFiles(['README.md', 'public/logo.png']), []);
});

test('LINTABLE_EXTENSIONS matches every extension the design specifies', () => {
  assert.deepEqual(
    [...LINTABLE_EXTENSIONS].sort(),
    ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.tsx', '.ts'].sort(),
  );
});

// === classifyLintResult, against real captured ESLint results ============

test('REGRESSION: a CLEAN file (status 0, non-empty array, messages: []) does NOT block', () => {
  // Real ESLint emits one entry per linted file even when it is clean, so the
  // array has length 1. Blocking on array length blocked every commit that
  // staged a clean JS/TS file. The exit code — 0 — is the findings signal.
  const result = { status: 0, error: undefined, stdout: REAL_CLEAN_STDOUT, stderr: '' };
  const parsed = JSON.parse(REAL_CLEAN_STDOUT);
  assert.equal(parsed.length, 1, 'fixture guard: a clean run really is a NON-EMPTY array');
  assert.deepEqual(parsed[0].messages, [], 'fixture guard: with zero messages');

  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false, 'a clean file must not block the commit');
  assert.equal(verdict.warning, undefined, 'a clean run is not a warning either');
});

test('an IGNORED tracked file (status 0, empty array) does NOT block', () => {
  const result = { status: 0, error: undefined, stdout: REAL_IGNORED_STDOUT, stderr: '' };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.warning, undefined);
});

test('REAL lint findings (status 1) DO block, and the reason names file, position and message', () => {
  const result = { status: 1, error: undefined, stdout: REAL_FINDINGS_STDOUT, stderr: '' };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, true, 'real findings must block');
  assert.equal(verdict.warning, undefined);
  assert.match(verdict.reason, /__tmp_lint_dirty\.mjs/);
  assert.match(verdict.reason, /1:7/);
  assert.match(verdict.reason, /'unusedVariable' is assigned a value but never used/);
  assert.match(verdict.reason, /3:10/);
  assert.match(verdict.reason, /'someUndefinedGlobalThing' is not defined/);
});

test('a path matching no file (real: status 2, empty stdout, banner on stderr) does NOT block', () => {
  const result = { status: 2, error: undefined, stdout: '', stderr: REAL_MISSING_STDERR };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false, 'a fatal ESLint error is not a lint finding');
  assert.ok(verdict.warning, 'and must warn');
});

test('status 1 with non-JSON stdout (e.g. Node module-load failure) does NOT block', () => {
  // No positive evidence ESLint ran → pass; CI still enforces lint.
  const result = {
    status: 1,
    error: undefined,
    stdout: "Error: Cannot find module 'C:\\\\repo\\\\node_modules\\\\eslint\\\\bin\\\\eslint.js'\nNode.js v24.15.0",
    stderr: '',
  };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warning);
});

test('status 1 with JSON that is not an ARRAY does NOT block', () => {
  const result = { status: 1, error: undefined, stdout: '{"unexpected":"object"}', stderr: '' };
  const verdict = classifyLintResult(result);
  assert.equal(verdict.blocked, false, 'only an array is positive evidence ESLint ran');
  assert.ok(verdict.warning);
});

test('ENOENT spawn error does NOT block', () => {
  const verdict = classifyLintResult({ status: null, error: { code: 'ENOENT' }, stdout: '', stderr: '' });
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warning);
});

test('ETIMEDOUT (budget exceeded) does NOT block', () => {
  const verdict = classifyLintResult({ status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' });
  assert.equal(verdict.blocked, false);
  assert.match(verdict.warning, /budget/);
});

test('any other spawn error does NOT block', () => {
  const verdict = classifyLintResult({ status: null, error: { code: 'E2BIG' }, stdout: '', stderr: '' });
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warning);
});

// === Batching across >MAX_FILES_PER_BATCH staged files ===================
//
// These drive combineBatchResults — the exact seam the hook uses and the one
// the old raw-stdout / raw-exit-code aggregation occupied. Each batch's input
// is a real captured ESLint spawnSync result; only WHICH batch gets which real
// result varies.

/** Real per-batch `spawnSync` results for a staged set of `fileCount` files,
 *  where the batch at `dirtyBatchIndex` (if given) carries real findings and
 *  the batch at `fatalBatchIndex` (if given) exited 2. */
function batchResults(fileCount, { dirtyBatchIndex, fatalBatchIndex } = {}) {
  const files = Array.from({ length: fileCount }, (_, i) => `src/generated/file-${i}.ts`);
  const batches = chunkFiles(files);
  return {
    batches,
    results: batches.map((_batch, i) => {
      if (i === dirtyBatchIndex) {
        return { status: 1, error: undefined, stdout: REAL_FINDINGS_STDOUT, stderr: '' };
      }
      if (i === fatalBatchIndex) {
        return { status: 2, error: undefined, stdout: '', stderr: REAL_MISSING_STDERR };
      }
      return { status: 0, error: undefined, stdout: REAL_CLEAN_BATCH_STDOUT, stderr: '' };
    }),
  };
}

test('chunkFiles splits a staged set into batches of at most MAX_FILES_PER_BATCH', () => {
  assert.equal(MAX_FILES_PER_BATCH, 100);
  const files = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts`);
  const batches = chunkFiles(files);
  assert.equal(batches.length, 3, '250 files must split into 3 batches');
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 50]);
  assert.deepEqual(batches.flat(), files, 'no file may be dropped or duplicated');
  assert.equal(chunkFiles([]).length, 0);
  assert.equal(chunkFiles(['a.ts']).length, 1);
});

test('REGRESSION: >100 staged files, ALL CLEAN → NOT blocked', () => {
  // Two batches, each a real clean multi-file ESLint run. The old code
  // concatenated their stdout into `[...]\n[...]`, which JSON.parse rejects,
  // so this landed in the unparseable branch — passing, but with linting
  // silently disabled for the largest diffs.
  const { batches, results } = batchResults(150);
  assert.equal(batches.length, 2, 'fixture guard: 150 files really is >1 batch');

  const verdict = combineBatchResults(results);
  assert.equal(verdict.blocked, false, 'a fully clean multi-batch run must not block');
  assert.equal(verdict.warning, undefined, 'and must not warn — ESLint ran fine in every batch');
});

test('REGRESSION: >100 staged files where the SECOND batch has real findings → BLOCKED', () => {
  // The case the stdout-concatenation bug broke outright: findings in any
  // batch after the first were swallowed and the commit sailed through.
  const { batches, results } = batchResults(150, { dirtyBatchIndex: 1 });
  assert.equal(batches.length, 2, 'fixture guard: the finding really is in a second batch');
  assert.equal(classifyLintResult(results[0]).blocked, false, 'fixture guard: batch 1 is clean');

  const verdict = combineBatchResults(results);
  assert.equal(verdict.blocked, true, 'findings in a later batch must still block');
  assert.match(verdict.reason, /__tmp_lint_dirty\.mjs/);
  assert.match(verdict.reason, /'someUndefinedGlobalThing' is not defined/);
});

test('REGRESSION: batch 1 has real findings and batch 2 exits 2 (fatal) → BLOCKED', () => {
  // Precedence, made order-independent. The old code kept the LAST nonzero
  // exit code, so batch 2's fatal 2 overwrote batch 1's 1 and the fatal-error
  // branch passed the commit — real findings suppressed by batch order.
  const { batches, results } = batchResults(150, { dirtyBatchIndex: 0, fatalBatchIndex: 1 });
  assert.equal(batches.length, 2);
  assert.equal(classifyLintResult(results[0]).blocked, true, 'fixture guard: batch 1 blocks');
  assert.equal(classifyLintResult(results[1]).blocked, false, 'fixture guard: batch 2 is a fatal-error warning');
  assert.ok(classifyLintResult(results[1]).warning);

  const verdict = combineBatchResults(results);
  assert.equal(verdict.blocked, true, "a later batch's fatal error must not suppress real findings");
  assert.equal(verdict.warning, undefined);
  assert.match(verdict.reason, /'someUndefinedGlobalThing' is not defined/);
});

test('a batch that could not run (warning) with no blocking batch → pass with that warning', () => {
  // Fail-open direction preserved: a batch that did not run is not evidence
  // of findings, so it must not block on its own.
  const { results } = batchResults(150, { fatalBatchIndex: 1 });
  const verdict = combineBatchResults(results);
  assert.equal(verdict.blocked, false);
  assert.ok(verdict.warning, 'the infra failure must still be surfaced');
});

test('combineBatchResults concatenates reasons from BLOCKING batches only', () => {
  const { results } = batchResults(250, { dirtyBatchIndex: 1 });
  const verdict = combineBatchResults(results);
  assert.equal(verdict.blocked, true);
  // Batches 0 and 2 are clean and contribute no reason text.
  const occurrences = verdict.reason.split("'someUndefinedGlobalThing' is not defined").length - 1;
  assert.equal(occurrences, 1, 'only the blocking batch contributes a reason');
});

test('the single-batch path still round-trips through combineBatchVerdicts', () => {
  const clean = classifyLintResult({ status: 0, error: undefined, stdout: REAL_CLEAN_STDOUT, stderr: '' });
  assert.deepEqual(combineBatchVerdicts([clean]), { blocked: false });

  const dirty = classifyLintResult({ status: 1, error: undefined, stdout: REAL_FINDINGS_STDOUT, stderr: '' });
  assert.equal(combineBatchVerdicts([dirty]).blocked, true);
});
