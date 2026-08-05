// Tests for the on-box acceptance register consistency checker.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { checkRegister, checkLiveView } from '../check-onbox-register.mjs';

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
// tests start from a byte-identical COPY of the real, currently-committed
// live view — known-agreeing with the real register at the time these tests
// run — and mutate the copy, never the checked-in files.
const REAL_LIVE_VIEW_HTML = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');

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

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', timeout: 60000 });
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
  withTempCopy(REAL_LIVE_VIEW_HTML, (filePath) => {
    const r = runCli(['--against-published', filePath]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
    assert.match(
      r.stdout,
      /check:onbox-register: OK/,
      'a genuine pass must print something distinguishing it from the CLI block never ' +
        `having run at all. stdout was: ${JSON.stringify(r.stdout)}`,
    );
  });
});

test('--against-published exits 0 when the saved copy LAGS the register (the normal pre-publish state)', () => {
  // The register is about to gain rows the published page does not have yet
  // — that is the entire reason a publish is happening. Modelled here by
  // decrementing the published owed total, exactly the shape review round 3
  // found being (wrongly) treated as a failure.
  const lagging = REAL_LIVE_VIEW_HTML.replace(
    /<div class="n owed">(\d+)<\/div>/,
    (_, n) => `<div class="n owed">${Number(n) - 4}</div>`,
  );
  assert.notEqual(
    lagging,
    REAL_LIVE_VIEW_HTML,
    'fixture setup: the owed-total span must have matched',
  );
  withTempCopy(lagging, (filePath) => {
    const r = runCli(['--against-published', filePath]);
    assert.equal(
      r.status,
      0,
      `a register that is AHEAD of the published page must not block publishing; got ` +
        `status=${r.status}, stdout=${r.stdout}, stderr=${r.stderr}`,
    );
  });
});

test('--against-published exits 1 and names the row when the published page is AHEAD (has a row the register lacks)', () => {
  // Rename an existing row ID on the published copy so the page carries a row
  // (B4) the register genuinely does not have — the real "lane A already
  // published, lane B hasn't merged that row yet" signature.
  const ahead = REAL_LIVE_VIEW_HTML.replace(
    '<span class="num">B3</span>',
    '<span class="num">B4</span>',
  );
  assert.notEqual(ahead, REAL_LIVE_VIEW_HTML, 'fixture setup: the B3 row ID must have matched');
  withTempCopy(ahead, (filePath) => {
    const r = runCli(['--against-published', filePath]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stdout: ${r.stdout}`);
    assert.match(r.stderr, /BEHIND what is already live/);
    assert.match(r.stderr, /Group B section has row B4/);
    assert.match(
      r.stderr,
      /Do not publish\. Merge the rows named above/,
      'a failing --against-published run must tell the operator to merge the LIVE rows ' +
        'in, not to edit the tracked file down to match the stale page',
    );
    // The inverted-diagnosis shape this test replaces: a "missing" message
    // must never appear, because "register has a row the page doesn't" is
    // not a failure in this mode.
    assert.doesNotMatch(r.stderr, /is missing row/);
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
