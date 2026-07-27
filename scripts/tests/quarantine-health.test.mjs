import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRegister,
  fileDomain,
  serverRelativePath,
  toRepoRelative,
  flattenVitestJson,
  findOutcome,
  classifyEntry,
  aggregate,
  formatReport,
} from '../quarantine-health.mjs';

// --- parseRegister -----------------------------------------------------

test('parseRegister returns no entries for the current (empty) register table', () => {
  const markdown = `# Flaky-test register

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

_Empty — no tests are currently quarantined._

<!-- Graduated 2026-07-27: the two sleep-prevention wake-lock tests in
\`server/src/routes/generation.test.ts\` (#1854). -->
`;
  assert.deepEqual(parseRegister(markdown), []);
});

test('parseRegister expands a multi-test row into one entry per backtick-quoted test name', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| \`engages on the one in-flight chapter\`, \`stays engaged while a second chapter is still in flight\` | \`server/src/routes/generation.test.ts\` | fs contention | it hangs | #399 (side-11) | 2026-07-06 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].testName, 'engages on the one in-flight chapter');
  assert.equal(entries[1].testName, 'stays engaged while a second chapter is still in flight');
  for (const e of entries) {
    assert.equal(e.file, 'server/src/routes/generation.test.ts');
    assert.deepEqual(e.issueNumbers, [399]);
  }
});

test('parseRegister ignores prose lines, the header row and the separator row', () => {
  const markdown = `Tests quarantined out of the gating suites.

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| \`a flaky test\` | \`src/foo.test.ts\` | timing | races | — | 2026-07-01 |

See the rewrite playbook.
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].testName, 'a flaky test');
  assert.deepEqual(entries[0].issueNumbers, []);
});

// --- fileDomain / serverRelativePath -----------------------------------

test('fileDomain classifies server/-prefixed files as server, everything else as frontend', () => {
  assert.equal(fileDomain('server/src/routes/generation.test.ts'), 'server');
  assert.equal(fileDomain('src/lib/router.test.ts'), 'frontend');
  assert.equal(fileDomain('e2e/foo.spec.ts'), 'frontend');
});

test('serverRelativePath strips the server/ prefix so the path matches vitest cwd=server/ expectations', () => {
  assert.equal(serverRelativePath('server/src/routes/generation.test.ts'), 'src/routes/generation.test.ts');
  assert.equal(serverRelativePath('src/lib/router.test.ts'), 'src/lib/router.test.ts');
});

// --- toRepoRelative ------------------------------------------------------

test('toRepoRelative strips the root prefix and normalises to forward slashes', () => {
  assert.equal(
    toRepoRelative('C:/repo/server/src/routes/generation.test.ts', 'C:/repo'),
    'server/src/routes/generation.test.ts',
  );
  assert.equal(
    toRepoRelative('C:\\repo\\server\\src\\routes\\generation.test.ts', 'C:\\repo'),
    'server/src/routes/generation.test.ts',
  );
});

test('toRepoRelative returns the input unchanged (normalised) if it does not start with root', () => {
  assert.equal(toRepoRelative('D:/elsewhere/foo.test.ts', 'C:/repo'), 'D:/elsewhere/foo.test.ts');
});

// --- flattenVitestJson ---------------------------------------------------

test('flattenVitestJson flattens a normal vitest --reporter=json payload', () => {
  const json = {
    testResults: [
      {
        name: 'C:/repo/src/lib/router.test.ts',
        assertionResults: [
          { title: 'a', fullName: 'suite a', status: 'passed' },
          { title: 'b', fullName: 'suite b', status: 'failed' },
        ],
      },
    ],
  };
  const out = flattenVitestJson(json, 'C:/repo');
  assert.deepEqual(out, [
    { file: 'src/lib/router.test.ts', title: 'a', fullName: 'suite a', status: 'passed' },
    { file: 'src/lib/router.test.ts', title: 'b', fullName: 'suite b', status: 'failed' },
  ]);
});

test('flattenVitestJson handles the degenerate --passWithNoTests zero-match payload without throwing', () => {
  assert.deepEqual(flattenVitestJson({ success: true, testResults: [] }), []);
});

test('flattenVitestJson handles a missing/malformed payload without throwing', () => {
  assert.deepEqual(flattenVitestJson(null), []);
  assert.deepEqual(flattenVitestJson({}), []);
  assert.deepEqual(flattenVitestJson({ testResults: 'not-an-array' }), []);
});

// --- findOutcome -----------------------------------------------------------

test('findOutcome matches by file + leaf title first', () => {
  const outcomes = [
    { file: 'server/src/routes/generation.test.ts', title: 'engages on the one in-flight chapter', fullName: 'x engages on the one in-flight chapter', status: 'passed' },
  ];
  const hit = findOutcome(outcomes, 'server/src/routes/generation.test.ts', 'engages on the one in-flight chapter');
  assert.equal(hit.status, 'passed');
});

test('findOutcome falls back to an exact fullName match, then a fullName substring match', () => {
  const outcomes = [
    { file: 'f.ts', title: 'leaf', fullName: 'describe block > full test name', status: 'failed' },
  ];
  assert.equal(findOutcome(outcomes, 'f.ts', 'describe block > full test name').status, 'failed');
  assert.equal(findOutcome(outcomes, 'f.ts', 'full test name').status, 'failed');
});

test('findOutcome returns null when nothing in the file matches', () => {
  const outcomes = [{ file: 'f.ts', title: 'leaf', fullName: 'x leaf', status: 'passed' }];
  assert.equal(findOutcome(outcomes, 'f.ts', 'a completely different test'), null);
  assert.equal(findOutcome(outcomes, 'other-file.ts', 'leaf'), null);
});

// --- classifyEntry (the core signal this whole feature exists to produce) -

test('classifyEntry: all runs passed -> always-passes', () => {
  assert.deepEqual(classifyEntry(['passed', 'passed', 'passed']), {
    bucket: 'always-passes',
    passed: 3,
    failed: 0,
    notFound: 0,
  });
});

test('classifyEntry: all runs failed -> never-passes (the #1854 scenario)', () => {
  assert.deepEqual(classifyEntry(['failed', 'failed', 'failed', 'failed', 'failed']), {
    bucket: 'never-passes',
    passed: 0,
    failed: 5,
    notFound: 0,
  });
});

test('classifyEntry: a mix of pass and fail -> intermittent', () => {
  assert.deepEqual(classifyEntry(['passed', 'failed', 'passed', 'failed', 'passed']), {
    bucket: 'intermittent',
    passed: 3,
    failed: 2,
    notFound: 0,
  });
});

test('classifyEntry: a single failure among passes is still intermittent, not never-passes', () => {
  // Regression guard: the never-passes branch must require passed === 0, not
  // just failed > 0 — otherwise one bad run would mislabel a mostly-healthy
  // flaky test as permanently broken.
  assert.equal(classifyEntry(['passed', 'passed', 'passed', 'passed', 'failed']).bucket, 'intermittent');
});

test('classifyEntry: not found in any run -> not-found, distinct from never-passes', () => {
  assert.deepEqual(classifyEntry([null, null, null]), {
    bucket: 'not-found',
    passed: 0,
    failed: 0,
    notFound: 3,
  });
});

test('classifyEntry: a skipped/todo status counts as a non-pass, not a pass', () => {
  assert.equal(classifyEntry(['passed', 'skipped', 'passed']).bucket, 'intermittent');
  assert.equal(classifyEntry(['skipped', 'skipped']).bucket, 'never-passes');
});

test('classifyEntry: some runs not-found, the rest all passed -> still always-passes, notFound recorded', () => {
  assert.deepEqual(classifyEntry(['passed', null, 'passed']), {
    bucket: 'always-passes',
    passed: 2,
    failed: 0,
    notFound: 1,
  });
});

// --- aggregate (end-to-end wiring of the pieces above) ---------------------

test('aggregate ties register entries to per-run outcomes and classifies each', () => {
  const entries = [
    { testName: 'always ok', file: 'f.ts', issueNumbers: [] },
    { testName: 'always broken', file: 'f.ts', issueNumbers: [1] },
  ];
  const perRunOutcomes = [
    [
      { file: 'f.ts', title: 'always ok', fullName: 'always ok', status: 'passed' },
      { file: 'f.ts', title: 'always broken', fullName: 'always broken', status: 'failed' },
    ],
    [
      { file: 'f.ts', title: 'always ok', fullName: 'always ok', status: 'passed' },
      { file: 'f.ts', title: 'always broken', fullName: 'always broken', status: 'failed' },
    ],
  ];
  const result = aggregate(entries, perRunOutcomes);
  assert.equal(result[0].bucket, 'always-passes');
  assert.equal(result[1].bucket, 'never-passes');
  assert.equal(result[0].runs, 2);
});

// --- formatReport ------------------------------------------------------

test('formatReport reports a clean no-op for an empty entry list', () => {
  const report = formatReport({ entries: [], runs: 0, issueStates: new Map() });
  assert.match(report, /nothing to run/i);
  assert.match(report, /clean no-op/i);
});

test('formatReport flags a never-passes test and a closed tracking issue', () => {
  const entries = [
    {
      testName: 'broken test',
      file: 'server/src/routes/generation.test.ts',
      issueNumbers: [399],
      bucket: 'never-passes',
      passed: 0,
      failed: 5,
      notFound: 0,
      runs: 5,
    },
  ];
  const issueStates = new Map([[399, 'CLOSED']]);
  const report = formatReport({ entries, runs: 5, issueStates });
  assert.match(report, /never-passes/);
  assert.match(report, /never passed across 5 run/i);
  assert.match(report, /CLOSED tracking issue/i);
  assert.match(report, /broken test/);
});

test('formatReport does not raise the never-passes/closed-issue callouts when nothing warrants them', () => {
  const entries = [
    {
      testName: 'healthy-ish test',
      file: 'src/foo.test.ts',
      issueNumbers: [1],
      bucket: 'intermittent',
      passed: 3,
      failed: 2,
      notFound: 0,
      runs: 5,
    },
  ];
  const issueStates = new Map([[1, 'OPEN']]);
  const report = formatReport({ entries, runs: 5, issueStates });
  assert.doesNotMatch(report, /never passed/i);
  assert.doesNotMatch(report, /CLOSED tracking issue/i);
});
