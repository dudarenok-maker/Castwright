import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRuns,
  parseRegister,
  isSeparatorRow,
  isHeaderRow,
  fileDomain,
  serverRelativePath,
  toRepoRelative,
  flattenVitestJson,
  findOutcome,
  classifyEntry,
  aggregate,
  formatReport,
  buildVitestArgs,
  classifyRunResult,
} from '../quarantine-health.mjs';

// --- resolveRuns (finding 12: QUARANTINE_HEALTH_RUNS=0/negative guard) -----

test('resolveRuns defaults to 5 when unset, zero, negative, or non-numeric', () => {
  assert.equal(resolveRuns(undefined), 5);
  assert.equal(resolveRuns('0'), 5);
  assert.equal(resolveRuns('-3'), 5);
  assert.equal(resolveRuns('not-a-number'), 5);
  assert.equal(resolveRuns(''), 5);
});

test('resolveRuns honours a valid positive integer, flooring a fraction', () => {
  assert.equal(resolveRuns('3'), 3);
  assert.equal(resolveRuns('2.9'), 2);
});

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

// finding 10: deleting the header-row/separator-row `continue` guards inside
// parseRegister leaves 24/24 green, because a real header/separator row's
// first cell is never backtick-quoted and so is already rejected by the
// downstream "no backtick-quoted test name" check regardless of these two
// guards. That makes the guards provably unreachable from parseRegister's
// own integration behaviour for any realistic register content — no
// parseRegister-level fixture can distinguish "guard present" from "guard
// removed". Pin each guard's own regex contract directly instead.
test('isSeparatorRow matches the markdown table separator row and nothing else', () => {
  assert.equal(isSeparatorRow('|------|------|-------|---------|----------------|-------------|'), true);
  assert.equal(isSeparatorRow('| `a test` | `f.ts` | timing | races | — | 2026-07-01 |'), false);
  assert.equal(isSeparatorRow('| Test | File | Class | Symptom | Tracking issue | Quarantined |'), false);
});

test('isHeaderRow matches the register header row and nothing else', () => {
  assert.equal(isHeaderRow('| Test | File | Class | Symptom | Tracking issue | Quarantined |'), true);
  assert.equal(isHeaderRow('| `a test` | `f.ts` | timing | races | — | 2026-07-01 |'), false);
  assert.equal(isHeaderRow('|------|------|-------|---------|----------------|-------------|'), false);
});

test('parseRegister requires the full 6-column row shape, not just any >=2-cell `|`-prefixed line', () => {
  // Regression guard for finding 10's third mutation survivor: loosening
  // `cells.length < 5` to `< 2` lets an unrelated 2-column table elsewhere in
  // the docs (or in this same file, above the real register table) parse as
  // a bogus entry if its first cell happens to be backtick-quoted.
  const markdown = `Some unrelated 2-column table appears elsewhere in the docs:

| \`some code\` | notes |
|---|---|
`;
  assert.deepEqual(parseRegister(markdown), []);
});

// --- fileDomain / serverRelativePath -----------------------------------

test('fileDomain classifies server/-prefixed files as server, e2e/-prefixed as e2e, everything else as frontend', () => {
  assert.equal(fileDomain('server/src/routes/generation.test.ts'), 'server');
  assert.equal(fileDomain('src/lib/router.test.ts'), 'frontend');
  // finding 2: an e2e/** row is a Playwright spec, not a frontend vitest file
  // — routing it through the frontend vitest include used to match zero
  // files and misreport a live, correctly-registered spec as a stale
  // register row. See aggregate()'s 'not-covered' handling.
  assert.equal(fileDomain('e2e/foo.spec.ts'), 'e2e');
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
  // finding 12: vitest 4 joins ancestor describe titles with a SPACE, not
  // ' > ' — the fixture used to claim a shape vitest never actually emits.
  const outcomes = [
    { file: 'f.ts', title: 'leaf', fullName: 'describe block full test name', status: 'failed' },
  ];
  assert.equal(findOutcome(outcomes, 'f.ts', 'describe block full test name').status, 'failed');
  assert.equal(findOutcome(outcomes, 'f.ts', 'full test name').status, 'failed');
});

test('findOutcome prefers a title match over a fullName match when both exist for the same query', () => {
  // finding 10: the documented title-before-fullName priority (quarantine-
  // health.mjs findOutcome) was unasserted — deleting the title branch and
  // falling straight to the fullName checks kept every prior test green,
  // because none of them put a title-match and a distinct fullName-match
  // candidate in the same outcomes list. This does.
  const outcomes = [
    { file: 'f.ts', title: 'leaf', fullName: 'describe block > leaf', status: 'failed' },
    { file: 'f.ts', title: 'something else', fullName: 'leaf', status: 'passed' },
  ];
  const hit = findOutcome(outcomes, 'f.ts', 'leaf');
  assert.equal(hit.status, 'failed');
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
    unavailable: 0,
  });
});

test('classifyEntry: all runs failed -> never-passes (the #1854 scenario)', () => {
  assert.deepEqual(classifyEntry(['failed', 'failed', 'failed', 'failed', 'failed']), {
    bucket: 'never-passes',
    passed: 0,
    failed: 5,
    notFound: 0,
    unavailable: 0,
  });
});

test('classifyEntry: a mix of pass and fail -> intermittent', () => {
  assert.deepEqual(classifyEntry(['passed', 'failed', 'passed', 'failed', 'passed']), {
    bucket: 'intermittent',
    passed: 3,
    failed: 2,
    notFound: 0,
    unavailable: 0,
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
    unavailable: 0,
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
    unavailable: 0,
  });
});

// --- classifyEntry: 'run-unavailable' (findings 5/6 — runner failures) -----

test('classifyEntry: every run unavailable (runner crashed/timed out every time) -> unknown, not not-found or never-passes', () => {
  assert.deepEqual(classifyEntry(['run-unavailable', 'run-unavailable', 'run-unavailable']), {
    bucket: 'unknown',
    passed: 0,
    failed: 0,
    notFound: 0,
    unavailable: 3,
  });
});

test('classifyEntry: some runs unavailable, the rest all passed -> still always-passes, excluded runs do not count as failures', () => {
  assert.deepEqual(classifyEntry(['passed', 'run-unavailable', 'passed']), {
    bucket: 'always-passes',
    passed: 2,
    failed: 0,
    notFound: 0,
    unavailable: 1,
  });
});

test('classifyEntry: a run-unavailable run is excluded, not treated as not-found', () => {
  // Regression guard: an unavailable run must not inflate `notFound` (which
  // would misreport it as a stale register row) nor `failed` (which would
  // misreport a runner crash as a broken test).
  const result = classifyEntry(['passed', 'run-unavailable']);
  assert.equal(result.bucket, 'always-passes');
  assert.equal(result.notFound, 0);
  assert.equal(result.unavailable, 1);
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

test('aggregate routes an e2e/** entry straight to not-covered without matching against vitest outcomes', () => {
  const entries = [{ testName: 'a playwright spec', file: 'e2e/foo.spec.ts', issueNumbers: [] }];
  // Even outcomes that would spuriously "match" by title must not be
  // consulted — not-covered is unconditional for the e2e domain.
  const perRunOutcomes = [[{ file: 'e2e/foo.spec.ts', title: 'a playwright spec', fullName: 'a playwright spec', status: 'passed' }]];
  const result = aggregate(entries, perRunOutcomes);
  assert.equal(result[0].bucket, 'not-covered');
  assert.equal(result[0].runs, 1);
});

test('aggregate marks an entry run-unavailable for a run whose domain failed to execute', () => {
  const entries = [{ testName: 'a server test', file: 'server/src/foo.test.ts', issueNumbers: [] }];
  const perRunOutcomes = [
    [], // run 0: server invocation crashed, no outcomes
    [{ file: 'server/src/foo.test.ts', title: 'a server test', fullName: 'a server test', status: 'passed' }], // run 1: ok
  ];
  const perRunFailedDomains = [new Set(['server']), new Set()];
  const result = aggregate(entries, perRunOutcomes, perRunFailedDomains);
  // Run 0 is excluded (unavailable), not counted as not-found; run 1 passed.
  assert.equal(result[0].bucket, 'always-passes');
  assert.equal(result[0].passed, 1);
  assert.equal(result[0].notFound, 0);
  assert.equal(result[0].unavailable, 1);
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

test('formatReport renders each row\'s OWN bucket in its own table row, not just anywhere in the document', () => {
  // finding 3: hardcoding every row's rendered bucket to 'always-passes'
  // left 24/24 tests green — the only bucket-ish assertion
  // (`/never-passes/`, above) is satisfied by the always-emitted legend
  // bullet, regardless of what any actual row renders. This pins the
  // per-row table cell itself, keyed to that row's own test name, so a
  // mutation that renders the wrong bucket for a specific row is caught
  // even when a DIFFERENT row's bucket (or the legend) is correct.
  const entries = [
    {
      testName: 'ok test',
      file: 'f.ts',
      issueNumbers: [],
      bucket: 'always-passes',
      passed: 5,
      failed: 0,
      notFound: 0,
      unavailable: 0,
      runs: 5,
    },
    {
      testName: 'broken test',
      file: 'f.ts',
      issueNumbers: [],
      bucket: 'never-passes',
      passed: 0,
      failed: 5,
      notFound: 0,
      unavailable: 0,
      runs: 5,
    },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  const lines = report.split('\n');
  const okRow = lines.find((l) => l.includes('`ok test`'));
  const brokenRow = lines.find((l) => l.includes('`broken test`'));
  assert.ok(okRow, 'expected a table row for "ok test"');
  assert.ok(brokenRow, 'expected a table row for "broken test"');
  assert.match(okRow, /\| always-passes \|/);
  assert.match(brokenRow, /\| never-passes \|/);
  assert.doesNotMatch(brokenRow, /\| always-passes \|/);
});

test('formatReport surfaces an unknown-bucket row distinctly, not as not-found or never-passes', () => {
  const entries = [
    {
      testName: 'mystery test',
      file: 'server/src/foo.test.ts',
      issueNumbers: [],
      bucket: 'unknown',
      passed: 0,
      failed: 0,
      notFound: 0,
      unavailable: 5,
      runs: 5,
    },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  const row = report.split('\n').find((l) => l.includes('`mystery test`'));
  assert.match(row, /\| unknown \|/);
  assert.match(report, /no usable data/i);
  // The legend always mentions "could not be located" in its not-found
  // bullet — assert the specific not-found CALLOUT (which only fires when a
  // row buckets not-found) is absent, not the legend prose.
  assert.doesNotMatch(report, /row\(s\) could not be located/i);
  assert.doesNotMatch(report, /never passed/i); // that's the never-passes callout
});

test('formatReport surfaces a not-covered (Playwright) row with a pointer to test:e2e:quarantine, not a stale-row verdict', () => {
  const entries = [
    {
      testName: 'a playwright spec',
      file: 'e2e/foo.spec.ts',
      issueNumbers: [],
      bucket: 'not-covered',
      passed: 0,
      failed: 0,
      notFound: 0,
      unavailable: 0,
      runs: 5,
    },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  const row = report.split('\n').find((l) => l.includes('`a playwright spec`'));
  assert.match(row, /\| not-covered \|/);
  assert.match(report, /test:e2e:quarantine/);
  assert.doesNotMatch(report, /row\(s\) could not be located/i);
});

// --- buildVitestArgs (finding 1: --retry=0 forced) --------------------------

test('buildVitestArgs forces --retry=0 so the JSON reporter reports the FIRST attempt, not a vitest.config.ts retry:1 best-of-2', () => {
  const args = buildVitestArgs(undefined, ['src/foo.test.ts']);
  assert.ok(args.includes('--retry=0'), `expected --retry=0 in ${JSON.stringify(args)}`);
});

test('buildVitestArgs includes --config when provided and appends the file list last', () => {
  const args = buildVitestArgs('vitest.config.slow.ts', ['a.test.ts', 'b.test.ts']);
  assert.deepEqual(args, [
    'vitest',
    'run',
    '--reporter=json',
    '--passWithNoTests',
    '--retry=0',
    '--config',
    'vitest.config.slow.ts',
    'a.test.ts',
    'b.test.ts',
  ]);
});

test('buildVitestArgs omits --config when none is given (root frontend run)', () => {
  const args = buildVitestArgs(undefined, ['src/foo.test.ts']);
  assert.ok(!args.includes('--config'));
});

// --- classifyRunResult (findings 5/6: distinguish timeout/crash/ok) --------

test('classifyRunResult: a normal successful vitest JSON payload -> ok', () => {
  const r = { error: undefined, signal: null, status: 0, stdout: JSON.stringify({ testResults: [] }), stderr: '' };
  assert.deepEqual(classifyRunResult(r), { runOutcome: 'ok', testResults: [] });
});

test('classifyRunResult: a normal FAILING vitest run (nonzero exit, valid JSON) is still ok — a test failure is not a runner failure', () => {
  const payload = { testResults: [{ name: 'f.ts', assertionResults: [{ title: 't', fullName: 't', status: 'failed' }] }] };
  const r = { error: undefined, signal: null, status: 1, stdout: JSON.stringify(payload), stderr: '' };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'ok');
  assert.deepEqual(result.testResults, payload.testResults);
});

test('classifyRunResult: spawnSync timeout (ETIMEDOUT) -> timed-out, not crashed, not silently { testResults: [] }', () => {
  const r = {
    error: Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    signal: 'SIGTERM',
    status: null,
    stdout: '',
    stderr: '',
  };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'timed-out');
  assert.deepEqual(result.testResults, []);
});

test('classifyRunResult: a spawn-level error with no ETIMEDOUT code -> crashed, distinct from timed-out', () => {
  const r = { error: Object.assign(new Error('spawnSync npx ENOENT'), { code: 'ENOENT' }), signal: null, status: null, stdout: '', stderr: '' };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'crashed');
});

test('classifyRunResult: unparsable stdout -> crashed, not a silent zero-result payload', () => {
  const r = { error: undefined, signal: null, status: 1, stdout: 'not json at all', stderr: 'fatal config error' };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'crashed');
  assert.deepEqual(result.testResults, []);
});
