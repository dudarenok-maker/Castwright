import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTopReleaseNote,
  isPlaceholderNotes,
  checkReleaseNotes,
  findMojibake,
  checkMojibake,
} from '../release-notes-gate.mjs';

const REAL = '# Castwright 1.7.0\n- **Mac.** Runs on Mac.\n\n# Castwright 1.6.0\n- **x.** y.';
const PLACEHOLDER = '# v9.9.9\n\nSee the GitHub release for details.';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parseTopReleaseNote reads only the newest section', () => {
  const top = parseTopReleaseNote(REAL);
  assert.equal(top.version, '1.7.0');
  assert.equal(top.bullets.length, 1);
});

test('isPlaceholderNotes flags empty / placeholder / no-bullets', () => {
  assert.equal(isPlaceholderNotes(''), true);
  assert.equal(isPlaceholderNotes(PLACEHOLDER), true);
  assert.equal(isPlaceholderNotes(REAL), false);
});

test('checkReleaseNotes passes when the top section matches the version', () => {
  assert.equal(checkReleaseNotes(REAL, '1.7.0').ok, true);
  assert.equal(checkReleaseNotes(REAL, 'v1.7.0').ok, true); // tolerate a leading v
});

test('checkReleaseNotes fails on placeholder or version mismatch', () => {
  assert.equal(checkReleaseNotes(PLACEHOLDER, '9.9.9').ok, false);
  assert.equal(checkReleaseNotes(REAL, '1.6.0').ok, false); // top is 1.7.0, not 1.6.0
  assert.equal(checkReleaseNotes('', '1.7.0').ok, false);
});

// #1956 — mojibake guard: a double-UTF-8-encoded em dash/arrow/etc. (correct
// UTF-8 bytes misread as windows-1252 and re-encoded as UTF-8).
const MOJIBAKE_EM_DASH = 'â€”'; // should decode to U+2014 —
const MOJIBAKE_ARROW = 'â†’'; // should decode to U+2192 →

test('findMojibake finds double-UTF-8-encoded spans and decodes them correctly', () => {
  const corrupt = `dash: ${MOJIBAKE_EM_DASH} arrow: ${MOJIBAKE_ARROW} end`;
  const hits = findMojibake(corrupt);
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.decoded.startsWith('—'))); // em dash
  assert.ok(hits.some((h) => h.decoded.startsWith('→'))); // arrow
});

test('findMojibake does not flag clean ASCII or already-correct Unicode', () => {
  assert.equal(findMojibake('Plain ASCII text.').length, 0);
  assert.equal(
    findMojibake('Already correct: em dash —, arrow →, ellipsis …, café, résumé').length,
    0,
  );
});

test('checkMojibake passes on clean text and fails on corrupted text', () => {
  assert.equal(checkMojibake('Clean text with a real — dash.', 'test.md').ok, true);
  const res = checkMojibake(`Corrupted: ${MOJIBAKE_EM_DASH} dash.`, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /test\.md/);
  assert.match(res.reason, /1 double-UTF-8-encoded mojibake span/);
});

test('checkMojibake reports a capped sample plus a remainder count', () => {
  const many = Array(8).fill(MOJIBAKE_EM_DASH).join(' x ');
  const res = checkMojibake(many, 'test.md');
  assert.equal(res.ok, false);
  assert.match(res.reason, /8 double-UTF-8-encoded mojibake span\(s\)/);
  assert.match(res.reason, /\+3 more/);
});

// Regression: this must FAIL against the pre-#1956-fix content of
// docs/release-notes-next.md (242 mojibake spans found on main @ b5479e9c)
// and PASS now that the file has been re-encoded. Asserting against the
// actual committed file means the guard fires pre-commit, not only at tag
// time, if the corruption ever comes back.
test('the committed docs/release-notes-next.md is free of mojibake', () => {
  const text = readFileSync(resolve(repoRoot, 'docs/release-notes-next.md'), 'utf8');
  const res = checkMojibake(text, 'docs/release-notes-next.md');
  assert.equal(res.ok, true, res.reason);
});

test('the committed RELEASE_NOTES.md is free of mojibake', () => {
  const text = readFileSync(resolve(repoRoot, 'RELEASE_NOTES.md'), 'utf8');
  const res = checkMojibake(text, 'RELEASE_NOTES.md');
  assert.equal(res.ok, true, res.reason);
});
