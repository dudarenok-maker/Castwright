import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveRuns,
  classifyRunsOverride,
  parseRegister,
  countRegisterDataRows,
  countUnparsedDataRows,
  planRegisterRun,
  isSeparatorRow,
  isHeaderRow,
  splitTableRow,
  fileDomain,
  serverRelativePath,
  toRepoRelative,
  flattenVitestJson,
  findOutcome,
  classifyEntry,
  minUsableRuns,
  aggregate,
  formatReport,
  buildVitestArgs,
  classifyRunResult,
  buildParseFailureMessage,
  worstCaseRunMs,
  budgetExceeded,
  main,
  VITEST_RUN_TIMEOUT_MS,
  RUN_LOOP_WALL_CLOCK_BUDGET_MS,
  JOB_CAP_MS,
} from '../quarantine-health.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

// --- classifyRunsOverride (re-review finding 8: warning-message bugs) ------

test('classifyRunsOverride: unset -> no warning', () => {
  assert.equal(classifyRunsOverride(undefined), null);
});

test('classifyRunsOverride: a valid integer -> no warning, even whitespace-padded', () => {
  // Regression guard: the old `String(RUNS) !== envValue` string comparison
  // tripped a spurious warning for ' 5 ' even though Number(' 5 ') = 5 is a
  // perfectly valid override.
  assert.equal(classifyRunsOverride('5'), null);
  assert.equal(classifyRunsOverride(' 5 '), null);
});

test('classifyRunsOverride: zero, negative, non-numeric, or empty -> invalid (falls back to the true default)', () => {
  assert.equal(classifyRunsOverride('0'), 'invalid');
  assert.equal(classifyRunsOverride('-3'), 'invalid');
  assert.equal(classifyRunsOverride('not-a-number'), 'invalid');
  assert.equal(classifyRunsOverride(''), 'invalid');
});

test('classifyRunsOverride: a valid but fractional value -> fractional (floored, not defaulted)', () => {
  // Regression guard: '2.9' floors to 2, which is NOT "the default" (5) —
  // the old message always said "defaulting to N", which was wrong wording
  // for this case.
  assert.equal(classifyRunsOverride('2.9'), 'fractional');
});

// --- parseRegister -----------------------------------------------------

test('parseRegister returns no entries for a genuinely empty register table (no data rows)', () => {
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

test('parseRegister extracts the test name from the real register prose format (#NNNN — <name>)', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2235 — revokes the older same-format manifest when a re-export of the same format finishes | \`server/src/routes/export.test.ts\` | intermittent under full-suite box contention | Fails on retry | #2235 | Quarantined |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].testName, 'revokes the older same-format manifest when a re-export of the same format finishes');
  assert.equal(entries[0].file, 'server/src/routes/export.test.ts');
  assert.deepEqual(entries[0].issueNumbers, [2235]);
});

// Regression test: drives the parser against the REAL register file,
// docs/testing/flaky-register.md. The old parser extracted test names only
// from backtick-quoted spans in the Test cell, but the real register's Test
// column is prose (only the File column is backtick-quoted), so every row
// was silently dropped and parseRegister returned []. This test fails against
// the unfixed parser and passes after the prose-format fallback was added.
test('parseRegister returns one entry per data row of the real flaky-register.md (regression)', () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const registerPath = resolve(testDir, '..', '..', 'docs', 'testing', 'flaky-register.md');
  const markdown = readFileSync(registerPath, 'utf8');
  const entries = parseRegister(markdown);
  // The real register currently has 2 data rows (#1981 and #2235).
  assert.ok(entries.length >= 2, `expected at least 2 entries from the real register, got ${entries.length}`);
  // Both quarantined rows must be present.
  const files = entries.map((e) => e.file);
  assert.ok(files.includes('server/src/routes/book-state-preserve-voices.test.ts'), 'missing #1981 row');
  assert.ok(files.includes('server/src/routes/export.test.ts'), 'missing #2235 row');
  // Issue numbers must be extracted from the Issue cell, not the Test cell.
  const by1981 = entries.find((e) => e.issueNumbers.includes(2226));
  assert.ok(by1981, '#1981 row must carry tracking issue #2226');
  const by2235 = entries.find((e) => e.issueNumbers.includes(2235));
  assert.ok(by2235, '#2235 row must carry tracking issue #2235');
});

test('countRegisterDataRows counts well-formed data rows, ignoring headers, separators, prose, and comments', () => {
  const markdown = `# Flaky-test register

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 — a stale cast PUT | \`server/src/routes/foo.test.ts\` | intermittent | Fails | #2226 | Not quarantined |
| #2235 — revokes the older manifest | \`server/src/routes/export.test.ts\` | intermittent | Fails on retry | #2235 | Quarantined |

_Empty — no other tests are currently quarantined._

<!-- Graduated 2026-07-27: old row | \`foo.test.ts\` | ... | ... | ... | ... | -->
`;
  assert.equal(countRegisterDataRows(markdown), 2);
});

test('countRegisterDataRows returns 0 for a genuinely empty register', () => {
  const markdown = `# Flaky-test register

| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

_Empty — no tests are currently quarantined._
`;
  assert.equal(countRegisterDataRows(markdown), 0);
});

test('countRegisterDataRows and countUnparsedDataRows handle empty File cells correctly (Bug A)', () => {
  // Bug A fix: countRegisterDataRows now counts structurally-well-formed rows
  // (≥5 cells) as "data rows" regardless of File cell contents, so the
  // loud-failure guard can detect empty File cells as unparsed entries.
  // parseRegister still skips rows with empty files when building entries
  // (can't use a row with no file), but both counters agree on what is a
  // "structurally well-formed data row" — enabling the guard.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 — valid test | \`server/src/routes/foo.test.ts\` | timing | races | #1981 | 2026-08-01 |
| #1982 — empty file cell | | timing | races | #1982 | 2026-08-02 |
| #1983 — whitespace-only file | \`   \` | timing | races | #1983 | 2026-08-03 |
`;
  // parseRegister skips the last two rows (empty file cells), so entries.length === 1
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1, 'parseRegister skips rows with empty/whitespace File cells (can\'t create entries without a file)');
  // countRegisterDataRows now sees all 3 structurally-well-formed rows
  const dataRows = countRegisterDataRows(markdown);
  assert.equal(dataRows, 3, 'countRegisterDataRows counts all structurally-well-formed rows, including those with empty File cells');
  // countUnparsedDataRows counts the 2 rows with empty File cells as unparsed
  const unparsed = countUnparsedDataRows(markdown);
  assert.equal(unparsed, 2, 'countUnparsedDataRows counts rows with empty File cells as unparsed');
});

// The loud-failure guard: when data rows are present but parseRegister
// returns zero entries, the runner must detect the mismatch rather than
// reporting a clean no-op. This test drives both functions against the same
// input to verify the guard's precondition — planRegisterRun() checks
// exactly this and returns parse-failure when it fires.
test('a register with data rows that parses to zero entries is detectable (loud-failure precondition)', () => {
  // Simulate a format the parser cannot handle: data rows with neither
  // backtick-quoted test names nor the #NNNN — prose pattern.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| some opaque test reference | \`server/src/routes/foo.test.ts\` | timing | races | #1234 | 2026-08-01 |
| another opaque reference | \`server/src/routes/bar.test.ts\` | timing | races | #5678 | 2026-08-02 |
`;
  const entries = parseRegister(markdown);
  const dataRows = countRegisterDataRows(markdown);
  assert.equal(entries.length, 0, 'parser should return 0 for unrecognized format');
  assert.equal(dataRows, 2, 'countRegisterDataRows should see 2 data rows');
  // The guard in planRegisterRun() checks exactly this: dataRows > 0 && unparsedCount > 0 → parse-failure.
  const plan = planRegisterRun(markdown);
  assert.equal(plan.outcome, 'parse-failure', 'should detect the parse failure');
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

// --- parseRegister: HTML-comment state tracking (re-review finding 1) ------
//
// The register's own retirement convention (see the graduated-row blocks in
// docs/testing/flaky-register.md) is to wrap a retired row in a multi-line
// `<!-- ... -->` block rather than delete it. bdeb44f9's commit message
// claimed this was fixed; it was not — parseRegister was functionally
// unchanged (only isSeparatorRow/isHeaderRow were extracted). A row inside a
// comment block still parsed as a live entry before this fix.

test('parseRegister does not parse a table row that is entirely inside a SINGLE-line HTML comment', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
<!-- | \`retired test\` | \`f.ts\` | timing | races | #1 | 2026-01-01 | -->
`;
  assert.deepEqual(parseRegister(markdown), []);
});

test('parseRegister does not parse a table row inside a MULTI-line HTML comment block', () => {
  // This is the shape that actually occurs in the real register: a prose
  // paragraph opens `<!--` on its own line, a `| ... |` row sits several
  // lines later, and `-->` closes the block on a later line still. Comment
  // state must carry ACROSS lines, not reset every iteration.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

<!-- Graduated 2026-07-27: retired because it was rewritten. Old row for
reference:
| \`retired test\` | \`f.ts\` | timing | races | #1 | 2026-01-01 |
No longer relevant. -->
`;
  assert.deepEqual(parseRegister(markdown), []);
});

test('parseRegister resumes parsing live rows AFTER a comment block closes', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| \`a live test\` | \`f.ts\` | timing | races | #2 | 2026-02-01 |

<!-- Graduated: | \`retired test\` | \`g.ts\` | timing | races | #1 | 2026-01-01 | -->
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].testName, 'a live test');
});

test('parseRegister handles a comment that opens and closes on the SAME line as a live row, without eating the row', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| \`a live test\` | \`f.ts\` | timing <!-- inline note --> | races | #2 | 2026-02-01 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].testName, 'a live test');
});

// --- Bug A regression: empty File cell with well-formed Test cell ----
// A row with an empty File cell but a well-formed, parseable Test cell
// (e.g., #NNNN — test name) must trigger parse-failure via the loud-failure
// guard, not silently vanish as if it doesn't exist.

test('parseRegisterRun returns parse-failure for a row with empty File cell but well-formed Test cell (Bug A)', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #9999 — some test name | | timing | races | #9999 | 2026-08-01 |
`;
  const result = planRegisterRun(markdown);
  // Bug A: before the fix, this returns 'empty' (row is invisible to the generator)
  // After the fix, it must return 'parse-failure' (row is counted as data but has empty File)
  assert.equal(result.outcome, 'parse-failure', 'empty File cell with well-formed Test cell should trigger parse-failure, not disappear silently');
  assert.equal(result.unparsedCount, 1, 'the malformed row should be counted toward unparsedCount');
});

// --- Bug C regression: prose Test cell with incidental backticks ----
// A Test cell shaped like `#2301 — retries the \`POST /api/x\` call once`
// (prose format with an incidental backtick inside the name) must extract
// the whole prose remainder, not just the backtick-quoted substring.

test('parseRegister extracts the full prose test name when it contains incidental backticks (Bug C)', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2301 — retries the \`POST /api/x\` call once | \`server/src/routes/foo.test.ts\` | timing | races | #2301 | 2026-08-01 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1, 'should parse 1 entry');
  // Bug C: before the fix, testName is 'POST /api/x' (just the backtick-quoted part)
  // After the fix, testName is the whole prose remainder including the backticks
  const expectedName = 'retries the `POST /api/x` call once';
  assert.equal(entries[0].testName, expectedName, `should extract full prose name with backticks intact, not just the backtick-quoted substring`);
});

test('parseRegister with prose prefix treats all backtick-quoted text as part of one name (not expansion)', () => {
  // Fix 1: a Test cell with prose prefix should NOT expand 2+ backtick-quoted spans.
  // The WHOLE remainder (including all backticks) becomes a single test name.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2301 — retries \`test A\`, \`test B\` | \`server/src/routes/foo.test.ts\` | timing | races | #2301 | 2026-08-01 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1, 'should parse 1 entry (not expand the prose remainder)');
  assert.equal(entries[0].testName, 'retries `test A`, `test B`', 'should preserve full prose name with backticks intact');
});

test('parseRegister keeps single incidental backtick-quoted text as part of prose name, not as separate test (Bug 2)', () => {
  // Bug 2: a Test cell with prose prefix and exactly 1 backtick pair should keep whole remainder as testName
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2301 — retries the \`POST /api/x\` call once | \`server/src/routes/foo.test.ts\` | timing | races | #2301 | 2026-08-01 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1, 'should parse 1 entry (not expand the single backtick pair)');
  assert.equal(entries[0].testName, 'retries the `POST /api/x` call once', 'should preserve full prose name with single backtick pair intact');
});

test('parseRegister regression: prose description with multiple distinct backtick-quoted terms stays one entry (round-4 false positive)', () => {
  // Round-4 false positive: the expansion logic split this real test description into 2 bogus entries.
  // Fix 1: prose format takes precedence, the whole remainder (including all backticks) is one test name.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2301 — fails when \`POST /api/x\` follows \`GET /api/y\` | \`server/src/routes/foo.test.ts\` | timing | races | #2301 | 2026-08-01 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1, 'should parse 1 entry (not split into 2 on the backtick boundaries)');
  assert.equal(entries[0].testName, 'fails when `POST /api/x` follows `GET /api/y`', 'should preserve the full prose description with all backticks intact');
});

// --- parseRegister / splitTableRow: escaped `|` in a cell (finding 1) ------
//
// A Symptom cell describing a literal pipe character must not shift every
// subsequent column left by one — that used to silently drop `issueNumbers`,
// disabling the closed-tracking-issue check (the whole lesson of the #399
// postmortem).

test('splitTableRow does not split on an escaped `\\|`, and unescapes it in the cell', () => {
  const cells = splitTableRow('| `a test` | `f.ts` | timing | uses a \\| character | #5 | 2026-01-01 |');
  assert.deepEqual(cells, ['`a test`', '`f.ts`', 'timing', 'uses a | character', '#5', '2026-01-01']);
});

test('parseRegister keeps issueNumbers intact when the Symptom cell contains an escaped pipe', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| \`a test\` | \`f.ts\` | timing | uses a \\| character | #5 | 2026-01-01 |
`;
  const entries = parseRegister(markdown);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].issueNumbers, [5]);
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

// --- classifyEntry: minimum-usable-runs floor (re-review finding 4) --------
//
// The header comment's whole premise ("A single run can't tell 'intermittent'
// from 'never passes' apart") means a verdict needs a MAJORITY of the
// attempted runs to actually be usable. Without a floor, 4-of-5 unavailable
// runs + one surviving pass rendered `always-passes` — "candidate to
// graduate back into the gating suite" — off a single data point.

test('minUsableRuns requires a majority (ceil(total/2))', () => {
  assert.equal(minUsableRuns(5), 3);
  assert.equal(minUsableRuns(4), 2);
  assert.equal(minUsableRuns(2), 1);
  assert.equal(minUsableRuns(1), 1);
});

test('classifyEntry: 4-of-5 runs unavailable + the ONE surviving run passing -> unknown, NOT always-passes', () => {
  const result = classifyEntry(['run-unavailable', 'run-unavailable', 'run-unavailable', 'run-unavailable', 'passed']);
  assert.equal(result.bucket, 'unknown');
  assert.equal(result.unavailable, 4);
});

test('classifyEntry: 4-of-5 runs unavailable + the ONE surviving run failing -> unknown, NOT never-passes', () => {
  // The mirror case from the finding: the old code would have rendered
  // "1 test(s) never passed across 5 run(s)" — a single failing attempt
  // reported as a five-run verdict.
  const result = classifyEntry(['run-unavailable', 'run-unavailable', 'run-unavailable', 'run-unavailable', 'failed']);
  assert.equal(result.bucket, 'unknown');
  assert.equal(result.unavailable, 4);
});

test('classifyEntry: exactly at the majority floor (3-of-5 usable) still renders a real verdict', () => {
  const result = classifyEntry(['run-unavailable', 'run-unavailable', 'passed', 'passed', 'passed']);
  assert.equal(result.bucket, 'always-passes');
  assert.equal(result.passed, 3);
});

test('classifyEntry: one below the majority floor (2-of-5 usable) degrades to unknown', () => {
  const result = classifyEntry(['run-unavailable', 'run-unavailable', 'run-unavailable', 'passed', 'passed']);
  assert.equal(result.bucket, 'unknown');
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
    [], // run 0: BOTH server configs crashed, no outcomes
    [{ file: 'server/src/foo.test.ts', title: 'a server test', fullName: 'a server test', status: 'passed' }], // run 1: ok
  ];
  const perRunFailedDomains = [new Set(['server-main', 'server-slow']), new Set()];
  const result = aggregate(entries, perRunOutcomes, perRunFailedDomains);
  // Run 0 is excluded (unavailable), not counted as not-found; run 1 passed.
  assert.equal(result[0].bucket, 'always-passes');
  assert.equal(result[0].passed, 1);
  assert.equal(result[0].notFound, 0);
  assert.equal(result[0].unavailable, 1);
});

// --- aggregate: per-server-config granularity (re-review finding 5) --------

test('aggregate trusts a hit from the SURVIVING server config when only the other config crashed', () => {
  const entries = [{ testName: 'a server test', file: 'server/src/foo.test.ts', issueNumbers: [] }];
  // serverMain succeeded and found the test; serverSlow crashed. The old
  // single 'server' flag would have discarded serverMain's real result.
  const perRunOutcomes = [
    [{ file: 'server/src/foo.test.ts', title: 'a server test', fullName: 'a server test', status: 'passed' }],
  ];
  const perRunFailedDomains = [new Set(['server-slow'])];
  const result = aggregate(entries, perRunOutcomes, perRunFailedDomains);
  assert.equal(result[0].bucket, 'always-passes');
  assert.equal(result[0].passed, 1);
  assert.equal(result[0].unavailable, 0);
});

test('aggregate treats a MISSING entry as unavailable, not not-found, when one server config crashed', () => {
  // The entry isn't in the outcomes we DO have — but since one config
  // crashed, we can't tell whether it belongs to the crashed config (which
  // never got a chance to report it) or is genuinely absent. Must not be
  // reported as a confident "not found" (that would blame a stale register
  // row for a runner failure it didn't cause).
  const entries = [{ testName: 'a server test', file: 'server/src/foo.test.ts', issueNumbers: [] }];
  const perRunOutcomes = [[]];
  const perRunFailedDomains = [new Set(['server-slow'])];
  const result = aggregate(entries, perRunOutcomes, perRunFailedDomains);
  assert.equal(result[0].unavailable, 1);
  assert.equal(result[0].notFound, 0);
});

test('aggregate reports a genuine not-found when BOTH server configs ran cleanly and neither found the entry', () => {
  const entries = [{ testName: 'a stale test', file: 'server/src/foo.test.ts', issueNumbers: [] }];
  const perRunOutcomes = [[]]; // both configs ran fine, neither matched anything
  const perRunFailedDomains = [new Set()];
  const result = aggregate(entries, perRunOutcomes, perRunFailedDomains);
  assert.equal(result[0].notFound, 1);
  assert.equal(result[0].unavailable, 0);
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
  // finding 4/8: the callout now states each row's OWN usable-run count
  // rather than the shared `runs` total (see the dedicated denominator
  // tests below for the case where they diverge).
  assert.match(report, /never passed in every usable run/i);
  assert.match(report, /`broken test` \(5 usable run\(s\)\)/);
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
  assert.match(report, /no reliable verdict/i);
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
  // finding 6 mutation survivor: the not-covered '—' guard in the Passed/found
  // column must actually render '—', not a numeric found/passed count. Anchor
  // directly on the bucket->Passed/found column boundary — a loose `| — |`
  // match elsewhere in the row (e.g. the also-'—' Tracking-issue column) does
  // NOT prove the Passed/found column itself is the one rendering it.
  assert.match(row, /\| not-covered \| — \|/);
  assert.match(report, /test:e2e:quarantine/);
  assert.doesNotMatch(report, /row\(s\) could not be located/i);
});

test('formatReport says no vitest runs were needed when EVERY entry is not-covered (finding 8)', () => {
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
  assert.match(report, /No vitest runs were needed/i);
  assert.doesNotMatch(report, /Ran the quarantine lane 5 time\(s\)/i);
});

test('formatReport still says "Ran the quarantine lane N time(s)" when at least one entry needed a real vitest run', () => {
  const entries = [
    { testName: 'a vitest test', file: 'f.ts', issueNumbers: [], bucket: 'always-passes', passed: 5, failed: 0, notFound: 0, unavailable: 0, runs: 5 },
    { testName: 'a playwright spec', file: 'e2e/foo.spec.ts', issueNumbers: [], bucket: 'not-covered', passed: 0, failed: 0, notFound: 0, unavailable: 0, runs: 5 },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  assert.match(report, /Ran the quarantine lane 5 time\(s\)/i);
});

// --- formatReport: Passed/found column honesty (re-review finding 6) -------
//
// The reviewer's mutation pass killed everything EXCEPT these — a survivor
// here is exactly the numeric evidence a reader uses to sanity-check a
// bucket, plus the partial-data disclosure, silently deleted.

test('formatReport Passed/found column uses FOUND (excluding not-found and unavailable), not the raw run total, and renders both partial-data suffixes', () => {
  const entries = [
    {
      testName: 'partial-data test',
      file: 'server/src/foo.test.ts',
      issueNumbers: [],
      bucket: 'intermittent',
      passed: 2,
      failed: 1,
      notFound: 1,
      unavailable: 1,
      runs: 5,
    },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  const row = report.split('\n').find((l) => l.includes('`partial-data test`'));
  // found = runs(5) - notFound(1) - unavailable(1) = 3, NOT runs(5).
  assert.match(row, /\| 2\/3 \(1 not found\) \(1 run\(s\) crashed\/timed out\) \|/);
});

test('formatReport omits the "not found" suffix when notFound is zero', () => {
  const entries = [
    { testName: 'clean test', file: 'f.ts', issueNumbers: [], bucket: 'always-passes', passed: 5, failed: 0, notFound: 0, unavailable: 0, runs: 5 },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  const row = report.split('\n').find((l) => l.includes('`clean test`'));
  assert.match(row, /\| 5\/5 \|/);
  assert.doesNotMatch(row, /not found/);
  assert.doesNotMatch(row, /crashed\/timed out/);
});

// --- formatReport: partiallyUnavailable callout (re-review finding 6) ------

test('formatReport raises the partial-data callout when a row has unavailable runs but is not bucketed unknown', () => {
  const entries = [
    {
      testName: 'mostly ok test',
      file: 'f.ts',
      issueNumbers: [],
      bucket: 'always-passes',
      passed: 4,
      failed: 0,
      notFound: 0,
      unavailable: 1,
      runs: 5,
    },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  assert.match(report, /row\(s\) had at least one run excluded/i);
});

test('formatReport does not raise the partial-data callout when nothing has unavailable runs', () => {
  const entries = [
    { testName: 'clean test', file: 'f.ts', issueNumbers: [], bucket: 'always-passes', passed: 5, failed: 0, notFound: 0, unavailable: 0, runs: 5 },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  assert.doesNotMatch(report, /row\(s\) had at least one run excluded/i);
});

// --- formatReport: per-row denominators (re-review finding 4/8) -----------

test('formatReport never-passes callout states each row\'s OWN usable-run count, not the shared total', () => {
  const entries = [
    { testName: 'broken with full coverage', file: 'f.ts', issueNumbers: [], bucket: 'never-passes', passed: 0, failed: 5, notFound: 0, unavailable: 0, runs: 5 },
    { testName: 'broken with partial coverage', file: 'g.ts', issueNumbers: [], bucket: 'never-passes', passed: 0, failed: 1, notFound: 0, unavailable: 4, runs: 5 },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  assert.match(report, /`broken with full coverage` \(5 usable run\(s\)\)/);
  assert.match(report, /`broken with partial coverage` \(1 usable run\(s\)\)/);
});

test('formatReport not-found callout states each row\'s OWN usable-run count, not the shared total', () => {
  const entries = [
    { testName: 'stale row', file: 'f.ts', issueNumbers: [], bucket: 'not-found', passed: 0, failed: 0, notFound: 2, unavailable: 3, runs: 5 },
  ];
  const report = formatReport({ entries, runs: 5, issueStates: new Map() });
  assert.match(report, /`stale row` \(2 usable run\(s\)\)/);
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

// --- classifyRunResult: maxBuffer overflow / OOM misdiagnosis (finding 2) --
//
// Measured against the real spawnSync shapes: a maxBuffer overflow AND a
// real timeout both kill the child with SIGTERM, so a bare `r.signal ===
// 'SIGTERM'` fallback can't tell them apart — only `r.error.code` can.

test('classifyRunResult: maxBuffer overflow (ENOBUFS + SIGTERM) -> crashed, NOT timed-out', () => {
  const r = {
    error: Object.assign(new Error('spawnSync npx ENOBUFS'), { code: 'ENOBUFS' }),
    signal: 'SIGTERM',
    status: null,
    stdout: '',
    stderr: '',
  };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'crashed');
});

test('classifyRunResult: a bare SIGKILL with no attached error (e.g. an OOM kill) -> crashed, NOT timed-out', () => {
  // Node's own timeout enforcement always attaches `error.code ===
  // 'ETIMEDOUT'` (verified above); a bare signal with no error is an
  // EXTERNAL kill, not this script's own timeout. Reporting it as a hang
  // sends an investigator looking for a deadlock when the real cause is
  // memory.
  const r = { error: undefined, signal: 'SIGKILL', status: null, stdout: '', stderr: '' };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'crashed');
  assert.match(result.errorMessage, /OOM/i);
});

test('classifyRunResult: a bare SIGTERM with no attached error is still treated as timed-out (platform fallback)', () => {
  const r = { error: undefined, signal: 'SIGTERM', status: null, stdout: '', stderr: '' };
  const result = classifyRunResult(r);
  assert.equal(result.runOutcome, 'timed-out');
});

// --- worstCaseRunMs / budgetExceeded (re-review finding 3) -----------------

test('worstCaseRunMs counts 1 invocation for frontend-only, 2 for server-only, 3 for both, 0 for neither', () => {
  assert.equal(worstCaseRunMs(1, 0, 1000), 1000);
  assert.equal(worstCaseRunMs(0, 1, 1000), 2000);
  assert.equal(worstCaseRunMs(1, 1, 1000), 3000);
  assert.equal(worstCaseRunMs(0, 0, 1000), 0);
});

test('budgetExceeded is true once elapsed + one more run\'s worst case would exceed the budget', () => {
  assert.equal(budgetExceeded(0, 5000, 10000), false);
  assert.equal(budgetExceeded(5000, 5000, 10000), false); // exactly at the budget: fits
  assert.equal(budgetExceeded(5001, 5000, 10000), true);
  assert.equal(budgetExceeded(9999, 2, 10000), true);
});

// --- countUnparsedDataRows (Finding 1: detect partial drops) ---------------

test('countUnparsedDataRows counts data rows that yield zero test names', () => {
  // Two good rows (prose format), one row that cannot be parsed (neither format).
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2235 — revokes the older manifest | \`server/src/routes/export.test.ts\` | timing | races | #2235 | 2026-08-01 |
| unparseable test without format | \`server/src/routes/foo.test.ts\` | timing | races | #1234 | 2026-08-02 |
| #1981 — another valid test | \`server/src/routes/bar.test.ts\` | timing | races | #1981 | 2026-08-03 |
`;
  assert.equal(countUnparsedDataRows(markdown), 1, 'should count 1 unparsed row');
});

test('countUnparsedDataRows returns 0 when all rows parse successfully', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2235 — revokes the older manifest | \`server/src/routes/export.test.ts\` | timing | races | #2235 | 2026-08-01 |
| #1981 — another valid test | \`server/src/routes/bar.test.ts\` | timing | races | #1981 | 2026-08-02 |
`;
  assert.equal(countUnparsedDataRows(markdown), 0, 'should count 0 unparsed rows');
});

test('planRegisterRun returns parse-failure when any data rows yield zero test names (finding 1)', () => {
  // Regression: partial row drop must be detected. One row uses a hyphen instead
  // of an em dash, the other parses successfully.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 - broken hyphen (not em dash) | \`server/src/routes/foo.test.ts\` | timing | races | #1981 | 2026-08-01 |
| #2235 — valid em dash | \`server/src/routes/bar.test.ts\` | timing | races | #2235 | 2026-08-02 |
`;
  const result = planRegisterRun(markdown);
  assert.equal(result.outcome, 'parse-failure', 'should detect partial drop');
  assert.equal(result.unparsedCount, 1, 'should report 1 unparsed row');
});

test('buildParseFailureMessage formats the parse-failure error for the job summary (finding 3)', () => {
  // Fixing finding 3: the parse-failure message was never reaching
  // $GITHUB_STEP_SUMMARY because main() only called console.error, not emit().
  // This tests the pure message-building function so the main() branch can
  // reliably call emit() with it.
  const registerPath = '/c/Claude/Projects/Audiobook-Generator/docs/testing/flaky-register.md';
  const message = buildParseFailureMessage(registerPath, 2, 1);
  assert.ok(message.includes('quarantine-health:'), 'message should start with tool name');
  assert.ok(message.includes(registerPath), 'message should include register path');
  assert.ok(message.includes('contains 2 data row(s)'), 'message should name the data row count');
  assert.ok(message.includes('but 1 could not be fully parsed'), 'message should name the unparsed count');
  assert.ok(message.includes('parser is silently dropping row(s)'), 'message should describe the bug');
});

// --- Bug B regression: emit() for parse-failure (finding 3 end-to-end) ----
// The parse-failure message must actually reach $GITHUB_STEP_SUMMARY via emit(),
// not just be logged to console. This regression test verifies the emit() path.

test('buildParseFailureMessage and reportParseFailure reach $GITHUB_STEP_SUMMARY end-to-end (Bug B)', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { reportParseFailure } = await import('../quarantine-health.mjs');

  // Create a temp file to simulate $GITHUB_STEP_SUMMARY
  const tempDir = mkdtempSync(join(tmpdir(), 'quarantine-health-test-'));
  const summaryPath = join(tempDir, 'summary.md');

  // Save the original env var and exit code
  const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  const originalExitCode = process.exitCode;

  try {
    // Set the temp file as $GITHUB_STEP_SUMMARY
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.exitCode = 0; // reset for this test

    // Call the real reportParseFailure function, which calls the real emit()
    reportParseFailure('/path/to/register.md', 3, 2);

    // Verify the exit code was set
    assert.equal(process.exitCode, 1, 'exit code should be set to 1');

    // Read back the file and verify the message was written via emit()
    const { readFileSync } = await import('node:fs');
    const written = readFileSync(summaryPath, 'utf8');
    assert.ok(written.includes('quarantine-health:'), 'message should be in GITHUB_STEP_SUMMARY via emit()');
    assert.ok(written.includes('3 data row(s)'), 'message should contain data row count in GITHUB_STEP_SUMMARY');
    assert.ok(written.includes('2 could not be fully parsed'), 'message should contain unparsed count in GITHUB_STEP_SUMMARY');
  } finally {
    // Restore the original env var and exit code
    if (originalSummaryPath === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
    }
    process.exitCode = originalExitCode;

    // Clean up temp file
    try {
      const { rmSync } = await import('node:fs');
      rmSync(summaryPath, { force: true });
      rmSync(tempDir, { force: true });
    } catch {}
  }
});

test('planRegisterRun returns ok when all data rows parse successfully', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #2235 — revokes the older manifest | \`server/src/routes/export.test.ts\` | timing | races | #2235 | 2026-08-01 |
| #1981 — another valid test | \`server/src/routes/bar.test.ts\` | timing | races | #1981 | 2026-08-02 |
`;
  const result = planRegisterRun(markdown);
  assert.equal(result.outcome, 'ok', 'should return ok for valid rows');
  assert.equal(result.unparsedCount, 0, 'should report 0 unparsed rows');
  assert.equal(result.entries.length, 2, 'should parse 2 entries');
});

test('countUnparsedDataRows detects rows with fewer than 5 cells as malformed (Fix 3)', () => {
  // A row with fewer than 5 cells is structurally invalid and must count as unparsed.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 — valid test | \`server/src/routes/foo.test.ts\` | timing | races |
| #1982 — another valid test | \`server/src/routes/bar.test.ts\` | timing | races | #1982 | 2026-08-02 |
`;
  const unparsed = countUnparsedDataRows(markdown);
  assert.equal(unparsed, 1, 'should count 1 unparsed row (the 4-cell malformed row)');
});

test('planRegisterRun returns parse-failure when any row has fewer than 5 cells (Fix 3)', () => {
  // A register with one well-formed row and one malformed row (4 cells) should fire parse-failure.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 — valid test | \`server/src/routes/foo.test.ts\` | timing | races |
| #1982 — another test | \`server/src/routes/bar.test.ts\` | timing | races | #1982 | 2026-08-02 |
`;
  const result = planRegisterRun(markdown);
  assert.equal(result.outcome, 'parse-failure', 'should detect malformed row with <5 cells');
  assert.equal(result.unparsedCount, 1, 'should report 1 unparsed row');
});

test('planRegisterRun returns parse-failure when the only row is malformed (Fix 3)', () => {
  // A register with ONLY a malformed row should return parse-failure, not empty.
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| some opaque reference | \`server/src/routes/foo.test.ts\` | timing |
`;
  const result = planRegisterRun(markdown);
  assert.equal(result.outcome, 'parse-failure', 'should detect a single malformed row');
  assert.equal(result.unparsedCount, 1, 'should report 1 unparsed row');
});

test('planRegisterRun returns empty when no data rows exist', () => {
  const markdown = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|

_Empty — no tests are currently quarantined._
`;
  const result = planRegisterRun(markdown);
  assert.equal(result.outcome, 'empty', 'should return empty for genuinely empty register');
  assert.equal(result.unparsedCount, 0, 'should report 0 unparsed rows');
  assert.equal(result.entries.length, 0, 'should parse 0 entries');
});

test('main() end-to-end: parse-failure dispatch reaches $GITHUB_STEP_SUMMARY (Fix 2)', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { main } = await import('../quarantine-health.mjs');

  // Create a temp directory for our test files
  const tempDir = mkdtempSync(join(tmpdir(), 'quarantine-health-main-test-'));
  const registerPath = join(tempDir, 'test-register.md');
  const summaryPath = join(tempDir, 'summary.md');

  // Write an unparseable register (a row with <5 cells — Fix 3)
  const unparseable = `| Test | File | Class | Symptom | Tracking issue | Quarantined |
|------|------|-------|---------|----------------|-------------|
| #1981 — unparseable row | \`server/src/routes/foo.test.ts\` | timing |
`;
  writeFileSync(registerPath, unparseable, 'utf8');

  // Save original env vars and exit code
  const originalSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  const originalExitCode = process.exitCode;

  try {
    // Set up the test environment
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    process.exitCode = 0;

    // Call main() with the temp register file
    main(registerPath);

    // Verify exit code was set to 1
    assert.equal(process.exitCode, 1, 'main() should set exit code to 1 on parse-failure');

    // Verify the parse-failure message was written to GITHUB_STEP_SUMMARY
    const written = readFileSync(summaryPath, 'utf8');
    assert.ok(written.includes('quarantine-health:'), 'message should be in GITHUB_STEP_SUMMARY');
    assert.ok(written.includes('1 data row(s)'), 'message should name the data row count');
    assert.ok(written.includes('1 could not be fully parsed'), 'message should name the unparsed count');
    assert.ok(written.includes('parser is silently dropping row(s)'), 'message should describe the bug');
  } finally {
    // Restore env vars and exit code
    if (originalSummaryPath === undefined) {
      delete process.env.GITHUB_STEP_SUMMARY;
    } else {
      process.env.GITHUB_STEP_SUMMARY = originalSummaryPath;
    }
    process.exitCode = originalExitCode;

    // Clean up temp files
    try {
      rmSync(summaryPath, { force: true });
      rmSync(registerPath, { force: true });
      rmSync(tempDir, { force: true });
    } catch {}
  }
});

test('the run-loop wall-clock budget fits inside the workflow job cap with margin (finding 3 arithmetic)', () => {
  // The budget check (`budgetExceeded`, called BEFORE starting each run)
  // guarantees the run loop's own total worst-case elapsed time never
  // exceeds RUN_LOOP_WALL_CLOCK_BUDGET_MS: a run only starts if elapsed +
  // its own worst case still fits inside the budget, so after that run
  // finishes (worst case), elapsed <= budget by construction. That bound
  // must leave real margin inside JOB_CAP_MS (mirrors `timeout-minutes: 30`
  // in .github/workflows/quarantine-health.yml) for checkout/npm-install/
  // apt-get-ffmpeg and the post-loop `gh issue view` calls, which all run
  // OUTSIDE this budget.
  assert.ok(
    RUN_LOOP_WALL_CLOCK_BUDGET_MS <= JOB_CAP_MS,
    `run-loop budget (${RUN_LOOP_WALL_CLOCK_BUDGET_MS}ms) must fit inside the job cap (${JOB_CAP_MS}ms)`,
  );
  const margin = JOB_CAP_MS - RUN_LOOP_WALL_CLOCK_BUDGET_MS;
  assert.ok(margin >= 5 * 60 * 1000, `expected at least 5 minutes of margin for the rest of the job, got ${margin}ms`);

  // Concretely: with the default RUNS=5 and a register touching BOTH
  // frontend and server files (worst case, 3 invocations/run), simulate the
  // loop's own stopping behaviour and confirm it stops well before RUNS
  // completes rather than ever letting elapsed exceed the budget.
  const worstPerRun = worstCaseRunMs(1, 1, VITEST_RUN_TIMEOUT_MS);
  let elapsed = 0;
  let started = 0;
  for (let i = 0; i < 5; i++) {
    if (budgetExceeded(elapsed, worstPerRun, RUN_LOOP_WALL_CLOCK_BUDGET_MS)) break;
    started++;
    elapsed += worstPerRun; // worst case: this run took the full timeout
  }
  assert.ok(started < 5, `expected the budget to stop the loop before all 5 runs, but all 5 started`);
  assert.ok(elapsed <= RUN_LOOP_WALL_CLOCK_BUDGET_MS, `worst-case elapsed (${elapsed}ms) exceeded the budget`);
});
