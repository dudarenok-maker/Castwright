// Tests for the on-box acceptance register consistency checker.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkRegister } from '../check-onbox-register.mjs';

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
