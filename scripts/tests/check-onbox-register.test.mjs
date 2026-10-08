// Tests for the on-box acceptance register consistency checker.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  checkRegister,
  checkLiveView,
  resolveBaselineTexts,
  CANNOT_VERIFY_BASELINE_ERROR,
  ROW_CONTENT_DRIFT_ERROR_PREFIX,
  EXTRACTION_ERROR_PREFIX,
  THREE_WAY_CONTENT_WARNING_PREFIX,
  ROW_ID_COLLISION_ERROR_PREFIX,
  UNMERGED_LANE_ROW_ERROR_PREFIX,
  UNKNOWN_PROVENANCE_ERROR_PREFIX,
  PUBLISHING_FILE_ERROR_PREFIX,
  DISCHARGE_NAME_ERROR_PREFIX,
  resolvePublishedProvenance,
  resolveMergeBaseRegister,
  stripHtmlComments,
  htmlCellText,
  ALLOCATION_FLOOR,
  parseNextIdMarker,
} from '../check-onbox-register.mjs';
import { readNormalized } from '../lib/read-normalized.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';
import * as onbox from '../check-onbox-register.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'check-onbox-register.mjs');
const REAL_LIVE_VIEW_PATH = join(
  HERE,
  '..',
  '..',
  'docs',
  'testing',
  'onbox-acceptance-register-live-view.html',
);
const REAL_REGISTER_PATH = join(
  HERE,
  '..',
  '..',
  'docs',
  'testing',
  'onbox-acceptance-register.md',
);

// A minimal but structurally complete register: an "At a glance" table with
// two groups plus a Blocked row, and matching body sections. Coherent by
// construction — each fixture below mutates exactly one aspect of it.
function buildRegister({
  tableA = 2,
  tableB = 1,
  total = 3,
  bodyARows = [1, 2],
  bodyBRows = [1],
  nextIdA = 101,
  nextIdB = 101,
} = {}) {
  const bodyASection = bodyARows
    .map((n) => `### A${n} · thing ${n}\n\nSome body text.\n`)
    .join('\n');
  const bodyBSection = bodyBRows
    .map((n) => `### B${n} · thing ${n}\n\nSome body text.\n`)
    .join('\n');
  const markerA = nextIdA === null ? '' : `\n<!-- next-id: A${nextIdA} -->\n`;
  const markerB = nextIdB === null ? '' : `\n<!-- next-id: B${nextIdB} -->\n`;
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | ${tableA} |
| **B** | Setup B | ${tableB} |
| — | **Blocked** (hardware absent) | 1 |

**${total} owed.** Oldest: **2026-01-01**.

---

## Group A — setup a
${markerA}
${bodyASection}
---

## Group B — setup b
${markerB}
${bodyBSection}
---

## Blocked — hardware not available

### Something blocked

Text.
`;
}

// A fixture builder for the uniqueness/allocation-floor tests (4, 4a, 4b):
// an arbitrary set of glance-table groups, each with its own optional
// next-id marker and row list, plus arbitrary extra sections (e.g. a
// Blocked section reusing a live group's row ID). Unlike buildRegister(),
// which fixes the group letters at A/B, this lets a test build exactly the
// groups and marker values it needs.
function registerFixture({ glance, groups, extraSections = [] } = {}) {
  const glanceRows = glance
    .map(([letter, count]) => `| **${letter}** | Setup ${letter} | ${count} |`)
    .join('\n');
  const total = glance.reduce((sum, [, count]) => sum + count, 0);
  const bodySections = groups
    .map(({ letter, nextId, rows }) => {
      const marker = nextId === null || nextId === undefined ? '' : `\n<!-- next-id: ${letter}${nextId} -->\n`;
      const rowsText = rows.map((n) => `### ${letter}${n} · thing ${n}\n\nBody text.\n`).join('\n');
      return `## Group ${letter} — setup ${letter.toLowerCase()}\n${marker}\n${rowsText}\n---\n`;
    })
    .join('\n');
  const extra = extraSections.join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${glanceRows}

**${total} owed.** Oldest: **2026-01-01**.

---

${bodySections}
${extra}`;
}

test('a coherent register passes with no errors', () => {
  assert.deepEqual(checkRegister(buildRegister()), []);
});

test('the real docs/testing/onbox-acceptance-register.md is internally coherent', () => {
  // Bare readFileSync, not readNormalized, is deliberate here: checkRegister
  // tolerates '\r' throughout (measured CRLF-safe), so there is nothing for
  // normalization to fix for this call. See the REAL_REGISTER_TEXT comment
  // near the bottom of this file for the read that DOES need it.
  const path = new URL('../../docs/testing/onbox-acceptance-register.md', import.meta.url);
  const text = readFileSync(path, 'utf8');
  assert.deepEqual(checkRegister(text), []);
});

test('check 1: per-group count mismatch is reported with a fix-naming message', () => {
  const errors = checkRegister(buildRegister({ tableA: 3 }));
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Group A: glance table says 3, body has 2 rows (A1–A2). Update the table or the body.',
    ),
    `expected a Group A count-mismatch error, got: ${JSON.stringify(errors)}`,
  );
});

// Every OTHER formatRowList-exercising assertion in this file (the two-row
// A1-A2 case above, the seven-row E1-E7 regression below) happens to use a
// run starting at 1 — the exact shape formatRowList's OLD `n === i + 1` form
// also handled. Under stable row IDs a contiguous run no longer has to start
// at 1 (e.g. after A1-A4 are discharged, A5-A7 is still "contiguous" for
// display purposes even though it doesn't start at 1), so this pins that
// general case specifically.
test('check 1: a contiguous run NOT starting at 1 still collapses to a range in the mismatch message', () => {
  const text = registerFixture({
    glance: [['E', 2]],
    groups: [{ letter: 'E', nextId: 101, rows: [5, 6, 7] }],
  });
  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e === 'Group E: glance table says 2, body has 3 rows (E5–E7). Update the table or the body.',
    ),
    `expected the range to collapse to E5–E7, got: ${JSON.stringify(errors)}`,
  );
});

test('check 2: total mismatch against the glance table sum is reported', () => {
  const errors = checkRegister(buildRegister({ total: 5 }));
  assert.ok(
    errors.some(
      (e) =>
        e ===
        "Total says 5 owed but the glance table's group counts sum to 3. Update the total or the table.",
    ),
    `expected a total-mismatch error, got: ${JSON.stringify(errors)}`,
  );
});

test('check 3: a group in the glance table with no body section is reported', () => {
  const withoutBodyC = buildRegister().replace(
    '| — | **Blocked** (hardware absent) | 1 |',
    '| **C** | Setup C | 1 |\n| — | **Blocked** (hardware absent) | 1 |',
  );
  const errors = checkRegister(withoutBodyC);
  assert.ok(
    errors.some((e) =>
      e.includes(
        'Group C appears in the "At a glance" table but has no "## Group C — ..." section',
      ),
    ),
    `expected a missing-body-section error, got: ${JSON.stringify(errors)}`,
  );
});

test('check 3: a body section with no glance table row is reported', () => {
  const withExtraBodySection = buildRegister().replace(
    '## Blocked — hardware not available',
    `## Group D — setup d

### D1 · thing 1

Some body text.

---

## Blocked — hardware not available`,
  );
  const errors = checkRegister(withExtraBodySection);
  assert.ok(
    errors.some((e) =>
      e.includes(
        'Body has a "## Group D — ..." section but Group D is missing from the "At a glance" table',
      ),
    ),
    `expected a missing-table-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('4: a group with gaps passes — IDs are allocated once, never reused', () => {
  const text = registerFixture({
    glance: [['A', 2]],
    groups: [{ letter: 'A', nextId: 101, rows: [1, 7] }],
  });
  assert.deepEqual(checkRegister(text), []);
});

test('4a: the same row ID in two sections is reported', () => {
  // The #2634/#2653 repro: a Blocked-section heading reusing a live Group E ID.
  const text = registerFixture({
    glance: [['E', 1]],
    groups: [{ letter: 'E', nextId: 101, rows: [6] }],
    extraSections: ['## Blocked — hardware not available\n\n### E6 · a blocked thing\n'],
  });
  assert.ok(
    checkRegister(text).some((e) => e.includes('Row ID E6 appears more than once')),
    'a duplicate row ID across sections must be reported',
  );
});

// The migration to stable IDs deleted the pre-existing within-group duplicate
// test with no replacement — the case above only covers two IDs colliding
// ACROSS sections. This pins the narrower, same-section case: two identical
// `### E6` headings inside one Group E section.
test('4a: the same row ID twice in the SAME section is reported', () => {
  // The glance count is fixtured to agree with the body's physical row count
  // (2 headings, even though both are E6) so check 1 stays satisfied and
  // this test can assert 4a's duplicate-ID error fires ALONE.
  const text = registerFixture({
    glance: [['E', 2]],
    groups: [{ letter: 'E', nextId: 101, rows: [6, 6] }],
  });
  assert.deepEqual(
    checkRegister(text),
    [
      'Row ID E6 appears more than once (2 headings). Row IDs are allocated once and never ' +
        "reused — give the newer row its group's next-id instead.",
    ],
    '4a must fire alone, with check 1 satisfied by the matching glance count',
  );
});

test('4b: a row ID at or above its group next-id is reported', () => {
  const text = registerFixture({
    glance: [['A', 1]],
    groups: [{ letter: 'A', nextId: 101, rows: [101] }],
  });
  assert.ok(checkRegister(text).some((e) => e.includes('is at or above')));
});

test('4b: a group with no next-id marker is an error, not a skip', () => {
  const text = registerFixture({
    glance: [['A', 1]],
    groups: [{ letter: 'A', nextId: null, rows: [1] }],
  });
  assert.ok(
    checkRegister(text).some((e) => e.includes('has no "<!-- next-id:')),
    'a missing marker must not silently disable the allocation-floor check',
  );
});

test('4b: a next-id below the allocation floor is reported', () => {
  const text = registerFixture({
    glance: [['A', 1]],
    groups: [{ letter: 'A', nextId: ALLOCATION_FLOOR - 1, rows: [1] }],
  });
  assert.ok(checkRegister(text).some((e) => e.includes('below the allocation floor')));
});

// The test above builds its fixture from `ALLOCATION_FLOOR - 1`, so it moves
// with the constant and can never catch the constant itself being lowered.
// This pins the LITERAL value: `ALLOCATION_FLOOR` must never drop below 101
// (see its own comment — allocation counts upward, and A99 is
// check-register-citations.mjs's own nonexistent-ID sentinel).
test('ALLOCATION_FLOOR is pinned at 101 and must never be lowered', () => {
  assert.equal(
    ALLOCATION_FLOOR,
    101,
    'ALLOCATION_FLOOR must never be lowered — a floor at or below 99 would ' +
      "eventually walk allocation through A99, check-register-citations.mjs's " +
      'own nonexistent-ID sentinel. If a fixture breaks against 101, the ' +
      'fixture is what is wrong, not this constant.',
  );
});

test('4b: an invalid row heading suppresses the per-row next-id comparison but not the sub-lettering rejection or the marker/floor checks', () => {
  // The "review fix 3" fixture above (A2a/A2b, no marker) can't reach the 4b
  // suppression line: it carries no next-id marker at all, so 4b `continue`s
  // at the nextId === null branch before the per-row loop runs. This fixture
  // adds a next-id marker AND a valid row at-or-above it (A101 against
  // next-id A101), so the per-row "is at or above" comparison would fire if
  // the suppression were removed.
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 2 |

**2 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

<!-- next-id: A101 -->

### A2a · thing 2 part a

Body text.

### A101 · thing 101

Body text.

---
`;
  const errors = checkRegister(text);
  assert.ok(
    errors.some((e) => e.includes('is not a valid row number')),
    `expected the sub-lettering rejection to still fire, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('is at or above')),
    `the per-row next-id comparison must be suppressed for a letter with an invalid row heading, got: ${JSON.stringify(errors)}`,
  );
});

test('parseNextIdMarker does not match a marker for a different group letter', () => {
  assert.equal(parseNextIdMarker('<!-- next-id: G101 -->\n', 'H'), null);
});

// Pins the regex's trailing `\s*\r?$` anchor: a line that merely STARTS like
// a valid marker but has non-whitespace trailing content after the closing
// `-->` is not a marker at all and must not match. Without the anchor the
// regex has nothing requiring it to reach end-of-line, so it would happily
// match the `A101` prefix and silently ignore everything after it.
test('parseNextIdMarker rejects a line with trailing content after the closing `-->`', () => {
  assert.equal(
    parseNextIdMarker('<!-- next-id: A101 --> this is not a valid marker line\n', 'A'),
    null,
  );
});

test('fix 1: a body-only group heading with an ASCII hyphen still counts as a group (not silently dropped)', () => {
  const withExtraBodySection = buildRegister().replace(
    '## Blocked — hardware not available',
    `## Group D - setup d

### D1 · thing 1

Some body text.

---

## Blocked — hardware not available`,
  );
  const errors = checkRegister(withExtraBodySection);
  assert.ok(
    errors.some((e) =>
      e.includes(
        'Body has a "## Group D — ..." section but Group D is missing from the "At a glance" table',
      ),
    ),
    `expected a missing-table-row error even with an ASCII-hyphen heading, got: ${JSON.stringify(errors)}`,
  );
});

test('fix 1: a body-only group heading with an en dash still counts as a group (not silently dropped)', () => {
  const withExtraBodySection = buildRegister().replace(
    '## Blocked — hardware not available',
    `## Group D – setup d

### D1 · thing 1

Some body text.

---

## Blocked — hardware not available`,
  );
  const errors = checkRegister(withExtraBodySection);
  assert.ok(
    errors.some((e) =>
      e.includes(
        'Body has a "## Group D — ..." section but Group D is missing from the "At a glance" table',
      ),
    ),
    `expected a missing-table-row error even with an en-dash heading, got: ${JSON.stringify(errors)}`,
  );
});

test('fix 2: a malformed glance-table row (extra column) is reported on its own, not as "missing from the table"', () => {
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Oldest | Rows |
|---|---|---|---|
| **A** | Setup A | 2026-01-01 | 2 |
| **F** | Setup F | 2026-01-01 | 1 |

**3 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

### A2 · thing 2

Body text.

---

## Group F — setup f

### F1 · thing 1

Body text.

---
`;
  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'The glance-table row for Group A could not be parsed — expected exactly three cells, the last a bare integer.',
    ),
    `expected a Group A malformed-row error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'The glance-table row for Group F could not be parsed — expected exactly three cells, the last a bare integer.',
    ),
    `expected a Group F malformed-row error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('missing from the "At a glance" table')),
    `did not expect a misleading missing-from-table error, got: ${JSON.stringify(errors)}`,
  );
});

test('fix 3: a duplicated body group section is reported', () => {
  const withDuplicateSection = buildRegister().replace(
    '## Blocked — hardware not available',
    `## Group A — setup a (duplicate)

### A1 · thing 1

Some body text.

### A2 · thing 2

Some body text.

---

## Blocked — hardware not available`,
  );
  const errors = checkRegister(withDuplicateSection);
  assert.ok(
    errors.some((e) => e.includes('Group A appears more than once in the body')),
    `expected a duplicate-body-section error, got: ${JSON.stringify(errors)}`,
  );
});

test('fix 3: a duplicated glance-table row is reported', () => {
  const withDuplicateRow = buildRegister().replace(
    '| **A** | Setup A | 2 |',
    '| **A** | Setup A | 2 |\n| **A** | Setup A | 2 |',
  );
  const errors = checkRegister(withDuplicateRow);
  assert.ok(
    errors.some((e) => e.includes('Group A appears more than once in the "At a glance" table')),
    `expected a duplicate-table-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('fix 5: a single-row count mismatch uses singular grammar and no dash range', () => {
  const errors = checkRegister(buildRegister({ tableB: 2, total: 4, bodyBRows: [1] }));
  assert.ok(
    errors.some(
      (e) =>
        e === 'Group B: glance table says 2, body has 1 row (B1). Update the table or the body.',
    ),
    `expected singular-grammar error, got: ${JSON.stringify(errors)}`,
  );
});

test('ops-44: a sub-lettered row heading ("### A19b") is rejected with a clear message, not silently dropped', () => {
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 1 |

**1 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

### A19b

Body text.

---
`;
  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Row heading "### A19b" is not a valid row number. Row numbers are plain integers (A1, A2, …), allocated once from the group\'s next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    ),
    `expected the sub-lettered-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('ops-44: a non-row "### " subheading inside a group section is still ignored', () => {
  const withNotesSubheading = buildRegister().replace(
    '### A2 · thing 2',
    '### Notes\n\nSome context that is not a row.\n\n### A2 · thing 2',
  );
  assert.deepEqual(checkRegister(withNotesSubheading), []);
});

test('ops-44: a fenced code block containing "### F2 · ..." does not inflate group F\'s count', () => {
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **F** | Setup F | 1 |

**1 owed.** Oldest: **2026-01-01**.

---

## Group F — setup f

<!-- next-id: F101 -->

### F1 · thing 1

Body text.

\`\`\`
### F2 · this is example text inside a fenced block, not a real row
\`\`\`

---
`;
  assert.deepEqual(checkRegister(text), []);
});

test('ops-44: a fenced code block containing "## Group Z — ..." does not create a phantom group', () => {
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 1 |

**1 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

<!-- next-id: A101 -->

### A1 · thing 1

Body text.

\`\`\`
## Group Z — this line must not create a phantom section
\`\`\`

More body text after the fence, still part of Group A.

---
`;
  assert.deepEqual(checkRegister(text), []);
});

test('ops-44: "~~~" fences behave the same as ``` fences for both the section split and the row-heading scan', () => {
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 1 |

**1 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

<!-- next-id: A101 -->

### A1 · thing 1

Body text.

~~~
### A2 · this is example text inside a tilde-fenced block, not a real row
## Group Z — this must not create a phantom section either
~~~

---
`;
  assert.deepEqual(checkRegister(text), []);
});

test('regression: reproduces the real 2026-07-28 drift (E=5 vs 7 rows, total 31)', () => {
  // Mirrors the actual incident this check exists to catch: the "At a
  // glance" table under-reported Group E (5 instead of the 7 rows actually
  // in the body) and the stated total (31) didn't even match what the
  // table's own (wrong) per-group figures summed to. Uses the real
  // register's own group sizes (19/2/3/2/7/1/1 = 35), not a scaled-down set.
  const groupSizes = { A: 19, B: 2, C: 3, D: 2, F: 1, G: 1 };
  const tableRows = Object.entries(groupSizes)
    .map(([letter, count]) => `| **${letter}** | Setup ${letter} | ${count} |`)
    .join('\n');
  const bodySections = Object.entries(groupSizes)
    .map(
      ([letter, count]) =>
        `## Group ${letter} — setup ${letter}\n\n` +
        Array.from(
          { length: count },
          (_, i) => `### ${letter}${i + 1} · thing ${i + 1}\n\nBody text.\n`,
        ).join('\n') +
        '\n---\n',
    )
    .join('\n');
  const bodyE = Array.from(
    { length: 7 },
    (_, i) => `### E${i + 1} · thing ${i + 1}\n\nBody text.\n`,
  ).join('\n');

  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${tableRows}
| **E** | Setup E | 5 |

**31 owed.** Oldest: **2026-06-01**.

---

${bodySections}

## Group E — setup e

${bodyE}
---
`;

  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Group E: glance table says 5, body has 7 rows (E1–E7). Update the table or the body.',
    ),
    `expected the Group E under-count error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some((e) => e.includes("Total says 31 owed but the glance table's group counts sum to")),
    `expected a total-mismatch error, got: ${JSON.stringify(errors)}`,
  );
});

// --- ops-44 independent-review follow-up (issue #1913 review comment) ---

test('review fix 1: an unterminated fenced code block is reported, not silently swallowed', () => {
  // Mirrors the review's exact repro: glance table says A = 1, body genuinely
  // has ### A1 and ### A2, with one stray ``` line inserted before ### A2.
  // Before the fix this returned [] (exit 0) — the fence blanked ### A2 and
  // everything after it, so check 1 never saw the mismatch.
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 1 |

**1 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

\`\`\`
### A2 · thing 2

Body text.

---
`;
  const errors = checkRegister(text);
  assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
  assert.match(
    errors[0],
    /^Unterminated fenced code block opened at line \d+ — everything after it was ignored\.$/,
  );
});

test('review fix 1: the no-fence control case still reports the count mismatch', () => {
  // Same document as the previous test with the stray fence removed — proves
  // the fence, not some other change, was what hid the mismatch.
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 1 |

**1 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

### A2 · thing 2

Body text.

---
`;
  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Group A: glance table says 1, body has 2 rows (A1–A2). Update the table or the body.',
    ),
    `expected the Group A count-mismatch error, got: ${JSON.stringify(errors)}`,
  );
});

test('review fix 1: a fence opened before "## At a glance" also degrades loudly', () => {
  // If the whole document (including the "## At a glance" heading itself)
  // gets swallowed by an unterminated fence, the failure must still be named
  // as an unterminated fence — not surface as the unrelated "No At a glance
  // section found" message, which would misdirect the fix.
  const text = '```\n' + buildRegister();
  const errors = checkRegister(text);
  assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
  assert.equal(
    errors[0],
    'Unterminated fenced code block opened at line 1 — everything after it was ignored.',
  );
});

test('review fix 2: dotted sub-numbering ("### A2.1") is rejected, not silently counted as row 2', () => {
  // \b alone (the pre-fix regex) treats "." as a word boundary just like
  // whitespace, so `### A2.1` and `### A2.2` were both silently counted as
  // row 2 — producing a phantom "duplicate row 2" contiguity error instead
  // of the correct invalid-row-heading rejection.
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 4 |

**4 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

### A2.1 · thing 2 part 1

Body text.

### A2.2 · thing 2 part 2

Body text.

### A3 · thing 3

Body text.

---
`;
  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Row heading "### A2.1 · thing 2 part 1" is not a valid row number. Row numbers are plain integers (A1, A2, …), allocated once from the group\'s next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    ),
    `expected the A2.1 rejection, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Row heading "### A2.2 · thing 2 part 2" is not a valid row number. Row numbers are plain integers (A1, A2, …), allocated once from the group\'s next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    ),
    `expected the A2.2 rejection, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('are not contiguous')),
    `did not expect a phantom "duplicate row 2" contiguity error, got: ${JSON.stringify(errors)}`,
  );
});

test('review fix 3: an invalid row heading suppresses the per-row 4b check for that letter, but NOT the marker-presence/floor checks', () => {
  // The decision comment's own motivating case: A2 split into A2a/A2b (table
  // bumped to 3 to "absorb" the split) instead of annotating a single row's
  // title. Table (3) vs. the one still-valid body row (A1) would otherwise
  // ALSO report a count mismatch on top of the two rejections. Deliberately
  // NOT sized so the counts happen to reconcile (unlike the pre-existing
  // A19b fixture, which dodges this case) — this test fails if fix 3 is
  // reverted.
  //
  // No `<!-- next-id: A101 -->` marker on this fixture, deliberately: per
  // Task 8's checkRegister, marker-presence and the allocation floor are NOT
  // suppressed by an invalid row heading in the same group — only the
  // per-row "is at or above next-id" comparison is. Asserting the
  // marker-missing error's ABSENCE here would pin exactly the hole this
  // check exists to close, so this asserts its PRESENCE instead.
  const text = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 3 |

**3 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

### A2a · thing 2 part a

Body text.

### A2b · thing 2 part b

Body text.

---
`;
  const errors = checkRegister(text);
  assert.deepEqual(errors, [
    'Row heading "### A2a · thing 2 part a" is not a valid row number. Row numbers are plain integers (A1, A2, …), allocated once from the group\'s next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    'Row heading "### A2b · thing 2 part b" is not a valid row number. Row numbers are plain integers (A1, A2, …), allocated once from the group\'s next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    'Group A has no "<!-- next-id: AN -->" allocation marker. Add one directly under the group heading — without it there is nothing to allocate new row IDs from.',
  ]);
});

test('review fix 4: CRLF line endings do not leak a raw \\r into the invalid-row-heading message', () => {
  const text = [
    '# On-box acceptance register',
    '',
    '## At a glance',
    '',
    '| Group | Setup | Rows |',
    '|---|---|---|',
    '| **A** | Setup A | 1 |',
    '',
    '**1 owed.** Oldest: **2026-01-01**.',
    '',
    '---',
    '',
    '## Group A — setup a',
    '',
    '### A1 · thing 1',
    '',
    'Body text.',
    '',
    '### A19b · sub',
    '',
    'Body text.',
    '',
    '---',
    '',
  ].join('\r\n');
  const errors = checkRegister(text);
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Row heading "### A19b · sub" is not a valid row number. Row numbers are plain integers (A1, A2, …), allocated once from the group\'s next-id — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    ),
    `expected the sub-lettered-row error with no trailing \\r, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('\r')),
    `expected no error message to contain a raw \\r, got: ${JSON.stringify(errors)}`,
  );
});

// ---------------------------------------------------------------------------
// checkLiveView — the register vs. its published HTML twin
// ---------------------------------------------------------------------------

// A minimal live view matching buildRegister()'s default shape: 2 A rows,
// 1 B row, 3 owed, plus a Blocked section whose `gtag` is not a single letter
// and whose row is `—` (both must be ignored, exactly as the markdown's own
// `—` glance rows are).
function buildLiveView({
  owed = 3,
  glanceA = 2,
  glanceB = 1,
  headerA = 2,
  headerB = 1,
  rowsA = ['A1', 'A2'],
  rowsB = ['B1'],
  glanceTag = 'glance',
  owedClass = 'n owed',
  sectionClass = 'group',
} = {}) {
  const rowSpans = (ids) =>
    ids
      .map(
        (id) =>
          `      <summary><span class="num">${id}</span><span class="iname">t</span></summary>`,
      )
      .join('\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="${owedClass}">${owed}</div><div class="l">Owed</div>
  </div>

  <table class="${glanceTag}">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#ga">A</a></td><td>Setup A</td><td>${glanceA}</td></tr>
      <tr><td><a href="#gb">B</a></td><td>Setup B</td><td>${glanceB}</td></tr>
      <tr><td>—</td><td><b>Blocked</b> (hardware absent)</td><td>1</td></tr>
    </tbody>
  </table>

  <section class="${sectionClass}" id="ga">
    <h3 class="gtitle"><span class="gtag">A</span> Setup A <span class="gcount">${headerA} rows</span></h3>
${rowSpans(rowsA)}
  </section>

  <section class="${sectionClass}" id="gb">
    <h3 class="gtitle"><span class="gtag">B</span> Setup B <span class="gcount">${headerB} row</span></h3>
${rowSpans(rowsB)}
  </section>

  <section class="${sectionClass} is-blocked" id="blocked">
    <h3 class="gtitle"><span class="gtag">BLK</span> Blocked <span class="gcount">1 row</span></h3>
      <summary><span class="num">—</span><span class="iname">something</span></summary>
  </section>
`;
}

test('a live view matching the register passes with no errors', () => {
  assert.deepEqual(checkLiveView(buildRegister(), buildLiveView()), []);
});

test('a row in the live view that the register does not have is caught', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ rowsA: ['A1', 'A2', 'A3'] }));
  assert.ok(
    errors.some((e) =>
      e.startsWith("Live view's Group A section has row A3 that the register's Group A does not."),
    ),
    `expected the extra-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('a duplicated row in the live view is caught', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ rowsA: ['A1', 'A2', 'A2'] }));
  assert.ok(
    errors.includes('Live view: Group A lists A2 more than once.'),
    `expected the duplicate-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('a group missing from the live view entirely is caught', () => {
  const liveView = buildLiveView().replace(
    /<section class="group" id="gb">[\s\S]*?<\/section>/,
    '',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.includes('Live view: no group section for Group B.'),
    `expected the missing-group error, got: ${JSON.stringify(errors)}`,
  );
});

// The three checks below are the vacuous-pass guards. Each renames a marker
// the parser depends on; without them a markup change would silently turn the
// whole live-view comparison into a no-op that reports green.
test('an unreadable owed total is an error, not a silent pass', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ owedClass: 'n total' }));
  assert.ok(
    errors.some((e) => e.startsWith('Live view: no `<div class="n owed">NN</div>` found')),
    `expected the unreadable-total error, got: ${JSON.stringify(errors)}`,
  );
});

test('an unreadable glance table is an error, not a silent pass', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ glanceTag: 'summary' }));
  assert.ok(
    errors.some((e) => e.startsWith('Live view: no `<table class="glance">` found')),
    `expected the unreadable-glance-table error, got: ${JSON.stringify(errors)}`,
  );
});

test('unreadable group sections are an error, not a silent pass', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ sectionClass: 'grp' }));
  // deepEqual, not `.some`: the branch bails out early precisely so it does
  // not then also report every group as missing a section. `.some` left that
  // early return unpinned (PR #2080 review round 2, #2).
  assert.deepEqual(
    errors,
    [
      'Live view: no `<section class="group…">` blocks with a single-letter `gtag` found — no rows could be read. If the markup changed, update scripts/check-onbox-register.mjs.',
    ],
    `expected exactly the unreadable-sections error, got: ${JSON.stringify(errors)}`,
  );
});

// The real file's Blocked and Unconfirmed sections carry MODIFIER classes
// (`class="group is-blocked"` / `is-soft`). A split marker ending at the
// closing quote missed both, folding their content into the preceding group's
// block — so the gtag filter never saw them and their rows were attributed to
// whichever group happened to precede them (PR #2080 review, F2). These two
// pin the modifier-class handling itself rather than re-asserting the happy
// path, which the first test in this block already covers.
test('a group section with a modifier class is still parsed as its own section', () => {
  const liveView = buildLiveView().replace(
    '<section class="group" id="gb">',
    '<section class="group is-hot" id="gb">',
  );
  assert.deepEqual(
    checkLiveView(buildRegister(), liveView),
    [],
    'a cosmetic modifier class must not make a section unreadable',
  );
});

test("a modifier-classed Blocked section's rows never land in another group", () => {
  // Its `—` row becomes a real row ID. If the Blocked section were folded into
  // Group B's block (the F2 bug), this would surface as an extra B-section row.
  const liveView = buildLiveView().replace(
    '<span class="num">—</span><span class="iname">something</span>',
    '<span class="num">Z9</span><span class="iname">something</span>',
  );
  assert.deepEqual(
    checkLiveView(buildRegister(), liveView),
    [],
    'the Blocked section must be skipped whole, not merged into the group above it',
  );
});

// The fixtures above can only prove the arithmetic. This one proves the
// parsers actually fit the real, hand-authored markup — the thing that breaks
// when someone restyles the live view.
test('the real register and its real live view agree', () => {
  // Bare readFileSync for both, not readNormalized: checkLiveView tolerates
  // '\r' throughout (measured CRLF-safe), so there's no normalization gap
  // to close here — unlike REAL_REGISTER_TEXT further down, which feeds a
  // literal '\n---\n'/'\n## ' delimiter scan and needs it.
  const md = readFileSync(
    new URL('../../docs/testing/onbox-acceptance-register.md', import.meta.url),
    'utf8',
  );
  const lv = readFileSync(
    new URL('../../docs/testing/onbox-acceptance-register-live-view.html', import.meta.url),
    'utf8',
  );
  assert.deepEqual(checkLiveView(md, lv), []);
});

// --- Branches added or left uncovered by the first round (PR #2080 review) ---

// F1: Map.set is last-writer-wins on both surfaces, so a repeated letter kept
// exactly one of two contradicting rows — and WHICH one depended on their
// order. Wrong-count-first is the direction that used to pass.
test('a group repeated in the live-view glance table is caught, wrong count first', () => {
  const liveView = buildLiveView().replace(
    '<tr><td><a href="#gb">B</a></td><td>Setup B</td><td>1</td></tr>',
    '<tr><td><a href="#gb">B</a></td><td>Setup B</td><td>99</td></tr>\n      <tr><td><a href="#gb">B</a></td><td>Setup B</td><td>1</td></tr>',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) =>
      e.startsWith('Live view: Group B appears more than once in the glance table.'),
    ),
    `expected the duplicate-glance-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('a group section repeated in the live view is caught', () => {
  const liveView = buildLiveView().replace(
    '<section class="group" id="gb">',
    '<section class="group" id="gb-copy">\n    <h3 class="gtitle"><span class="gtag">B</span> Setup B <span class="gcount">1 row</span></h3>\n      <summary><span class="num">B1</span><span class="iname">t</span></summary>\n  </section>\n\n  <section class="group" id="gb">',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) => e.startsWith('Live view: more than one group section carries the gtag B.')),
    `expected the duplicate-section error, got: ${JSON.stringify(errors)}`,
  );
});

test('a malformed live-view glance row is reported on its own', () => {
  const liveView = buildLiveView().replace(
    '<tr><td><a href="#ga">A</a></td><td>Setup A</td><td>2</td></tr>',
    '<tr><td><a href="#ga">A</a></td><td>Setup A</td><td>2026-01-01</td><td>2</td></tr>',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.includes(
      'Live view: the glance-table row for Group A could not be parsed — expected exactly three cells, the last a bare integer.',
    ),
    `expected the malformed-row error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e === 'Live view: Group A is missing from the glance table.'),
    `a malformed row must not also report as missing, got: ${JSON.stringify(errors)}`,
  );
});

test("a group in the register's glance table but missing from the live view's is caught", () => {
  const liveView = buildLiveView().replace(
    '<tr><td><a href="#gb">B</a></td><td>Setup B</td><td>1</td></tr>',
    '',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.includes('Live view: Group B is missing from the glance table.'),
    `expected the missing-glance-row error, got: ${JSON.stringify(errors)}`,
  );
});

test("a group in the live view's glance table that the register's does not have is caught", () => {
  const liveView = buildLiveView().replace(
    '<tr><td>—</td>',
    '<tr><td><a href="#gz">Z</a></td><td>Setup Z</td><td>1</td></tr>\n      <tr><td>—</td>',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) =>
      e.startsWith(
        "Live view: glance table has a Group Z row that the register's glance table does not.",
      ),
    ),
    `expected the extra-glance-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('a group header with no row count is caught', () => {
  const liveView = buildLiveView().replace('<span class="gcount">2 rows</span>', '');
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) => e.startsWith("Live view: Group A's header has no")),
    `expected the missing-gcount error, got: ${JSON.stringify(errors)}`,
  );
});

test("a live-view group section the register's body does not have is caught", () => {
  const liveView = buildLiveView().replace(
    '<section class="group is-blocked" id="blocked">',
    '<section class="group" id="gz">\n    <h3 class="gtitle"><span class="gtag">Z</span> Setup Z <span class="gcount">1 row</span></h3>\n      <summary><span class="num">Z1</span><span class="iname">t</span></summary>\n  </section>\n\n  <section class="group is-blocked" id="blocked">',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) =>
      e.startsWith("Live view has a Group Z section that the register's body does not."),
    ),
    `expected the extra-section error, got: ${JSON.stringify(errors)}`,
  );
});

// F5: an unterminated fence blanks the rest of the markdown, so without this
// bail-out every live-view comparison ran against a truncated register and
// demanded the deletion of sections that were perfectly fine.
test('an unterminated fence in the register bails out instead of condemning real sections', () => {
  const register = buildRegister().replace('## Group B — setup b', '```\n\n## Group B — setup b');
  const errors = checkLiveView(register, buildLiveView());
  assert.equal(
    errors.length,
    1,
    `expected exactly the fence error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors[0].startsWith('Cannot check the live view: the register has an unterminated fenced'),
    `expected the fence bail-out, got: ${JSON.stringify(errors)}`,
  );
});

// F6: a row filed under the wrong section names the section it was actually
// found in, not just "extra"/"missing" with nothing saying where it sat.
test('a row filed under the wrong group section names the section it is extra in', () => {
  const liveView = buildLiveView({ rowsA: ['A1', 'A2', 'B1'], rowsB: [] });
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) => e.includes("Live view's Group A section has row B1")),
    `expected the extra-row error to name Group A, got: ${JSON.stringify(errors)}`,
  );
});

// --- Round 2 findings (PR #2080) ---

// #1: the shape filter used to DROP a non-conforming `num` before comparison,
// so a live-view row the register does not have vanished from the check
// entirely. The markdown side rejects the identical violation loudly.
test('a live-view row with an invalid row ID is reported, not silently dropped', () => {
  for (const bad of ['A31b', 'A3.1', 'a3', 'A 3']) {
    const liveView = buildLiveView({ rowsA: ['A1', 'A2', bad], headerA: 2 });
    const errors = checkLiveView(buildRegister(), liveView);
    assert.ok(
      errors.some((e) => e.includes(`has a row numbered "${bad}"`)),
      `expected ${bad} to be reported, got: ${JSON.stringify(errors)}`,
    );
  }
});

// #5: the split marker was positional, so moving `class` after `id` re-opened
// F2's fold — the one attribute variation that degraded silently rather than
// failing loudly.
test('a group section is parsed with its class attribute after other attributes', () => {
  const liveView = buildLiveView().replace(
    '<section class="group" id="gb">',
    '<section id="gb" data-x="1" class="group">',
  );
  assert.deepEqual(checkLiveView(buildRegister(), liveView), []);
});

test('a modifier-classed Blocked section is parsed whole even with class last', () => {
  const liveView = buildLiveView().replace(
    '<section class="group is-blocked" id="blocked">',
    '<section id="blocked" class="group is-blocked">',
  );
  // Its `—` row must not leak into Group B, the section above it.
  assert.deepEqual(checkLiveView(buildRegister(), liveView), []);
});

// #4: widening the marker to `class="group[^"]*"` also matched sibling names.
test('a sibling class like "grouping" is not mistaken for a group section', () => {
  const liveView = buildLiveView().replace(
    '<section class="group" id="gb">',
    '<section class="grouping" id="nav"><span class="gtag">A</span></section>\n\n  <section class="group" id="gb">',
  );
  assert.deepEqual(
    checkLiveView(buildRegister(), liveView),
    [],
    'a decoy section must not register as a duplicate Group A',
  );
});

// #6: comments, both directions. Commenting a section out removes it from the
// published page; commenting a row out does not add one.
test('a commented-out group section is reported as missing', () => {
  const liveView = buildLiveView().replace(
    /<section class="group" id="gb">([\s\S]*?)<\/section>/,
    '<!-- <section class="group" id="gb">$1</section> -->',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.includes('Live view: no group section for Group B.'),
    `expected the commented-out section to read as missing, got: ${JSON.stringify(errors)}`,
  );
});

test('a commented-out row is not counted as a real one', () => {
  const liveView = buildLiveView().replace(
    '<summary><span class="num">A2</span><span class="iname">t</span></summary>',
    '<summary><span class="num">A2</span><span class="iname">t</span></summary>\n      <!-- <summary><span class="num">A9</span><span class="iname">t</span></summary> -->',
  );
  assert.deepEqual(checkLiveView(buildRegister(), liveView), []);
});

// #7: `<tr>` was matched exactly, so an ADDED glance row carrying any
// attribute was invisible — the same brittleness the section marker had.
test('an added glance row carrying an attribute is still seen', () => {
  const liveView = buildLiveView().replace(
    '<tr><td>—</td>',
    '<tr class="dim"><td><a href="#gz">Z</a></td><td>Setup Z</td><td>5</td></tr>\n      <tr><td>—</td>',
  );
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) => e.startsWith('Live view: glance table has a Group Z row')),
    `expected the extra glance row to be seen, got: ${JSON.stringify(errors)}`,
  );
});

// #2, survivor 1: no test fed checkLiveView a markdown without the heading.
test('a markdown with no "At a glance" section reports that, and nothing else', () => {
  const register = buildRegister().replace('## At a glance', '## Summary');
  assert.deepEqual(checkLiveView(register, buildLiveView()), [
    'No "## At a glance" section in the markdown — cannot check the live view against it.',
  ]);
});

// ---------------------------------------------------------------------------
// #2199: `extraOnly` + `baselineText` — discharge-aware --against-published.
//
// A discharge (removing a row, which contiguity then renumbers the
// survivors) makes the still-live page look "ahead" in exactly the same
// shape as a genuine competing-lane publish: a live-page row/group the
// working register doesn't have. `checkLiveView` disambiguates the two by
// checking whether a SECOND register text — meant to be origin/main's copy,
// injected here directly rather than fetched via git, per the design's
// "keep checkLiveView unit-testable, do the git show in the CLI layer"
// requirement — also lacks the row: baseline-lacks-it-too means discharged
// (not reported); baseline-still-has-it means genuinely behind (reported).
// ---------------------------------------------------------------------------

// A minimal single-group register/live-view pair, parameterised by letter and
// row numbers — reused for all four #2199 scenarios below so each test only
// states the one thing that differs (working rows vs. baseline rows vs.
// live-page rows).
function buildSingleGroupRegister(letter, rowNumbers, nextId = 101) {
  const body = rowNumbers.map((n) => `### ${letter}${n} · thing ${n}\n\nBody text.\n`).join('\n');
  const marker = nextId === null ? '' : `\n<!-- next-id: ${letter}${nextId} -->\n`;
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **${letter}** | Setup ${letter} | ${rowNumbers.length} |

**${rowNumbers.length} owed.** Oldest: **2026-01-01**.

---

## Group ${letter} — setup ${letter.toLowerCase()}
${marker}
${body}
---
`;
}

function buildSingleGroupLiveView(letter, { owed, glanceCount, headerCount, rowIds }) {
  const rowSpans = rowIds
    .map(
      (id) => `      <summary><span class="num">${id}</span><span class="iname">t</span></summary>`,
    )
    .join('\n');
  const lower = letter.toLowerCase();
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${owed}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#g${lower}">${letter}</a></td><td>Setup ${letter}</td><td>${glanceCount}</td></tr>
    </tbody>
  </table>

  <section class="group" id="g${lower}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">${headerCount} rows</span></h3>
${rowSpans}
  </section>
`;
}

// The exact 2026-08-06 shape from #2199, updated for stable row IDs: Group
// C's C1/C2 were discharged and C3 — never renumbered, IDs are allocated
// once and never reused — stays C3, leaving a gap rather than a renumbered
// survivor. The live page (fetched before the publish that will fix it)
// still shows all three original IDs; the working register has only the
// surviving C3; origin/main already carries the same discharge (this
// change, or an already-merged one) so its baseline copy agrees with the
// working register, not the stale live page.
test('#2199: a discharge + renumber passes when origin/main also lacks the discharged IDs', () => {
  const workingRegister = buildSingleGroupRegister('C', [3]);
  const baselineRegister = buildSingleGroupRegister('C', [3]);
  const liveView = buildSingleGroupLiveView('C', {
    owed: 3,
    glanceCount: 3,
    headerCount: 3,
    rowIds: ['C1', 'C2', 'C3'],
  });
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    // #3529: a discharge is a row the page's own merged publish committed.
    publishedProvenance: { kind: 'merged', nonce: 'main0x1', stampedRowIds: ['C1', 'C2', 'C3'] },
  });
  assert.deepEqual(errors, []);
});

// The acceptance criteria's other named case: a row genuinely published from
// a competing lane. A38 exists on the live page and on origin/main (the
// competing lane's PR already merged there) but not yet in this register —
// this must still fail, and name A38.
test('#2199: a row still present on origin/main is reported as a genuine competing-lane row (names A38)', () => {
  const workingRegister = buildSingleGroupRegister(
    'A',
    Array.from({ length: 37 }, (_, i) => i + 1),
  );
  const baselineRegister = buildSingleGroupRegister(
    'A',
    Array.from({ length: 38 }, (_, i) => i + 1),
  );
  const liveView = buildSingleGroupLiveView('A', {
    owed: 38,
    glanceCount: 38,
    headerCount: 38,
    rowIds: Array.from({ length: 38 }, (_, i) => `A${i + 1}`),
  });
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
  });
  assert.ok(
    errors.some((e) => e.includes('BEHIND what is already published') && e.includes('A38')),
    `expected a stale-row error naming A38, got: ${JSON.stringify(errors)}`,
  );
});

// Fail-closed (not fail-open): when the baseline can't be resolved at all —
// modelling `git show origin/main:...` failing in the CLI layer — the check
// must refuse to guess, not silently treat "unknown" as "discharged".
test('#2199: an unresolvable baseline fails closed with a "cannot verify" error, not a silent pass', () => {
  const workingRegister = buildSingleGroupRegister('C', [1]);
  const liveView = buildSingleGroupLiveView('C', {
    owed: 3,
    glanceCount: 3,
    headerCount: 3,
    rowIds: ['C1', 'C2', 'C3'],
  });
  for (const unavailable of [null, undefined, 'not a register at all — no headings here']) {
    const errors = checkLiveView(workingRegister, liveView, {
      direction: 'extraOnly',
      baselineText: unavailable,
    });
    assert.notDeepEqual(
      errors,
      [],
      `baselineText=${JSON.stringify(unavailable)} must not silently pass`,
    );
    assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /cannot verify/i);
    // #2199 review round 3 (B2): pins that the CLI's `cannotVerify` sniff
    // (identity against this same exported constant, not a message-prose
    // prefix match) actually matches what checkLiveView returns.
    assert.equal(errors[0], CANNOT_VERIFY_BASELINE_ERROR);
  }
});

// #2199 review round 3 (A2): a PARTIALLY parseable baseline used to fail
// OPEN. The old `resolveBaselineGroups` only rejected a baseline for two
// narrow reasons (an unterminated fence, or no "## At a glance" section at
// all) — every OTHER kind of internal inconsistency (a glance-table row
// with no matching body section, a count mismatch, a contiguity gap, ...)
// fell through as a "resolved" baseline with an empty or incomplete
// `bodyGroups` for the broken group, which then made every live-page row in
// that group read as "discharged" (nothing in the baseline to contradict
// it). These pin the fix: `resolveBaselineGroups` now runs `checkRegister`
// over the baseline and rejects it outright if that reports ANYTHING.
test('#2199 review (A2): a baseline with a valid glance-table row but NO matching body section fails closed, not open', () => {
  // The reviewer's exact repro shape: working register A1-A3, live page
  // A1-A4, baseline glance table says "A: 3" (a plausible, non-obviously-
  // broken number) but has no "## Group A" body section at all. The old
  // code returned `{ tableLetters: {A}, bodyGroups: {} }` here — a
  // non-null, "resolved" result — so A4 read as discharged and the check
  // returned zero errors. The correct verdict is "BEHIND by A4".
  const workingRegister = buildSingleGroupRegister('A', [1, 2, 3]);
  const liveView = buildSingleGroupLiveView('A', {
    owed: 4,
    glanceCount: 4,
    headerCount: 4,
    rowIds: ['A1', 'A2', 'A3', 'A4'],
  });
  const partiallyParseableBaseline = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 3 |

**3 owed.** Oldest: **2026-01-01**.

---
`;
  // Fixture sanity: confirm this baseline really is the "falls through the
  // old narrow test" shape — it HAS "## At a glance" and no unterminated
  // fence, so the pre-A2 code would have treated it as resolved.
  assert.ok(partiallyParseableBaseline.includes('## At a glance'));
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: partiallyParseableBaseline,
  });
  assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
  assert.equal(errors[0], CANNOT_VERIFY_BASELINE_ERROR);
});

test('#2199 review (A2): a baseline with an internal count mismatch (glance vs. body) also fails closed', () => {
  // A different flavour of "partially parseable" than the missing-section
  // case above — the glance table and body both exist and both have SOME
  // content for Group A, but they disagree with each other (checkRegister's
  // own check 1). Still must not read as a usable, trustworthy baseline.
  const workingRegister = buildSingleGroupRegister('A', [1, 2]);
  const liveView = buildSingleGroupLiveView('A', {
    owed: 3,
    glanceCount: 3,
    headerCount: 3,
    rowIds: ['A1', 'A2', 'A3'],
  });
  const inconsistentBaseline = `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | Setup A | 5 |

**5 owed.** Oldest: **2026-01-01**.

---

## Group A — setup a

### A1 · thing 1

Body text.

### A2 · thing 2

Body text.

---
`;
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: inconsistentBaseline,
  });
  assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
  assert.equal(errors[0], CANNOT_VERIFY_BASELINE_ERROR);
});

// The default `direction: 'both'` tracked-pair comparison must not change
// behaviour just because a `baselineText` happens to be passed alongside it
// — it is scoped to `extraOnly` only.
test("#2199: passing baselineText has no effect on the default direction:'both' comparison", () => {
  const withBaseline = checkLiveView(
    buildRegister(),
    buildLiveView({ rowsA: ['A1', 'A2', 'A3'] }),
    {
      baselineText: 'irrelevant and, deliberately, not even a parseable register',
    },
  );
  const withoutBaseline = checkLiveView(
    buildRegister(),
    buildLiveView({ rowsA: ['A1', 'A2', 'A3'] }),
  );
  assert.deepEqual(withBaseline, withoutBaseline);
  assert.ok(
    withBaseline.some((e) => e.startsWith("Live view's Group A section has row A3")),
    `expected the ordinary 'both'-mode extra-row error to still fire, got: ${JSON.stringify(withBaseline)}`,
  );
});

// ---------------------------------------------------------------------------
// #2272: `options.dischargingIds` — the narrower gap #2199's baseline cannot
// close on its own. The baseline can only recognise a discharge that has
// ALREADY merged to origin/main; `--against-published` runs BEFORE merge,
// from the shipping branch, so origin/main still has the row at that moment
// and the baseline (correctly, per its own contract) calls it genuinely
// BEHIND. `dischargingIds` is the operator's explicit assertion that a named
// row was deliberately discharged by the change about to publish — it
// suppresses exactly the rows named, and only those.
// ---------------------------------------------------------------------------

// The register discharged BOTH A3 and A4 (only A1/A2 remain); origin/main's
// baseline hasn't merged that discharge yet, so it still has all four; the
// live page (fetched before the publish that will fix it) still shows all
// four too. Naming both suppresses both — the run must pass.
test('#2272: --discharging suppresses exactly the named live-only rows and the run passes', () => {
  const workingRegister = buildSingleGroupRegister('A', [1, 2]);
  const baselineRegister = buildSingleGroupRegister('A', [1, 2, 3, 4]);
  const liveView = buildSingleGroupLiveView('A', {
    owed: 4,
    glanceCount: 4,
    headerCount: 4,
    rowIds: ['A1', 'A2', 'A3', 'A4'],
  });
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    dischargingIds: ['A3', 'A4'],
  });
  assert.deepEqual(errors, []);
});

// Same fixture, but only A3 is named. A4 must still fail — and still name
// A4 specifically — whether it was simply forgotten or is a genuine
// competing-lane row: this is the A44 regression (2026-08-11) that #2199
// exists to keep failing, and #2272 must not trade it away.
test('#2272: an unnamed live-only row in the same run still fails, naming its own ID', () => {
  const workingRegister = buildSingleGroupRegister('A', [1, 2]);
  const baselineRegister = buildSingleGroupRegister('A', [1, 2, 3, 4]);
  const liveView = buildSingleGroupLiveView('A', {
    owed: 4,
    glanceCount: 4,
    headerCount: 4,
    rowIds: ['A1', 'A2', 'A3', 'A4'],
  });
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    dischargingIds: ['A3'],
  });
  assert.ok(
    errors.some((e) => e.includes('BEHIND what is already published') && e.includes('A4')),
    `expected a stale-row error naming A4, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('A3')),
    `A3 was named via --discharging and must not appear in any error, got: ${JSON.stringify(errors)}`,
  );
});

// Naming an ID that is NOT live-only — here, a row present in the register,
// the baseline, AND the live page, i.e. fully in sync — must be a loud
// error, not a silent no-op. Without this, a typo (or a name copied from
// the wrong discharge) would pass silently and the flag would degenerate
// into a blanket mute.
test('#2272: naming an ID that is not live-only is an error, not a silent no-op', () => {
  const workingRegister = buildSingleGroupRegister('A', [1, 2]);
  const baselineRegister = buildSingleGroupRegister('A', [1, 2]);
  const liveView = buildSingleGroupLiveView('A', {
    owed: 2,
    glanceCount: 2,
    headerCount: 2,
    rowIds: ['A1', 'A2'],
  });
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    dischargingIds: ['A1'],
  });
  assert.equal(errors.length, 1, `expected exactly one error, got: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /never accounts for a live-only row/);
  assert.match(errors[0], /A1/);
});

// `dischargingIds` has no effect outside 'extraOnly' — the flag is scoped to
// the pre-publish comparison it was built for, mirroring baselineText's own
// direction:'both' no-op test above.
test("#2272: dischargingIds has no effect on the default direction:'both' comparison", () => {
  const withDischarging = checkLiveView(
    buildRegister(),
    buildLiveView({ rowsA: ['A1', 'A2', 'A3'] }),
    { dischargingIds: ['A3'] },
  );
  const withoutDischarging = checkLiveView(
    buildRegister(),
    buildLiveView({ rowsA: ['A1', 'A2', 'A3'] }),
  );
  assert.deepEqual(withDischarging, withoutDischarging);
  assert.ok(
    withDischarging.some((e) => e.startsWith("Live view's Group A section has row A3")),
    `expected the ordinary 'both'-mode extra-row error to still fire, got: ${JSON.stringify(withDischarging)}`,
  );
});

// ---------------------------------------------------------------------------
// #2599/A41: per-row content hashing for `--against-published`. A row can
// keep the same ID and the same per-group count while its own BODY TEXT
// silently regresses on the published page (PR #2578 review rounds 13-18 —
// caught only by manual byte-diffing, because nothing mechanical compared
// row content). Design decision: dudarenok-maker/Castwright#2599 comment
// 5484697345 — hash each row's body, keyed by ID, comparing only IDs present
// on BOTH sides.
//
// This compares the TRACKED local live view (`options.trackedLiveViewHtml`)
// against the PUBLISHED snapshot (`checkLiveView`'s second argument) — NOT
// the register. The register and its HTML twin are deliberately different
// documents that only have to agree on structure, not row wording — hashing
// the real committed register against the real committed live view produces
// a mismatch for nearly every row even in a healthy state (this was checked
// against this repo's own files while building this check, and is why the
// end-to-end CLI tests further down, which read both real files, would
// otherwise turn permanently red). The tracked live view and a snapshot of
// what's actually live, by contrast, ARE supposed to carry the same row
// content whenever nothing has changed — see `parseLiveViewRowBodies`'s own
// header for the fuller account.
//
// A row ID tracked-only (edited locally, not yet published) is tolerated —
// the normal pre-publish state. A row ID published-only is untouched by
// this check (existing discharge handling decides it).
// ---------------------------------------------------------------------------

// A controllable set of `<details class="item">` / `<div class="body">` rows
// for one glance-table group — real live-view row markup, since that is the
// one shape `parseLiveViewRowBodies` reads (mirrors the tracked
// live-view.html and every real `--against-published` snapshot;
// `buildLiveView`/`buildSingleGroupLiveView` above deliberately skip it,
// which is also why none of the tests using them exercise this check at
// all).
function buildRowContentLiveView(rows, letter = 'A') {
  const detailsBlocks = rows
    .map(
      ({ id, body, risk, title }) => `    <details class="item">
      <summary><span class="num">${id}</span><span class="iname">${title ?? 't'}</span><span class="risk">${risk ?? 'default'}</span></summary>
      <div class="body">
        <p>${body}</p>
      </div>
    </details>`,
    )
    .join('\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${rows.length}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#g${letter.toLowerCase()}">${letter}</a></td><td>Setup ${letter}</td><td>${rows.length}</td></tr>
    </tbody>
  </table>

  <section class="group" id="g${letter.toLowerCase()}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">${rows.length} rows</span></h3>
${detailsBlocks}
  </section>
`;
}

test('#2599: identical row body content (tracked vs published) passes, no content-drift error', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: 'Shared content, unchanged.' },
  ]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: 'Shared content, unchanged.' },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
  });
  assert.deepEqual(errors, []);
});

// Mutation-provable: same ID, same per-group count (both sides have exactly
// one row, A1) — only the row's own body text differs between the tracked
// copy and the published copy. This is the exact A41 regression shape the
// whole-page diff this replaces could never catch. With the baseline
// available, this represents a genuine drift: tracked has new content not
// in the baseline, published matches the baseline. The fix disambiguates
// using the baseline live-view HTML.
test('#2599: a row whose ID and count match but body content differs is caught, naming the row', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Genuine A41-style drift: tracked matches baseline (already merged to
  // origin/main), but published still carries the old, stale content — the
  // live page was never updated to match.
  const baselineLiveView = buildRowContentLiveView([
    { id: 'A1', body: 'Tracked local content, different from published.' },
  ]);
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: 'Tracked local content, different from published.' },
  ]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: 'Original content.' },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
    baselineLiveViewText: baselineLiveView,
  });
  assert.deepEqual(errors, [`${ROW_CONTENT_DRIFT_ERROR_PREFIX}A1: content differs between local and published`]);
});

test('#2599: a row present only in the tracked live view (not yet published) is tolerated, not reported as content drift', () => {
  const workingRegister = buildMultiGroupRegister([{ letter: 'A', rowNumbers: [1, 2] }]);
  const baselineRegister = buildMultiGroupRegister([{ letter: 'A', rowNumbers: [1, 2] }]);
  // A2 is new, about to be published for the first time — the published
  // copy only has A1. It has no published-side body to compare against at
  // all.
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: 'Body text.' },
    { id: 'A2', body: 'New row, not yet published.' },
  ]);
  const publishedLiveView = buildRowContentLiveView([{ id: 'A1', body: 'Body text.' }]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
  });
  assert.ok(
    !errors.some((e) => e.includes('content differs')),
    `a tracked-only row must not be reported as content drift, got: ${JSON.stringify(errors)}`,
  );
});

// `trackedLiveViewHtml` is opt-in: a caller that never passes it (as none of
// the OTHER extraOnly tests in this file do) gets no content-drift checking
// at all, rather than an error about a missing argument — most direct
// `checkLiveView` callers have no tracked copy to compare and nothing this
// sub-check needs from them.
test('#2599: omitting trackedLiveViewHtml skips the content-drift check entirely', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: 'Whatever this says is irrelevant here.' },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
  });
  assert.deepEqual(errors, []);
});

// #2599/A41: Content-hashing baseline disambiguation tests. A row's content
// may differ between tracked and published for two reasons: (1) a legitimate
// local edit not yet merged to origin/main (pending publish), or (2) a genuine
// revert/hand-edit on the live page. The baseline (origin/main's copy)
// disambiguates: if published matches the baseline while tracked differs, the
// edit is a local pending-publish, not drift.
test('#2599: a legitimate pending-publish edit (published matches baseline) does not fail', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Baseline and published both have the SAME OLD content (main hasn't changed).
  // Tracked has the NEW content (local edit not yet on origin/main). This is
  // a legitimate pending-publish state — published matches baseline, tracked is ahead.
  const oldContent = 'Old content from origin/main.';
  const newContent = 'New local edit, not yet on origin/main.';
  const baselineLiveView = buildRowContentLiveView([
    { id: 'A1', body: oldContent },
  ]);
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: newContent },
  ]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: oldContent },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
    baselineLiveViewText: baselineLiveView,
  });
  assert.deepEqual(
    errors,
    [],
    `a legitimate pending-publish edit should not fail, got: ${JSON.stringify(errors)}`,
  );
});

// Genuine drift (A41): a fix was merged to origin/main, but the live page was
// independently reverted to stale content. Tracked matches baseline (fix on main),
// published differs from both (live was reverted). This is drift and must be flagged.
test('#2599: a genuine revert (published differs from baseline/tracked) fails', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Baseline and tracked both have the FIXED content (already on origin/main).
  // Published has the OLD content (the live page was reverted/hand-edited).
  // This is genuine A41-style drift.
  const fixedContent = 'Fixed content, merged to origin/main.';
  const oldContent = 'Old content, published was reverted.';
  const baselineLiveView = buildRowContentLiveView([
    { id: 'A1', body: fixedContent },
  ]);
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: fixedContent },
  ]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: oldContent },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
    baselineLiveViewText: baselineLiveView,
  });
  assert.deepEqual(
    errors,
    [`${ROW_CONTENT_DRIFT_ERROR_PREFIX}A1: content differs between local and published`],
    `a genuine revert should fail, got: ${JSON.stringify(errors)}`,
  );
});

// Baseline not available — fail closed, skip the content-hashing check.
test('#2599: missing baseline live-view skips content-hashing, does not fail', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Tracked and published differ, but no baseline is available.
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: 'Edited content.' },
  ]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: 'Original content.' },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
    baselineLiveViewText: null, // No baseline
  });
  assert.deepEqual(
    errors,
    [],
    `missing baseline should skip content-hashing, not fail, got: ${JSON.stringify(errors)}`,
  );
});

// #2599/A41: the summary element (title/risk badge) is now included in the
// content hash, so a stale risk badge is caught as drift, same as a changed
// body paragraph. Regression test for Finding 3: ensure a row with unchanged
// body but different risk badge between tracked and published (with matching
// baseline) is caught as genuine drift.
test('#2599: a row whose body is unchanged but risk badge differs is caught as content drift', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // All three have the same body content, but the summary/risk badge differs.
  // Genuine drift: tracked matches baseline (already merged — 'current' is
  // the correct, already-committed badge), but published still shows the
  // stale badge that was never updated on the live page.
  const sharedBody = 'Shared body content.';
  const baselineLiveView = buildRowContentLiveView([
    { id: 'A1', body: sharedBody, risk: 'current' },
  ]);
  const trackedLiveViewHtml = buildRowContentLiveView([
    { id: 'A1', body: sharedBody, risk: 'current' },
  ]);
  const publishedLiveView = buildRowContentLiveView([
    { id: 'A1', body: sharedBody, risk: 'stale-badge' },
  ]);
  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
    baselineLiveViewText: baselineLiveView,
  });
  assert.deepEqual(
    errors,
    [`${ROW_CONTENT_DRIFT_ERROR_PREFIX}A1: content differs between local and published`],
    `a stale risk badge should be caught as content drift, got: ${JSON.stringify(errors)}`,
  );
});

// ---------------------------------------------------------------------------
// #2272 review finding 1: a discharge that removes a group's LAST row makes
// the whole group vanish from the working register (not just one row within
// a group the register still has) — a shape the per-row `extra`/`staleExtra`
// logic above never sees, because it only runs for letters `mdBodyGroups`
// still has. This is live today: Group F has exactly one row in the real
// register, so discharging it removes the whole group. Builds a register
// with more than one group so a whole-group discharge can be modelled
// without disturbing the group that survives.
// ---------------------------------------------------------------------------

// A register/baseline pair spanning MULTIPLE groups — buildSingleGroupRegister
// only ever produces one group, which can't model "the register still has
// Group A but has lost Group F entirely".
function buildMultiGroupRegister(groups) {
  const glanceRows = groups
    .map(({ letter, rowNumbers }) => `| **${letter}** | Setup ${letter} | ${rowNumbers.length} |`)
    .join('\n');
  const total = groups.reduce((sum, g) => sum + g.rowNumbers.length, 0);
  const bodySections = groups
    .map(({ letter, rowNumbers }) => {
      const body = rowNumbers
        .map((n) => `### ${letter}${n} · thing ${n}\n\nBody text.\n`)
        .join('\n');
      return `## Group ${letter} — setup ${letter.toLowerCase()}\n\n<!-- next-id: ${letter}101 -->\n\n${body}---\n`;
    })
    .join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${glanceRows}

**${total} owed.** Oldest: **2026-01-01**.

---

${bodySections}`;
}

function buildMultiGroupLiveView(owed, groups) {
  const glanceRows = groups
    .map(({ letter, glanceCount }) => {
      const lower = letter.toLowerCase();
      return `      <tr><td><a href="#g${lower}">${letter}</a></td><td>Setup ${letter}</td><td>${glanceCount}</td></tr>`;
    })
    .join('\n');
  const sections = groups
    .map(({ letter, headerCount, rowIds }) => {
      const lower = letter.toLowerCase();
      const rowSpans = rowIds
        .map(
          (id) =>
            `      <summary><span class="num">${id}</span><span class="iname">t</span></summary>`,
        )
        .join('\n');
      return `  <section class="group" id="g${lower}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">${headerCount} rows</span></h3>
${rowSpans}
  </section>`;
    })
    .join('\n\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${owed}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
${glanceRows}
    </tbody>
  </table>

${sections}
`;
}

// Group F had exactly one row (F1); this change discharges it, so Group F
// disappears from the working register entirely, while origin/main's
// baseline (not merged yet) and the live page (fetched before the publish
// that will fix it) both still show it. Naming F1 must suppress BOTH the
// glance-table and body-section whole-group BEHIND verdicts and let the run
// pass — before this fix, no invocation of --discharging produced green for
// a single-row group.
test('#2272 review finding 1: --discharging on a whole-group (single-row) discharge passes', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]); // Group F is entirely absent
  const baselineRegister = buildMultiGroupRegister([
    { letter: 'A', rowNumbers: [1] },
    { letter: 'F', rowNumbers: [1] },
  ]);
  const liveView = buildMultiGroupLiveView(2, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'F', glanceCount: 1, headerCount: 1, rowIds: ['F1'] },
  ]);
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    dischargingIds: ['F1'],
  });
  assert.deepEqual(errors, []);
});

// Group D had two rows (D1, D2), both discharged by this change — but only
// D1 is named. A partial name must NOT suppress the whole group: the run
// still fails, naming D2 (the leftover, unaccounted-for row) specifically —
// not just "add the group back" — and D1 must not appear in any error (it
// really was consumed) nor trigger the separate "not a live-only row" error.
test('#2272 review finding 1: a partially-named whole-group discharge still fails, naming only the leftover row', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]); // Group D is entirely absent
  const baselineRegister = buildMultiGroupRegister([
    { letter: 'A', rowNumbers: [1] },
    { letter: 'D', rowNumbers: [1, 2] },
  ]);
  const liveView = buildMultiGroupLiveView(3, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'D', glanceCount: 2, headerCount: 2, rowIds: ['D1', 'D2'] },
  ]);
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    dischargingIds: ['D1'],
  });
  assert.ok(
    errors.some(
      (e) =>
        e.includes('BEHIND what is already published') &&
        e.includes('D2') &&
        e.includes('not named via --discharging'),
    ),
    `expected a BEHIND error naming leftover D2, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('D1')),
    `D1 was named via --discharging and consumed — it must not appear in any error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('never accounts for a live-only row')),
    `D1 genuinely is live-only (for the partially-discharged Group D) and must not be reported as an unrecognised name, got: ${JSON.stringify(errors)}`,
  );
});

// A plain run with NO --discharging involvement for a vanished group must
// keep its ORIGINAL wording verbatim — the leftover-naming message is only
// for a PARTIAL --discharging match, not every whole-group BEHIND verdict.
test('#2272 review finding 1: a whole-group BEHIND verdict with no --discharging keeps its original wording', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildMultiGroupRegister([
    { letter: 'A', rowNumbers: [1] },
    { letter: 'F', rowNumbers: [1] },
  ]);
  const liveView = buildMultiGroupLiveView(2, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'F', glanceCount: 1, headerCount: 1, rowIds: ['F1'] },
  ]);
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
  });
  assert.ok(
    errors.some((e) => e.endsWith('Add the group to the register before publishing.')),
    `expected the original glance-table wording, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some((e) => e.endsWith('Add the section before publishing.')),
    `expected the original body-section wording, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('not named via --discharging')),
    `no --discharging was passed at all — the leftover-naming wording must not appear, got: ${JSON.stringify(errors)}`,
  );
});

// ---------------------------------------------------------------------------
// #2199 review round 2: `resolveBaselineText` — the CLI layer's git surface.
//
// A first version of the fix read the LOCAL `origin/main` ref as-is, with no
// fetch — which trusts a ref that only moves on `git fetch`/`pull`. An
// operator whose local checkout predates a merge on `main` would see that
// merge's row as absent from BOTH their working register and their stale
// local baseline, which the discharge filter then wrongly read as "already
// discharged" and let through — a false negative on the exact #1931 shape
// `--against-published` exists to catch. The fix: `resolveBaselineText`
// fetches FRESH before reading, and fails closed (not open) if the fetch
// itself fails.
//
// These tests inject a fake `gitRunner` rather than touching real git or the
// network, so they're fast and hermetic — they pin the ORCHESTRATION
// (fetch always precedes show; a fetch failure short-circuits before show
// ever runs; both failure shapes are correctly labelled) independent of
// whatever the real git binary or network happens to do. A separate CLI-level
// test further down proves the same fetch-failure shape end-to-end through a
// real (but deliberately unreachable) `git fetch`.
// ---------------------------------------------------------------------------

test('resolveBaselineTexts: fetch, then rev-parse FETCH_HEAD, then show <sha> for both files, in that order, on success', () => {
  const calls = [];
  const fakeRunner = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '', error: undefined };
    if (args[0] === 'rev-parse') {
      return { status: 0, stdout: 'deadbeefcafe\n', stderr: '', error: undefined };
    }
    if (args[0] === 'show') {
      // Return different content for the register vs live-view file
      if (args[1].includes('onbox-acceptance-register.md')) {
        return { status: 0, stdout: 'FAKE REGISTER TEXT', stderr: '', error: undefined };
      } else if (args[1].includes('onbox-acceptance-register-live-view.html')) {
        return { status: 0, stdout: 'FAKE LIVEVIEW TEXT', stderr: '', error: undefined };
      }
      return { status: 0, stdout: 'FAKE TEXT', stderr: '', error: undefined };
    }
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  const result = resolveBaselineTexts(
    '/fake/repo',
    'docs/testing/onbox-acceptance-register.md',
    'docs/testing/onbox-acceptance-register-live-view.html',
    fakeRunner,
  );
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['fetch', 'rev-parse', 'show', 'show'],
    'expected fetch, then rev-parse, then show (register), then show (live-view), in that order',
  );
  assert.deepEqual(calls[0].args, ['fetch', 'origin', 'main']);
  assert.deepEqual(calls[1].args, ['rev-parse', 'FETCH_HEAD']);
  // #2199 review round 5 (optional hardening): reads the SHA `rev-parse`
  // resolved, not the symbolic name `FETCH_HEAD` — freezing it immediately
  // after the fetch narrows the window for a concurrent same-worktree fetch
  // to move FETCH_HEAD out from under this read.
  assert.deepEqual(calls[2].args, [
    'show',
    'deadbeefcafe:docs/testing/onbox-acceptance-register.md',
  ]);
  assert.deepEqual(calls[3].args, [
    'show',
    'deadbeefcafe:docs/testing/onbox-acceptance-register-live-view.html',
  ]);
  assert.equal(calls[0].cwd, '/fake/repo');
  assert.equal(calls[1].cwd, '/fake/repo');
  assert.equal(calls[2].cwd, '/fake/repo');
  assert.equal(calls[3].cwd, '/fake/repo');
  assert.deepEqual(result, {
    registerText: 'FAKE REGISTER TEXT',
    liveViewText: 'FAKE LIVEVIEW TEXT',
    failedStep: null,
    fetchedSha: 'deadbeefcafe',
  });
});

test('resolveBaselineTexts: whitespace/newline around the rev-parsed SHA is trimmed before the show calls', () => {
  // Real `git rev-parse` output ends with a trailing newline — asserting
  // this explicitly pins that the SHA is trimmed, not concatenated as-is
  // (which would produce an invalid `<sha>\n:<path>` show argument).
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: '  abc123  \n', stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: 'TEXT', stderr: '' };
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  resolveBaselineTexts('/fake/repo', 'reg.md', 'live.html', fakeRunner);
  // Both show calls (register and liveview) should use the trimmed SHA
  assert.deepEqual(calls[2], ['show', 'abc123:reg.md']);
  assert.deepEqual(calls[3], ['show', 'abc123:live.html']);
});

// #2199 review round 3 (A1): `git fetch origin main` only GUARANTEES it
// writes `FETCH_HEAD` — updating `refs/remotes/origin/main` is an
// opportunistic side effect that depends on `remote.origin.fetch`'s
// refspec mapping `refs/heads/main` at all. A narrowed refspec makes the
// fetch exit 0 while `origin/main` silently stays stale, reopening the
// exact staleness hole round 2 closed, through a different door. This test
// pins the chosen fix (read `FETCH_HEAD`, never `origin/main:<path>`) by
// asserting on the LITERAL show args — a regression back to `origin/main:`
// would pass every other test in this file (they never touch the real,
// possibly-narrowly-configured origin) but must fail this one.
test("resolveBaselineTexts: never references origin/main directly at any step, so a narrowed remote refspec can't serve a stale ref (A1)", () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'cafef00d\n', stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: 'FRESH', stderr: '' };
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  const result = resolveBaselineTexts('/fake/repo', 'reg.md', 'live.html', fakeRunner);
  assert.deepEqual(calls[1], ['rev-parse', 'FETCH_HEAD']);
  assert.deepEqual(calls[2], ['show', 'cafef00d:reg.md']);
  assert.deepEqual(calls[3], ['show', 'cafef00d:live.html']);
  for (const call of calls) {
    assert.ok(
      !call.some((arg) => typeof arg === 'string' && arg.includes('origin/main')),
      `no git call may ever reference origin/main directly, got: ${JSON.stringify(call)}`,
    );
  }
  assert.equal(result.registerText, 'FRESH');
  assert.equal(result.liveViewText, 'FRESH');
});

test('resolveBaselineTexts: a failing fetch (non-zero exit) short-circuits before show ever runs', () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 1, stdout: '', stderr: 'fake fetch failure' };
    return { status: 0, stdout: 'should never be reached', stderr: '' };
  };
  const result = resolveBaselineTexts('/fake/repo', 'reg.md', 'live.html', fakeRunner);
  assert.deepEqual(result, { registerText: null, liveViewText: null, failedStep: 'fetch' });
  assert.deepEqual(calls, ['fetch'], 'show must not run after a failed fetch');
});

test('resolveBaselineTexts: a spawn error on fetch (e.g. git missing, or a timeout) is also a fetch failure', () => {
  // Node's spawnSync sets `result.error` (not just a non-zero `status`) both
  // when the executable can't be spawned at all (ENOENT) and when its own
  // `timeout` option fires — this fixture models either, since the
  // production code treats them identically.
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') {
      return { status: null, error: new Error('spawnSync git ETIMEDOUT'), stdout: '', stderr: '' };
    }
    return { status: 0, stdout: 'should never be reached', stderr: '' };
  };
  const result = resolveBaselineTexts('/fake/repo', 'reg.md', 'live.html', fakeRunner);
  assert.deepEqual(result, { registerText: null, liveViewText: null, failedStep: 'fetch' });
  assert.deepEqual(calls, ['fetch']);
});

test('resolveBaselineTexts: a failing show (after a successful fetch + rev-parse) is reported as a show failure, not a fetch failure', () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'cafef00d\n', stderr: '' };
    if (args[0] === 'show') return { status: 128, stdout: '', stderr: 'fake show failure' };
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  const result = resolveBaselineTexts('/fake/repo', 'reg.md', 'live.html', fakeRunner);
  assert.deepEqual(result, { registerText: null, liveViewText: null, failedStep: 'show' });
  // Both register and liveview show calls are attempted, so we see up to 4 calls total
  assert.ok(
    calls.includes('show'),
    'show must run after a successful fetch + rev-parse',
  );
});

test('resolveBaselineTexts: a failing rev-parse (after a successful fetch) is also reported as a "show" failure, and the show never runs', () => {
  // #2199 review round 5 (optional hardening): rev-parse and show are folded
  // into the same failedStep, deliberately — see resolveBaselineTexts's own
  // comment for why. This pins that folding, and that a rev-parse failure
  // still short-circuits before an invalid `undefined:<path>` show is ever
  // attempted.
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') {
      return { status: 128, stdout: '', stderr: 'fake rev-parse failure' };
    }
    return { status: 0, stdout: 'should never be reached', stderr: '' };
  };
  const result = resolveBaselineTexts('/fake/repo', 'reg.md', 'live.html', fakeRunner);
  assert.deepEqual(result, { registerText: null, liveViewText: null, failedStep: 'show' });
  assert.deepEqual(calls, ['fetch', 'rev-parse'], 'show must not run after a failed rev-parse');
});

// #2199 review round 3 (B3): on a `failedStep === 'show'` failure, the CLI
// layer prints a specific line saying the fetch ALREADY succeeded — so the
// generic `checkLiveView` "cannot verify" message (which fires alongside it,
// unconditionally, for every cannot-verify cause) must never itself tell the
// operator to "run git fetch", or the two lines contradict each other in the
// same output (one says the fetch just worked; the other says to run it).
// A real end-to-end CLI test for the `show`-only-fails shape would need a
// git repo with a fetchable ref that lacks the target file at that ref — not
// something constructible deterministically without a scratch repo — so
// this pins the fix at its source: the shared constant's own text.
test('#2199 review (B3): the generic cannot-verify message does not prescribe git fetch (would contradict a show-only failure)', () => {
  assert.doesNotMatch(
    CANNOT_VERIFY_BASELINE_ERROR,
    /git fetch/i,
    'the generic message must not tell the operator to run git fetch — that reads as a ' +
      'live contradiction when the actual failure was `git show`, which only runs AFTER ' +
      'a fetch that already succeeded',
  );
});

// ---------------------------------------------------------------------------
// `--against-published <file>` — #1931's "re-read immediately before
// publishing" step, mechanised (2036 review round 2 / R3 amendment). CI has
// no credentials to fetch the published artifact, so this mode takes a
// LOCALLY SAVED COPY of the page fetched by hand right before a publish and
// diffs it against the register with the exact same `checkLiveView` used for
// the tracked live-view file — these tests spawn the real CLI (not the
// imported functions) so the argument parsing and file-reading are actually
// exercised, not just the comparator underneath them.
//
// The real, committed `docs/testing/onbox-acceptance-register.md` is what
// the CLI's REGISTER path always reads (it is not overridable), so these
// tests start from a copy of the real, currently-committed live view —
// known-agreeing with the real register at the time these tests run — and
// mutate the copy, never the checked-in files.
//
// #2199 review round 3 (A4/A5): most of these tests use
// `ONBOX_TEST_BASELINE_FILE` (see that env var's own comment in
// `scripts/check-onbox-register.mjs`) to supply a KNOWN, hermetic baseline
// instead of letting the CLI run a real `git fetch`/`git show` against
// whatever `origin/main` happens to contain at test-run time. Two defects
// that shape used to cause, both fixed by using this seam:
//   - **A5**: a real `git fetch` makes these tests (and therefore
//     `test:hooks`, wired into pre-commit/pre-push via `verify:fast:scoped`/
//     `verify:fast:branch`) require network access, so any commit touching
//     the on-box register could no longer be made offline.
//   - **A4**: a test whose expected verdict depends on live `origin/main`
//     content is itself a latent bug — a fixture computed as "one past
//     Group B's highest row, so it's surely not on origin/main yet" breaks
//     the moment ANY lane merges a new Group B row while this branch is
//     open, including the exact discharge-and-renumber workflow #2199
//     exists to unblock.
// The one deliberate exception is the real-git-fetch-FAILURE test further
// down, which does NOT use this override — a live `git fetch` failing is
// the entire point there, and it's engineered (via an unreachable proxy) to
// fail deterministically rather than depending on ambient network state.
// Deliberately raw, unlike REAL_REGISTER_TEXT immediately below: every
// live-view parser in check-onbox-register.mjs is `[\s\S]*?`/`[^<]*` plus a
// trim, so a `\r` cannot move any of them (measured on CRLF input: byte-
// identical results). Raw here is a decision, not an oversight.
const REAL_LIVE_VIEW_HTML = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');
// readNormalized, not a bare readFileSync: buildAheadBaselineText below scans
// this text for literal '\n---\n' / '\n## ' delimiters, which miss on a
// CRLF checkout (#2291) — see scripts/lib/read-normalized.mjs.
const REAL_REGISTER_TEXT = readNormalized(REAL_REGISTER_PATH);

function withTempCopy(html, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'onbox-published-'));
  const filePath = join(dir, 'published.html');
  writeFileSync(filePath, html, 'utf8');
  try {
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Writes BOTH the published-page HTML and a baseline register text to their
// own files in one temp dir, for tests that inject a hermetic baseline via
// `ONBOX_TEST_BASELINE_FILE` rather than letting the CLI fetch a real one.
function withHermeticBaseline(publishedHtml, baselineText, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'onbox-hermetic-'));
  const publishedPath = join(dir, 'published.html');
  const baselinePath = join(dir, 'baseline.md');
  writeFileSync(publishedPath, publishedHtml, 'utf8');
  writeFileSync(baselinePath, baselineText, 'utf8');
  try {
    return fn(publishedPath, baselinePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, envOverrides) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
    windowsHide: true,
  });
}

// Forces the real `git fetch origin main` inside `resolveBaselineText` to
// fail deterministically, for the two real-git-binary tests further down
// that need a genuine (not gitRunner-injected) fetch failure. The original
// mechanism here was `HTTPS_PROXY`/`https_proxy` pointed at an unreachable
// port — that only forces a failure when `origin` is an http(s) remote: an
// agent running this suite from a fresh clone whose `origin` was a local
// filesystem path saw 2 failures, because a proxy env var has no effect on
// a non-HTTP transport and the fetch just succeeded against the local path.
// `GIT_ALLOW_PROTOCOL` is git's own transport allowlist (see
// git-remote-ext(1)/gitremote-helpers(1)): a value that names no real
// transport rejects whatever transport `origin` actually uses — https, ssh,
// a bare local path, anything — with no network I/O and no assumption about
// `origin`'s URL scheme at all. Also faster (git refuses before attempting
// any connection at all, instead of waiting out a refused TCP connect).
const FORCE_GIT_FETCH_FAILURE_ENV = {
  GIT_ALLOW_PROTOCOL: 'no-transport-named-this-for-hermetic-test',
};

// The highest row number Group `letter` has in `registerText`, computed from
// the register's OWN `### <Letter><N>` body headings — the authoritative
// source, not the live view — so a fixture built from it is correct by
// construction regardless of whether the live view happens to be in sync.
function computeMaxRowNumber(registerText, letter) {
  const numbers = [...registerText.matchAll(new RegExp(`^### ${letter}(\\d+)\\b`, 'gm'))].map((m) =>
    Number(m[1]),
  );
  assert.ok(
    numbers.length > 0,
    `fixture setup: Group ${letter} must have at least one row in the register`,
  );
  const max = Math.max(...numbers);
  // Callers use `max + 1` as "an ID that does not exist yet", inserting it
  // as a synthetic row via buildAheadBaselineText for the "ahead baseline"
  // fixtures. That helper now bumps ITS OWN copy's next-id marker past the
  // row it inserts (see its own comment), so the result stays
  // checkRegister-consistent regardless of how much headroom THIS
  // (unmutated) register text's next-id currently has — headroom here is no
  // longer a precondition for correctness. Only the marker's presence is
  // still required, for callers that read it directly.
  const nextId = parseNextIdMarker(registerText, letter);
  assert.ok(
    nextId !== null,
    `fixture setup: Group ${letter} must have a "<!-- next-id: ${letter}N -->" marker`,
  );
  return max;
}

// Renames one live-view row span from `<letter><oldNumber>` to
// `<letter><newNumber>` — used to synthesise "the live page has a row this
// register doesn't" without depending on any row ID that doesn't already
// exist in the fixture.
function renameLiveViewRowId(liveViewHtml, letter, oldNumber, newNumber) {
  const oldId = `${letter}${oldNumber}`;
  const newId = `${letter}${newNumber}`;
  const mutated = liveViewHtml.replace(
    `<span class="num">${oldId}</span>`,
    `<span class="num">${newId}</span>`,
  );
  assert.notEqual(
    mutated,
    liveViewHtml,
    `fixture setup: the ${oldId} row ID must have matched in the live view`,
  );
  return { newId, mutated };
}

// Builds a baseline register text that is `registerText` PLUS one extra,
// contiguous, internally-consistent row for Group `letter` — models "another
// lane already merged this row into origin/main". Bumps the glance-table
// count, the stated total, AND appends a matching body heading, all three in
// lockstep, so the result passes `checkRegister` (required since #2199
// review round 3's A2 fix rejects a baseline `checkRegister` finds
// inconsistent) — an earlier draft of this helper that only added the body
// heading produced a baseline `checkRegister` correctly refused, which
// would have made the test below assert "cannot verify" instead of the
// intended "genuinely behind" verdict.
function buildAheadBaselineText(registerText, letter, newRowNumber, title) {
  const glanceRegex = new RegExp(`(\\| \\*\\*${letter}\\*\\* \\| [^|]+ \\| )(\\d+)( \\|)`);
  assert.ok(
    glanceRegex.test(registerText),
    `fixture setup: the glance-table row for Group ${letter} must be found`,
  );
  let text = registerText.replace(
    glanceRegex,
    (_, pre, count, post) => `${pre}${Number(count) + 1}${post}`,
  );

  const totalRegex = /\*\*(\d+) owed\.\*\*/;
  assert.ok(totalRegex.test(text), 'fixture setup: the owed total must be found');
  text = text.replace(totalRegex, (_, total) => `**${Number(total) + 1} owed.**`);

  const groupHeadingIdx = text.indexOf(`## Group ${letter} `);
  assert.notEqual(
    groupHeadingIdx,
    -1,
    `fixture setup: the "## Group ${letter} " heading must be found`,
  );
  const nextHeadingIdx = text.indexOf('\n## ', groupHeadingIdx + 1);
  const sectionEnd = nextHeadingIdx === -1 ? text.length : nextHeadingIdx;
  const section = text.slice(groupHeadingIdx, sectionEnd);
  const lastDividerIdx = section.lastIndexOf('\n---\n');
  assert.notEqual(
    lastDividerIdx,
    -1,
    `fixture setup: Group ${letter}'s closing "---" divider must be found`,
  );
  const insertion = `\n### ${letter}${newRowNumber} · ${title}\n\nBody text (test fixture).\n`;
  const mutatedSection =
    section.slice(0, lastDividerIdx) + insertion + section.slice(lastDividerIdx);
  let result = text.slice(0, groupHeadingIdx) + mutatedSection + text.slice(sectionEnd);

  // The synthetic row above models "another lane already merged this row" —
  // a real merge like that always bumps the group's own next-id marker past
  // the newly-minted row too, or the merged register would immediately trip
  // 4b's own "row at or above next-id" check. Bump it here so this baseline
  // stays checkRegister-consistent regardless of how much headroom the real
  // register's next-id marker happens to have right now — it can be zero,
  // e.g. immediately after a row was minted at the exact allocation floor
  // (reproduced: Group B's real next-id sat exactly at max+1 once B101 was
  // minted at the prior floor, which is correct allocation, not a bug).
  //
  // ANCHORED, same as check-onbox-register.mjs's own parseNextIdMarker (line
  // ~227) — an unanchored pattern matches the how-to prose's own inline-code
  // example marker (e.g. "`<!-- next-id: A101 -->`" in this file's header
  // comment) before it ever reaches a group's real marker, for whichever
  // letter that example happens to use. Reproduced for letter 'A'.
  const nextIdRegex = new RegExp(`^(<!--\\s*next-id:\\s*${letter})(\\d+)(\\s*-->\\s*\\r?)$`, 'm');
  assert.ok(
    nextIdRegex.test(result),
    `fixture setup: the "<!-- next-id: ${letter}N -->" marker must be found`,
  );
  result = result.replace(nextIdRegex, (_, pre, n, post) => {
    const bumped = Math.max(Number(n), newRowNumber + 1);
    return `${pre}${bumped}${post}`;
  });

  return result;
}

// #1931 review round 3: the FIRST version of this mode reported checkLiveView's
// default, symmetric comparison — `missing` (register has, live page doesn't)
// AND `extra` (live page has, register doesn't). `missing` is the NORMAL,
// INTENDED pre-publish state: you are publishing precisely because the
// register you are about to publish has rows the live page does not yet
// have. Reporting it inverted the diagnosis (told the operator their OWN
// tracked file was stale) and prescribed a destructive remedy ("update the
// live view's summary strip" == delete the rows you were about to publish).
// Only `extra` is real evidence of staleness — a fixture built by
// DECREMENTING the published owed total models the benign lagging-page case
// and must PASS, not fail; a fixture built by adding a row on the published
// page that the register lacks is the one that must fail. Both are covered
// below, plus a positive stdout signal on both the passing paths (`OK — …`)
// so a broken `invokedAsCli` detection — the same symlink/junction hazard
// #2036 review round 2 found in run-golden-audio.mjs — cannot hide behind an
// assertion that only checks the exit code (a prior version of these tests
// did exactly that, and stayed green with the entire CLI block deleted).

test('--against-published exits 0, with the OK signal, when the saved copy agrees with the real register', () => {
  // #2199 review round 3 (A5): hermetic — injects the REAL register's own
  // text as the baseline via ONBOX_TEST_BASELINE_FILE, so this needs no
  // network and no dependency on live origin/main content.
  withHermeticBaseline(REAL_LIVE_VIEW_HTML, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(
      r.stdout,
      /check:onbox-register: OK/,
      'a genuine pass must print something distinguishing it from the CLI block never ' +
        `having run at all. stdout was: ${JSON.stringify(r.stdout)}`,
    );
  });
});

// PR #2798 review round 1/2: checkLiveView strips HTML comments as its first
// act (stripHtmlComments, called before any parsing), so it is structurally
// blind to whether a <!-- BEGIN/END GENERATED:... --> marker pair is present,
// well-formed, or wraps the right value — a dropped or stale marker leaves
// every existing check green. This PR's own two merge-conflict resolutions
// hand-edited these exact marker/value pairs; nothing else in the suite would
// have caught a mismatch. Cross-checks the live-view's embedded marker values
// against the register's own "## At a glance" table and owed-total prose —
// an independent computation, not a re-read of the same numbers.
test('the live-view GENERATED markers exist, are well-formed, and match the register\'s own figures', () => {
  const glanceTableRowRe = /\|\s*\*\*([A-Z])\*\*\s*\|[^|]*\|\s*(\d+)\s*\|/g;
  const expectedByGroup = new Map();
  for (const m of REAL_REGISTER_TEXT.matchAll(glanceTableRowRe)) {
    expectedByGroup.set(m[1], Number(m[2]));
  }
  assert.ok(expectedByGroup.size > 0, 'expected to parse at least one glance-table row from the real register');

  const ownedMatch = REAL_REGISTER_TEXT.match(/\*\*(\d+) owed\.\*\*/);
  assert.ok(ownedMatch, 'expected an "**N owed.**" prose line in the real register');
  const expectedOwed = Number(ownedMatch[1]);

  for (const [letter, expectedCount] of expectedByGroup) {
    const markerRe = new RegExp(
      `<!-- BEGIN GENERATED:glance:${letter} -->(\\d+)<!-- END GENERATED:glance:${letter} -->`,
    );
    const found = REAL_LIVE_VIEW_HTML.match(markerRe);
    assert.ok(found, `expected exactly one well-formed glance:${letter} marker pair in the live-view HTML`);
    assert.equal(
      Number(found[1]),
      expectedCount,
      `glance:${letter} marker says ${found[1]}, the register's own glance table says ${expectedCount}`,
    );
  }

  const stripMatch = REAL_LIVE_VIEW_HTML.match(
    /<!-- BEGIN GENERATED:strip -->[\s\S]*?<div class="n owed">(\d+)<\/div>[\s\S]*?<!-- END GENERATED:strip -->/,
  );
  assert.ok(stripMatch, 'expected a well-formed BEGIN/END GENERATED:strip pair wrapping the owed stat');
  assert.equal(
    Number(stripMatch[1]),
    expectedOwed,
    `strip marker's owed figure is ${stripMatch[1]}, the register's own "**N owed.**" prose says ${expectedOwed}`,
  );
});

// #2199 review round 4: the ONBOX_TEST_BASELINE_FILE seam (A4/A5) was itself
// a silent bypass of the guard — a green run with it set was byte-for-byte
// indistinguishable in the output from a genuine pass. Reachable danger: set
// in a shell profile, a CI job, or copied into a real invocation by a future
// agent, and `--against-published` silently becomes decorative. These pin
// the fix (an unconditional stderr WARNING) on BOTH the success and failure
// paths — the reviewer's own framing was "the green is the dangerous case; a
// failure already stops the operator", so the success-path assertion is the
// one that matters most.
test('--against-published prints an unmistakable WARNING when ONBOX_TEST_BASELINE_FILE is set — success path', () => {
  withHermeticBaseline(REAL_LIVE_VIEW_HTML, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(r.status, 0, `expected exit 0 (this is the success-path case), got ${r.status}`);
    // Plain substring checks, not a regex over the path — a Windows path
    // contains backslashes that are regex metacharacters in some positions
    // and would need escaping; `includes` sidesteps that entirely.
    assert.ok(
      r.stderr.includes('WARNING: baseline injected from ONBOX_TEST_BASELINE_FILE='),
      `expected the warning prefix, got stderr: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes(baselinePath),
      `expected the warning to name the override path (${baselinePath}), got stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /must never be used to gate a publish/,
      `expected the warning to say the seam must never gate a publish, got stderr: ${r.stderr}`,
    );
  });
});

test('--against-published prints an unmistakable WARNING when ONBOX_TEST_BASELINE_FILE is set — failure path', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const newRowNumber = lastB + 1;
  const { mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, newRowNumber);
  const aheadBaseline = buildAheadBaselineText(
    REAL_REGISTER_TEXT,
    'B',
    newRowNumber,
    'synthetic ahead row (fixture, warning test)',
  );
  withHermeticBaseline(mutated, aheadBaseline, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(r.status, 1, `expected exit 1 (this is the failure-path case), got ${r.status}`);
    assert.match(
      r.stderr,
      /WARNING: baseline injected from ONBOX_TEST_BASELINE_FILE=/,
      `expected the warning even on a failing run, got stderr: ${r.stderr}`,
    );
  });
});

// #2199 review round 5 (nit 1): an unreadable ONBOX_TEST_BASELINE_FILE used
// to set `failedStep: 'show'`, so the CLI claimed "`git show FETCH_HEAD:...`
// failed even though the preceding `git fetch origin main` just succeeded"
// when NO git ran at all — this is the TEST-ONLY seam, unset means real git
// never gets invoked. Pins the fix: its own honest label, naming the
// override path and explicitly saying no git call ran.
test('--against-published gives an unreadable ONBOX_TEST_BASELINE_FILE its own honest failure message, not a fabricated git-show failure', () => {
  withTempCopy(REAL_LIVE_VIEW_HTML, (filePath) => {
    const missingBaselinePath = filePath + '.does-not-exist-as-a-baseline';
    const r = runCli(['--against-published', filePath], {
      ONBOX_TEST_BASELINE_FILE: missingBaselinePath,
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stdout: ${r.stdout}`);
    // The WARNING still fires (the override IS set, even though unreadable).
    assert.match(r.stderr, /WARNING: baseline injected from ONBOX_TEST_BASELINE_FILE=/);
    assert.ok(
      r.stderr.includes(`Could not read ONBOX_TEST_BASELINE_FILE=${missingBaselinePath}`),
      `expected an honest "could not read" message naming the override path, got stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /no `git fetch` or `git show` ran/,
      `expected the message to say no git ran, got stderr: ${r.stderr}`,
    );
    // The fabricated-failure shape this replaces: claiming `git show`
    // failed when git was never invoked at all.
    assert.doesNotMatch(
      r.stderr,
      /\u0060git show FETCH_HEAD:/,
      'must not claim git show failed when the override path was simply unreadable',
    );
  });
});

test('--against-published does NOT print the ONBOX_TEST_BASELINE_FILE warning on a normal run (override unset)', () => {
  // Reuses the real-fetch-failure fixture below rather than a fresh one: it
  // already exercises the baseline-resolution code path (with the override
  // deliberately UNSET) all the way through a real, failing `git fetch` —
  // proving the warning's absence here isn't just because this run never
  // reached that code.
  withTempCopy(REAL_LIVE_VIEW_HTML, (filePath) => {
    const r = runCli(['--against-published', filePath], FORCE_GIT_FETCH_FAILURE_ENV);
    assert.doesNotMatch(
      r.stderr,
      /ONBOX_TEST_BASELINE_FILE/,
      `the warning must never appear when the override is unset, got stderr: ${r.stderr}`,
    );
    // #2199 review round 5 (nit 4): the comment above CLAIMS this run reaches
    // the baseline-resolution block via a real, failing fetch — but nothing
    // asserted that. Without this, the test would pass vacuously if a future
    // change made the CLI exit BEFORE that block for any reason (a changed
    // arg-parsing order, an early return, ...), since an absent warning is
    // indistinguishable from "never got far enough to print it".
    assert.match(
      r.stderr,
      /`git fetch origin main` failed/,
      `expected proof this run actually reached the baseline-resolution block (a real, ` +
        `failing fetch), not just that the warning happens to be absent — got stderr: ${r.stderr}`,
    );
  });
});

test('--against-published exits 0 when the saved copy LAGS the register (the normal pre-publish state)', () => {
  // The register is about to gain rows the published page does not have yet
  // — that is the entire reason a publish is happening. Modelled here by
  // decrementing the published owed total, exactly the shape review round 3
  // found being (wrongly) treated as a failure. Hermetic per A5, same as
  // above.
  const lagging = REAL_LIVE_VIEW_HTML.replace(
    /<div class="n owed">(\d+)<\/div>/,
    (_, n) => `<div class="n owed">${Number(n) - 4}</div>`,
  );
  assert.notEqual(
    lagging,
    REAL_LIVE_VIEW_HTML,
    'fixture setup: the owed-total span must have matched',
  );
  withHermeticBaseline(lagging, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(
      r.status,
      0,
      `a register that is AHEAD of the published page must not block publishing; got ` +
        `status=${r.status}, stdout=${r.stdout}, stderr=${r.stderr}`,
    );
  });
});

// #2199 review round 3 (A4): the previous version of this test derived its
// "definitely not on origin/main yet" row ID from the live view's CURRENT
// highest Group B row and asserted exit 0 — which only held while
// origin/main's Group B genuinely had no row at that number. It went red on
// exactly the workflow #2199 exists to unblock (a branch discharging the
// last Group B row, or any lane merging a new Group B row while this branch
// was open). Hermetic now: `newId` is computed from — and the injected
// baseline literally IS — this checkout's own register text, so "the
// baseline lacks `newId`" is true by construction (the highest existing row
// number, by definition, isn't itself present as one-past-itself), not by
// assumption about live git state.
test('--against-published exits 0 when a live-page row is absent from BOTH the register and its (hermetic) baseline (a discharge, #2199)', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      // #3529: a discharge is a row the page's own MERGED publish carried.
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'merged',
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0 (row ${newId} absent from both), got ${r.status}. stdout: ${r.stdout}, ` +
        `stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /check:onbox-register: OK/);
  });
});

// #3529: the same shape on a page an UNMERGED lane published — that lane's
// row, not a discharge — must fail, via its own bucket and remedy.
test('--against-published exits 1 for a live-only row on a page an unmerged lane published (#3529)', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged',
    });
    assert.equal(r.status, 1, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes(`unmerged-lane-row: ${newId}:`), r.stderr);
    assert.match(
      r.stderr,
      /WARNING: published-page provenance injected from ONBOX_TEST_PUBLISHED_PROVENANCE=unmerged/,
    );
    assert.ok(r.stderr.includes('--publishing'), 'names the union path');
    assert.ok(!r.stderr.includes('Merge the rows named above'), 'must not get the BEHIND remedy');
  });
});

// #3529 (review pass 1, 🟡2): the collision class reaches its OWN bucket and
// remedy through the CLI, never the BEHIND "merge the rows" remedy. Two lanes
// each minted the next Group B ID with different titles.
test('--against-published routes a row-ID collision to its own bucket and remedy (#3529)', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  const retitle = (html, title) =>
    html.replace(
      new RegExp(`(<span class="num">${newId}</span>\\s*<span class="iname">)[\\s\\S]*?(</span>)`),
      `$1${title}$2`,
    );
  const tracked = retitle(mutated, 'Mine, a row this lane minted');
  const published = retitle(mutated, 'Theirs, a row another lane minted');
  assert.notEqual(tracked, mutated, 'fixture setup: the iname must have matched');
  withHermeticBaseline(published, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const trackedPath = join(dirname(publishedPath), 'tracked.html');
    writeFileSync(trackedPath, tracked, 'utf8');
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_TRACKED_LIVEVIEW_FILE: trackedPath,
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'merged',
    });
    assert.equal(r.status, 1, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes(`row-id-collision: ${newId}:`), r.stderr);
    assert.ok(r.stderr.includes('Renumber your row as each error above says'), r.stderr);
    assert.ok(!r.stderr.includes('Merge the rows named above'), 'must not get the BEHIND remedy');
    assert.ok(!/BEHIND what is already live/.test(r.stderr), 'must not be reported in the BEHIND bucket');
  });
});

// #3529 (review pass 1, 🟠 no green path): `--publishing <file>` is the
// union path — the file about to be published carries the other lane's row.
test('--against-published --publishing a union file goes green; without it the same run fails (#3529)', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  // The union: the tracked page (row lastB) PLUS the other lane's row
  // (lastB + 1), its block copied verbatim from the live page, with the
  // derived figures regenerated (review pass 2, 🟠3 — a hand-built union
  // whose figures were not is refused; see the pass-2 tests).
  const union = onbox.buildUnionLiveView(REAL_LIVE_VIEW_HTML, mutated, [newId]);
  assert.notEqual(union, REAL_LIVE_VIEW_HTML, 'fixture setup: the union must differ');
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const unionPath = join(dirname(publishedPath), 'union.html');
    writeFileSync(unionPath, union, 'utf8');
    const env = { ONBOX_TEST_BASELINE_FILE: baselinePath, ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged' };
    const without = runCli(['--against-published', publishedPath], env);
    assert.equal(without.status, 1, without.stderr);
    const withUnion = runCli(['--against-published', publishedPath, '--publishing', unionPath], env);
    assert.equal(withUnion.status, 0, `stdout: ${withUnion.stdout}, stderr: ${withUnion.stderr}`);
    assert.match(withUnion.stdout, /check:onbox-register: OK/);
  });
});

// #3529: the other two new classes reach their own buckets too, never the
// BEHIND "merge the rows" remedy.
test('--against-published routes unknown-provenance and publishing-file errors to their own buckets (#3529)', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const unknown = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'unknown',
    });
    assert.equal(unknown.status, 1, unknown.stderr);
    assert.match(unknown.stderr, /could not be established:\s+- unknown-provenance: /);
    assert.ok(unknown.stderr.includes(newId), unknown.stderr);
    assert.ok(!/BEHIND what is already live/.test(unknown.stderr), unknown.stderr);

    // A union whose copy of the other lane's row was edited.
    const block = mutated.match(
      new RegExp(`<details\\b[^>]*class="item"[^>]*>\\s*<summary><span class="num">${newId}</span>[\\s\\S]*?</details>`),
    )[0];
    const edited = mutated.replace(block, block.replace('<div class="body">', '<div class="body"><p>edited</p>'));
    assert.notEqual(edited, mutated, 'fixture setup: the body must have matched');
    const unionPath = join(dirname(publishedPath), 'union.html');
    writeFileSync(unionPath, edited, 'utf8');
    const differs = runCli(['--against-published', publishedPath, '--publishing', unionPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged',
    });
    assert.equal(differs.status, 1, differs.stderr);
    assert.match(differs.stderr, /does not carry the live page\u0027s rows verbatim:\s+- publishing-file: /);
    assert.ok(!/BEHIND what is already live/.test(differs.stderr), differs.stderr);
  });
});

test('--publishing without --against-published is refused (#3529)', () => {
  const r = runCli(['--publishing', 'x.html']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--publishing only makes sense alongside --against-published/);
});

// #2199 review round 3 (A6): the test this replaced (the pre-#2199 "AHEAD"
// test) was the ONLY CLI-level coverage of the genuine "register is BEHIND"
// branch, and it was deleted rather than converted when #2199 rewrote the
// discharge test above — leaving that branch with zero CLI coverage.
// Restored here using the same hermetic seam as A4/A5: the injected baseline
// genuinely HAS the extra row (built via `buildAheadBaselineText`, which
// keeps it `checkRegister`-consistent per the A2 fix), so this models a real
// competing-lane publish rather than a discharge — the live page and the
// baseline agree that `newId` exists; only this checkout's own register
// doesn't have it yet.
test('--against-published exits 1 and shows the register is BEHIND when the (hermetic) baseline still has the row', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const newRowNumber = lastB + 1;
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, newRowNumber);
  const aheadBaseline = buildAheadBaselineText(
    REAL_REGISTER_TEXT,
    'B',
    newRowNumber,
    'synthetic ahead row (fixture, A6)',
  );
  withHermeticBaseline(mutated, aheadBaseline, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1 (row ${newId} still owed per the baseline), got ${r.status}. ` +
        `stdout: ${r.stdout}, stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /shows the register is BEHIND what is already live/,
      `expected the BEHIND label, got stderr: ${r.stderr}`,
    );
    assert.match(r.stderr, new RegExp(`Group B section has row ${newId}`));
    assert.match(
      r.stderr,
      /Do not publish\. Merge the rows named above/,
      'a failing --against-published run must tell the operator to merge the LIVE rows ' +
        'in, not to edit the tracked file down to match the stale page',
    );
    // The inverted-diagnosis shape #1931 review round 3 fixed: a "missing"
    // message must never appear, because "register has a row the page
    // doesn't" is not a failure in this mode.
    assert.doesNotMatch(r.stderr, /is missing row/);
  });
});

// #2199 review round 2: end-to-end proof (real CLI process, real `git`
// binary) that a genuinely failing `git fetch origin main` fails closed —
// not just the injected-runner unit tests above, which pin the
// orchestration but stub git out entirely. See
// `FORCE_GIT_FETCH_FAILURE_ENV`'s own comment for why this forces the
// failure via `GIT_ALLOW_PROTOCOL` rather than an unreachable proxy: the
// proxy trick only works when `origin` is an http(s) remote, and this test
// must fail closed regardless of what transport `origin` actually uses.
// Scoped to this one child process's environment only — touches no repo
// git config, remotes, or tracked state.
test('--against-published fails closed with a NON-ZERO exit when `git fetch origin main` itself fails, and the message names the fetch', () => {
  withTempCopy(REAL_LIVE_VIEW_HTML, (filePath) => {
    const r = runCli(['--against-published', filePath], FORCE_GIT_FETCH_FAILURE_ENV);
    assert.equal(
      r.status,
      1,
      `a failed git fetch must not pass — expected exit 1, got ${r.status}. ` +
        `stdout: ${r.stdout}, stderr: ${r.stderr}`,
    );
    assert.match(
      r.stderr,
      /`git fetch origin main` failed/,
      `expected the message to name the fetch as what failed, got stderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /[Cc]annot verify/);
    assert.doesNotMatch(
      r.stdout,
      /check:onbox-register: OK/,
      'a failed fetch must not read as a pass',
    );
    // #2199 review round 3 (B2): pins that the CLI's `cannotVerify` label and
    // remedy actually fire for a real (not just injected-runner-simulated)
    // failure — the label is "could not be checked" / "Do not publish until
    // this passes.", NOT the genuine-behind framing ("shows the register is
    // BEHIND" / "Merge the rows named above"), which would misdirect the
    // operator (there are no rows to merge; the check couldn't run at all).
    assert.match(
      r.stderr,
      /could not be checked/,
      `expected the cannot-verify-specific label, got stderr: ${r.stderr}`,
    );
    assert.match(r.stderr, /Do not publish until this passes\./);
    // #2199 review round 5 (nit 2): this sentence used to print TWICE on the
    // cannot-verify path — once as part of the CANNOT_VERIFY_BASELINE_ERROR
    // text `report()` prints, once more as a redundant follow-up line.
    // `.match(...g)` with a global regex returns every match, so its length
    // is the occurrence count.
    const occurrences = (r.stderr.match(/Do not publish until this passes\./g) ?? []).length;
    assert.equal(
      occurrences,
      1,
      `expected "Do not publish until this passes." exactly once, got ${occurrences} in: ${r.stderr}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /Merge the rows named above/,
      'the cannot-verify case has no rows to name, so the genuine-BEHIND remedy must not print',
    );
  });
});

test('--against-published exits 1 with a usage message when no file path is given', () => {
  const r = runCli(['--against-published']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a file path/);
});

test('--against-published exits 1 with "Not found" when the given file does not exist', () => {
  withTempCopy('unused', (filePath) => {
    const missingPath = filePath + '.does-not-exist';
    const r = runCli(['--against-published', missingPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Not found:/);
  });
});

// ---------------------------------------------------------------------------
// #2272: `--discharging <id>[,<id>...]` at the CLI layer. The unit tests
// above pin the semantics inside `checkLiveView`; these spawn the real
// process (like the rest of the --against-published CLI tests above) to
// prove the real argv parsing and threading (CLI -> checkLiveView) actually
// wire up, not just that the option works when passed directly.
// ---------------------------------------------------------------------------

test('--discharging without --against-published fails loudly rather than being silently ignored', () => {
  const r = runCli(['--discharging', 'E10']);
  assert.equal(
    r.status,
    1,
    `expected exit 1, got ${r.status}. stdout: ${r.stdout}, stderr: ${r.stderr}`,
  );
  assert.match(r.stderr, /--discharging only makes sense alongside --against-published/);
});

test('--discharging with no value fails with a usage message', () => {
  const r = runCli(['--against-published', 'unused.html', '--discharging']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--discharging requires a value/);
});

// #2280 review (nit 5): a bare `--discharging` (no value AND no
// --against-published) must report the more useful "only makes sense
// alongside --against-published" reason, not "requires a value" — the flag
// is unusable either way, but naming --against-published's absence first is
// what actually explains why. Order-dependent: before the fix the
// missing-value check ran first and always won this case.
test('a bare --discharging with neither a value nor --against-published reports the --against-published reason, not "requires a value"', () => {
  const r = runCli(['--discharging']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--discharging only makes sense alongside --against-published/);
  assert.doesNotMatch(r.stderr, /--discharging requires a value/);
});

// End-to-end proof that the CLI actually threads --discharging's argv value
// into checkLiveView's `dischargingIds` option. Same fixture shape as the
// "genuinely BEHIND" test above (A6): a live-page row absent from this
// register, present in the (hermetic) baseline — but here it's named via
// --discharging, so the run must now pass instead of failing.
test('--discharging names the row genuinely absent from this register and the run passes, real argv end to end', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const newRowNumber = lastB + 1;
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, newRowNumber);
  const aheadBaseline = buildAheadBaselineText(
    REAL_REGISTER_TEXT,
    'B',
    newRowNumber,
    'synthetic ahead row (fixture, #2272)',
  );
  withHermeticBaseline(mutated, aheadBaseline, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath, '--discharging', newId], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(
      r.status,
      0,
      `expected exit 0 (row ${newId} named via --discharging), got ${r.status}. ` +
        `stdout: ${r.stdout}, stderr: ${r.stderr}`,
    );
    assert.match(r.stdout, /check:onbox-register: OK/);
  });
});

// #2272 review finding 2: an unconsumed --discharging name used to be
// wrapped in the "register is BEHIND" banner, whose remedy ("Merge the rows
// named above — already live, not yet in this register") is false for a
// name like an already-registered row, and would tell an operator (or an
// agent) to add a duplicate. This proves the CLI now reports it under its
// OWN label, with its OWN remedy, and never prints the BEHIND remedy at all.
// Names the register's own first row heading — genuinely present
// everywhere, so definitely not live-only.
test('#2272 review finding 2: naming an ID that is not live-only is reported under its own label, not the BEHIND banner', () => {
  const existingIdMatch = REAL_REGISTER_TEXT.match(/^### ([A-Z]\d+)\b/m);
  assert.ok(
    existingIdMatch,
    'fixture setup: the real register must have at least one row heading',
  );
  const existingId = existingIdMatch[1];
  withHermeticBaseline(REAL_LIVE_VIEW_HTML, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath, '--discharging', existingId], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}. stdout: ${r.stdout}, stderr: ${r.stderr}`,
    );
    assert.match(r.stderr, new RegExp(`--discharging named ${existingId}`));
    assert.match(
      r.stderr,
      /Fix the --discharging value/,
      'expected the bad-name-specific remedy, not the BEHIND one',
    );
    assert.doesNotMatch(
      r.stderr,
      /Merge the rows named above/,
      `a bad --discharging name has no rows to merge — the BEHIND remedy must not print, got: ${r.stderr}`,
    );
    assert.doesNotMatch(
      r.stderr,
      /shows the register is BEHIND what is already live/,
      `an unrecognised --discharging name is not evidence the register is behind, got: ${r.stderr}`,
    );
  });
});

// #2272 review (mixed-case regression): the branch interaction between
// `dischargeNameErrors` and `behindErrors` in the CLI layer — one invocation
// producing BOTH an unconsumed --discharging name AND a genuine
// competing-lane BEHIND row. This must never blend into one report: each
// class gets its own banner and its own remedy, in its own block, and
// neither remedy leaks onto the other's list. Combines the A6-style
// genuinely-BEHIND fixture (a real, hermetic-baseline BEHIND row, not named)
// with a bad --discharging name (the register's own first row heading — it's
// present everywhere, so it can never be live-only) in the SAME run.
test('#2272 review: an unconsumed --discharging name AND a genuine BEHIND row in one run both surface, each under its own banner and remedy', () => {
  const existingIdMatch = REAL_REGISTER_TEXT.match(/^### ([A-Z]\d+)\b/m);
  assert.ok(
    existingIdMatch,
    'fixture setup: the real register must have at least one row heading',
  );
  const badDischargeName = existingIdMatch[1];

  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const newRowNumber = lastB + 1;
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, newRowNumber);
  assert.notEqual(
    badDischargeName,
    newId,
    'fixture setup: the bad name and the genuinely-BEHIND row must be distinct IDs',
  );
  const aheadBaseline = buildAheadBaselineText(
    REAL_REGISTER_TEXT,
    'B',
    newRowNumber,
    'synthetic ahead row (fixture, #2272 mixed-case regression)',
  );
  withHermeticBaseline(mutated, aheadBaseline, (publishedPath, baselinePath) => {
    const r = runCli(['--against-published', publishedPath, '--discharging', badDischargeName], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}. stdout: ${r.stdout}, stderr: ${r.stderr}`,
    );
    // Both banners, and both remedies, must be present.
    assert.match(r.stderr, /does not account for any live-only row/);
    assert.match(r.stderr, /shows the register is BEHIND what is already live/);
    assert.match(r.stderr, /Fix the --discharging value\(s\) named above/);
    assert.match(r.stderr, /Do not publish\. Merge the rows named above/);
    // Ordering pins that each remedy sits with its OWN list, never blended:
    // the discharge-name block (label + remedy) prints entirely before the
    // BEHIND block (label + remedy) starts.
    const dischargeLabelIdx = r.stderr.indexOf('does not account for any live-only row');
    const dischargeRemedyIdx = r.stderr.indexOf('Fix the --discharging value(s) named above');
    const behindLabelIdx = r.stderr.indexOf('shows the register is BEHIND what is already live');
    const behindRemedyIdx = r.stderr.indexOf('Do not publish. Merge the rows named above');
    assert.ok(
      [dischargeLabelIdx, dischargeRemedyIdx, behindLabelIdx, behindRemedyIdx].every(
        (i) => i !== -1,
      ),
      `expected all four markers present, got stderr: ${r.stderr}`,
    );
    assert.ok(
      dischargeLabelIdx < dischargeRemedyIdx &&
        dischargeRemedyIdx < behindLabelIdx &&
        behindLabelIdx < behindRemedyIdx,
      `expected the discharge-name block (label+remedy) entirely before the BEHIND block ` +
        `(label+remedy), got stderr: ${r.stderr}`,
    );
    // Each ID is named only inside its OWN block — the bad name never leaks
    // into the BEHIND list, and the genuinely-BEHIND row never leaks into
    // the discharge-name list.
    assert.ok(
      r.stderr.indexOf(badDischargeName) < behindLabelIdx,
      `the bad --discharging name (${badDischargeName}) must be named before the BEHIND ` +
        `banner starts, got stderr: ${r.stderr}`,
    );
    assert.ok(
      r.stderr.indexOf(newId) > dischargeRemedyIdx,
      `the genuinely-BEHIND row (${newId}) must be named after the discharge-name remedy, ` +
        `got stderr: ${r.stderr}`,
    );
  });
});

// #2272 review (nit 2): a repeated --discharging flag used to silently keep
// only the FIRST occurrence (process.argv.indexOf finds only one match) —
// `--discharging A1 --discharging A2` parsed as just A1, with A2 dropped
// with no warning. Now rejected outright.
test('#2272 review (nit 2): a repeated --discharging flag is rejected, not silently narrowed to the first occurrence', () => {
  const r = runCli([
    '--against-published',
    'unused.html',
    '--discharging',
    'A1',
    '--discharging',
    'A2',
  ]);
  assert.equal(
    r.status,
    1,
    `expected exit 1, got ${r.status}. stdout: ${r.stdout}, stderr: ${r.stderr}`,
  );
  assert.match(r.stderr, /passed more than once/);
});

// #2272 review (nit 3): a value like ",,," survives the "requires a value"
// check (the raw argv string is non-empty) but filters down to an EMPTY
// array after splitting on commas — which used to proceed exactly as if
// --discharging had never been passed at all: flag accepted, did nothing,
// said nothing. Now rejected with its own usage message.
test('#2272 review (nit 3): --discharging ",,," has no usable ID after splitting and is rejected', () => {
  const r = runCli(['--against-published', 'unused.html', '--discharging', ',,,']);
  assert.equal(
    r.status,
    1,
    `expected exit 1, got ${r.status}. stdout: ${r.stdout}, stderr: ${r.stderr}`,
  );
  assert.match(r.stderr, /has no usable row ID/);
});

// Belt-and-suspenders on the CLI entry point itself: nothing else here spawns
// the real process, so a break in `invokedAsCli`'s own detection (the same
// symlink/junction hazard #2036 review round 2 found in run-golden-audio.mjs)
// would be invisible to every other test in this file, which only imports
// the pure functions. Asserts on the OK signal, not just the exit code —
// review round 3 found a status-only version of this exact test stayed
// green with the entire CLI block deleted (`invokedAsCli` mutated to a
// never-matching literal): a broken guard and a genuine pass both read as
// "exit 0, no output".
test('the CLI (no flags) exits 0, with the OK signal, against the real committed register + live view', () => {
  const r = runCli([]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  assert.match(
    r.stdout,
    /check:onbox-register: OK/,
    `a genuine pass must print something. stdout was: ${JSON.stringify(r.stdout)}`,
  );
});

// --- CodeQL #218/#219 paired tests: fixpoint sanitizers ----------------------
// The fixpoint loop is the standard CodeQL remediation for
// js/incomplete-multi-character-sanitization: it guarantees no residue
// survives by repeating until the string stops changing.
//
// Mutation-checked 2026-08-20 under #2529 against the old single-pass bodies
// (reconstructed from commit b8025ed7):
//  * stripHtmlComments — a genuine second-pass case EXISTS. Removing
//    `<!--x-->` from `<<!--x-->!--y-->` concatenates the surviving leading `<`
//    with `!--y-->` into a NEW complete `<!--y-->` that only a second pass can
//    remove: single-pass leaves `<!--y-->`, the fixpoint reduces it to ''. The
//    paired test below uses that input, so it FAILS on the old body and PASSES
//    on the fixpoint.
//  * htmlCellText — NO distinguishing input exists. `<[^>]*>` is already
//    complete in a single global pass: any surviving `<` has no following `>`
//    in the input, and removing tags can never manufacture a new `>` adjacent
//    to a surviving `<`, so a single pass equals the fixpoint for every input.
//    The test below is therefore kept as a plain sanitizer behaviour assertion
//    (no `<script` / `<` may reach compared cell text), NOT as proof the
//    fixpoint loop does extra work. The consequently-redundant htmlCellText
//    fixpoint loop is flagged in #2529 as a dismissal-residue candidate; it is
//    not acted on here.

test('stripHtmlComments: fixpoint removes a comment whose residue re-opens a new one (CodeQL #218)', () => {
  // `<<!--x-->!--y-->`: one pass removes `<!--x-->`, concatenating the
  // surviving leading `<` with `!--y-->` into a NEW complete `<!--y-->` that
  // only a second pass can remove. This input fails on the old single-pass
  // body (`<!--y-->` survives) and passes on the fixpoint.
  const result = stripHtmlComments('<<!--x-->!--y-->');
  assert.equal(result, '');
  assert.ok(!result.includes('<!--'), `no comment open should survive, got: ${result}`);
  assert.ok(!/<!--[\s\S]*?-->/.test(result), `no complete comment should survive, got: ${result}`);
});

test('stripHtmlComments: adjacent independent comments are all removed', () => {
  assert.equal(stripHtmlComments('a<!--x-->b<!--y-->c'), 'abc');
});

test('stripHtmlComments: empty comment is removed', () => {
  assert.equal(stripHtmlComments('before<!---->after'), 'beforeafter');
});

test('stripHtmlComments: simple comment is removed', () => {
  assert.equal(stripHtmlComments('before<!-- comment -->after'), 'beforeafter');
});

test('htmlCellText: no tag string or opening bracket reaches compared text (CodeQL #219)', () => {
  // Behavioural only, per the mutation check above: for `<[^>]*>` a single
  // global pass is already complete, so no input can discriminate single-pass
  // from fixpoint. This asserts the sanitizer invariant (no `<script` / no `<`
  // survives), not that the fixpoint loop adds anything.
  const result = htmlCellText('<<a>script>alert(1)');
  assert.ok(!result.includes('<script'), `no <script should survive, got: ${result}`);
  assert.ok(!result.includes('<'), `no opening tag char should survive, got: ${result}`);
});

test('htmlCellText: multiple independent tags are all stripped', () => {
  assert.equal(htmlCellText('<b>bold</b> and <i>italic</i>'), 'bold and italic');
});

test('htmlCellText: handles simple tags correctly', () => {
  assert.equal(htmlCellText('<span class="x">hello</span>'), 'hello');
});

test('htmlCellText: collapses whitespace after tag stripping', () => {
  assert.equal(htmlCellText('<b>  hello   world  </b>'), 'hello world');
});

// ---------------------------------------------------------------------------
// #2599/A41: parseLiveViewRowBodies extraction-failure handling. A silent skip
// when markup changes (e.g. <div class="body"> → <div class="body is-open">)
// turns the whole check into a vacuous pass over fewer rows. These errors must
// surface explicitly rather than silently dropping rows.
// ---------------------------------------------------------------------------

test('#2599/A41: missing row-ID marker is an extraction error, not a silent skip', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // A row block with no <span class="num"> — the ID cannot be extracted.
  const malformedLiveView = `<title>On-box acceptance register — Castwright</title>
  <div class="strip"><div class="n owed">1</div><div class="l">Owed</div></div>
  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#ga">A</a></td><td>Setup A</td><td>1</td></tr>
    </tbody>
  </table>
  <section class="group" id="ga">
    <h3 class="gtitle"><span class="gtag">A</span> Setup A <span class="gcount">1 rows</span></h3>
    <details class="item">
      <summary><!-- Missing <span class="num">A1</span> here --><span class="iname">t</span></summary>
      <div class="body"><p>Row content</p></div>
    </details>
  </section>`;
  const errors = checkLiveView(workingRegister, malformedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml: malformedLiveView,
  });
  assert.ok(
    errors.some((e) => e.startsWith(EXTRACTION_ERROR_PREFIX) && e.includes('could not extract row ID')),
    `expected an extraction error for missing row ID, got: ${JSON.stringify(errors)}`,
  );
});

test('#2599/A41: malformed body-div markup is an extraction error, not a silent skip', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // The <div class="body"> is changed to <div class="body is-open"> — the
  // closing tag regex no longer matches, so the body content cannot be extracted.
  const malformedLiveView = `<title>On-box acceptance register — Castwright</title>
  <div class="strip"><div class="n owed">1</div><div class="l">Owed</div></div>
  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#ga">A</a></td><td>Setup A</td><td>1</td></tr>
    </tbody>
  </table>
  <section class="group" id="ga">
    <h3 class="gtitle"><span class="gtag">A</span> Setup A <span class="gcount">1 rows</span></h3>
    <details class="item">
      <summary><span class="num">A1</span><span class="iname">t</span></summary>
      <div class="body is-open"><p>Row content changed by markup</p></div>
    </details>`;
  const errors = checkLiveView(workingRegister, malformedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml: malformedLiveView,
  });
  assert.ok(
    errors.some((e) => e.startsWith(EXTRACTION_ERROR_PREFIX) && e.includes('Row A1') && e.includes('could not extract body content')),
    `expected an extraction error for row A1 body, got: ${JSON.stringify(errors)}`,
  );
});

test('#2599/A41: when both tracked and published fail extraction, all errors surface', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Both copies have malformed markup — both should report errors.
  const malformedTracked = `<title>On-box acceptance register — Castwright</title>
  <div class="strip"><div class="n owed">1</div><div class="l">Owed</div></div>
  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#ga">A</a></td><td>Setup A</td><td>1</td></tr>
    </tbody>
  </table>
  <section class="group" id="ga">
    <h3 class="gtitle"><span class="gtag">A</span> Setup A <span class="gcount">1 rows</span></h3>
    <details class="item">
      <summary><span class="num">A1</span><span class="iname">t</span></summary>
      <div class="body broken"><p>Malformed tracked</p></div>
    </details>
  </section>`;
  const malformedPublished = `<title>On-box acceptance register — Castwright</title>
  <div class="strip"><div class="n owed">1</div><div class="l">Owed</div></div>
  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#ga">A</a></td><td>Setup A</td><td>1</td></tr>
    </tbody>
  </table>
  <section class="group" id="ga">
    <h3 class="gtitle"><span class="gtag">A</span> Setup A <span class="gcount">1 rows</span></h3>
    <details class="item">
      <summary><span class="num">A1</span><span class="iname">t</span></summary>
      <div class="body broken"><p>Malformed published</p></div>
    </details>
  </section>`;
  const errors = checkLiveView(workingRegister, malformedPublished, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml: malformedTracked,
  });
  // Should have extraction errors reported from both the tracked and published
  // parses (they both have malformed markup). Since both are malformed with the
  // same ID, we expect at least two errors (one from each parse).
  assert.ok(
    errors.length >= 2,
    `expected at least 2 extraction errors (one per malformed copy), got ${errors.length}: ${JSON.stringify(errors)}`,
  );
  // Most specifically, should have extraction errors for row A1 body.
  assert.ok(
    errors.some((e) => e.startsWith(EXTRACTION_ERROR_PREFIX) && e.includes('Row A1') && e.includes('could not extract body content')),
    `expected Row A1 body-extraction errors, got: ${JSON.stringify(errors)}`,
  );
});

// #2599 Finding A: Regression test for the content-drift failure banner naming the correct file.
// The banner should name the LIVE_VIEW file (what was actually diffed), not the REGISTER file.
test('--against-published: content-drift error banner names the live-view.html file, not the register', () => {
  const originalLiveView = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');
  // Genuine A41-style drift under the corrected model: tracked matches the
  // baseline (this edit is already merged to origin/main) while published
  // still carries the OLD, stale content — the live page never caught up.
  const modifiedLiveView = originalLiveView.replace(
    /<p>([^<]+)<\/p>/,
    '<p>Modified content for testing drift detection</p>',
  );
  // Hermetic test — use temp files for all three inputs, never the real
  // tracked repo file (see #2599 review round 2: writing to the real file
  // directly is unsafe and non-hermetic).
  const dir = mkdtempSync(join(tmpdir(), 'onbox-cli-test-'));
  try {
    const publishedPath = join(dir, 'published.html');
    const baselinePath = join(dir, 'baseline.md');
    const baselineLiveViewPath = join(dir, 'baseline-liveview.html');
    const trackedLiveViewPath = join(dir, 'tracked-liveview.html');
    writeFileSync(publishedPath, originalLiveView, 'utf8');
    writeFileSync(baselinePath, REAL_REGISTER_TEXT, 'utf8');
    writeFileSync(baselineLiveViewPath, modifiedLiveView, 'utf8');
    writeFileSync(trackedLiveViewPath, modifiedLiveView, 'utf8');

    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_BASELINE_LIVEVIEW_FILE: baselineLiveViewPath,
      ONBOX_TEST_TRACKED_LIVEVIEW_FILE: trackedLiveViewPath,
    });

    assert.equal(r.status, 1, `expected exit 1 for content drift, got ${r.status}. stderr: ${r.stderr}`);
    // The fix for Finding A: banner should say "differs from" the live-view HTML path
    assert.ok(
      r.stderr.includes('onbox-acceptance-register-live-view.html'),
      `expected banner to name the live-view.html file, got stderr: ${r.stderr}`,
    );
    // Verify it mentions content differs (for the drift case)
    assert.ok(
      r.stderr.includes('content differs') || r.stderr.includes('row-content-drift'),
      `expected error to mention content differs, got stderr: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2599 Finding B: Regression test for CLI-level wiring of trackedLiveViewHtml.
// This test verifies the CLI properly passes the tracked live view to the content-drift check.
// Mutation test: if the line passing trackedLiveViewHtml is commented out, this should fail.
test('--against-published: CLI correctly wires trackedLiveViewHtml into the content-drift check', () => {
  const originalContent = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');
  // Genuine A41-style drift: tracked matches baseline (already merged to
  // origin/main), but published still carries the old, stale content.
  const modifiedContent = originalContent.replace(
    /<p>([^<]+)<\/p>/,
    '<p>Test-modified content to trigger drift detection</p>',
  );
  const dir = mkdtempSync(join(tmpdir(), 'onbox-cli-test-'));
  try {
    const publishedPath = join(dir, 'published.html');
    const baselinePath = join(dir, 'baseline.md');
    const baselineLiveViewPath = join(dir, 'baseline-live.html');
    const trackedLiveViewPath = join(dir, 'tracked-live.html');
    writeFileSync(publishedPath, originalContent, 'utf8');
    writeFileSync(baselinePath, REAL_REGISTER_TEXT, 'utf8');
    writeFileSync(baselineLiveViewPath, modifiedContent, 'utf8');
    writeFileSync(trackedLiveViewPath, modifiedContent, 'utf8');

    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_BASELINE_LIVEVIEW_FILE: baselineLiveViewPath,
      ONBOX_TEST_TRACKED_LIVEVIEW_FILE: trackedLiveViewPath,
    });

    // tracked (modified) matches baseline (also modified) — genuine drift,
    // since published still carries the stale, original content. If
    // trackedLiveViewHtml were not actually wired into the check (the CLI
    // silently reading the real on-disk file instead of this override),
    // the real on-disk file would almost certainly not equal `modifiedContent`
    // byte-for-byte, changing the verdict — this asserts the specific,
    // non-vacuous outcome the wiring is responsible for.
    assert.equal(r.status, 1, `expected exit 1 for genuine content drift, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('row-content-drift'),
      `expected a row-content-drift error, got stderr: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2837 Finding 1: 3-way content disagreement (all three differ) is ordinary
// for multi-step publishes but hash-only comparison can't tell from genuine
// conflicts. Must report as advisory warning, not hard-block. Test that the
// warning is returned and is marked as such (not a hard drift error).
test('#2837: 3-way content disagreement (all three differ) returns warning, not error', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // All three have different content: the classic 34/61 multi-step scenario.
  // Baseline has v0, published has v0 (unchanged), tracked has v1 (first edit).
  // Then before merging, tracked changes to v2 (second edit). Now all three differ.
  const v0Content = 'Original baseline content (v0).';
  const v1Content = 'First edit (v1), published.';
  const v2Content = 'Second edit (v2), tracked local.';

  const baselineLiveView = buildRowContentLiveView([{ id: 'A1', body: v0Content }]);
  const publishedLiveView = buildRowContentLiveView([{ id: 'A1', body: v1Content }]);
  const trackedLiveViewHtml = buildRowContentLiveView([{ id: 'A1', body: v2Content }]);

  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
    trackedLiveViewHtml,
    baselineLiveViewText: baselineLiveView,
  });

  // Should contain a 3-way warning, not a drift error.
  assert.ok(
    errors.some((e) => e.startsWith(THREE_WAY_CONTENT_WARNING_PREFIX)),
    `expected a 3-way warning, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.startsWith(ROW_CONTENT_DRIFT_ERROR_PREFIX)),
    `should not have a drift error for 3-way case, got: ${JSON.stringify(errors)}`,
  );
});

// #2837 Finding 4: extraction errors must be tagged with their source so the
// CLI can attribute them correctly (tracked vs published vs baseline).
test('#2837: extraction errors from tracked copy are tagged [tracked]', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  // Tracked live view has malformed HTML (missing the body div's class attribute,
  // which parseLiveViewRowBodies requires to find it).
  const normalHtml = buildRowContentLiveView([{ id: 'A1', body: 'Normal content' }]);
  const corruptedTrackedHtml = normalHtml.replace(
    /<div class="body">/g,
    '<div>',
  );
  const publishedLiveView = buildRowContentLiveView([{ id: 'A1', body: 'Normal' }]);

  const errors = checkLiveView(workingRegister, publishedLiveView, {
    direction: 'extraOnly',
    baselineText: workingRegister,
    trackedLiveViewHtml: corruptedTrackedHtml,
  });

  const trackedErrors = errors.filter((e) => e.includes('[tracked]'));
  assert.ok(
    trackedErrors.length > 0,
    `expected extraction error tagged [tracked], got: ${JSON.stringify(errors)}`,
  );
});

// #2599 review round 2: the polarity of the tracked/published/baseline
// disambiguation was inverted in an earlier fix — every ordinary publish
// (tracked ahead of an unmerged baseline, published still at baseline)
// hard-failed as if it were genuine drift. Unit-test fixtures alone didn't
// catch this because a fixture that's WRITTEN to assert "not drift" can
// itself encode the wrong scenario, same as this file's own
// pre-existing fixtures did. The only test that actually caught the
// inversion replayed REAL commit history and measured a concrete
// false-positive rate (14/25). This test keeps that replay as a permanent
// regression check: replay the last N real commits that touched the
// live-view file as ordinary, unmerged, pre-publish edits, and assert none
// of them ever hard-fail as content drift.
const REPO_ROOT = join(HERE, '..', '..');
test('#2599 review round 2: replaying real live-view.html history as ordinary pending-publishes never hard-fails', () => {
  const lvRelPath = 'docs/testing/onbox-acceptance-register-live-view.html';
  const regRelPath = 'docs/testing/onbox-acceptance-register.md';
  const commits = spawnSync(
    'git',
    ['-C', REPO_ROOT, 'log', '--format=%H', '-25', '--', lvRelPath],
    { encoding: 'utf8', windowsHide: true },
  ).stdout.trim().split('\n').filter(Boolean);
  assert.ok(commits.length > 0, 'fixture assumption: real commit history exists for the live-view file');

  function show(ref, path) {
    const r = spawnSync('git', ['-C', REPO_ROOT, 'show', `${ref}:${path}`], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout : null;
  }

  const falsePositives = [];
  let replayedCommitsCount = 0;
  for (const commit of commits) {
    const oldLiveView = show(`${commit}~1`, lvRelPath);
    const newLiveView = show(commit, lvRelPath);
    const oldRegister = show(`${commit}~1`, regRelPath);
    const newRegister = show(commit, regRelPath);
    if (oldLiveView === null || newLiveView === null || oldRegister === null || newRegister === null) continue;
    replayedCommitsCount += 1;
    // Replay as the ordinary pre-merge publish shape: tracked = the new
    // commit's content (just committed locally), baseline = the OLD content
    // (not yet merged to origin/main), published = the OLD content (the
    // live page, unchanged so far).
    const errors = checkLiveView(newRegister, oldLiveView, {
      direction: 'extraOnly',
      baselineText: oldRegister,
      trackedLiveViewHtml: newLiveView,
      baselineLiveViewText: oldLiveView,
    });
    const driftErrors = errors.filter((e) => e.includes('row-content-drift'));
    if (driftErrors.length > 0) {
      falsePositives.push({ commit: commit.slice(0, 8), driftErrors });
    }
  }

  assert.ok(
    replayedCommitsCount > 0,
    `test must replay at least one commit to be meaningful, but ${replayedCommitsCount} passed the all-contents-available guard`,
  );

  assert.deepEqual(
    falsePositives,
    [],
    `${falsePositives.length}/${commits.length} ordinary-publish replays hard-failed as content drift: ${JSON.stringify(falsePositives, null, 2)}`,
  );
});

// #2837 Finding 1: CLI-level test ensuring 3-way warnings print to stderr and
// exit 0 (not 1). Unit tests cover checkLiveView's return value; this tests
// the CLI's wiring: that `console.warn` prints the warnings visibly, that
// `behindErrors` filter excludes 3-way-prefixed entries, and that
// publishedFailed is NOT set.
test('#2837: CLI -- 3-way content disagreement prints warning to stderr, exits 0', () => {
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // All three differ: baseline v0, published v1 (from a first publish),
  // tracked v2 (second edit before merge).
  const v0Content = 'Original baseline (v0)';
  const v1Content = 'First publish (v1)';
  const v2Content = 'Second edit (v2)';

  const baselineLiveView = buildRowContentLiveView([{ id: 'A1', body: v0Content }]);
  const publishedLiveView = buildRowContentLiveView([{ id: 'A1', body: v1Content }]);
  const trackedLiveViewHtml = buildRowContentLiveView([{ id: 'A1', body: v2Content }]);

  const dir = mkdtempSync(join(tmpdir(), 'onbox-cli-test-'));
  try {
    const publishedPath = join(dir, 'published.html');
    const baselinePath = join(dir, 'baseline.md');
    const baselineLiveViewPath = join(dir, 'baseline-liveview.html');
    const trackedLiveViewPath = join(dir, 'tracked-liveview.html');
    writeFileSync(publishedPath, publishedLiveView, 'utf8');
    writeFileSync(baselinePath, baselineRegister, 'utf8');
    writeFileSync(baselineLiveViewPath, baselineLiveView, 'utf8');
    writeFileSync(trackedLiveViewPath, trackedLiveViewHtml, 'utf8');

    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_BASELINE_LIVEVIEW_FILE: baselineLiveViewPath,
      ONBOX_TEST_TRACKED_LIVEVIEW_FILE: trackedLiveViewPath,
    });

    // Must exit 0 (not 1) — 3-way warnings do not block.
    assert.equal(r.status, 0, `expected exit 0 for 3-way warning (not error), got ${r.status}. stderr: ${r.stderr}`);
    // Warning must appear in stderr.
    assert.ok(
      r.stderr.includes('Three-way content differences detected'),
      `expected 3-way warning message in stderr, got: ${r.stderr}`,
    );
    // Exact string check: the message must say "not blocking".
    assert.ok(
      r.stderr.includes('not blocking'),
      `expected "not blocking" in warning text, got: ${r.stderr}`,
    );
    // The row ID should be mentioned in the warning.
    assert.ok(
      r.stderr.includes('A1'),
      `expected row ID (A1) mentioned in warning, got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2837 Finding 1: CLI-level test for extraction error in the tracked (working-tree)
// live-view file. The banner must blame the tracked/local file specifically.
test('#2837: CLI -- extraction error in tracked live-view produces [tracked] banner', () => {
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Normal published/baseline; corrupted tracked by removing the body div's class.
  const normalHtml = buildRowContentLiveView([{ id: 'A1', body: 'Normal content' }]);
  const corruptedTrackedHtml = normalHtml.replace(
    /<div class="body">/g,
    '<div>',  // Missing class="body", causes extraction error
  );

  const dir = mkdtempSync(join(tmpdir(), 'onbox-cli-test-'));
  try {
    const publishedPath = join(dir, 'published.html');
    const baselinePath = join(dir, 'baseline.md');
    const baselineLiveViewPath = join(dir, 'baseline-liveview.html');
    const trackedLiveViewPath = join(dir, 'tracked-liveview.html');
    writeFileSync(publishedPath, normalHtml, 'utf8');
    writeFileSync(baselinePath, baselineRegister, 'utf8');
    writeFileSync(baselineLiveViewPath, normalHtml, 'utf8');
    writeFileSync(trackedLiveViewPath, corruptedTrackedHtml, 'utf8');

    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_BASELINE_LIVEVIEW_FILE: baselineLiveViewPath,
      ONBOX_TEST_TRACKED_LIVEVIEW_FILE: trackedLiveViewPath,
    });

    // Must fail (exit 1) due to malformed HTML.
    assert.equal(r.status, 1, `expected exit 1 for extraction error, got ${r.status}. stderr: ${r.stderr}`);
    // The error banner must mention that the tracked/local copy is broken.
    assert.ok(
      r.stderr.includes('Your local') && r.stderr.includes('working-tree copy'),
      `expected error to blame local/working-tree copy, got: ${r.stderr}`,
    );
    // The banner must include [tracked] tag or mention "tracked".
    assert.ok(
      r.stderr.includes('[tracked]') || r.stderr.includes('tracking'),
      `expected [tracked] tag or 'tracking' mention in error, got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2837 Finding 1: CLI-level test for extraction error in the baseline
// (origin/main) live-view file. The banner must blame the baseline specifically.
test('#2837: CLI -- extraction error in baseline live-view produces [baseline] banner', () => {
  const baselineRegister = buildSingleGroupRegister('A', [1]);
  // Normal published/tracked; corrupted baseline by removing the body div's class.
  const normalHtml = buildRowContentLiveView([{ id: 'A1', body: 'Normal content' }]);
  const corruptedBaselineHtml = normalHtml.replace(
    /<div class="body">/g,
    '<div>',  // Missing class="body", causes extraction error
  );

  const dir = mkdtempSync(join(tmpdir(), 'onbox-cli-test-'));
  try {
    const publishedPath = join(dir, 'published.html');
    const baselinePath = join(dir, 'baseline.md');
    const baselineLiveViewPath = join(dir, 'baseline-liveview.html');
    const trackedLiveViewPath = join(dir, 'tracked-liveview.html');
    writeFileSync(publishedPath, normalHtml, 'utf8');
    writeFileSync(baselinePath, baselineRegister, 'utf8');
    writeFileSync(baselineLiveViewPath, corruptedBaselineHtml, 'utf8');
    writeFileSync(trackedLiveViewPath, normalHtml, 'utf8');

    const r = runCli(['--against-published', publishedPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_BASELINE_LIVEVIEW_FILE: baselineLiveViewPath,
      ONBOX_TEST_TRACKED_LIVEVIEW_FILE: trackedLiveViewPath,
    });

    // Must fail (exit 1) due to malformed HTML.
    assert.equal(r.status, 1, `expected exit 1 for extraction error, got ${r.status}. stderr: ${r.stderr}`);
    // The error banner itself (not the unrelated ONBOX_TEST_BASELINE_LIVEVIEW_FILE
    // override warning, which also happens to mention "origin/main") must
    // specifically blame the baseline copy — this exact phrase only appears
    // in the baseline extraction-error banner text.
    assert.ok(
      r.stderr.includes("origin/main's") && r.stderr.includes('(baseline copy) has malformed'),
      `expected the baseline extraction-error banner specifically, got: ${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Executable-as-written: `Import-Module` needs a leading `.\` (#3055 pass 3) ---
//
// E103's criterion told the operator to run `Import-Module
// scripts\lib\wt-gc-junctions.psm1 -Force` and treat an `Import-Module` failure
// as a disqualifying FAIL. Run verbatim that command ALWAYS fails
// (`Modules_ModuleNotFound`): PowerShell reads a bare relative path as a module
// NAME and searches $env:PSModulePath. So the criterion guaranteed the exact
// false FAIL it had just been rewritten to teach the operator to recognise.
// Class guard over every acceptance surface, not just that one row.

// The quote characters are \uXXXX escapes, not literals (" = double,
// ' = single). server/src/spawn-windows-hide.test.ts scans this file as an
// external file, and its #2747 guard rejects any regex literal whose bare
// quotes desync its quote tracker. Written literally, the first double quote
// opens a string, the second closes it, and the single quote that follows opens
// one that never closes -- which would blank the rest of this file and hide any
// real spawn call below it. Escaping keeps the match semantics identical.
const IMPORT_MODULE_RE =
  /Import-Module\s+(?:-Name\s+)?(&quot;|&#39;|[\u0022\u0027]?)([^\u0022\u0027\s;|&<]+)/g;

/** A path is safe if it is absolute, variable-rooted, or explicitly relative. */
function importPathIsExecutable(spec) {
  if (!/[\\/]/.test(spec)) return true; // a bare module NAME, resolved via PSModulePath
  return /^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|[\\/]|\$)/.test(spec);
}

test('every Import-Module command quoted in docs/testing is executable as written (#3055)', () => {
  const surfaces = [
    join(HERE, '..', '..', 'docs', 'testing', 'onbox-acceptance-register.md'),
    REAL_LIVE_VIEW_PATH,
  ];
  const bad = [];
  for (const file of surfaces) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_MODULE_RE)) {
      if (!importPathIsExecutable(m[2])) bad.push(`${file}: Import-Module ${m[2]}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    'A relative Import-Module path needs a leading `.\\` -- without it PowerShell searches\n' +
      '$env:PSModulePath and fails with Modules_ModuleNotFound on both engines.\n' +
      bad.join('\n'),
  );

  // The matcher and the predicate must both be able to fire, or the assertion
  // above is vacuous.
  const probe = [...'Import-Module scripts\\lib\\x.psm1 -Force'.matchAll(IMPORT_MODULE_RE)];
  assert.equal(probe.length, 1);
  assert.equal(importPathIsExecutable(probe[0][2]), false);
  assert.equal(importPathIsExecutable('.\\scripts\\lib\\x.psm1'), true);
  assert.equal(importPathIsExecutable('./scripts/lib/x.psm1'), true);
  assert.equal(importPathIsExecutable('Pester'), true);
});

// ---------------------------------------------------------------------------
// #3529: ways `--against-published` passed a publish that would have broken
// another lane's rows (the 2026-10-07 PR #3525 / #3505 incident), and how the
// check now tells them apart.
//
//  1. A row-ID COLLISION: two lanes each allocated B103, with different
//     titles. Matching by ID alone called them equal.
//  2. An UNMERGED LANE'S live-only row: #2199 reads "live has it, origin/main
//     lacks it" as a discharge, but a row an unmerged PR ADDED has the same
//     shape. What separates them is PROVENANCE: which commit stamped the live
//     page's `data-publish-id`, and whether origin/main (or your own HEAD)
//     contains it — `publishedProvenance` below, resolved from real git by
//     `resolvePublishedProvenance` (covered against throwaway repos further
//     down).
//
// Fixtures are minimal and synthetic: Group B, main's marker at B103.
// ---------------------------------------------------------------------------

const MAIN_B = () => buildSingleGroupRegister('B', [101, 102], 103);
const MINE_TITLE = 'Ollama structured-output modes on a real model';
const THEIRS_TITLE = 'Abort and drain on a local Ollama analyzer';

// A page published by a branch origin/main has not merged.
const UNMERGED = { kind: 'unmerged', nonce: 'lane0x1', commit: 'abc1234' };
// A merged / own publish whose committed live view carried exactly `ids`.
const merged = (ids) => ({ kind: 'merged', nonce: 'main0x1', commit: 'def5678', stampedRowIds: ids });
const own = (ids) => ({ kind: 'own', nonce: 'mine0x1', commit: 'aaa9999', stampedRowIds: ids });

function collisionOptions({ trackedRows, publishedRows, working, baseline, extra = {} }) {
  return [
    working ?? buildSingleGroupRegister('B', [101, 102, 103], 104),
    buildRowContentLiveView(publishedRows, 'B'),
    {
      direction: 'extraOnly',
      baselineText: baseline ?? MAIN_B(),
      trackedLiveViewHtml: buildRowContentLiveView(trackedRows, 'B'),
      publishedProvenance: UNMERGED,
      ...extra,
    },
  ];
}

const baseRows = [
  { id: 'B101', body: 'x' },
  { id: 'B102', body: 'x' },
];

const ofPrefix = (errors, prefix) => errors.filter((e) => e.startsWith(prefix));

test('#3529: the same row ID under a different title is a collision, naming the ID, both titles and the renumber target', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    }),
  );
  const collision = ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX);
  assert.equal(collision.length, 1, JSON.stringify(errors));
  assert.match(collision[0], /B103/);
  assert.ok(collision[0].includes(MINE_TITLE) && collision[0].includes(THEIRS_TITLE));
  // highest of the register's own next-id (B104), the live page's highest + 1
  // (B104) and origin/main's next-id (B103)
  assert.match(collision[0], /B104/);
});

test('#3529: the renumber target is the live page highest ID + 1 when that exceeds the register next-id', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [
        ...baseRows,
        { id: 'B103', body: 'theirs', title: THEIRS_TITLE },
        { id: 'B108', body: 'theirs', title: 'other' },
      ],
    }),
  );
  const collision = errors.find((e) => e.startsWith(ROW_ID_COLLISION_ERROR_PREFIX));
  assert.ok(collision, JSON.stringify(errors));
  assert.match(collision, /B109/);
});

// Review pass 1, 🟡1: main's own marker is a third allocation surface. main
// minted B103-B105 (none survive there), so B104 is already spent.
test('#3529: the renumber target respects origin/main next-id (allocate-once)', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      baseline: buildSingleGroupRegister('B', [101, 102], 106),
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    }),
  );
  const collision = errors.find((e) => e.startsWith(ROW_ID_COLLISION_ERROR_PREFIX));
  assert.ok(collision, JSON.stringify(errors));
  assert.match(collision, /Renumber your row to B106\b/);
});

test('#3529: the same row ID with the same title passes (no collision)', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
    }),
  );
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 0, JSON.stringify(errors));
});

test('#3529: whitespace, markup and entity differences in a title are not a collision', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'a', title: 'Ollama structured output &amp; modes' }],
      publishedRows: [
        ...baseRows,
        { id: 'B103', body: 'b', title: 'Ollama  <code>structured</code>&nbsp; output & modes' },
      ],
    }),
  );
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 0, JSON.stringify(errors));
});

test('#3529: a retitled row origin/main already has, with no merge-base evidence, is not a tracked-vs-live collision', () => {
  const baseline = buildSingleGroupRegister('B', [101, 102, 103], 104);
  const errors = checkLiveView(
    ...collisionOptions({
      baseline,
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: 'reworded title' }],
      publishedRows: [...baseRows, { id: 'B103', body: 'mine', title: 'original title' }],
    }),
  );
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 0, JSON.stringify(errors));
});

// Review pass 1, 🟠 (own retitle): this lane minted B103 "Old title",
// published it, then a review round retitled it. The live page is this lane's
// own earlier publish, so the title change is a retitle.
test('#3529: own earlier publish — a same-ID title change is a retitle, not a collision', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'v2', title: 'New title' }],
      publishedRows: [...baseRows, { id: 'B103', body: 'v1', title: 'Old title' }],
      extra: { publishedProvenance: own(['B101', 'B102', 'B103']) },
    }),
  );
  assert.deepEqual(
    errors.filter((e) => !e.startsWith(THREE_WAY_CONTENT_WARNING_PREFIX)),
    [],
  );
});

// ...and the row the operator renumbered away from is still their own row,
// never "another unmerged lane's".
test('#3529: own earlier publish — a row this lane later dropped is its own, not another lane', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102, 104], 105),
      trackedRows: [...baseRows, { id: 'B104', body: 'v2', title: 'New title' }],
      publishedRows: [...baseRows, { id: 'B103', body: 'v1', title: 'Old title' }],
      extra: { publishedProvenance: own(['B101', 'B102', 'B103']) },
    }),
  );
  assert.deepEqual(errors, []);
});

test('#3529: a live-only row origin/main lacks, on a page an unmerged lane published, is that lane’s row', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102], 103),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    }),
  );
  const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
  assert.equal(unmerged.length, 1, JSON.stringify(errors));
  assert.match(unmerged[0], /B103/);
  assert.match(unmerged[0], /lane0x1/, 'names the publish id');
  assert.match(unmerged[0], /--publishing/);
  assert.ok(!/--discharging/.test(unmerged[0]), 'must never steer the operator to --discharging');
});

// Review pass 1, 🔴: the old next-id rule went silent here. #3525 merged
// first (main = B101,B102,B105, next-id B106) and had published the UNION:
// its own rows plus #3505's B103/B104. A later lane with no Group B change now
// publishes against that union page.
test('#3529: overtaken lane — rows a merged union publish carried for an unmerged lane still fail', () => {
  const mainAfter3525 = buildSingleGroupRegister('B', [101, 102, 105], 106);
  const mine = [...baseRows, { id: 'B105', body: '3525', title: '3525 row' }];
  const errors = checkLiveView(
    mainAfter3525,
    buildRowContentLiveView(
      [
        ...baseRows,
        { id: 'B103', body: '3505a', title: '3505 row a' },
        { id: 'B104', body: '3505b', title: '3505 row b' },
        { id: 'B105', body: '3525', title: '3525 row' },
      ],
      'B',
    ),
    {
      direction: 'extraOnly',
      baselineText: mainAfter3525,
      trackedLiveViewHtml: buildRowContentLiveView(mine, 'B'),
      baselineLiveViewText: buildRowContentLiveView(mine, 'B'),
      // #3525's stamp commit is on main now; its committed live view carried
      // only #3525's rows — B103/B104 rode in on the union publish.
      publishedProvenance: merged(['B101', 'B102', 'B105']),
    },
  );
  const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
  assert.deepEqual(
    unmerged.map((e) => e.match(/^unmerged-lane-row: (B\d+):/)?.[1]),
    ['B103', 'B104'],
    JSON.stringify(errors),
  );
});

test('#3529: a merged publish whose committed live view carried the row — a genuine discharge (#2199)', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      baseline: buildSingleGroupRegister('B', [101, 102], 104),
      working: buildSingleGroupRegister('B', [101, 102], 104),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'discharged', title: 'gone' }],
      extra: { publishedProvenance: merged(['B101', 'B102', 'B103']) },
    }),
  );
  assert.deepEqual(errors, []);
});

// Review pass 1, 🔴 (second entry point): a brand-new group letter has no
// marker on main; the provenance rule is not keyed on one.
test('#3529: a whole new group an unmerged lane published fails per row', () => {
  const live = buildMultiGroupLiveView(3, [
    { letter: 'B', glanceCount: 2, headerCount: 2, rowIds: ['B101', 'B102'] },
    { letter: 'I', glanceCount: 1, headerCount: 1, rowIds: ['I101'] },
  ]);
  const errors = checkLiveView(MAIN_B(), live, {
    direction: 'extraOnly',
    baselineText: MAIN_B(),
    publishedProvenance: UNMERGED,
  });
  const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
  assert.equal(unmerged.length, 1, JSON.stringify(errors));
  assert.match(unmerged[0], /^unmerged-lane-row: I101:/);
});

test('#3529: a whole group discharged on a merged publish stays silent', () => {
  const live = buildMultiGroupLiveView(3, [
    { letter: 'B', glanceCount: 2, headerCount: 2, rowIds: ['B101', 'B102'] },
    { letter: 'I', glanceCount: 1, headerCount: 1, rowIds: ['I101'] },
  ]);
  const errors = checkLiveView(MAIN_B(), live, {
    direction: 'extraOnly',
    baselineText: MAIN_B(),
    publishedProvenance: merged(['B101', 'B102', 'I101']),
  });
  assert.deepEqual(errors, []);
});

test('#3529: --discharging does NOT suppress another lane’s row (it names only rows THIS change discharged)', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102], 103),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { dischargingIds: ['B103'] },
    }),
  );
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(errors));
  assert.equal(ofPrefix(errors, DISCHARGE_NAME_ERROR_PREFIX).length, 0, 'the name is consumed, not also reported');
});

test('#3529: an untraceable publish id fails closed, naming the nonce and the fetch', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102], 103),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: {
        publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'not found in any git history this checkout has' },
      },
    }),
  );
  const unknown = ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX);
  assert.equal(unknown.length, 1, JSON.stringify(errors));
  assert.match(unknown[0], /ghost0x1/);
  assert.match(unknown[0], /B103/);
  assert.ok(unknown[0].includes("git fetch origin '+refs/heads/*:refs/remotes/origin/*'"), unknown[0]);
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 0);
});

test('#3529: an untraceable publish id is not an error when no verdict depends on it', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102], 103),
      trackedRows: baseRows,
      publishedRows: baseRows,
      extra: { publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'x' } },
    }),
  );
  assert.deepEqual(errors, []);
});

test('#3529: an extraOnly run with no provenance at all fails closed', () => {
  const errors = checkLiveView(
    buildSingleGroupRegister('B', [101, 102], 103),
    buildRowContentLiveView([...baseRows, { id: 'B103', body: 'theirs' }], 'B'),
    { direction: 'extraOnly', baselineText: MAIN_B() },
  );
  assert.equal(ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX).length, 1, JSON.stringify(errors));
});

// Review pass 1, 🟠 (no green path): the union publish carries the other
// lane's rows; `publishingHtml` is that file.
test('#3529: --publishing a union file that carries the other lane’s rows byte-for-byte goes green', () => {
  const theirs = [
    { id: 'B103', body: 'theirs a', title: THEIRS_TITLE },
    { id: 'B104', body: 'theirs b', title: 'second row from the unmerged lane' },
  ];
  const mine = [...baseRows, { id: 'B105', body: 'mine', title: MINE_TITLE }];
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102, 105], 106),
    trackedRows: mine,
    publishedRows: [...baseRows, ...theirs],
  });
  assert.equal(ofPrefix(checkLiveView(working, published, options), UNMERGED_LANE_ROW_ERROR_PREFIX).length, 2);
  const union = buildRowContentLiveView([...baseRows, ...theirs, mine[2]], 'B');
  assert.deepEqual(checkLiveView(working, published, { ...options, publishingHtml: union }), []);
});

test('#3529: --publishing a file whose copy of the other lane’s row differs from the live block fails', () => {
  const theirs = [{ id: 'B103', body: 'theirs a', title: THEIRS_TITLE }];
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 103),
    trackedRows: baseRows,
    publishedRows: [...baseRows, ...theirs],
  });
  const union = buildRowContentLiveView([...baseRows, { ...theirs[0], body: 'edited copy' }], 'B');
  const errors = checkLiveView(working, published, { ...options, publishingHtml: union });
  const mismatch = ofPrefix(errors, PUBLISHING_FILE_ERROR_PREFIX);
  assert.equal(mismatch.length, 1, JSON.stringify(errors));
  assert.match(mismatch[0], /B103/);
  // The specific verdict, not only the whole-file comparison's generic one.
  assert.match(mismatch[0], /differs from the live page\u0027s/);
});

test('#3529: --publishing a file that lacks the other lane’s row still fails', () => {
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 103),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
  });
  const errors = checkLiveView(working, published, {
    ...options,
    publishingHtml: buildRowContentLiveView(baseRows, 'B'),
  });
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(errors));
});

// Review pass 1, 🟠 (merged-lane collision): lane X minted B103 "Theirs" and
// merged; this lane branched earlier, minted its own B103 "Mine" and has not
// rebased. main has B103, you have B103, the merge-base has none: both lanes
// minted it.
test('#3529: a collision with a lane that already merged fails via the merge-base', () => {
  const mainWithTheirs = buildRowContentLiveView([...baseRows, { id: 'B103', body: 'theirs', title: 'Theirs' }], 'B');
  const mainRegister = buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Theirs');
  const mineRegister = buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Mine');
  const errors = checkLiveView(mineRegister, mainWithTheirs, {
    direction: 'extraOnly',
    baselineText: mainRegister,
    trackedLiveViewHtml: buildRowContentLiveView([...baseRows, { id: 'B103', body: 'mine', title: 'Mine' }], 'B'),
    baselineLiveViewText: mainWithTheirs,
    publishedProvenance: merged(['B101', 'B102', 'B103']),
    mergeBaseText: MAIN_B(),
  });
  const collision = ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX);
  assert.equal(collision.length, 1, JSON.stringify(errors));
  assert.match(collision[0], /^row-id-collision: B103:/);
  assert.match(collision[0], /Renumber your row to B104\b/);
  // Same shape, but this lane rebased onto main (merge-base has B103): no
  // collision, it is main's own row.
  const rebased = checkLiveView(mineRegister, mainWithTheirs, {
    direction: 'extraOnly',
    baselineText: mainRegister,
    trackedLiveViewHtml: buildRowContentLiveView([...baseRows, { id: 'B103', body: 'mine', title: 'Mine' }], 'B'),
    baselineLiveViewText: mainWithTheirs,
    publishedProvenance: merged(['B101', 'B102', 'B103']),
    mergeBaseText: mainRegister,
  });
  assert.equal(ofPrefix(rebased, ROW_ID_COLLISION_ERROR_PREFIX).length, 0, JSON.stringify(rebased));
});

// Review pass 2 (🟡3) narrowed this to the one case the merge-base decides:
// an ID origin/main carries under another title. See the pass-2 test for the
// silent case.
test('#3529: an unresolvable merge-base fails closed rather than skipping the merged-lane collision check', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      baseline: buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Theirs'),
      working: buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Mine'),
      trackedRows: baseRows,
      publishedRows: baseRows,
      extra: { mergeBaseText: null },
    }),
  );
  assert.equal(ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX).length, 1, JSON.stringify(errors));
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 0, 'undecidable, not a collision');
});

test('#3529: the real incident — colliding B103 and a live-only B104 — fails on both counts', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [
        ...baseRows,
        { id: 'B103', body: 'theirs', title: THEIRS_TITLE },
        { id: 'B104', body: 'theirs', title: 'second row from the unmerged lane' },
      ],
    }),
  );
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 1);
  const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
  assert.equal(unmerged.length, 1);
  assert.match(unmerged[0], /B104/);
});

// ---------------------------------------------------------------------------
// #3529: `resolvePublishedProvenance` / `resolveMergeBaseRegister` against
// REAL git. Throwaway repositories, every spawn through
// `scrubGitEnvForThrowawayRepo` — see publish-token-git.test.mjs's header for
// why `cwd` alone does not isolate a git call. Self-contained (no network, no
// dependence on this checkout's depth), so they run the same on CI.
// ---------------------------------------------------------------------------

const PROV_LIVE = 'docs/testing/onbox-acceptance-register-live-view.html';
const PROV_REGISTER = 'docs/testing/onbox-acceptance-register.md';
const provEnv = () => scrubGitEnvForThrowawayRepo();
const provRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: provEnv(), windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
};
const provGit = (repo, ...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: provEnv(), windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
function provPage(nonce, rowIds) {
  const token = nonce ? `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n` : '';
  return `${token}${rowIds.map((id) => `<span class="num">${id}</span>`).join('\n')}\n`;
}
function provCommit(repo, nonce, rowIds, registerText) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  writeFileSync(join(repo, PROV_LIVE), provPage(nonce, rowIds));
  if (registerText !== undefined) writeFileSync(join(repo, PROV_REGISTER), registerText);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `stamp ${nonce}`);
  return provGit(repo, 'rev-parse', 'HEAD');
}
// main: nonce main0001 (B101,B102). lane-x: lane0001 (adds B103), unmerged.
// mine (checked out): mine0001 (adds B104). A later main commit re-stamps.
function withProvenanceRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'onbox-provenance-'));
  try {
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    provCommit(repo, 'main0001', ['B101', 'B102'], 'REGISTER AT FORK\n');
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    provCommit(repo, 'lane0001', ['B101', 'B102', 'B103']);
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'mine');
    provCommit(repo, 'mine0001', ['B101', 'B102', 'B104']);
    provGit(repo, 'switch', '-q', 'main');
    const mainSha = provCommit(repo, 'main0002', ['B101'], 'REGISTER ON MAIN\n');
    provGit(repo, 'switch', '-q', 'mine');
    return fn(repo, mainSha);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('#3529 git: the env scrub isolates the provenance throwaway repo (self-check)', () => {
  withProvenanceRepo((repo) => {
    // Had the scrub failed, these commits would have landed in (and this log
    // would read) the real repository instead of the four fixture commits.
    assert.equal(provGit(repo, 'rev-list', '--all', '--count'), '4');
    assert.equal(provGit(repo, 'branch', '--show-current'), 'mine');
  });
});

test('#3529 git: a page stamped on main is a merged publish, with the rows its committed live view carried', () => {
  withProvenanceRepo((repo, mainSha) => {
    const p = resolvePublishedProvenance(repo, PROV_LIVE, provPage('main0001', ['B101', 'B102', 'B999']), mainSha, provRunner);
    assert.equal(p.kind, 'merged');
    assert.equal(p.nonce, 'main0001');
    assert.deepEqual([...p.stampedRowIds].sort(), ['B101', 'B102'], 'rows from the COMMIT, not the page');
  });
});

test('#3529 git: a page stamped only in HEAD is your own earlier publish', () => {
  withProvenanceRepo((repo, mainSha) => {
    const p = resolvePublishedProvenance(repo, PROV_LIVE, provPage('mine0001', ['B101']), mainSha, provRunner);
    assert.equal(p.kind, 'own');
    assert.deepEqual([...p.stampedRowIds].sort(), ['B101', 'B102', 'B104']);
  });
});

test('#3529 git: a page stamped on another unmerged branch is an unmerged lane', () => {
  withProvenanceRepo((repo, mainSha) => {
    const p = resolvePublishedProvenance(repo, PROV_LIVE, provPage('lane0001', ['B103']), mainSha, provRunner);
    assert.equal(p.kind, 'unmerged');
    assert.equal(p.nonce, 'lane0001');
    assert.match(p.commit, /^[0-9a-f]{40}$/);
  });
});

test('#3529 git: once that lane merges, the same page reads as merged', () => {
  withProvenanceRepo((repo) => {
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'merge', '-q', '--no-edit', '-X', 'theirs', 'lane-x');
    const mainSha = provGit(repo, 'rev-parse', 'HEAD');
    provGit(repo, 'switch', '-q', 'mine');
    const p = resolvePublishedProvenance(repo, PROV_LIVE, provPage('lane0001', ['B103']), mainSha, provRunner);
    assert.equal(p.kind, 'merged');
    assert.deepEqual([...p.stampedRowIds].sort(), ['B101', 'B102', 'B103']);
  });
});

test('#3529 git: a nonce in no history at all is unknown, never a default', () => {
  withProvenanceRepo((repo, mainSha) => {
    const p = resolvePublishedProvenance(repo, PROV_LIVE, provPage('ghost0001', ['B101']), mainSha, provRunner);
    assert.equal(p.kind, 'unknown');
    assert.equal(p.nonce, 'ghost0001');
    const none = resolvePublishedProvenance(repo, PROV_LIVE, provPage(null, ['B101']), mainSha, provRunner);
    assert.equal(none.kind, 'unknown');
    assert.equal(none.nonce, null);
  });
});

test('#3529 git: a failed lookup is unknown, not "not found"', () => {
  const failing = () => ({ status: 128, stdout: '', stderr: 'fatal', error: undefined });
  const p = resolvePublishedProvenance('/nowhere', PROV_LIVE, provPage('main0001', []), 'abc', failing);
  assert.equal(p.kind, 'unknown');
  assert.match(p.reason, /could not search/);
  // Only the origin/main search fails: reading that as "not on main" would
  // fall through to the other searches and misreport a merged page.
  withProvenanceRepo((repo, mainSha) => {
    const mainOnlyFails = (args, cwd) =>
      args.includes(mainSha) ? { status: 128, stdout: '', stderr: 'fatal' } : provRunner(args, cwd);
    const q = resolvePublishedProvenance(repo, PROV_LIVE, provPage('mine0001', []), mainSha, mainOnlyFails);
    assert.equal(q.kind, 'unknown', JSON.stringify(q));
    assert.match(q.reason, /origin\/main/);
  });
});

test('#3529 git: resolveMergeBaseRegister reads the register at merge-base(HEAD, main)', () => {
  withProvenanceRepo((repo, mainSha) => {
    assert.equal(resolveMergeBaseRegister(repo, PROV_REGISTER, mainSha, provRunner), 'REGISTER AT FORK\n');
    assert.equal(resolveMergeBaseRegister(repo, 'docs/absent.md', mainSha, provRunner), '');
    assert.equal(resolveMergeBaseRegister(repo, PROV_REGISTER, 'not-a-ref', provRunner), null);
  });
});

// ---------------------------------------------------------------------------
// #3529, PR #3532 review pass 2. Exports added by this round are read through
// the `onbox` namespace so a missing one fails its own test, not the import.
//
//   🟠1 the stamping commit is the OLDEST commit that introduced the nonce
//       (the stamp, not the merge commit that later brought it to main), and
//       a row ID origin/main's register has EVER carried is a discharge.
//   🟠2 the "Retired carried rows" record, its PR-state check, and naming a
//       carried row's OWNER rather than whoever carried it.
//   🟠3 `--publishing` checks the whole file against the deterministic union.
//   🟠4 the whole-group paths classify a row main lacks by provenance too.
// ---------------------------------------------------------------------------

// Real merges in a throwaway repo. `uMerge` makes a genuine `--no-ff` merge
// commit and writes the resolution explicitly — never `-X theirs`, which
// makes the merge commit's view equal the stamp's and hid the pass-2 defect.
const U_ROW = (n) => ({ id: `B${n}`, body: `body B${n}`, title: `title B${n}` });
const uView = (nonce, nums) =>
  buildRowContentLiveView(nums.map(U_ROW), 'B').replace(
    '<title>',
    `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n<title>`,
  );
function uWrite(repo, nonce, nums, next) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  writeFileSync(join(repo, PROV_LIVE), uView(nonce, nums));
  writeFileSync(join(repo, PROV_REGISTER), buildSingleGroupRegister('B', nums, next));
}
function uCommit(repo, nonce, nums, next, msg) {
  uWrite(repo, nonce, nums, next);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', msg ?? `stamp ${nonce}`);
  return provGit(repo, 'rev-parse', 'HEAD');
}
function uMerge(repo, branch, nonce, nums, next) {
  spawnSync('git', ['merge', '--no-ff', '--no-commit', '-q', branch], {
    cwd: repo,
    env: provEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  uWrite(repo, nonce, nums, next);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `Merge ${branch}`);
  const head = provGit(repo, 'rev-parse', 'HEAD');
  assert.equal(provGit(repo, 'rev-list', '--parents', '-n', '1', head).split(' ').length, 3, 'a real merge commit');
  return head;
}
function withUnionRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'onbox-union-'));
  try {
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    uCommit(repo, 'main0001', [101, 102], 103);
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
// What a lane checked out at `branch` gets from --against-published, through
// the same real lookups the CLI wires in.
function uCheck(repo, branch, page, extra = {}) {
  provGit(repo, 'switch', '-q', branch);
  const mainSha = provGit(repo, 'rev-parse', 'main');
  const provenance = onbox.resolvePublishedProvenance(repo, PROV_LIVE, page, mainSha, provRunner);
  return checkLiveView(readFileSync(join(repo, PROV_REGISTER), 'utf8'), page, {
    direction: 'extraOnly',
    baselineText: provGit(repo, 'show', `${mainSha}:${PROV_REGISTER}`) + '\n',
    baselineLiveViewText: provGit(repo, 'show', `${mainSha}:${PROV_LIVE}`) + '\n',
    trackedLiveViewHtml: readFileSync(join(repo, PROV_LIVE), 'utf8'),
    publishedProvenance: provenance,
    mergeBaseText: onbox.resolveMergeBaseRegister(repo, PROV_REGISTER, mainSha, provRunner),
    mainEverCarried: (id) => onbox.resolveMainEverCarried?.(repo, PROV_REGISTER, mainSha, id, provRunner),
    rowOwnerLookup: (id) => onbox.resolveRowOwner?.(repo, PROV_LIVE, id, provRunner),
    ...extra,
  });
}
const realErrors = (errors) => errors.filter((e) => !e.startsWith(THREE_WAY_CONTENT_WARNING_PREFIX));

// 🟠1 (a): kills "newest hit" (pass-2 mutant M27's inverse).
test('#3529 pass 2: on a merged page the stamping commit is the stamp, not the merge commit into main', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    const stamp = uCommit(repo, 'lane0001', [101, 102, 103], 104);
    uCommit(repo, 'lane0001', [101, 102], 104, 'review round drops B103 without re-stamping');
    provGit(repo, 'switch', '-q', 'main');
    const merge = uMerge(repo, 'lane-l', 'lane0001', [101, 102], 104);
    assert.notEqual(merge, stamp);
    const p = onbox.resolvePublishedProvenance(repo, PROV_LIVE, uView('lane0001', [101, 102, 103]), merge, provRunner);
    assert.equal(p.kind, 'merged');
    assert.equal(p.commit, stamp, 'the stamp commit, not the merge commit');
    assert.deepEqual([...p.stampedRowIds].sort(), ['B101', 'B102', 'B103']);
  });
});

// Pass-2 M1: when the stamp commit itself cannot be read, the next pickaxe
// hit is the re-stamp that REMOVED the nonce. Only the anchor check keeps it
// from being taken as the stamp; an unreadable stamp is unknown, never a guess.
test('#3529 pass 2: an unreadable stamp commit is unknown, never the later commit that re-stamped it away', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    const stamp = uCommit(repo, 'lane0001', [101, 102, 103], 104);
    const restamp = uCommit(repo, 'lane0002', [101, 102], 104, 're-stamp');
    provGit(repo, 'switch', '-q', 'main');
    const merge = uMerge(repo, 'lane-l', 'lane0002', [101, 102], 104);
    const stampUnreadable = (args, cwd) =>
      args[0] === 'show' && args[1].startsWith(`${stamp}:`) ? { status: 128, stdout: '', stderr: 'fatal' } : provRunner(args, cwd);
    const p = onbox.resolvePublishedProvenance(repo, PROV_LIVE, uView('lane0001', [101, 102, 103]), merge, stampUnreadable);
    assert.notEqual(p.commit, restamp, JSON.stringify(p));
    assert.equal(p.kind, 'unknown', JSON.stringify(p));
  });
});

// 🟠1 (a): kills dropping `--diff-merges=first-parent` (pass-2 M26's shape).
// The natural resolution of a live-view conflict IS a re-stamp, so the nonce
// is born in the merge commit itself.
test('#3529 pass 2: a nonce born in a merge commit (a re-stamp during conflict resolution) is found', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    uCommit(repo, 'lane0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', 'main');
    uCommit(repo, 'main0002', [101, 102, 104], 105);
    provGit(repo, 'switch', '-q', 'lane-l');
    const merge = uMerge(repo, 'main', 'lane0002', [101, 102, 103, 104], 105);
    const mainSha = provGit(repo, 'rev-parse', 'main');
    const p = onbox.resolvePublishedProvenance(repo, PROV_LIVE, uView('lane0002', [101, 102, 103, 104]), mainSha, provRunner);
    assert.equal(p.kind, 'own', JSON.stringify(p));
    assert.equal(p.commit, merge);
    assert.deepEqual([...p.stampedRowIds].sort(), ['B101', 'B102', 'B103', 'B104']);
  });
});

// Review pass 2, S1: the operator's direct case still passes.
test('#3529 pass 2 S1: a merged publish that carried B103, then a merged discharge without a republish, is silent', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    uCommit(repo, 'lane0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'lane-l', 'lane0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', '-c', 'disch');
    uCommit(repo, 'disc0001', [101, 102], 104, 'discharge B103');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'disch', 'disc0001', [101, 102], 104);
    provGit(repo, 'switch', '-q', '-c', 'q');
    assert.deepEqual(realErrors(uCheck(repo, 'q', uView('lane0001', [101, 102, 103]))), []);
  });
});

// Review pass 2, S2: the lane's own row, dropped after its publish, is not
// "another unmerged lane's" once that lane merges.
test('#3529 pass 2 S2: own row dropped after publishing, then merged — silent for the lane and for every later lane', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    uCommit(repo, 'lane0001', [101, 102, 103], 104);
    const page = uView('lane0001', [101, 102, 103]);
    uCommit(repo, 'lane0001', [101, 102], 104, 'drop own B103');
    assert.deepEqual(realErrors(uCheck(repo, 'lane-l', page)), [], 'pre-merge, own lane');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'lane-l', 'lane0001', [101, 102], 104);
    provGit(repo, 'switch', '-q', '-c', 'q');
    assert.deepEqual(realErrors(uCheck(repo, 'q', page)), [], 'post-merge, another lane');
  });
});

// Review pass 2, S3/S3b: the verdict no longer depends on merge order.
function s3(xFirst) {
  return withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    uCommit(repo, 'xxxx0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-k');
    uCommit(repo, 'kkkk0001', [101, 102, 104], 105);
    // K's union publish: its own view plus X's B103.
    const union = uView('kkkk0001', [101, 102, 103, 104]);
    provGit(repo, 'switch', '-q', 'main');
    if (xFirst) {
      uMerge(repo, 'lane-x', 'xxxx0001', [101, 102, 103], 104);
      provGit(repo, 'switch', '-q', 'lane-k');
      uMerge(repo, 'main', 'kkkk0001', [101, 102, 103, 104], 105);
      provGit(repo, 'switch', '-q', 'main');
      uMerge(repo, 'lane-k', 'kkkk0001', [101, 102, 103, 104], 105);
    } else {
      uMerge(repo, 'lane-k', 'kkkk0001', [101, 102, 104], 105);
      provGit(repo, 'switch', '-q', 'lane-x');
      uMerge(repo, 'main', 'xxxx0002', [101, 102, 103, 104], 105);
      provGit(repo, 'switch', '-q', 'main');
      uMerge(repo, 'lane-x', 'xxxx0002', [101, 102, 103, 104], 105);
    }
    provGit(repo, 'switch', '-q', '-c', 'disch');
    uCommit(repo, 'disc0001', [101, 102, 104], 105, 'discharge B103');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'disch', 'disc0001', [101, 102, 104], 105);
    provGit(repo, 'switch', '-q', '-c', 'q');
    return realErrors(uCheck(repo, 'q', union));
  });
}
test('#3529 pass 2 S3: a union-carried row whose carrier merged first, then its own lane, then a discharge — silent', () => {
  assert.deepEqual(s3(false), []);
});
test('#3529 pass 2 S3b: the same with the owning lane merging first — silent, consistent with S3', () => {
  assert.deepEqual(s3(true), []);
});

// Review pass 3, 🔴 (P3g): "main has ever carried it" follows main's own
// first-parent line. A merged lane that minted a colliding ID on its branch
// and renumbered it BEFORE merging (#3525's f980d2c8 B103) never put that ID
// in main's register, so it must not exempt the other lane's live copy.
test('#3529 pass 3 P3g: a merged lane that minted a colliding ID and renumbered it before merging does not exempt the other lane', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    uCommit(repo, 'xxxx0001', [101, 102, 103], 104);
    const pageX = uView('xxxx0001', [101, 102, 103]);
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-k');
    uCommit(repo, 'kkkk0001', [101, 102, 103], 104, 'K mints B103 (collides with X)');
    uCommit(repo, 'kkkk0002', [101, 102, 104], 105, 'K renumbers B103 -> B104');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'lane-k', 'kkkk0002', [101, 102, 104], 105);
    const mainSha = provGit(repo, 'rev-parse', 'main');
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B103', provRunner), false);
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B104', provRunner), true, 'the merge brought B104');
    provGit(repo, 'switch', '-q', '-c', 'q');
    const carryOut = new Set();
    const errors = realErrors(uCheck(repo, 'q', pageX, { carryOut }));
    assert.equal(ofPrefix(errors, `${UNMERGED_LANE_ROW_ERROR_PREFIX}B103`).length, 1, JSON.stringify(errors));
    assert.deepEqual([...carryOut], ['B103']);
  });
});

test('#3529 pass 2: a live-only row origin/main has ever carried is a discharge, whatever the provenance', () => {
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 104),
    baseline: buildSingleGroupRegister('B', [101, 102], 104),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'once on main', title: 'gone' }],
  });
  for (const provenance of [UNMERGED, merged(['B101', 'B102'])]) {
    const opts = { ...options, publishedProvenance: provenance };
    assert.deepEqual(checkLiveView(working, published, { ...opts, mainEverCarried: (id) => id === 'B103' }), []);
    const never = checkLiveView(working, published, { ...opts, mainEverCarried: () => false });
    assert.equal(ofPrefix(never, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(never));
    // A failed lookup (null) grants no exemption.
    const failed = checkLiveView(working, published, { ...opts, mainEverCarried: () => null });
    assert.equal(ofPrefix(failed, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(failed));
  }
});

test('#3529 pass 2 git: resolveMainEverCarried reads every register main has ever had', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    uCommit(repo, 'lane0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'lane-l', 'lane0001', [101, 102, 103], 104);
    const mainSha = uCommit(repo, 'main0002', [101, 102], 104, 'discharge B103');
    provGit(repo, 'switch', '-q', '-c', 'lane-y');
    uCommit(repo, 'yyyy0001', [101, 102, 104], 105);
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B103', provRunner), true);
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B104', provRunner), false, 'only on an unmerged lane');
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B10', provRunner), false, 'no prefix match');
    const failing = () => ({ status: 128, stdout: '', stderr: 'fatal' });
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B103', failing), null);
  });
});

// 🟠2 sub-point: a union-carried row names its OWNER, never the carrier.
test('#3529 pass 2: a union-carried row names the lane that first committed it, not the carrier', () => {
  const owner = { commit: '0123456789abcdef0123456789abcdef01234567', refs: ['origin/lane-x'] };
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 103),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    extra: { publishedProvenance: merged(['B101', 'B102']), rowOwnerLookup: (id) => (id === 'B103' ? owner : null) },
  });
  const errors = ofPrefix(checkLiveView(working, published, options), UNMERGED_LANE_ROW_ERROR_PREFIX);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0].includes('0123456789ab'), errors[0]);
  assert.ok(errors[0].includes('gh pr list --head lane-x'), errors[0]);
  assert.ok(!errors[0].includes('def5678'), 'must not name the carrier commit');
  assert.ok(!errors[0].includes('main0x1'), 'must not name the carrier publish id');
});

test('#3529 pass 2 git: resolveRowOwner finds the commit and branch that first committed a row', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    const xCommit = uCommit(repo, 'xxxx0001', [101, 102, 103], 104);
    uCommit(repo, 'xxxx0002', [101, 102, 103], 104, 'restamp');
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-k');
    uCommit(repo, 'kkkk0001', [101, 102, 104], 105);
    // A carrier that later COMMITS a union with X's B103 (dated later, so
    // date order is unambiguous) must not be named as its owner.
    provGit(repo, 'switch', '-q', '-c', 'lane-c');
    uWrite(repo, 'cccc0001', [101, 102, 103, 104], 105);
    provGit(repo, 'add', '-A');
    const later = { ...provEnv(), GIT_AUTHOR_DATE: '2030-01-01T01:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T01:00:00Z' };
    assert.equal(spawnSync('git', ['commit', '-qm', 'carrier commits a union'], { cwd: repo, env: later, windowsHide: true }).status, 0);
    provGit(repo, 'switch', '-q', 'lane-k');
    const owner = onbox.resolveRowOwner(repo, PROV_LIVE, 'B103', provRunner);
    assert.equal(owner.commit, xCommit);
    assert.deepEqual(owner.refs, ['lane-x']);
    assert.equal(onbox.resolveRowOwner(repo, PROV_LIVE, 'B109', provRunner), null);
  });
});

// 🟠2: the committed retirement record.
function withRetired(registerText, rowsMd) {
  return registerText.replace(
    '## At a glance',
    `## Retired carried rows\n\nPreamble.\n\n| Row | Owning PR | Closed unmerged | Reason |\n|---|---|---|---|\n${rowsMd}\n## At a glance`,
  );
}
// Review pass 3 (operator decision 4): gh also reports the PR's head branch,
// which must be the branch that first committed the row.
const closedStates = (state, mergedAt = null, headRefName = 'lane-x') => ({
  available: true,
  states: new Map([[3505, { state, mergedAt, headRefName }]]),
});
const OWNER_X = { commit: '0123456789abcdef0123456789abcdef01234567', refs: ['origin/lane-x'] };
const ownerOfB103 = (owner) => (id) => (id === 'B103' ? owner : null);

test('#3529 pass 2: checkRegister accepts a well-formed Retired carried rows table, empty or not, and its absence', () => {
  const reg = MAIN_B();
  assert.deepEqual(checkRegister(reg), []);
  assert.deepEqual(checkRegister(withRetired(reg, '')), []);
  assert.deepEqual(checkRegister(withRetired(reg, '| B103 | #3505 | 2026-10-07 | closed in favour of #3525 |\n')), []);
});

test('#3529 pass 2: checkRegister rejects a malformed Retired carried rows table, naming what is wrong', () => {
  const reg = MAIN_B();
  const cases = [
    ['| B103 | 3505 | 2026-10-07 | r |\n', /PR/],
    ['| B103 | #3505 | Oct 7 | r |\n', /date/],
    ['| B10x | #3505 | 2026-10-07 | r |\n', /row ID/],
    ['| B103 | #3505 | 2026-10-07 |  |\n', /reason/],
    ['| B103 | #3505 | 2026-10-07 |\n', /four cells/],
    ['| B103 | #3505 | 2026-10-07 | r |\n| B103 | #3506 | 2026-10-07 | r |\n', /more than once/],
    ['| B101 | #3505 | 2026-10-07 | r |\n', /still a row/],
  ];
  for (const [rows, pattern] of cases) {
    const errors = checkRegister(withRetired(reg, rows));
    assert.equal(errors.length, 1, `${rows}: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /Retired carried rows/);
    assert.match(errors[0], pattern);
  }
  const wrongHeader = withRetired(reg, '').replace('| Row | Owning PR | Closed unmerged | Reason |', '| ID | PR | Date | Why |');
  assert.match(checkRegister(wrongHeader)[0] ?? '', /Retired carried rows.*table/);
  const noTable = reg.replace('## At a glance', '## Retired carried rows\n\nNo table here.\n\n## At a glance');
  assert.match(checkRegister(noTable)[0] ?? '', /Retired carried rows.*table/);
});

function retiredCase(registerRows, extra = {}) {
  return checkLiveView(
    ...collisionOptions({
      working: withRetired(buildSingleGroupRegister('B', [101, 102], 103), registerRows),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { rowOwnerLookup: ownerOfB103(OWNER_X), ...extra },
    }),
  );
}
const RETIRED_B103 = '| B103 | #3505 | 2026-10-07 | closed in favour of #3525 |\n';

test('#3529 pass 2: a retired row whose PR is closed unmerged is dropped from the must-carry set', () => {
  assert.deepEqual(retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED') }), []);
});

test('#3529 pass 2: a malformed Retired carried rows table fails the --against-published run too', () => {
  const errors = retiredCase('| B103 | 3505 | 2026-10-07 | r |\n', { retiredPrStates: closedStates('CLOSED') });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000');
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /PR/);
});

test('#3529 pass 2: a retirement record naming an OPEN PR is refused, naming the PR, and mutes nothing', () => {
  const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('OPEN') });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000');
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /#3505/);
  assert.match(retired[0], /OPEN/);
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'the row still must be carried');
});

test('#3529 pass 2: a retirement record naming a MERGED PR is refused', () => {
  for (const states of [closedStates('MERGED', '2026-10-07T00:00:00Z'), closedStates('CLOSED', '2026-10-07T00:00:00Z')]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: states });
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000');
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.match(retired[0], /#3505/);
    assert.match(retired[0], /merged/i);
  }
});

test('#3529 pass 2: a PR whose state could not be read is refused; gh unavailable warns and accepts', () => {
  const unreadable = retiredCase(RETIRED_B103, {
    retiredPrStates: { available: true, states: new Map([[3505, { error: 'Could not resolve to a PullRequest' }]]) },
  });
  assert.equal(ofPrefix(unreadable, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000').length, 1, JSON.stringify(unreadable));
  for (const states of [{ available: false, reason: 'gh is not installed' }, undefined]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: states });
    const warnings = ofPrefix(errors, onbox.RETIRED_ROW_WARNING_PREFIX ?? '\u0000');
    assert.equal(warnings.length, 1, JSON.stringify(errors));
    assert.match(warnings[0], /#3505/);
    assert.match(warnings[0], /owns/);
    assert.deepEqual(errors.filter((e) => !warnings.includes(e)), []);
  }
});

test('#3529 pass 2: a retirement recorded on origin/main applies to a branch that predates it', () => {
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 103),
    baseline: withRetired(MAIN_B(), RETIRED_B103),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    extra: { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup: ownerOfB103(OWNER_X) },
  });
  assert.deepEqual(checkLiveView(working, published, options), []);
});

// Review pass 3, 🟡1 (P3a) and operator decision 4: a retirement is honoured
// only when the named PR's head branch is the branch that first committed
// the row. A wrong PR number cannot mute a live lane.
test('#3529 pass 3 P3a: a retirement naming an unrelated closed PR is refused, naming both branches, and mutes nothing', () => {
  const states = { available: true, states: new Map([[3509, { state: 'CLOSED', mergedAt: null, headRefName: 'fix/unrelated' }]]) };
  const errors = retiredCase('| B103 | #3509 | 2026-10-07 | typo for #3505 |\n', { retiredPrStates: states });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /#3509/);
  assert.match(retired[0], /fix\/unrelated/);
  assert.match(retired[0], /lane-x/);
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'the row still must be carried');
});

test('#3529 pass 3: a retirement whose PR head branch is the row owner\'s branch is honoured, local or remote ref', () => {
  for (const refs of [['origin/lane-x'], ['lane-x'], ['lane-y', 'origin/lane-x']]) {
    const errors = retiredCase(RETIRED_B103, {
      retiredPrStates: closedStates('CLOSED'),
      rowOwnerLookup: ownerOfB103({ ...OWNER_X, refs }),
    });
    assert.deepEqual(errors, [], JSON.stringify(refs));
  }
});

test('#3529 pass 3: a retirement whose row owner cannot be determined is refused, naming the PR branch and how to fetch it', () => {
  for (const rowOwnerLookup of [() => null, () => ({ ...OWNER_X, refs: [] }), undefined]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup });
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.match(retired[0], /#3505/);
    assert.match(retired[0], /lane-x/);
    assert.match(retired[0], /git fetch origin pull\/3505\/head:lane-x/);
    assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'the row still must be carried');
  }
});

test('#3529 pass 3: a retirement whose PR head branch gh did not report is refused', () => {
  const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED', null, null) });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /#3505/);
  assert.match(retired[0], /head branch/);
});

test('#3529 pass 3: the owner is looked up only for a retired row the live page still carries', () => {
  let lookups = 0;
  const [working, published, options] = collisionOptions({
    working: withRetired(buildSingleGroupRegister('B', [101, 102], 103), RETIRED_B103),
    trackedRows: baseRows,
    publishedRows: baseRows,
    extra: { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup: () => (lookups++, null) },
  });
  assert.deepEqual(checkLiveView(working, published, options), []);
  assert.equal(lookups, 0, 'a retired row no longer live needs no owner — its branch may be long gone');
});

test('#3529 pass 2: resolveRetiredPrStates reads gh through an injected runner, never the network', () => {
  const calls = [];
  const gh = (states) => (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    const n = Number(args[2]);
    if (!(n in states)) return { status: 1, stdout: '', stderr: 'Could not resolve to a PullRequest' };
    return { status: 0, stdout: JSON.stringify(states[n]), stderr: '' };
  };
  const r = onbox.resolveRetiredPrStates(
    '/repo',
    [3505, 3506, 3507, 3508],
    gh({
      3505: { state: 'CLOSED', mergedAt: null, headRefName: 'lane-x' },
      3506: { state: 'OPEN', mergedAt: null, headRefName: 'lane-o' },
      3508: { state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z', headRefName: 'lane-m' },
    }),
  );
  assert.equal(r.available, true);
  assert.deepEqual(r.states.get(3508), { state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z', headRefName: 'lane-m' });
  assert.deepEqual(r.states.get(3505), { state: 'CLOSED', mergedAt: null, headRefName: 'lane-x' });
  assert.equal(r.states.get(3506).state, 'OPEN');
  assert.match(r.states.get(3507).error, /Could not resolve/);
  assert.ok(calls.some((c) => c === 'pr view 3505 --json state,mergedAt,headRefName'), calls.join('\n'));
  calls.length = 0;
  assert.deepEqual(onbox.resolveRetiredPrStates('/repo', [], gh({})).states.size, 0);
  assert.deepEqual(calls, [], 'no entries, no gh calls');
  const noGh = onbox.resolveRetiredPrStates('/repo', [3505], () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }));
  assert.equal(noGh.available, false);
  const noAuth = onbox.resolveRetiredPrStates('/repo', [3505], (args) =>
    args[0] === 'auth' ? { status: 1, stdout: '', stderr: 'not logged in' } : assert.fail('must not query a PR unauthenticated'),
  );
  assert.equal(noAuth.available, false);
  assert.match(noAuth.reason, /not authenticated|not logged in/);
});

// 🟠3: `--publishing` checks the WHOLE file.
const theirsB103 = { id: 'B103', body: 'theirs a', title: THEIRS_TITLE };
const theirsB104 = { id: 'B104', body: 'theirs b', title: 'second row from the unmerged lane' };
const mineB105 = { id: 'B105', body: 'mine', title: MINE_TITLE };
function unionFixture() {
  const tracked = buildRowContentLiveView([...baseRows, mineB105], 'B');
  const live = buildRowContentLiveView([...baseRows, theirsB103, theirsB104], 'B');
  const [working, , options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102, 105], 106),
    trackedRows: [...baseRows, mineB105],
    publishedRows: [],
  });
  return { tracked, live, working, options };
}

test('#3529 pass 2: buildUnionLiveView inserts carried blocks in ID order and regenerates the derived figures', () => {
  const { tracked, live } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B104', 'B103']);
  assert.equal(union, buildRowContentLiveView([...baseRows, theirsB103, theirsB104, mineB105], 'B'));
});

// Review pass 3, 🟡5 (R2/R3): with two groups, a carried Group B row lands in
// Group B's section and raises only Group B's glance count and gcount. Every
// earlier union test had a single group, so a lookup that ignored the letter
// stayed green.
test('#3529 pass 3: in a two-group view the union carries each row into its own group and raises only its figures', () => {
  const twoGroup = (bRows) => {
    const a = buildRowContentLiveView([{ id: 'A101', body: 'a', title: 'ta' }], 'A');
    const html = a
      .replace('<div class="n owed">1</div>', `<div class="n owed">${1 + bRows.length}</div>`)
      .replace('    </tbody>', `      <tr><td><a href="#gb">B</a></td><td>Setup B</td><td>${bRows.length}</td></tr>\n    </tbody>`);
    const bBlocks = bRows
      .map(
        (r) =>
          `    <details class="item">\n      <summary><span class="num">${r.id}</span><span class="iname">${r.title}</span><span class="risk">default</span></summary>\n      <div class="body">\n        <p>${r.body}</p>\n      </div>\n    </details>`,
      )
      .join('\n');
    return html.replace(
      '</section>\n',
      `</section>\n\n  <section class="group" id="gb">\n    <h3 class="gtitle"><span class="gtag">B</span> Setup B <span class="gcount">${bRows.length} rows</span></h3>\n${bBlocks}\n  </section>\n`,
    );
  };
  const b = (n) => ({ id: `B${n}`, body: `b${n}`, title: `t${n}` });
  const tracked = twoGroup([b(101), b(102), b(105)]);
  const live = twoGroup([b(101), b(102), b(103), b(104)]);
  assert.equal(onbox.buildUnionLiveView(tracked, live, ['B104', 'B103']), twoGroup([b(101), b(102), b(103), b(104), b(105)]));
});

test('#3529 pass 2: a union built by buildUnionLiveView passes --publishing, CRLF or not', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']);
  assert.deepEqual(checkLiveView(working, live, { ...options, publishingHtml: union }), []);
  assert.deepEqual(checkLiveView(working, live, { ...options, publishingHtml: union.replace(/\n/g, '\r\n') }), [], 'CRLF');
});

test('#3529 pass 2 S6: a union missing one of your own rows fails, naming it', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']);
  const block101 = union.match(/ {4}<details class="item">\s*<summary><span class="num">B101<\/span>[\s\S]*?<\/details>\n/)[0];
  const errors = checkLiveView(working, live, { ...options, publishingHtml: union.replace(block101, '') });
  const pub = ofPrefix(errors, PUBLISHING_FILE_ERROR_PREFIX);
  assert.ok(pub.some((e) => /B101/.test(e)), JSON.stringify(errors));
});

test('#3529 pass 2: a union whose copy of your own row differs fails, naming it', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']).replace('<p>mine</p>', '<p>stale mine</p>');
  const pub = ofPrefix(checkLiveView(working, live, { ...options, publishingHtml: union }), PUBLISHING_FILE_ERROR_PREFIX);
  assert.ok(pub.some((e) => /B105/.test(e)), JSON.stringify(pub));
});

test('#3529 pass 2: a hand-built union whose derived figures were not regenerated fails, naming --build-union', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']).replace('<div class="n owed">5</div>', '<div class="n owed">3</div>');
  const pub = ofPrefix(checkLiveView(working, live, { ...options, publishingHtml: union }), PUBLISHING_FILE_ERROR_PREFIX);
  assert.equal(pub.length, 1, JSON.stringify(pub));
  assert.match(pub[0], /--build-union/);
});

test('#3529 pass 2: a union carrying a row that is neither yours nor live fails, naming it', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']).replace('<span class="num">B104</span>', '<span class="num">B107</span>');
  const pub = ofPrefix(checkLiveView(working, live, { ...options, publishingHtml: union }), PUBLISHING_FILE_ERROR_PREFIX);
  assert.ok(pub.some((e) => /B107/.test(e) && /neither/.test(e)), JSON.stringify(pub));
});

test('#3529 pass 2: buildUnionLiveView refuses a carried row whose group has no section in your live view', () => {
  const tracked = buildRowContentLiveView(baseRows, 'B');
  const iView = buildRowContentLiveView([{ id: 'I101', body: 'theirs' }], 'I');
  const live = `${tracked}\n${iView.slice(iView.indexOf('  <section'))}`;
  assert.throws(() => onbox.buildUnionLiveView(tracked, live, ['I101']), /Group I/);
  assert.throws(() => onbox.buildUnionLiveView(tracked, live, ['B109']), /not on the live page/);
  assert.throws(() => onbox.buildUnionLiveView(tracked, live, ['B101']), /already in your live view/);
});

// 🟠4: the whole-group paths.
test('#3529 pass 2 S7: in a group this register dropped entirely, another lane’s row is classified, and --discharging cannot silence it', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildMultiGroupRegister([
    { letter: 'A', rowNumbers: [1] },
    { letter: 'F', rowNumbers: [1] },
  ]);
  const liveView = buildMultiGroupLiveView(3, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'F', glanceCount: 2, headerCount: 2, rowIds: ['F1', 'F2'] },
  ]);
  const opts = { direction: 'extraOnly', baselineText: baselineRegister, publishedProvenance: UNMERGED };
  for (const named of [['F1'], ['F1', 'F2']]) {
    const errors = checkLiveView(workingRegister, liveView, { ...opts, dischargingIds: named });
    const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.deepEqual(unmerged.map((e) => e.match(/^unmerged-lane-row: ([A-Z]\d+):/)?.[1]), ['F2'], JSON.stringify(errors));
    assert.ok(!errors.some((e) => /BEHIND/.test(e) && /F2/.test(e)), `F2 is not BEHIND-routed: ${JSON.stringify(errors)}`);
    assert.equal(ofPrefix(errors, DISCHARGE_NAME_ERROR_PREFIX).length, 0, JSON.stringify(errors));
  }
  // The discharge itself still passes when nothing else is on the page.
  const clean = buildMultiGroupLiveView(2, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'F', glanceCount: 1, headerCount: 1, rowIds: ['F1'] },
  ]);
  assert.deepEqual(checkLiveView(workingRegister, clean, { ...opts, dischargingIds: ['F1'] }), []);
});

// 🟡2: pass-2 survivors M7 and M8.
test('#3529 pass 2 (M7): on your own page, a row your stamp did NOT commit is not exempt from the collision check', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      // Your union publish carried B103 for another lane; your stamp did not.
      extra: { publishedProvenance: own(['B101', 'B102']) },
    }),
  );
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 1, JSON.stringify(errors));
});

test('#3529 pass 2 (M8): a same-ID title difference under unknown provenance is reported, not skipped', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'x' } },
    }),
  );
  const unknown = ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX);
  assert.equal(unknown.length, 1, JSON.stringify(errors));
  assert.match(unknown[0], /B103/);
  // B103 is in your own file, so "carry it" is not the way forward.
  assert.ok(!unknown[0].includes('--build-union'), unknown[0]);
  assert.match(unknown[0], /renumber/);
});

// 🟡3: an unreadable merge-base only matters when a verdict depends on it.
test('#3529 pass 2: an unreadable merge-base is silent unless an ID is shared with origin/main under another title', () => {
  const quiet = checkLiveView(
    ...collisionOptions({ trackedRows: baseRows, publishedRows: baseRows, extra: { mergeBaseText: null } }),
  );
  assert.deepEqual(quiet, []);
  const mainRegister = buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Theirs');
  const mineRegister = buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Mine');
  const loud = checkLiveView(mineRegister, buildRowContentLiveView(baseRows, 'B'), {
    direction: 'extraOnly',
    baselineText: mainRegister,
    publishedProvenance: merged(['B101', 'B102']),
    mergeBaseText: null,
  });
  const unknown = ofPrefix(loud, UNKNOWN_PROVENANCE_ERROR_PREFIX);
  assert.equal(unknown.length, 1, JSON.stringify(loud));
  assert.match(unknown[0], /B103/);
  assert.match(unknown[0], /merge-base/);
});

// 🟡4: the unknown-provenance error gives the next step.
test('#3529 pass 2: the unknown-provenance error names both ways forward — fetch, or carry the rows', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102], 103),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'x' } },
    }),
  );
  const unknown = ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX)[0] ?? '';
  assert.match(unknown, /--build-union/);
  assert.match(unknown, /--publishing/);
});

// ---------------------------------------------------------------------------
// CLI wiring against REAL git (🟡2: pass-2 mutants M20/M21 unwired the real
// provenance and merge-base lookups with the whole suite green, because every
// other CLI test runs under ONBOX_TEST_BASELINE_FILE, which skips both). A
// throwaway repo with a bare `origin`, the CLI copied into it, no overrides.
// ---------------------------------------------------------------------------
const CLI_FILES = ['check-onbox-register.mjs', 'git-env.mjs', 'gh.mjs', 'publish-token.mjs', join('lib', 'is-main-module.mjs')];
// No ambient GitHub token may make the real gh lookup authenticated here.
function withoutGhTokens(env) {
  for (const key of Object.keys(env)) {
    if (/^(GH|GITHUB)_(TOKEN|ENTERPRISE_TOKEN)$/i.test(key)) delete env[key];
  }
  return env;
}
function withCliRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'onbox-cli-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'work');
  try {
    mkdirSync(repo);
    provGit(root, 'init', '-q', '--bare', '-b', 'main', origin);
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    provGit(repo, 'remote', 'add', 'origin', origin);
    for (const f of CLI_FILES) {
      mkdirSync(dirname(join(repo, 'scripts', f)), { recursive: true });
      writeFileSync(join(repo, 'scripts', f), readFileSync(join(HERE, '..', f)));
    }
    writeFileSync(join(repo, '.gitignore'), 'scripts/\n*.saved.html\n');
    return fn(repo, (args, env = {}) =>
      spawnSync(process.execPath, [join(repo, 'scripts', 'check-onbox-register.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 120000,
        env: withoutGhTokens({ ...provEnv(), ...env }),
        windowsHide: true,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const titled = (nums, titles) =>
  nums.map((n) => ({ id: `B${n}`, body: `body B${n}`, title: titles[n] ?? `title B${n}` }));
function cliCommit(repo, nonce, nums, next, titles = {}, retiredRows = null) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  writeFileSync(
    join(repo, PROV_LIVE),
    buildRowContentLiveView(titled(nums, titles), 'B').replace(
      '<title>',
      `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n<title>`,
    ),
  );
  let reg = buildSingleGroupRegister('B', nums, next);
  for (const [n, t] of Object.entries(titles)) reg = reg.replace(`### B${n} · thing ${n}`, `### B${n} · ${t}`);
  if (retiredRows !== null) reg = withRetired(reg, retiredRows);
  writeFileSync(join(repo, PROV_REGISTER), reg);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `stamp ${nonce}`);
}

test('#3529 pass 2 CLI: real provenance, merge-base, ever-carried, owner and gh lookups are all wired', () => {
  withCliRepo((repo, cli) => {
    cliCommit(repo, 'main0001', [101, 102], 103);
    provGit(repo, 'push', '-q', 'origin', 'main');
    // mine forks here, mints its own B103, discharges B102 and retires an
    // unrelated B109 (a retirement the real gh lookup must try to confirm).
    provGit(repo, 'switch', '-q', '-c', 'mine');
    cliCommit(repo, 'mine0001', [101, 103], 104, { 103: 'Mine' }, '| B109 | #1 | 2026-10-07 | test fixture |\n');
    // lane-y mints a different B103 and merges first.
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-y');
    cliCommit(repo, 'yyyy0001', [101, 102, 103], 104, { 103: 'Theirs Y' });
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'merge', '-q', '--no-ff', '--no-edit', 'lane-y');
    provGit(repo, 'push', '-q', 'origin', 'main');
    // lane-x, unmerged, adds B104 and publishes.
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    cliCommit(repo, 'xxxx0001', [101, 102, 103, 104], 105, { 103: 'Theirs Y', 104: 'X row' });
    const page = readFileSync(join(repo, PROV_LIVE), 'utf8');
    // main then discharges B102 — which lane-x's page still carries.
    provGit(repo, 'switch', '-q', 'main');
    cliCommit(repo, 'main0003', [101, 103], 104, { 103: 'Theirs Y' });
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'mine');
    writeFileSync(join(repo, 'page.saved.html'), page);
    // gh made unauthenticated (or absent): the real lookup must say so.
    const ghHome = mkdtempSync(join(tmpdir(), 'onbox-gh-'));
    const env = { GH_CONFIG_DIR: ghHome };
    let r;
    try {
      r = cli(['--against-published', 'page.saved.html'], env);
    } finally {
      rmSync(ghHome, { recursive: true, force: true });
    }
    assert.ok(!r.stderr.includes('unmerged-lane-row: B102'), `main has carried B102 — a discharge: ${r.stderr}`);
    assert.match(r.stderr, /retired-row-warning: B109 .*\(gh (is not installed|is not authenticated|could not run)/);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!/WARNING: .*injected/.test(r.stderr), 'no test override in play');
    assert.ok(r.stderr.includes('unmerged-lane-row: B104:'), r.stderr);
    assert.ok(r.stderr.includes('gh pr list --head lane-x'), `names the owning lane: ${r.stderr}`);
    assert.ok(r.stderr.includes('row-id-collision: B103:'), `merged-lane collision via the merge-base: ${r.stderr}`);
  });
});

test('#3529 pass 2 CLI: --build-union writes a union that then passes, and is refused without --against-published or with --publishing', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const env = { ONBOX_TEST_BASELINE_FILE: baselinePath, ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged' };
    const unionPath = join(dirname(publishedPath), 'union.html');
    const built = runCli(['--against-published', publishedPath, '--build-union', unionPath], env);
    assert.equal(built.status, 0, `stdout: ${built.stdout}\nstderr: ${built.stderr}`);
    assert.ok(built.stdout.includes(unionPath) && built.stdout.includes(newId), built.stdout);
    const union = readFileSync(unionPath, 'utf8');
    assert.ok(union.includes(`<span class="num">${newId}</span>`));
    const checked = runCli(['--against-published', publishedPath, '--publishing', unionPath], env);
    assert.equal(checked.status, 0, `stdout: ${checked.stdout}\nstderr: ${checked.stderr}`);
    const both = runCli(['--against-published', publishedPath, '--publishing', unionPath, '--build-union', unionPath], env);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /--build-union cannot be combined with --publishing/);
  });
  const alone = runCli(['--build-union', 'x.html']);
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /--build-union only makes sense alongside --against-published/);
});

test('#3529 pass 2 CLI: a hand-built union with stale figures is refused under --publishing', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  const blockOf = (html, id) =>
    html.match(new RegExp(`<details\\b[^>]*class="item"[^>]*>\\s*<summary><span class="num">${id}</span>[\\s\\S]*?</details>`))[0];
  const mine = blockOf(REAL_LIVE_VIEW_HTML, `B${lastB}`);
  // Rows right, figures not regenerated — the 2026-10-07 hand-edit shape, minus the edit.
  const stale = REAL_LIVE_VIEW_HTML.replace(mine, `${mine}\n    ${blockOf(mutated, `B${lastB + 1}`)}`);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const unionPath = join(dirname(publishedPath), 'union.html');
    writeFileSync(unionPath, stale, 'utf8');
    const r = runCli(['--against-published', publishedPath, '--publishing', unionPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /publishing-file: .*--build-union/);
  });
});

// Review pass 3 (operator decision 4, 🟡5 R4): the retirement check, end to
// end through real git (the owner lookup) and the ONBOX_TEST_GH_PR_STATES
// seam (gh). The seam answers only the PRs the run asks about, so an entry
// the CLI forgot to look up — one only origin/main's register records —
// reads as unresolvable rather than silently passing.
test('#3529 pass 3 CLI: a retirement is honoured only for the closed PR that owns the row, including one only origin/main records', () => {
  withCliRepo((repo, cli) => {
    cliCommit(repo, 'main0001', [101, 102], 103);
    provGit(repo, 'push', '-q', 'origin', 'main');
    // lane-x, never merged, mints B103 and publishes the page.
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    cliCommit(repo, 'xxxx0001', [101, 102, 103], 104, { 103: 'X row' });
    writeFileSync(join(repo, 'page.saved.html'), readFileSync(join(repo, PROV_LIVE), 'utf8'));
    // old forks main before the retirement lands there.
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'old');
    provGit(repo, 'switch', '-q', 'main');
    cliCommit(repo, 'main0002', [101, 102], 103, {}, '| B103 | #77 | 2026-10-08 | lane-x closed unmerged |\n');
    provGit(repo, 'push', '-q', 'origin', 'main');
    const run = (branch, states) => {
      provGit(repo, 'switch', '-q', branch);
      return cli(['--against-published', 'page.saved.html'], { ONBOX_TEST_GH_PR_STATES: states });
    };
    for (const branch of ['main', 'old']) {
      const owned = run(branch, '{"77":{"state":"CLOSED","headRefName":"lane-x"}}');
      assert.equal(owned.status, 0, `${branch}: stdout: ${owned.stdout}\nstderr: ${owned.stderr}`);
      assert.match(owned.stderr, /WARNING: gh PR states injected from ONBOX_TEST_GH_PR_STATES/);
    }
    const wrongPr = run('old', '{"77":{"state":"CLOSED","headRefName":"fix/unrelated"}}');
    assert.equal(wrongPr.status, 1, wrongPr.stderr);
    assert.match(wrongPr.stderr, /retired-carried-row: B103: .*#77.*fix[/]unrelated.*lane-x/);
    assert.ok(wrongPr.stderr.includes('unmerged-lane-row: B103:'), wrongPr.stderr);
    assert.ok(!/BEHIND what is already live/.test(wrongPr.stderr), wrongPr.stderr);
    const open = run('old', '{"77":{"state":"OPEN","headRefName":"lane-x"}}');
    assert.equal(open.status, 1, open.stderr);
    assert.match(open.stderr, /retired-carried-row: B103: .*#77.*OPEN/);
    const unavailable = run('old', 'unavailable');
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.match(unavailable.stderr, /retired-row-warning: B103 .*#77/);
    // The owner's branch gone from this checkout: fail closed, naming the fetch.
    provGit(repo, 'branch', '-q', '-D', 'lane-x');
    const ownerless = run('old', '{"77":{"state":"CLOSED","headRefName":"lane-x"}}');
    assert.equal(ownerless.status, 1, ownerless.stderr);
    assert.match(ownerless.stderr, /retired-carried-row: B103: .*git fetch origin pull[/]77[/]head:lane-x/);
  });
});
