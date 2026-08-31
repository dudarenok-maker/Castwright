// Tests for the docs/testing/**+docs/features/** register-row citation
// checker (#2831). Run via `npm run test:hooks` (node --test, no extra
// deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkRegisterCitations,
  extractCitations,
  isFrozenPath,
  REGISTER_PATH,
} from '../check-register-row-citations.mjs';

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
  const { failures, citationCount } = checkRegisterCitations({
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
  const { failures } = checkRegisterCitations({
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
  const before = checkRegisterCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(before.failures, []);

  const registerWithoutE1 = REGISTER_TEXT.replace(/### E1 · another thing\n\nSome body text\.\n/, '');
  const mutatedFiles = { ...files, [REGISTER_PATH]: registerWithoutE1 };
  const after = checkRegisterCitations({
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
  const { failures, citationCount } = checkRegisterCitations({
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
  const { failures } = checkRegisterCitations({
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
  const { failures, citationCount } = checkRegisterCitations({
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
  const { failures, citationCount } = checkRegisterCitations({
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
  const { failures } = checkRegisterCitations({
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
  const { failures, annotated } = checkRegisterCitations({
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
  const { failures, annotated } = checkRegisterCitations({
    files: [REGISTER_PATH, 'docs/testing/plan.md'],
    readFile: fakeReadFile(files),
  });
  assert.deepEqual(annotated, []);
  assert.deepEqual(failures, [{ file: 'docs/testing/plan.md', line: 2, id: 'A99' }]);
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
  const { failures, citationCount } = checkRegisterCitations({
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
