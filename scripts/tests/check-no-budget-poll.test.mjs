// scripts/tests/check-no-budget-poll.test.mjs
// Planted-sample acceptance tests for the budgeted-poll + oversized-timeout
// heuristic checker (scripts/check-no-budget-poll.mjs).
//
// Run via node:test (npm run test:hooks).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanContent } from '../check-no-budget-poll.mjs';

const repoRoot = process.cwd();

// ---------------------------------------------------------------------------
// Unit tests against scanContent() directly (no subprocess, no temp files)
// ---------------------------------------------------------------------------

test('scanContent: flags budgeted poll line', () => {
  const content = [
    'while (!done) {',
    "  if (Date.now() - start > 5000) throw new Error('timed out');",
    '  await sleep(5);',
    '}',
  ].join('\n');
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'budget-poll');
  assert.equal(hits[0].line, 2);
});

test('scanContent: flags oversized timeout > 120000', () => {
  const content = "it('slow test', async () => {\n  await doWork();\n}, 180000);\n";
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'oversized-timeout');
});

test('scanContent: flags oversized timeout with underscores (180_000)', () => {
  const content = "it('slow test', async () => {\n  await doWork();\n}, 180_000);\n";
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'oversized-timeout');
});

test('scanContent: does NOT flag 60_000 (legitimate ffmpeg timeout)', () => {
  const content = "it('ffmpeg test', async () => {\n  await runFfmpeg();\n}, 60_000);\n";
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 0);
});

test('scanContent: does NOT flag 120_000 (at the threshold, not over)', () => {
  const content = "it('test', async () => {\n  await thing();\n}, 120_000);\n";
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 0);
});

test('scanContent: does NOT flag elapsed measurement (no > comparison)', () => {
  // `const elapsed = Date.now() - start;` is a timing assertion, not a poll
  const content = "const elapsed = Date.now() - start;\nexpect(elapsed).toBeLessThan(500);\n";
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 0);
});

test('scanContent: flags both patterns in the same file', () => {
  const content = [
    "if (Date.now() - start > timeoutMs) throw new Error('timed out');",
    "it('x', async () => { await x(); }, 180_000);",
  ].join('\n');
  const hits = scanContent(content, 'fake.test.ts');
  assert.equal(hits.length, 2);
  const kinds = hits.map((h) => h.kind).sort();
  assert.deepEqual(kinds, ['budget-poll', 'oversized-timeout']);
});

// ---------------------------------------------------------------------------
// Integration test: run the CLI against a planted-violation temp directory
// and against a clean one, asserting exit codes.
// ---------------------------------------------------------------------------

test('CLI exits non-zero against a planted budgeted-poll + oversized-timeout file', () => {
  // Temp dir is INSIDE the repo so node path resolution works correctly.
  // We put a *.test.ts file in it so the scanner picks it up.
  const dir = mkdtempSync(join(repoRoot, 'budget-poll-tmp-'));
  const f = join(dir, 'planted.test.ts');
  writeFileSync(
    f,
    [
      "import { it } from 'vitest';",
      'async function until(pred) {',
      '  const start = Date.now();',
      '  while (!pred()) {',
      "    if (Date.now() - start > 5000) throw new Error('timed out');",
      '    await new Promise((r) => setTimeout(r, 5));',
      '  }',
      '}',
      "it('bloated', async () => { await work(); }, 180000);",
    ].join('\n'),
  );

  let exitCode;
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-no-budget-poll.mjs', dir],
      { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' },
    );
    exitCode = result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.notEqual(exitCode, 0, 'checker should exit non-zero for the planted violation');
});

test('CLI exits 0 against a clean temp directory', () => {
  const dir = mkdtempSync(join(repoRoot, 'budget-poll-tmp-'));
  const f = join(dir, 'clean.test.ts');
  writeFileSync(
    f,
    [
      "import { it, vi } from 'vitest';",
      'async function until(pred) {',
      '  await vi.waitFor(() => { if (!pred()) throw new Error(); });',
      '}',
      "it('ok', async () => { await stuff(); }, 60_000);",
    ].join('\n'),
  );

  let exitCode;
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-no-budget-poll.mjs', dir],
      { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' },
    );
    exitCode = result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(exitCode, 0, 'checker should exit 0 for a clean file');
});
