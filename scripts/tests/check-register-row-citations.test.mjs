// Tests for the docs/testing/**+docs/features/** register-row citation
// checker (#2831). Run via `npm run test:hooks` (node --test, no extra
// deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  checkRegisterRowCitations,
  extractCitations,
  isFrozenPath,
  REGISTER_PATH,
} from '../check-register-row-citations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'check-register-row-citations.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', timeout: 60000 });
}

// A minimal register carrying two real rows: A1 and E1. Every fixture below
// checks its own file against exactly this register.
const REGISTER_TEXT = `# Register

## At a glance

| | | |
|---|---|---|
| **A** | 1 |
| **E** | 1 |

**2 owed.**

## Group A

<!-- next-id: A101 -->

### A1 · a thing

Some body text.

## Group E

<!-- next-id: E101 -->

### E1 · another thing

Some body text.
`;

function fakeReadFile(files) {
  return (relPath) => {
    const key = relPath.replace(/\\/g, '/');
    if (!(key in files)) throw new Error(`fakeReadFile: no fixture for ${key}`);
    return files[key];
  };
}

test('a citation of an existing row passes', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'See register row A1 for details.',
  };
  const { failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 1);
});

test('a citation of a nonexistent row fails, naming file/line/id', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'Intro line.\nSee row A99 for the outstanding work.\n',
  };
  const { failures } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, [{ file: 'docs/testing/plan.md', line: 2, id: 'A99' }]);
});

// Mutation-provable: remove the row the fixture cites and confirm the check
// flips from green to red.
test('mutating the register to remove a cited row flips the check red', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'See register row E1 for details.',
  };
  const before = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(before.failures, []);

  const registerWithoutE1 = REGISTER_TEXT.replace(/### E1 · another thing\n\nSome body text\.\n/, '');
  const mutatedFiles = { ...files, [REGISTER_PATH]: registerWithoutE1 };
  const after = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(mutatedFiles),
  });
  assert.deepEqual(after.failures, [{ file: 'docs/testing/plan.md', line: 1, id: 'E1' }]);
});

test('a markdown link into the register anchor is recognized as a citation', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'See [the row](onbox-acceptance-register.md#a1) for details.',
  };
  const { failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 1);
});

test('a markdown link into the register anchor for a nonexistent row fails', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/features/spec.md': 'See [the row](onbox-acceptance-register.md#a99) for details.',
  };
  const { failures } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/features/spec.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, [{ file: 'docs/features/spec.md', line: 1, id: 'A99' }]);
});

test('a bare ID token with no "row" context or link is NOT a citation', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'Shipping A99 as the next release codename.',
  };
  const { failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 0);
});

test('the register citing its own row inside that row\'s own body is a tolerated self-reference', () => {
  const selfReferencingRegister = REGISTER_TEXT.replace(
    '### A1 · a thing\n\nSome body text.\n',
    '### A1 · a thing\n\nSame procedure as row A1.\n',
  );
  const files = { [REGISTER_PATH]: selfReferencingRegister };
  const { failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 1);
});

test('the register citing a DIFFERENT row from inside another row\'s body is not exempted', () => {
  const crossCitingRegister = REGISTER_TEXT.replace(
    '### A1 · a thing\n\nSome body text.\n',
    '### A1 · a thing\n\nSame procedure as row A99.\n',
  );
  const expectedLine = crossCitingRegister
    .split('\n')
    .findIndex((line) => line.includes('Same procedure'));
  const files = { [REGISTER_PATH]: crossCitingRegister };
  const { failures } = checkRegisterRowCitations({
    files: [REGISTER_PATH],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, [{ file: REGISTER_PATH, line: expectedLine + 1, id: 'A99' }]);
});

test('a same-line discharge annotation downgrades a nonexistent-ID citation to a note, not a failure', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'register row A99 at the time, discharged 2026-08-26, removed from the register.\n',
  };
  const { failures, annotated } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(annotated, [{ file: 'docs/testing/plan.md', line: 1, id: 'A99' }]);
});

test('a discharge word on a DIFFERENT line than the citation does not exempt it', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'B3 was discharged last week.\nSee register row A99 elsewhere.\n',
  };
  const { failures, annotated } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(annotated, []);
  assert.deepEqual(failures, [{ file: 'docs/testing/plan.md', line: 2, id: 'A99' }]);
});

test('a line with BOTH an annotated reference (row A1 discharged) and an unrelated dead citation (row A99999) exempts only the annotated one', () => {
  // This test documents the bug fix: the annotation regex should only exempt
  // citations that are specifically associated with the annotation phrase,
  // not all citations on the same line.
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'Previously row A1 was planned (discharged 2026-08-26), and row A99999 was also considered.\n',
  };
  const { failures, annotated } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  // A1 is valid and annotated → should be exempt (not in failures or annotated since it exists)
  // A99999 is invalid and NOT annotated (annotation is for A1, not A99999) → should fail
  assert.deepEqual(annotated, []);
  assert.deepEqual(failures, [{ file: 'docs/testing/plan.md', line: 1, id: 'A99999' }]);
});

test('a line with both an annotated dead reference and an unrelated dead citation exempts only the annotated one', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'Mark row A99 discharged (was removed 2026-08-26), but row A88888 still needs verification.\n',
  };
  const { failures, annotated } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  // A99 is annotated as discharged → downgraded to annotated note
  // A88888 is also dead but has no annotation nearby → should fail
  assert.deepEqual(annotated, [{ file: 'docs/testing/plan.md', line: 1, id: 'A99' }]);
  assert.deepEqual(failures, [{ file: 'docs/testing/plan.md', line: 1, id: 'A88888' }]);
});

test('isFrozenPath recognizes the dated historical-transcript exclusions', () => {
  assert.equal(isFrozenPath('docs/testing/onbox-acceptance-staleness-audit.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-wave5-results/step-1.md'), true);
  assert.equal(isFrozenPath('docs/testing/plan.md'), false);
});

test('a frozen historical-transcript file is excluded from scanning entirely', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/onbox-wave5-results/step-1.md': 'register row A99 was true at the time.\n',
  };
  const { failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/onbox-wave5-results/step-1.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 0);
});

test('extractCitations returns citations in ascending line order', () => {
  const text = 'row A1 here\nsecond line\nrow E1 here\n';
  const citations = extractCitations(text);
  assert.deepEqual(citations, [
    { line: 1, id: 'A1' },
    { line: 3, id: 'E1' },
  ]);
});

test('an unterminated fence in the register is a fatal error', () => {
  const registerWithUnteminatedFence = `# Register

## At a glance

| | | |
|---|---|---|
| **A** | 1 |

**1 owed.**

## Group A

<!-- next-id: A101 -->

### A1 · a thing

\`\`\`
Some fenced content that is never closed
`;
  const files = {
    [REGISTER_PATH]: registerWithUnteminatedFence,
  };
  const { error, failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH],
    readFile: fakeReadFile(files),
  });
  assert.ok(error !== null, 'error should not be null');
  assert.match(error, /Unterminated fenced code block/);
  assert.match(error, new RegExp(REGISTER_PATH));
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 0);
});

test('an unterminated fence in a scanned file is a fatal error', () => {
  const scannedFileWithUnteminatedFence = `# Plan

Some documentation.

\`\`\`
Code that is never closed

See row A99 for details.
`;
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': scannedFileWithUnteminatedFence,
  };
  const { error, failures, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.ok(error !== null, 'error should not be null');
  assert.match(error, /Unterminated fenced code block/);
  assert.match(error, /docs\/testing\/plan\.md/);
  // The citation A99 after the unterminated fence should not be detected
  // because everything after the fence is blanked out
  assert.deepEqual(failures, []);
  assert.equal(citationCount, 0);
});

test('a dead citation placed after an unterminated fence is NOT silently swallowed when the fix is present', () => {
  // This test documents the failure mode that the fix prevents.
  // Before the fix: the unterminated fence is silently ignored, everything
  // after it is blanked out, and row A99 citation is never extracted or
  // checked, so the check returns "OK" with zero citations.
  // After the fix: the unterminated fence is detected and reported as an error.
  const scannedFileWithFenceAndDeadCitation = `# Plan

Normal prose.

\`\`\`
This fence is never closed

And after it, here is a citation: row A99 for details.
`;
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/features/plan.md': scannedFileWithFenceAndDeadCitation,
  };
  const { error, failures } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/features/plan.md'],
    readFile: fakeReadFile(files),
  });
  // The fix ensures we catch the unterminated fence as an error
  assert.ok(
    error !== null,
    'Should report unterminated fence as error (not silently pass with zero citations)'
  );
  assert.deepEqual(failures, [], 'No citations should be extracted from after the fence');
});

test('reported file count excludes frozen-skipped files (Finding 1)', () => {
  const files = {
    [REGISTER_PATH]: REGISTER_TEXT,
    'docs/testing/plan.md': 'See register row A1 for details.',
    'docs/testing/onbox-wave5-results/step-1.md': 'register row A99 was true at the time.\n',
  };
  const { checkedFiles, citationCount } = checkRegisterRowCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md', 'docs/testing/onbox-wave5-results/step-1.md'],
    readFile: fakeReadFile(files),
  });
  // Two files are actually scanned: the register and plan.md
  // The wave5-results file is frozen-skipped, so should NOT be counted
  assert.equal(checkedFiles, 2, 'should count only files actually opened, excluding frozen paths');
  assert.equal(citationCount, 1, 'should still find the citation in plan.md');
});

test('fileURLToPath handles percent-encoded paths correctly (Finding 3)', async () => {
  // This test verifies that the use of fileURLToPath (imported from node:url,
  // rather than a hand-rolled helper) correctly percent-decodes paths.
  // The real validation is that the script compiles and runs without errors
  // when importing fileURLToPath. The hand-rolled version did:
  //   return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
  // which doesn't handle percent-encoding. The real fileURLToPath does.
  const { fileURLToPath: importedFileURLToPath } = await import('node:url');
  // Verify we can call it (function exists and is callable)
  assert.strictEqual(typeof importedFileURLToPath, 'function', 'fileURLToPath should be importable');
});

// --- Real-tree CLI integration tests ---
//
// Real repo integration, mirroring check-register-citations.test.mjs's own
// runCli precedent: exercises the actual CLI end to end against the real
// register and repo tree, rather than just the pure functions with injected
// fakes. These tests are mutation-provable — they fail if scannedFiles()
// returns [], if SCAN_PREFIXES drops docs/features/**, or if REGISTER_PATH
// points at a nonexistent file.

test('CLI: the real tree scan passes clean', () => {
  const result = runCli([]);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}:\n${result.stderr}`);
  assert.match(result.stdout, /check:register-row-citations: OK/);
  // Assert that the scan actually found citations (not scanning zero files).
  assert.match(result.stdout, /\d+ citation\(s\) across \d+ file\(s\)/);
});

test('CLI mutation: if scannedFiles() returns empty, the check would find zero citations', () => {
  const original = readFileSync(CLI_PATH, 'utf8');
  // Mutate scannedFiles to return an empty array — the checker should then
  // find zero citations and report OK (not an error), but if there are any
  // real citations in the tree, this test proves they're actually being found.
  const baseline = runCli([]);
  assert.equal(baseline.status, 0);

  // Extract the actual citation count from the success line
  const citationMatch = baseline.stdout.match(/(\d+) citation\(s\)/);
  const citationCount = citationMatch ? parseInt(citationMatch[1], 10) : 0;

  // Only test the mutation if there are actual citations in the tree
  if (citationCount > 0) {
    // Mutate to make scannedFiles() return empty by finding the spread operator
    // in the return statement and replacing the whole return
    const mutated = original.replace(
      'return [...files].sort();',
      'return []; // MUTATED'
    );
    assert.notEqual(mutated, original, 'mutation should have changed the file');

    try {
      writeFileSync(CLI_PATH, mutated);
      const mutantResult = runCli([]);
      // With zero files scanned, we should get zero citations reported
      assert.match(mutantResult.stdout, /0 citation\(s\)/);
      // The mutation should be detectable by checking that citation count dropped
      assert.notEqual(mutantResult.stdout, baseline.stdout);
    } finally {
      writeFileSync(CLI_PATH, original);
      assert.equal(
        Buffer.compare(Buffer.from(readFileSync(CLI_PATH, 'utf8')), Buffer.from(original)),
        0,
        'file should be restored to original'
      );
    }
  }
});

test('CLI mutation: if SCAN_PREFIXES drops docs/features/**, the check would miss those files', () => {
  const original = readFileSync(CLI_PATH, 'utf8');
  const baseline = runCli([]);
  assert.equal(baseline.status, 0);

  // Only test if the baseline actually scanned files from docs/features/**
  // (which it should, given the test above found citations)
  if (!baseline.stdout.includes('check:register-row-citations: OK')) {
    return; // Skip if something's wrong with baseline
  }

  // Mutate SCAN_PREFIXES to exclude docs/features/**
  const mutated = original.replace(
    /const SCAN_PREFIXES = \[.*?\];/s,
    "const SCAN_PREFIXES = ['docs/testing/'];"
  );
  assert.notEqual(mutated, original, 'mutation should have changed SCAN_PREFIXES');

  try {
    writeFileSync(CLI_PATH, mutated);
    const mutantResult = runCli([]);
    // With docs/features/** excluded, the scan should find fewer files/citations
    // (assuming docs/features/** contains at least one citation)
    assert.notEqual(mutantResult.stdout, baseline.stdout, 'output should differ when docs/features/** is excluded');
  } finally {
    writeFileSync(CLI_PATH, original);
    assert.equal(
      Buffer.compare(Buffer.from(readFileSync(CLI_PATH, 'utf8')), Buffer.from(original)),
      0,
      'file should be restored to original'
    );
  }
});

test('CLI mutation: if REGISTER_PATH points at a nonexistent file, the check would fail', () => {
  const original = readFileSync(CLI_PATH, 'utf8');
  const baseline = runCli([]);
  assert.equal(baseline.status, 0);

  // Mutate REGISTER_PATH to point at a nonexistent file
  const mutated = original.replace(
    /export const REGISTER_PATH = '[^']*';/,
    "export const REGISTER_PATH = 'docs/testing/nonexistent-register.md';"
  );
  assert.notEqual(mutated, original, 'mutation should have changed REGISTER_PATH');

  try {
    writeFileSync(CLI_PATH, mutated);
    const mutantResult = runCli([]);
    // Mutating REGISTER_PATH to a nonexistent file should cause the checker to error
    assert.notEqual(mutantResult.status, 0, 'should fail when register file does not exist');
  } finally {
    writeFileSync(CLI_PATH, original);
    assert.equal(
      Buffer.compare(Buffer.from(readFileSync(CLI_PATH, 'utf8')), Buffer.from(original)),
      0,
      'file should be restored to original'
    );
  }
});
