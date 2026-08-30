// Pins the wiring commit 75e831b1 added to .github/workflows/pr-issue-link.yml
// for the Dependabot exemption (#2433/#2791): the workflow passes PR_AUTHOR
// (sourced from github.event.pull_request.user.login) into
// scripts/validate-pr-issue-link.mjs's argv[3], which isDependabotExempt()
// reads to decide whether to skip the issue-link requirement.
//
// scripts/tests/validate-pr-issue-link.test.mjs covers isDependabotExempt()
// and hasIssueLink() thoroughly, but nothing asserted that the WORKFLOW
// actually wires PR_AUTHOR through -- delete the workflow's `env:` block and
// every one of those tests still passes, because they call the exported
// functions directly and never touch the YAML. argv[3] would be `undefined`,
// isDependabotExempt(undefined) is false, and Dependabot would be blocked
// again with no test able to see it (found reviewing PR #2791's fix).
//
// This also pins the fix's OWN comment's second claim: the exemption is
// scoped to a single STEP's `env:`, not a job-level `if:` -- a job-level
// skip would leave this required status context PENDING forever on a
// Dependabot PR (a required check needs a completed run to report success,
// not merely to be skipped), which blocks merge exactly as hard as an
// outright failure. Same two-direction shape as workflow-wiring.test.mjs's
// "aggregator sentinel" test, scoped to this smaller workflow.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'pr-issue-link.yml');
// readNormalized, not a bare readFileSync: several assertions below scan for
// a literal '\n' after a YAML key, which misses on a CRLF checkout (#2291).
const source = readNormalized(workflowPath);

test('the lint job carries no job-level `if:` that could skip the step entirely', () => {
  const jobMatch = source.match(/^ {2}lint:\n((?: {4}.*\n|\n)*)/m);
  assert.ok(jobMatch, "job 'lint' not found in pr-issue-link.yml — did it get renamed?");
  const jobBody = jobMatch[1];
  // Job-level keys sit at 4-space indent, directly under `lint:`. A job-level
  // `if:` at that indent would leave the required status context PENDING
  // (not failed, not passed) on any PR it skips — which blocks merge exactly
  // as hard as an outright failure, and worse: silently, forever.
  assert.doesNotMatch(
    jobBody,
    /^ {4}if:/m,
    'lint job carries a job-level `if:` — this would leave the required status ' +
      'context PENDING forever on a skipped PR instead of completing green; the ' +
      'Dependabot exemption must live at the step level (env: PR_AUTHOR), not here',
  );
});

test('the "Validate PR issue link" step passes PR_AUTHOR sourced from the PR author', () => {
  const stepMatch = source.match(/- name: Validate PR issue link\n((?: {8}.*\n|\n)*)/);
  assert.ok(
    stepMatch,
    "step 'Validate PR issue link' not found in pr-issue-link.yml — did it get renamed?",
  );
  const stepBody = stepMatch[1];

  assert.match(
    stepBody,
    /env:\n\s*PR_AUTHOR:\s*\$\{\{\s*github\.event\.pull_request\.user\.login\s*\}\}/,
    'the "Validate PR issue link" step does not pass ' +
      'PR_AUTHOR: ${{ github.event.pull_request.user.login }} in its env: block — ' +
      'without it, argv[3] is undefined, isDependabotExempt(undefined) is false, ' +
      'and every Dependabot PR is blocked again with no test able to see it',
  );

  // The run: line must actually forward $PR_AUTHOR as argv[3] — declaring the
  // env var alone does nothing if the invocation drops it.
  assert.match(
    stepBody,
    /run:\s*node scripts\/validate-pr-issue-link\.mjs\s+"\$RUNNER_TEMP\/pr-body\.txt"\s+"\$PR_AUTHOR"/,
    'the step\'s `run:` does not pass "$PR_AUTHOR" as the second argument to ' +
      'validate-pr-issue-link.mjs — the env var must be forwarded as argv[3]',
  );
});
