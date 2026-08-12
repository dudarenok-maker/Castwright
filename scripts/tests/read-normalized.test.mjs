// Regression coverage for scripts/lib/read-normalized.mjs (#2291 defect 2).
//
// The bug this guards against is invisible on an LF-native dev box by
// construction: reading a real committed file here always sees LF, because
// this box's core.autocrlf is false. So these tests build their own CRLF
// fixtures rather than reading a tracked file — that's what makes them fail
// (with the tree in its normal LF state) if the normalization is ever
// reverted, instead of passing vacuously the way a "read the real file and
// check it parses" test would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readNormalized } from '../lib/read-normalized.mjs';

function withTempFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'read-normalized-'));
  const filePath = join(dir, 'fixture.txt');
  writeFileSync(filePath, content, 'utf8');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readNormalized collapses CRLF to LF', () => {
  withTempFile('line one\r\nline two\r\nline three\r\n', (filePath) => {
    assert.equal(readNormalized(filePath), 'line one\nline two\nline three\n');
  });
});

test('readNormalized is a no-op on an already-LF file', () => {
  withTempFile('line one\nline two\n', (filePath) => {
    assert.equal(readNormalized(filePath), 'line one\nline two\n');
  });
});

// Reproduces the actual failure shape from #2291: a literal '\n'-anchored
// delimiter scan (the same kind check-onbox-register.test.mjs's
// buildAheadBaselineText and review-gate-mechanism.test.mjs's frontmatter
// regex use) misses on CRLF content, and readNormalized is what fixes it.
test('a literal \\n delimiter scan misses on raw CRLF text but finds it via readNormalized', () => {
  const body = '## Group B\r\n\r\nsome row\r\n\r\n---\r\n\r\n## Group C\r\n';
  withTempFile(body, (filePath) => {
    const raw = readFileSync(filePath, 'utf8');
    assert.equal(raw.indexOf('\n---\n'), -1, 'fixture sanity: raw CRLF text must NOT match');

    const normalized = readNormalized(filePath);
    assert.notEqual(
      normalized.indexOf('\n---\n'),
      -1,
      'readNormalized output must contain a plain LF delimiter the raw CRLF text lacks',
    );
  });
});
