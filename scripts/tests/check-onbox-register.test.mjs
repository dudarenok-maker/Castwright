// Tests for the on-box acceptance register consistency checker.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  checkRegister,
  checkLiveView,
  resolveBaselineText,
  CANNOT_VERIFY_BASELINE_ERROR,
} from '../check-onbox-register.mjs';

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
} = {}) {
  const bodyASection = bodyARows
    .map((n) => `### A${n} · thing ${n}\n\nSome body text.\n`)
    .join('\n');
  const bodyBSection = bodyBRows
    .map((n) => `### B${n} · thing ${n}\n\nSome body text.\n`)
    .join('\n');
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

${bodyASection}
---

## Group B — setup b

${bodyBSection}
---

## Blocked — hardware not available

### Something blocked

Text.
`;
}

test('a coherent register passes with no errors', () => {
  assert.deepEqual(checkRegister(buildRegister()), []);
});

test('the real docs/testing/onbox-acceptance-register.md is internally coherent', () => {
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

test('check 4: non-contiguous row numbers (a duplicate) are reported independently of check 1', () => {
  // Table says 2 for A, and the body has exactly 2 headings — so check 1
  // (count) is satisfied — but they are both numbered A1, a duplicate
  // rather than A1/A2.
  const errors = checkRegister(buildRegister({ bodyARows: [1, 1] }));
  assert.ok(
    errors.some((e) => e.includes('Group A row numbers are not contiguous from 1: found A1, A1')),
    `expected a contiguity error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('glance table says')),
    `did not expect a count-mismatch error alongside the contiguity one, got: ${JSON.stringify(errors)}`,
  );
});

test('check 4: a gap in row numbers is reported', () => {
  const errors = checkRegister(buildRegister({ tableA: 2, bodyARows: [1, 3] }));
  assert.ok(
    errors.some((e) => e.includes('Group A row numbers are not contiguous from 1: found A1, A3')),
    `expected a contiguity error, got: ${JSON.stringify(errors)}`,
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
        'Row heading "### A19b" is not a valid row number. Rows are numbered contiguously (A1, A2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.',
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
        'Row heading "### A2.1 · thing 2 part 1" is not a valid row number. Rows are numbered contiguously (A1, A2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    ),
    `expected the A2.1 rejection, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some(
      (e) =>
        e ===
        'Row heading "### A2.2 · thing 2 part 2" is not a valid row number. Rows are numbered contiguously (A1, A2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    ),
    `expected the A2.2 rejection, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !errors.some((e) => e.includes('are not contiguous')),
    `did not expect a phantom "duplicate row 2" contiguity error, got: ${JSON.stringify(errors)}`,
  );
});

test('review fix 3: an invalid row heading suppresses checks 1 and 4 for that letter, leaving only the rejection messages', () => {
  // The decision comment's own motivating case: A2 split into A2a/A2b (table
  // bumped to 3 to "absorb" the split) instead of annotating a single row's
  // title. Table (3) vs. the one still-valid body row (A1) would otherwise
  // ALSO report a count mismatch on top of the two rejections. Deliberately
  // NOT sized so the counts happen to reconcile (unlike the pre-existing
  // A19b fixture, which dodges this case) — this test fails if fix 3 is
  // reverted.
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
    'Row heading "### A2a · thing 2 part a" is not a valid row number. Rows are numbered contiguously (A1, A2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.',
    'Row heading "### A2b · thing 2 part b" is not a valid row number. Rows are numbered contiguously (A1, A2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.',
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
        'Row heading "### A19b · sub" is not a valid row number. Rows are numbered contiguously (A1, A2, …) — for a row covering more than one debt, annotate its title instead of sub-lettering.',
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

test('a stale owed total in the live view is caught', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ owed: 2 }));
  assert.deepEqual(errors, [
    "Live view says 2 owed but the register says 3. Update the live view's summary strip.",
  ]);
});

test('a stale per-group count in the live view glance table is caught', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ glanceA: 5 }));
  assert.deepEqual(errors, [
    'Live view: glance table says Group A has 5 rows, the register says 2.',
  ]);
});

test("a stale count in a live-view group's own header is caught", () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ headerA: 5 }));
  assert.deepEqual(errors, ["Live view: Group A's header says 5 rows, the register's body has 2."]);
});

// The 2026-07-28 drift, both halves: a row added to the markdown but never
// republished, and a row published from an unmerged branch. They cancelled in
// the total, so only a row-by-row comparison surfaces either.
test('a row present in the register but missing from the live view is caught', () => {
  const errors = checkLiveView(
    buildRegister({ tableA: 3, total: 4, bodyARows: [1, 2, 3] }),
    buildLiveView({ owed: 4, glanceA: 3, headerA: 3, rowsA: ['A1', 'A2'] }),
  );
  assert.ok(
    errors.includes(
      "Live view's Group A section is missing row A3 — present in the register, absent from that section.",
    ),
    `expected the missing-row error, got: ${JSON.stringify(errors)}`,
  );
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

test('two offsetting row errors are both reported, not cancelled in the total', () => {
  // Same count on both sides — only a row-by-row comparison can see this.
  const errors = checkLiveView(buildRegister(), buildLiveView({ rowsA: ['A1', 'A3'] }));
  assert.ok(
    errors.some((e) => e.includes('missing row A2')),
    `expected the missing-row error, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some((e) => e.includes('Group A section has row A3')),
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

// F6: a row filed under the wrong section produced two messages that read as
// contradicting each other, with nothing saying where the row actually sat.
test('a row filed under the wrong group section names both sections', () => {
  const liveView = buildLiveView({ rowsA: ['A1', 'A2', 'B1'], rowsB: [] });
  const errors = checkLiveView(buildRegister(), liveView);
  assert.ok(
    errors.some((e) => e.includes("Live view's Group A section has row B1")),
    `expected the extra-row error to name Group A, got: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    errors.some((e) => e.includes("Live view's Group B section is missing row B1")),
    `expected the missing-row error to name Group B, got: ${JSON.stringify(errors)}`,
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
function buildSingleGroupRegister(letter, rowNumbers) {
  const body = rowNumbers.map((n) => `### ${letter}${n} · thing ${n}\n\nBody text.\n`).join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **${letter}** | Setup ${letter} | ${rowNumbers.length} |

**${rowNumbers.length} owed.** Oldest: **2026-01-01**.

---

## Group ${letter} — setup ${letter.toLowerCase()}

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

// The exact 2026-08-06 shape from #2199: Group C's C1/C2 were discharged and
// C3 renumbered to C1. The live page (fetched before the publish that will
// fix it) still shows all three original IDs; the working register has only
// the renumbered survivor; origin/main already carries the same discharge
// (this change, or an already-merged one) so its baseline copy agrees with
// the working register, not the stale live page.
test('#2199: a discharge + renumber passes when origin/main also lacks the discharged IDs', () => {
  const workingRegister = buildSingleGroupRegister('C', [1]);
  const baselineRegister = buildSingleGroupRegister('C', [1]);
  const liveView = buildSingleGroupLiveView('C', {
    owed: 3,
    glanceCount: 3,
    headerCount: 3,
    rowIds: ['C1', 'C2', 'C3'],
  });
  const errors = checkLiveView(workingRegister, liveView, {
    direction: 'extraOnly',
    baselineText: baselineRegister,
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
      return `## Group ${letter} — setup ${letter.toLowerCase()}\n\n${body}---\n`;
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

test('resolveBaselineText: fetch, then rev-parse FETCH_HEAD, then show <sha>, in that order, on success', () => {
  const calls = [];
  const fakeRunner = (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '', error: undefined };
    if (args[0] === 'rev-parse') {
      return { status: 0, stdout: 'deadbeefcafe\n', stderr: '', error: undefined };
    }
    if (args[0] === 'show') {
      return { status: 0, stdout: 'FAKE REGISTER TEXT', stderr: '', error: undefined };
    }
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  const result = resolveBaselineText(
    '/fake/repo',
    'docs/testing/onbox-acceptance-register.md',
    fakeRunner,
  );
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['fetch', 'rev-parse', 'show'],
    'expected fetch, then rev-parse, then show, in that order',
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
  assert.equal(calls[0].cwd, '/fake/repo');
  assert.equal(calls[1].cwd, '/fake/repo');
  assert.equal(calls[2].cwd, '/fake/repo');
  assert.deepEqual(result, { text: 'FAKE REGISTER TEXT', failedStep: null });
});

test('resolveBaselineText: whitespace/newline around the rev-parsed SHA is trimmed before the show', () => {
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
  resolveBaselineText('/fake/repo', 'reg.md', fakeRunner);
  assert.deepEqual(calls[2], ['show', 'abc123:reg.md']);
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
test("resolveBaselineText: never references origin/main directly at any step, so a narrowed remote refspec can't serve a stale ref (A1)", () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'cafef00d\n', stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: 'FRESH', stderr: '' };
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  const result = resolveBaselineText('/fake/repo', 'reg.md', fakeRunner);
  assert.deepEqual(calls[1], ['rev-parse', 'FETCH_HEAD']);
  assert.deepEqual(calls[2], ['show', 'cafef00d:reg.md']);
  for (const call of calls) {
    assert.ok(
      !call.some((arg) => typeof arg === 'string' && arg.includes('origin/main')),
      `no git call may ever reference origin/main directly, got: ${JSON.stringify(call)}`,
    );
  }
  assert.equal(result.text, 'FRESH');
});

test('resolveBaselineText: a failing fetch (non-zero exit) short-circuits before show ever runs', () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 1, stdout: '', stderr: 'fake fetch failure' };
    return { status: 0, stdout: 'should never be reached', stderr: '' };
  };
  const result = resolveBaselineText('/fake/repo', 'reg.md', fakeRunner);
  assert.deepEqual(result, { text: null, failedStep: 'fetch' });
  assert.deepEqual(calls, ['fetch'], 'show must not run after a failed fetch');
});

test('resolveBaselineText: a spawn error on fetch (e.g. git missing, or a timeout) is also a fetch failure', () => {
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
  const result = resolveBaselineText('/fake/repo', 'reg.md', fakeRunner);
  assert.deepEqual(result, { text: null, failedStep: 'fetch' });
  assert.deepEqual(calls, ['fetch']);
});

test('resolveBaselineText: a failing show (after a successful fetch + rev-parse) is reported as a show failure, not a fetch failure', () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args[0]);
    if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'cafef00d\n', stderr: '' };
    if (args[0] === 'show') return { status: 128, stdout: '', stderr: 'fake show failure' };
    throw new Error(`unexpected git subcommand in test: ${args[0]}`);
  };
  const result = resolveBaselineText('/fake/repo', 'reg.md', fakeRunner);
  assert.deepEqual(result, { text: null, failedStep: 'show' });
  assert.deepEqual(
    calls,
    ['fetch', 'rev-parse', 'show'],
    'show must still run after a successful fetch + rev-parse',
  );
});

test('resolveBaselineText: a failing rev-parse (after a successful fetch) is also reported as a "show" failure, and the show never runs', () => {
  // #2199 review round 5 (optional hardening): rev-parse and show are folded
  // into the same failedStep, deliberately — see resolveBaselineText's own
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
  const result = resolveBaselineText('/fake/repo', 'reg.md', fakeRunner);
  assert.deepEqual(result, { text: null, failedStep: 'show' });
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
const REAL_LIVE_VIEW_HTML = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');
const REAL_REGISTER_TEXT = readFileSync(REAL_REGISTER_PATH, 'utf8');

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
  });
}

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
  return Math.max(...numbers);
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
  return text.slice(0, groupHeadingIdx) + mutatedSection + text.slice(sectionEnd);
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
      /`git show FETCH_HEAD:/,
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
    const r = runCli(['--against-published', filePath], {
      HTTPS_PROXY: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1',
    });
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
// orchestration but stub git out entirely. `HTTPS_PROXY` pointed at a port
// nothing listens on makes git's own fetch attempt fail fast (connection
// refused, no DNS/network dependency either way) without touching this
// repo's git config, remotes, or any tracked state — scoped to this one
// child process's environment only.
test('--against-published fails closed with a NON-ZERO exit when `git fetch origin main` itself fails, and the message names the fetch', () => {
  withTempCopy(REAL_LIVE_VIEW_HTML, (filePath) => {
    const r = runCli(['--against-published', filePath], {
      HTTPS_PROXY: 'http://127.0.0.1:1',
      https_proxy: 'http://127.0.0.1:1',
    });
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
