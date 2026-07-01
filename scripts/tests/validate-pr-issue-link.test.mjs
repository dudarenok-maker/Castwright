// Tests for the PR issue-link validator.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasIssueLink } from '../validate-pr-issue-link.mjs';

const accepted = [
  'Closes #123',
  'This PR Refs #45 for a partial delivery.',
  'Some text.\n\nCloses #1\n\nMore text.',
  'refs #99',
  'CLOSES #7',
  'See `npm run verify` first.\n\nCloses #55',
  // A stray/unpaired backtick in an earlier paragraph must not pair across
  // a blank-line (paragraph) boundary with a later, unrelated backtick and
  // swallow a real Closes/Refs reference sitting in between.
  'It cost $5` per unit.\n\nCloses #12 — see the `config` value.',
];

const rejected = [
  '',
  'No issue link here.',
  'See issue 123 for details.',
  '`Closes #123`',
  '```\nCloses #123\n```',
  'This encloses #123 something unrelated.',
  'Closesnt #123',
  'Closed #123',
];

for (const body of accepted) {
  test(`accepts: ${JSON.stringify(body)}`, () => {
    assert.equal(hasIssueLink(body), true, `expected true for ${JSON.stringify(body)}`);
  });
}

for (const body of rejected) {
  test(`rejects: ${JSON.stringify(body)}`, () => {
    assert.equal(hasIssueLink(body), false, `expected false for ${JSON.stringify(body)}`);
  });
}

test('rejects non-string input', () => {
  assert.equal(hasIssueLink(undefined), false);
  assert.equal(hasIssueLink(null), false);
});
