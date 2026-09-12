// Pins the wiring fix for #3116: the stamped-since check compares against the
// merge commit's first parent (HEAD^1), not the stale github.event.pull_request.base.sha.
//
// Pass 4 changed the wiring from `--stamped-since ${{ github.event.pull_request.base.sha }}`
// to `--stamped-since HEAD^1` with `fetch-depth: 2` so that the base ref is available.
// Prior to the fix, CI silently compared against a base.sha that was stale whenever
// another PR had merged in the meantime, so a PR would report "OK" on a change that had
// differed from main for up to 27 commits (pass 4 observed exactly that). The wiring
// test exists because reverting to base.sha would pass silently — the predicate would
// still work on the intended cases, but on the actual cases where main had published
// since this PR opened, it would report OK for the violation it exists to catch.
//
// This test also pins the paired if: condition (see pr-issue-link-workflow-wiring.test.mjs's
// job-level if: guard for the reasoning — the required-status-context shape — plus
// #3116's own comment in the workflow) and the fetch-depth wiring that makes HEAD^1 available.
//
// #3138 folded the standalone, path-filtered onbox-register-check.yml workflow into
// verify.yml's `lint-and-checks` job (that job's context is what main's branch
// protection actually requires; the old workflow's never could be). Every assertion
// below now reads verify.yml and is scoped to the `lint-and-checks` job block, not the
// whole file — other jobs in verify.yml (e.g. `detect`, `frontend-tests`) legitimately
// reference `github.event.pull_request.base.sha` for unrelated diff-scoping, so a
// file-wide scan for that string would false-positive once the checks shared a file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'verify.yml');
// readNormalized, not a bare readFileSync: the assertions below scan for a literal '\n'
// after a YAML key, which misses on a CRLF checkout (#2291).
const source = readNormalized(workflowPath);

// Isolate the `lint-and-checks` job block — same job-block regex shape as
// workflow-wiring.test.mjs's own job scan — so the assertions below can't
// accidentally match an unrelated job's Checkout step or base.sha reference.
const jobMatch = source.match(/^ {2}lint-and-checks:\n((?: {4}.*\n|\n)*)/m);
assert.ok(jobMatch, "job 'lint-and-checks' not found — did it get renamed?");
const jobBody = jobMatch[1];

test('the checkout step sets fetch-depth: 0 so HEAD^1 is available', () => {
  const checkoutMatch = jobBody.match(/- name: Checkout\n((?: {8}.*\n|\n)*)/);
  assert.ok(checkoutMatch, "step 'Checkout' not found in lint-and-checks — did it get renamed?");
  const checkoutBody = checkoutMatch[1];

  assert.match(
    checkoutBody,
    /fetch-depth:\s*0/,
    'checkout step does not set fetch-depth: 0 — without full history, HEAD^1 (the merge ' +
      'commit\'s first parent) is not available and `git show HEAD^1:...` fails',
  );
});

test('the stamped-since check runs with --stamped-since HEAD^1, not a stale base.sha', () => {
  const stampStepMatch = jobBody.match(
    /- name: Check the live view was re-stamped if its content changed\n((?: {8}.*\n|\n)*)/,
  );
  assert.ok(
    stampStepMatch,
    'step "Check the live view was re-stamped if its content changed" not found — did it get renamed?',
  );
  const stampStepBody = stampStepMatch[1];

  // The bug was base.sha staying at its value when the PR opened, while the merge ref
  // followed main. When another PR merged in the meantime, CI would silently compare
  // against a base that was now 27 commits behind, and report OK on unstamped edits
  // that differed from main (pass 4 observed 3 consecutive runs with this). Scoped to
  // the lint-and-checks job body: other jobs use base.sha for unrelated diff-scoping.
  assert.doesNotMatch(
    jobBody,
    /pull_request\.base\.sha/,
    'lint-and-checks job contains "pull_request.base.sha" — this is stale (base.sha stays at ' +
      'the value when the PR opened, while the merge ref follows main). Use HEAD^1 instead',
  );

  assert.match(
    stampStepBody,
    /run:\s*node scripts\/check-onbox-register\.mjs --stamped-since HEAD\^1/,
    'stamp step does not run `--stamped-since HEAD^1` — it compares against a stale ' +
      'base.sha or is missing the flag entirely',
  );
});

test('the stamped-since step is skipped with !cancelled() so it runs even if an earlier step fails', () => {
  const stampStepMatch = jobBody.match(
    /- name: Check the live view was re-stamped if its content changed\n((?: {8}.*\n|\n)*)/,
  );
  assert.ok(stampStepMatch, "step 'Check the live view was re-stamped...' not found");
  const stampStepBody = stampStepMatch[1];

  assert.match(
    stampStepBody,
    /if:\s*\$\{\{\s*!cancelled\(\)\s*&&\s*github\.event_name\s*==\s*'pull_request'\s*&&/,
    'stamp step\'s `if:` does not include `!cancelled()` && `github.event_name == \'pull_request\'`, ' +
      'in that order — if an earlier step fails, this check would be skipped instead of ' +
      'evaluating and reporting the issue',
  );
});
