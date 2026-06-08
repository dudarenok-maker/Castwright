/* Tests for scripts/repair-narrator-credit.mjs
   Run via: node --test scripts/tests/repair-narrator-credit.test.mjs

   Covers planBackfill: the pure function that decides which books need
   'Castwright' written as their narratorCredit.  An explicit (non-empty,
   non-whitespace) credit is left untouched; null / empty / whitespace → included. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planBackfill, main } from '../repair-narrator-credit.mjs';

// ---------------------------------------------------------------------------
// planBackfill — pure function tests
// ---------------------------------------------------------------------------

test('planBackfill: null narratorCredit → included', () => {
  const result = planBackfill([{ bookId: 'book-a', narratorCredit: null }]);
  assert.deepEqual(result, ['book-a']);
});

test('planBackfill: undefined narratorCredit → included', () => {
  const result = planBackfill([{ bookId: 'book-b', narratorCredit: undefined }]);
  assert.deepEqual(result, ['book-b']);
});

test('planBackfill: empty string narratorCredit → included', () => {
  const result = planBackfill([{ bookId: 'book-c', narratorCredit: '' }]);
  assert.deepEqual(result, ['book-c']);
});

test('planBackfill: whitespace-only narratorCredit → included', () => {
  const result = planBackfill([{ bookId: 'book-d', narratorCredit: '   ' }]);
  assert.deepEqual(result, ['book-d']);
});

test('planBackfill: explicit credit → excluded', () => {
  const result = planBackfill([{ bookId: 'book-e', narratorCredit: 'Jane Narrator' }]);
  assert.deepEqual(result, []);
});

test('planBackfill: "Castwright" already set → excluded (not re-written)', () => {
  /* The brand default itself counts as explicit once written — idempotent. */
  const result = planBackfill([{ bookId: 'book-f', narratorCredit: 'Castwright' }]);
  assert.deepEqual(result, []);
});

test('planBackfill: mixed — only the empty/null entries are returned', () => {
  const books = [
    { bookId: 'a', narratorCredit: null },
    { bookId: 'b', narratorCredit: 'Jane' },
    { bookId: 'c', narratorCredit: '' },
    { bookId: 'd', narratorCredit: 'Castwright' },
    { bookId: 'e', narratorCredit: '  ' },
  ];
  const result = planBackfill(books);
  assert.deepEqual(result, ['a', 'c', 'e']);
});

test('planBackfill: empty array → empty result', () => {
  assert.deepEqual(planBackfill([]), []);
});

// ---------------------------------------------------------------------------
// main --apply — integration: writes narratorCredit only where empty
// ---------------------------------------------------------------------------

test('main --apply writes Castwright where narratorCredit is missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-narrator-credit-test-'));
  try {
    const booksRoot = join(tmp, 'books');
    const bookDir = join(booksRoot, 'My Book');
    const audiobookDir = join(bookDir, '.audiobook');
    mkdirSync(audiobookDir, { recursive: true });
    writeFileSync(
      join(audiobookDir, 'state.json'),
      JSON.stringify({ title: 'My Book', author: 'Author A', narratorCredit: null }),
    );

    await main(['--apply'], booksRoot);

    const written = JSON.parse(readFileSync(join(audiobookDir, 'state.json'), 'utf8'));
    assert.equal(written.narratorCredit, 'Castwright');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main --apply skips books with an explicit credit', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-narrator-credit-skip-'));
  try {
    const booksRoot = join(tmp, 'books');
    const bookDir = join(booksRoot, 'Another Book');
    const audiobookDir = join(bookDir, '.audiobook');
    mkdirSync(audiobookDir, { recursive: true });
    const initial = { title: 'Another Book', author: 'Author B', narratorCredit: 'Jane Narrator' };
    writeFileSync(join(audiobookDir, 'state.json'), JSON.stringify(initial));

    await main(['--apply'], booksRoot);

    const written = JSON.parse(readFileSync(join(audiobookDir, 'state.json'), 'utf8'));
    assert.equal(written.narratorCredit, 'Jane Narrator', 'explicit credit must NOT be overwritten');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main dry-run does NOT modify state.json', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'repair-narrator-credit-dry-'));
  try {
    const booksRoot = join(tmp, 'books');
    const bookDir = join(booksRoot, 'Dry Book');
    const audiobookDir = join(bookDir, '.audiobook');
    mkdirSync(audiobookDir, { recursive: true });
    const initial = { title: 'Dry Book', author: 'Author C', narratorCredit: null };
    writeFileSync(join(audiobookDir, 'state.json'), JSON.stringify(initial));

    /* No --apply → dry-run default */
    await main([], booksRoot);

    const written = JSON.parse(readFileSync(join(audiobookDir, 'state.json'), 'utf8'));
    assert.equal(written.narratorCredit, null, 'dry-run must not touch state.json');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
