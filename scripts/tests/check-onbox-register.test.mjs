// Tests for the on-box acceptance register consistency checker.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRegister, checkLiveView } from '../check-onbox-register.mjs';

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

  <section class="${sectionClass}" id="blocked">
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
      'Live view is missing row A3 — present in the register, absent from the live view.',
    ),
    `expected the missing-row error, got: ${JSON.stringify(errors)}`,
  );
});

test('a row in the live view that the register does not have is caught', () => {
  const errors = checkLiveView(buildRegister(), buildLiveView({ rowsA: ['A1', 'A2', 'A3'] }));
  assert.ok(
    errors.some((e) => e.startsWith('Live view has row A3 that the register does not.')),
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
    errors.some((e) => e.includes('has row A3 that the register does not')),
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
  assert.ok(
    errors.some((e) => e.startsWith('Live view: no `<section class="group">` blocks')),
    `expected the unreadable-sections error, got: ${JSON.stringify(errors)}`,
  );
});

test('the Blocked section and its em-dash rows are ignored on both sides', () => {
  // buildLiveView's Blocked section carries a `—` row and a `BLK` gtag; the
  // default register's glance table carries a `—` Blocked row. Neither may
  // contribute to a count, so the default pair passing is the assertion — this
  // pins it explicitly against a future parser that starts counting them.
  assert.deepEqual(checkLiveView(buildRegister(), buildLiveView()), []);
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
