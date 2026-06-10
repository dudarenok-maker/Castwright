import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTopReleaseNote,
  isPlaceholderNotes,
  checkReleaseNotes,
} from '../release-notes-gate.mjs';

const REAL = '# Castwright 1.7.0\n- **Mac.** Runs on Mac.\n\n# Castwright 1.6.0\n- **x.** y.';
const PLACEHOLDER = '# v9.9.9\n\nSee the GitHub release for details.';

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
