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
  // A stray, unpaired ``` embedded mid-line (not alone on its own line) is
  // not a real fenced-code delimiter and must not pair with an unrelated
  // ``` later in the body across paragraph breaks, swallowing a real
  // Closes/Refs reference sitting in between.
  'Version ```\nnote.\n\nCloses #5\n\nSee ```\nagain.',
  // Two real, properly-paired fenced blocks with a real link between them
  // must still resolve correctly.
  '```\nsome code\n```\n\nCloses #6\n\n```\nmore code\n```',
  // A fence with NO blank line on either side is still a block boundary --
  // a stray backtick before it must not pair, across the fence, with a
  // backtick after it and swallow a real Closes/Refs reference sitting in
  // the paragraph right after the fence closes.
  'a`\n```\nc\n```\nCloses #9 `d`',
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
  // A double-backtick-delimited span is a single real code span (per
  // CommonMark) and must not be mis-parsed as two adjacent empty
  // single-backtick spans, which would leak its "Closes #NN" content
  // through unstripped.
  '``Closes #5``',
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
