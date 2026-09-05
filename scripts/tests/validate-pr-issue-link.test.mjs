// Tests for the PR issue-link validator.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hasIssueLink, isDependabotExempt } from '../validate-pr-issue-link.mjs';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'validate-pr-issue-link.mjs',
);

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

// --- #2791/#2433: dependabot[bot] exemption -----------------------------
// PR review gate finding on #2791: main's rulesets require this check with
// bypass_actors: [], and a Dependabot-authored PR body never contains
// Closes/Refs (it has no mechanism to add one), so every Dependabot PR was
// permanently unmergeable. isDependabotExempt() is the single carve-out;
// these tests pin both halves so the exemption can't quietly widen or
// silently do nothing.

test('isDependabotExempt: true only for the exact bot login', () => {
  assert.equal(isDependabotExempt('dependabot[bot]'), true);
  assert.equal(isDependabotExempt('dependabot'), false);
  assert.equal(isDependabotExempt('Dependabot[bot]'), false); // case-sensitive on purpose
  assert.equal(isDependabotExempt('some-human'), false);
  assert.equal(isDependabotExempt('renovate[bot]'), false);
  assert.equal(isDependabotExempt(undefined), false);
  assert.equal(isDependabotExempt(''), false);
});

// CLI-level (not just unit-level): this is what the workflow actually
// invokes, so it's the shape that would have caught the original finding —
// before this fix, the script took no author argument at all and a
// Dependabot PR body with no Closes/Refs exited 1 exactly like a human's.
test('CLI: a dependabot[bot]-authored PR with no Closes/Refs still passes the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-issue-link-'));
  try {
    const bodyFile = join(dir, 'body.txt');
    // Real shape of a Dependabot PR body (see PR #873, cited in the finding):
    // no Closes/Refs anywhere.
    writeFileSync(
      bodyFile,
      'Bumps [esbuild](https://github.com/evanw/esbuild) from 0.28.0 to 0.28.1.\n',
    );
    const result = spawnSync(process.execPath, [scriptPath, bodyFile, 'dependabot[bot]'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The negative control the exemption must not disarm: same body, same
// script, different (human) author — must still fail. Without this case, a
// broken exemption that skips the check for EVERY author would pass the
// test above and go undetected.
test('CLI: a human-authored PR with no Closes/Refs still fails the check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-issue-link-'));
  try {
    const bodyFile = join(dir, 'body.txt');
    writeFileSync(
      bodyFile,
      'Bumps [esbuild](https://github.com/evanw/esbuild) from 0.28.0 to 0.28.1.\n',
    );
    const result = spawnSync(process.execPath, [scriptPath, bodyFile, 'some-human'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(
      result.status,
      1,
      `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// And a human PR that DOES link an issue must still pass — the exemption
// path must not have broken the ordinary case.
test('CLI: a human-authored PR with a Closes link still passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-issue-link-'));
  try {
    const bodyFile = join(dir, 'body.txt');
    writeFileSync(bodyFile, 'Closes #123\n');
    const result = spawnSync(process.execPath, [scriptPath, bodyFile, 'some-human'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(
      result.status,
      0,
      `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
