// Tests for scripts/check-register-citations.mjs — the mechanical checker
// for docs/testing/onbox-acceptance-register.md row-ID citations scattered
// across the repo (issue #2629 option 3). Uses synthetic register/file
// fixtures rather than the real register, which changes under us.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseRegisterRows,
  isFrozenPath,
  checkNonexistentIds,
  checkRunSheetLinkage,
  checkConflictingSubjects,
  findUnclassifiedRunSheetMentions,
} from '../check-register-citations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'check-register-citations.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', timeout: 60000 });
}

// A minimal but structurally real register: two groups, a run-sheet
// cross-reference on one row, and a "Blocked" section that reuses a live
// row's ID for cross-reference (mirroring the real register's E6/E8-under-
// Blocked shape) — parsing must not be fooled by it.
function buildRegister() {
  return `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · fs-38 Wave 3 ([#1000](https://github.com/dudarenok-maker/Castwright/issues/1000))

Some body text. Run sheet: \`docs/testing/thing-onbox-acceptance.md\`.

### A2 · Second thing (#1001)

Body two.

---

## Group B — local analyzer only

### B1 · Language gate (#1001)

Same subject as A2 on purpose — legitimately spans two rows.

---

## Blocked — hardware not available

### A2 · Reused heading for cross-reference, not a real row

This must NOT be parsed as a Group A row — it's under Blocked.
`;
}

test('parseRegisterRows: collects row IDs, issue numbers, and run-sheet paths from Group sections only', () => {
  const { rows } = parseRegisterRows(buildRegister());
  assert.deepEqual([...rows.keys()].sort(), ['A1', 'A2', 'B1']);
  assert.deepEqual([...rows.get('A1').issues], [1000]);
  assert.deepEqual([...rows.get('A1').runSheetPaths], ['docs/testing/thing-onbox-acceptance.md']);
  assert.deepEqual([...rows.get('A2').issues], [1001]);
  assert.deepEqual([...rows.get('B1').issues], [1001]);
});

test('parseRegisterRows: a borrowed criteria reference ("already exist in <path>\'s ... section") is not treated as owning that run sheet', () => {
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Owns it (#1)

Run sheet: \`docs/testing/shared-onbox-acceptance.md\`.

### A2 · Borrows from it (#2)

The complete criteria already exist in
\`docs/testing/shared-onbox-acceptance.md\`'s section and are not restated here.

---
`;
  const { rows } = parseRegisterRows(text);
  assert.deepEqual([...rows.get('A1').runSheetPaths], ['docs/testing/shared-onbox-acceptance.md']);
  assert.deepEqual([...rows.get('A2').runSheetPaths], []);
});

test('parseRegisterRows: a bare-filename "Run sheet: [...]" mention (no docs/testing/ prefix) is normalised to the full repo-relative path', () => {
  // The register lives IN docs/testing/, so about half its own run-sheet
  // mentions are bare relative links, e.g.
  // "Run sheet: [`sidecar-evict-latency-onbox-acceptance.md`](...)." —
  // measured directly against the real register. Missing this form was the
  // reason a real injected Check B defect on that exact file went
  // undetected: the row's runSheetPaths set was silently empty.
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Thing (#1000)

Run sheet: \`bare-filename-onbox-acceptance.md\`.

---
`;
  const { rows } = parseRegisterRows(text);
  assert.deepEqual([...rows.get('A1').runSheetPaths], [
    'docs/testing/bare-filename-onbox-acceptance.md',
  ]);
});

test('parseRegisterRows: a row heading reused under Blocked for cross-reference is not a second A2', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // Only one A2 title survives — the Group A one, not the Blocked one.
  assert.equal(rows.get('A2').title.includes('Second thing'), true);
});

// --- Check A: nonexistent ID ---

test('checkNonexistentIds: fires (as a hard error) on a cited ID with no register heading and no annotation', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'See register row A9 for details.';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
  assert.match(errors[0], /docs\/foo\.md/);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: does not fire on a correct citation', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'See register row A1 for details.';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: handles a slash-separated multi-ID citation', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Recorded — register rows A46/B3, run sheet ...';
  const { errors } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes('A46')));
  assert.ok(errors.some((e) => e.includes('B3')));
});

test('checkNonexistentIds: a discharge annotation in the SAME section downgrades the finding to non-fatal, not dropped', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = [
    '## Some section',
    '',
    'Record what was observed — register row B3 was discharged on 2026-08-21',
    'and no longer exists.',
    '',
  ].join('\n');
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
  assert.match(annotated[0], /docs\/foo\.md/);
});

test('checkNonexistentIds: an annotation in a DIFFERENT section does not excuse the citation', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = [
    '## Section one',
    '',
    'register row B3 was discharged and no longer exists.',
    '',
    '## Section two',
    '',
    'See register row A9 for details.',
    '',
  ].join('\n');
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  // B3 (section one) is annotated; A9 (section two, no annotation there) is
  // a hard error — the annotation must not leak across a heading boundary.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

// Pass-6 review of PR #2630 (finding C): paired real-tree injection proved a
// discharge word ANYWHERE in the enclosing section/window excused EVERY
// nonexistent-ID citation in it, not just the one the annotation was
// actually about. Real repro: a `// see register row A44 ...` comment 9
// lines above an unrelated UI-toast assertion whose text happens to contain
// "no longer exists" (about a dead character alias, nothing to do with a
// register row) disarmed the check for A44. Requiring the annotation to
// name the SAME id it excuses closes this without touching any of the 10
// live annotations in the real corpus (each already names its own id right
// next to the discharge word).
test('checkNonexistentIds: a discharge word nearby that does NOT reference the cited ID does not excuse it (finding C)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // Padded with unrelated filler lines (each ~70 chars) so the ID mention
  // and the discharge word sit well over ID_PROXIMITY_CHARS (120) apart,
  // reproducing the real shape: a `no longer exists` UI-toast assertion
  // several lines below an unrelated discharge comment.
  const filler = Array.from(
    { length: 8 },
    (_, n) => `      const someUnrelatedSetupLine${n} = doSomethingElseEntirely(n);`,
  );
  const text = [
    '## Some section',
    '',
    '// see register row A9 for the discharge history this repro pins',
    ...filler,
    'Names the dead target and says it was',
    'no longer exists, so it was not restored.',
    '',
  ].join('\n');
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(annotated.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
});

test('checkNonexistentIds: a discharge annotation that DOES name the cited ID right next to it still excuses it (paired control)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = [
    '## Some section',
    '',
    '// see register row A9 — discharged 2026-08-21, no longer exists.',
    '',
    'Names the dead target and says it was',
    'no longer exists, so it was not restored.',
    '',
  ].join('\n');
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A9/);
});

// Pass-7 review of PR #2630 (finding D): a discharge word within
// ID_PROXIMITY_CHARS of the CITED id used to excuse it even when the
// discharge word actually belongs to a DIFFERENT id on the same multi-ID
// line — real paired injection on `cast-id-drift-onbox-acceptance.md:11`
// ("... and A45 (#2128 audio currency, §9 below), and A99 (Wave 4) — **B3
// is discharged (2026-08-21) ...") smuggled a nonexistent A99 through
// unannotated: the discharge word sat within 120 chars of A45, A99, AND B3,
// so the old per-id-window check excused all three. Binding the discharge
// word to only its own CLAUSE fixes it: the em-dash right before "B3 is
// discharged" opens a new clause (this corpus's own convention for
// introducing a discharge sentence), so an ID named BEFORE that dash — in
// the row list, not the discharge clause — is excluded even though it sits
// well within ID_PROXIMITY_CHARS.
test('checkNonexistentIds: a discharge word on a multi-ID line only excuses IDs in its own clause, not every ID within the window (finding D)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> Register rows: A2 (Wave 1), and A9 (Wave 4) — **B3 is discharged (2026-08-21) ' +
    'and no longer exists.**\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  // A9 is nonexistent and named BEFORE the clause-opening dash, not inside
  // the discharge clause itself — it must still hard-error, not be silently
  // excused by B3's discharge note.
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — the same discharge word DOES excuse the ID it actually sits next to', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '> Register rows: A2 (Wave 1) — **A9 is discharged (2026-08-21) and no longer exists.**\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A9/);
});

// Pass-7 review of PR #2630 (finding I): the existing anchor test's fixture
// ('## 5 · D13 verdict') fails to match HEADING_ID_REGEX with OR without the
// '^' anchor — what saves it is the ID token POSITION ('5', not 'D13'), not
// the anchor itself. Measured tree-wide: the anchored and un-anchored
// regexes match identically on every live file (0 differing lines), so
// deleting '^' from HEADING_ID_REGEX left the 49-test suite fully green —
// the code was right, the proof was hollow. This fixture distinguishes the
// two directly: a blockquoted heading-shaped line does not start the
// string with '#', so the ANCHORED regex must not match it, while an
// un-anchored `test()` would still find "### A48 ·" partway into the line.
test('checkNonexistentIds: a blockquoted heading-shaped line is NOT a citation — pins the "^" anchor directly (finding I)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '> ### A48 · Some quoted heading text\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/testing/onbox-sitting-foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

// --- Check B: bidirectional run-sheet linkage ---
//
// Scoped to the run sheet's HEADER paragraph, not the whole file — see
// check-register-citations.mjs's own comment for why a whole-file scan is a
// false-negative machine: the body legitimately re-mentions the owning row
// elsewhere (Result lines, discharge notes), so it is satisfied by ANY
// mention and never actually tests the header that asserts ownership.

test('checkRunSheetLinkage: fires when the header cites the wrong row, even though the body cites the right one elsewhere', () => {
  // This is the exact defect a whole-file bare-token scan cannot see: A24 is
  // present in the file (in the body), so a whole-file scan would pass it —
  // but the header, the thing that actually asserts ownership, says A19.
  const { rows } = parseRegisterRows(buildRegister());
  const text = [
    '# Thing onbox acceptance',
    '',
    '> Register row: [`onbox-acceptance-register.md` A2](onbox-acceptance-register.md)',
    '',
    '---',
    '',
    '_(Once run, mark the register row A1 discharged.)_',
    '',
  ].join('\n');
  const readFile = () => text;
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A1/);
  assert.match(errors[0], /cites A2 instead/);
});

test('checkRunSheetLinkage: does not fire when the header paragraph cites the row back', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const readFile = () =>
    '# Thing onbox acceptance\n\n> Register row: [A1](onbox-acceptance-register.md)\n\n---\n\nBody.\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 0);
});

test('checkRunSheetLinkage: content below the header\'s `---` is NOT read as the header paragraph, even when it carries a genuine-looking "Register row:" line', () => {
  // Real bug: the previous version of this test put NO "Register row:" line
  // anywhere in the body either, so it passed vacuously — a mutant that
  // deletes extractHeaderRegion's `---`-truncation entirely (returning the
  // whole file) still produced "no header line found" and the test stayed
  // green, because there was nothing past the `---` for the widened scan to
  // wrongly pick up. This fixture puts a real "Register row: A1" line AFTER
  // the `---` (inside what looks like a criteria table, but a plain prose
  // line would trip the same mutant) — a whole-file mutant would find it and
  // wrongly report 0 errors; the real implementation must still fail with
  // "no header line found", because that line sits in the BODY, not the
  // header paragraph the header region is supposed to be bounded to.
  const { rows } = parseRegisterRows(buildRegister());
  const readFile = () =>
    '# Thing\n\n> Some other metadata, no row line.\n\n---\n\n| # | Criterion | Register row |\n' +
    '|---|---|---|\n| 1 | Thing | A1 |\n\nRegister row: A1\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no "Register row\(s\):" header/);
});

// Pass-6 review of PR #2630 (finding F-c): `extractIdTokensWithRanges(paragraph)`
// mutated to `extractIdTokensWithRanges(headerRegion)` at the call site left
// the suite green — real (night-watch C2->C4) repro: the intro prose ABOVE
// the "Register row(s):" line legitimately mentions the CORRECT row
// elsewhere in the header, so a widened scan over the whole header region
// finds that correct mention and wrongly clears a paragraph that actually
// cites the WRONG row. This fixture pins exactly that shape: intro prose
// names A1 (correct), the "Register row(s):" paragraph itself cites A9
// (wrong) — the real implementation must still fail, because only the
// paragraph counts as the assertion of ownership.
test('checkRunSheetLinkage: intro prose above the header paragraph correctly naming the row does NOT excuse the paragraph itself citing the wrong one', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const readFile = () =>
    "# Thing\n\n> This run sheet is A1's own criteria walkthrough.\n>\n" +
    '> Register row: A9\n\n---\n\nBody.\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /named by register row A1/);
  assert.match(errors[0], /cites A9 instead/);
});

test('checkRunSheetLinkage: expands an en-dash ID range so a row inside it counts as cited', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // A1 must sit STRICTLY INSIDE a written range, unreachable by the bare-
  // token scan alone — "A0-A2" contains the literal substrings "A0" and
  // "A2", never "A1", so A1 is only found via range expansion. (The
  // previous fixture, "A1-A2" asserting on A1, was vacuous: A1 is the
  // range's own spelled-out start endpoint, already matched by the plain
  // bare-token scan with the range loop deleted entirely — see the mutation
  // note this test now guards against.)
  const readFile = () => '# Thing\n\n> Register rows: A0-A2\n\n---\n\nBody.\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 0);
});

test('checkRunSheetLinkage: skips past a leading YAML frontmatter fence before looking for the real header', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const readFile = () =>
    '---\nstatus: draft\n---\n\n# Thing\n\n> Register row: A1\n\n---\n\nBody.\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 0);
});

test('checkRunSheetLinkage: a header with no "Register row(s):" line is its own distinct, visible finding', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const readFile = () => '# Thing onbox acceptance\n\n> Some other metadata, no row line.\n\n---\n\nBody.\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no "Register row\(s\):" header/);
});

test('checkRunSheetLinkage: reports a missing run-sheet file rather than throwing', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const readFile = () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  };
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not found|missing/i);
});

// --- Check B ownership markers + unclassified-mention visibility ---
//
// The register uses TWO ownership phrasings, measured directly against the
// real file: prose "run sheet", and the structured bold field
// `*Criteria:*` (e.g. language-recurrence-onbox-acceptance.md's rows). A
// checker recognising only the first silently never evaluates the second —
// and, worse, never SAYS it isn't evaluating it. These tests cover both: the
// `*Criteria:*` marker is recognised and enforced, and any mention neither
// marker classifies as owned is surfaced by name rather than left invisible.

test('parseRegisterRows: a "*Criteria:*"-introduced run sheet is classified as OWNED, not just mentioned', () => {
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Thing (#1000)

*Needs:* a single 8 GB GPU. *Criteria:*
[\`criteria-field-onbox-acceptance.md\`](criteria-field-onbox-acceptance.md)
§Some gate. *Cost:* short.

---
`;
  const { rows } = parseRegisterRows(text);
  assert.deepEqual([...rows.get('A1').runSheetPaths], [
    'docs/testing/criteria-field-onbox-acceptance.md',
  ]);
});

test('checkRunSheetLinkage: a "*Criteria:*"-owned run sheet with the wrong header still fails', () => {
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Thing (#1000)

*Criteria:*
[\`criteria-field-onbox-acceptance.md\`](criteria-field-onbox-acceptance.md)
§Some gate.

---
`;
  const { rows } = parseRegisterRows(text);
  const readFile = () =>
    '# Criteria field\n\n> Register row: A2\n\n---\n\nBody.\n';
  const errors = checkRunSheetLinkage(rows, readFile);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A1/);
  assert.match(errors[0], /cites A2 instead/);
});

test('parseRegisterRows: "*Criteria:* `path`\'s ... section" is a borrowed reference, not ownership, even though it has the bold marker', () => {
  // A39's real body shape: "*Criteria:* `docs/testing/fs38-wave3-onbox-
  // acceptance.md`'s `#2026 — ...` section" — the possessive "'s" names a
  // SECTION within another row's run sheet, not A39's own. Without this
  // exclusion, A39 misclassifies as owning fs38-wave3-onbox-acceptance.md
  // and Check B then falsely fails it (that file's header correctly names
  // its real owner, A1, not A39) — this was a real defect this sweep
  // introduced and caught against the live register, not a hypothetical.
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Owns it (#1000)

Run sheet: \`docs/testing/thing-onbox-acceptance.md\`.

### A2 · Borrows a subsection of it (#1001)

*Needs:* a thing. *Criteria:* \`docs/testing/thing-onbox-acceptance.md\`'s
\`#1001 — extra criteria\` section.

---
`;
  const { rows } = parseRegisterRows(text);
  assert.deepEqual([...rows.get('A2').runSheetPaths], []);
  assert.deepEqual([...rows.get('A2').mentionedRunSheetPaths], [
    'docs/testing/thing-onbox-acceptance.md',
  ]);
});

test('findUnclassifiedRunSheetMentions: a mentioned-but-unowned run sheet (a borrowed reference) is listed, not silently dropped', () => {
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Owns it (#1000)

Run sheet: \`docs/testing/thing-onbox-acceptance.md\`.

### A2 · Borrows from it (#1001)

The complete criteria already exist in
\`docs/testing/thing-onbox-acceptance.md\`'s section and are not restated here.

---
`;
  const { rows } = parseRegisterRows(text);
  const unclassified = findUnclassifiedRunSheetMentions(rows);
  assert.deepEqual(unclassified, [
    { path: 'docs/testing/thing-onbox-acceptance.md', id: 'A2' },
  ]);
  // A1 owns it outright — must not ALSO show up as unclassified.
  assert.ok(!unclassified.some((u) => u.id === 'A1'));
});

// --- Check C: one subject, conflicting IDs ---

test('checkConflictingSubjects: does not fire when a subject legitimately spans two register rows', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', 'See register row A2 (#1001) and register row B1 (#1001) — both are correct.'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: fires (wrongId, FATAL) when a heading pairs an existing ID with the wrong subject', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // #1000 legitimately maps only to A1 in the register. A "### A2 · ... (#1000)"
  // heading is an existing-but-wrong citation on its own line — the shape
  // PR #2630's finding A actually was (a uniform ID shift across headings).
  // Pass 7 (finding G): this class is now `wrongId` — FATAL, not exploratory.
  const files = new Map([['docs/bar.md', '### A2 · Some pack section (#1000)\n\nBody.\n']]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /A2/);
  assert.match(wrongId[0], /1000/);
  assert.match(wrongId[0], /A1/); // names the legitimate ID(s) for the subject
});

test('checkConflictingSubjects: fires the same way (wrongId) off a "Criteria source:" line', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '> **Criteria source:** `onbox-acceptance-register.md` A2 (#1000).\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /A2/);
  assert.match(wrongId[0], /1000/);
  assert.match(wrongId[0], /A1/);
});

test('checkConflictingSubjects: the "row(s) ID" prose idiom alone is NOT a Check C surface any more', () => {
  // Narrowed (finding D, PR #2630 pass 6): a bare "row A2 (#1000)" prose
  // sentence used to be Check C's only surface, but same-line scoping over
  // that surface can't disambiguate a line naming several rows at once (the
  // measured false-positive shape) — Check C now trusts only a heading or a
  // "Criteria source:" line, each of which can only ever name one row.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([['docs/bar.md', 'See register row A2 (#1000) for the fix.']]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: a "### A6 + A7 · ..." two-row heading is checked for BOTH IDs', () => {
  // Pass-7 review of PR #2630 (finding F): the heading surface used to
  // capture only the first ID token, so a real two-row heading shape
  // (`onbox-sitting-voice-design.md:80`'s "### A6 + A7 · ...") silently
  // skipped checking its second ID entirely. #1000 legitimately maps only to
  // A1 — a "### A2 + A1 · ... (#1000)" heading is wrong for its first ID
  // (A2) and right for its second (A1); both must be evaluated.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([['docs/bar.md', '### A2 + A1 · Some combined section (#1000)\n\nBody.\n']]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /A2/);
  assert.doesNotMatch(wrongId[0], /cited A1/);
});

test('checkConflictingSubjects: warns (unknownSubject, non-fatal) when the paired subject number maps to NO current register row at all', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    // #9999 is in no register heading — a "Criteria source:" line naming A1
    // for it must still warn rather than silently pass, but as the
    // exploratory/non-fatal `unknownSubject` class, not `wrongId`.
    ['docs/bar.md', '> **Criteria source:** `onbox-acceptance-register.md` A1 for #9999.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 1);
  assert.match(unknownSubject[0], /A1/);
  assert.match(unknownSubject[0], /9999/);
  assert.match(unknownSubject[0], /does not appear in any current register row heading/);
});

// --- frozen-path exclusion ---

test('isFrozenPath: excludes the documented frozen globs', () => {
  assert.equal(isFrozenPath('docs/testing/onbox-wave3-results/step-1.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-wave4-results/x.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-wave5-results/x.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-acceptance-staleness-audit.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-wave3-plan.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-wave4-linkage.md'), true);
  assert.equal(isFrozenPath('docs/release-notes-next.md'), true);
  assert.equal(isFrozenPath('RELEASE_NOTES.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-acceptance-register.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-acceptance-register-live-view.html'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-sitting-plan.md'), false);
  assert.equal(isFrozenPath('docs/features/278-cast-character-identity.md'), false);
  // Pass-7 review of PR #2630 (finding B): `docs/features/archive/` used to
  // be frozen wholesale, hiding a live nonexistent-ID citation one directory
  // over from the isStableSuperpowersDoc shape pass 6 already fixed. It is
  // no longer exempted — an archived plan's own "Ship notes"/discharge
  // annotation is what legitimately excuses a stale citation now, same as
  // anywhere else in the tree.
  assert.equal(isFrozenPath('docs/features/archive/44-pr-hygiene.md'), false);
  assert.equal(
    isFrozenPath('docs/features/archive/283-castwright-local-rebind.md'),
    false,
  );
});

// Pass-6 review of PR #2630 (finding B): `isStableSuperpowersDoc` used to
// exclude any docs/superpowers/** file from Check A wholesale when its own
// leading frontmatter said `status: stable`, on the theory that a stable
// spec/plan is a frozen design record. That theory was false — a stable
// doc's "Owed acceptance (on-box)" section is a LIVE pointer, not history,
// and the exclusion hid exactly this shape going stale in the real repo
// (2026-08-13-language-recurrence-and-prompt-design.md cited nonexistent
// `A46`/`B3` while its non-excluded sibling plan file had already been
// corrected). This pins that a `status: stable` docs/superpowers/** file is
// no longer special-cased: an unannotated nonexistent-ID citation inside one
// is a Check A error like anywhere else in the tree.
test('checkNonexistentIds: a status: stable docs/superpowers/** file is NOT excluded — an unannotated nonexistent ID inside one still errors', () => {
  const registerText = buildRegister();
  const { rows } = parseRegisterRows(registerText);
  const text =
    '---\nstatus: stable\n---\n\n' +
    '**Owed acceptance (on-box):** register rows A46 for the still-owed acceptance.\n';
  const { errors, annotated } = checkNonexistentIds(
    text,
    'docs/superpowers/specs/x-design.md',
    rows,
  );
  assert.equal(annotated.length, 0);
  assert.ok(
    errors.some((e) => e.includes('cited A46')),
    `expected an A46 error, got: ${JSON.stringify(errors)}`,
  );
});

test('checkNonexistentIds: a status: active docs/superpowers/** file was never excluded either — unaffected by the removal', () => {
  const registerText = buildRegister();
  const { rows } = parseRegisterRows(registerText);
  const text = '---\nstatus: active\n---\n\nSee register row A46 for the still-owed acceptance.\n';
  const { errors } = checkNonexistentIds(text, 'docs/superpowers/plans/x.md', rows);
  assert.ok(errors.some((e) => e.includes('cited A46')));
});

// --- Check A: annotation must be ADJACENT to the citation it excuses ---
//
// Real bug: enclosingSectionText bounded a citation to "the nearest
// enclosing markdown heading" — but NO .ts/.tsx/.mjs/.html/.json/.yml file
// (and some .md files) has any heading at all, so the "section" silently
// became the WHOLE FILE, and one occurrence of "discharged"/"no longer
// exists" ANYWHERE in it disarmed Check A for the entire file. Measured: an
// injected nonexistent `A44` in `src/views/cast.test.tsx` was excused by an
// unrelated UI-toast assertion 296 lines away ("the 'wren' alias no longer
// exists"). These tests pin the fix: a small, bounded window when no small
// heading-bounded section exists.

test('checkNonexistentIds: an unrelated discharge phrase far away in a file with NO markdown headings does not excuse a nonexistent citation', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const lines = [];
  lines.push('See register row A9 for details.'); // line 1 — the citation
  // No markdown headings anywhere in this file (mirrors real .tsx/.ts/.mjs
  // files, none of which have a `#` heading) — enough filler that the
  // "whole file" bound this produces without the size cap would exceed it.
  for (let i = 0; i < 70; i++) lines.push(`filler line ${i}`);
  lines.push('the "wren" alias no longer exists and was not restored.'); // far away
  const { errors, annotated } = checkNonexistentIds(lines.join('\n'), 'src/views/cast.test.tsx', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: a discharge phrase a few lines away (no headings at all) still excuses the citation — "near", not "same heading-bounded section"', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = [
    'See register row A9 for details.',
    'It was discharged and no longer exists.',
  ].join('\n');
  const { errors, annotated } = checkNonexistentIds(text, 'src/views/cast.test.tsx', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A9/);
});

// Pass-6 review of PR #2630 (finding F-b): the test above alone can't pin
// ANNOTATION_WINDOW_LINES' actual value (25) — its 2-line, no-heading
// fixture takes the `end - start <= MAX_ANNOTATION_SECTION_LINES` whole-
// section path, never reaching the ±25-line WINDOW fallback the constant
// actually governs; setting the constant to 0 leaves it green. These two
// pin the real lower bound on real-corpus-shaped input: a headingless file
// long enough (>60 lines total) to force the window fallback, with the SAME
// id both cited and annotated — one pair 23 lines apart (the measured real
// gap that widened this constant from 5 to 25 in the first place) which
// must still excuse, and one pair 30 lines apart which must NOT (a window
// mutated down to e.g. 5 would make the first assertion below fail too).
function buildWindowFixture(gapLines) {
  const lines = [];
  // Deliberately no "row" word here — this line must not itself be a SECOND
  // Check A citation of A9 (which would confound the assertions below); it
  // mirrors the real corpus's "A9 — discharged 2026-08-21" annotation shape.
  lines.push('A9 was discharged and no longer exists.');
  for (let i = 0; i < gapLines - 1; i++) lines.push(`filler line ${i}`);
  lines.push('See register row A9 for details.');
  for (let i = 0; i < 40; i++) lines.push(`trailing filler ${i}`); // push total > 60 lines
  return lines.join('\n');
}

test('checkNonexistentIds: annotation 23 lines above the citation (measured real gap) still excuses it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const { errors, annotated } = checkNonexistentIds(buildWindowFixture(23), 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A9/);
});

test('checkNonexistentIds: annotation 30 lines above the citation (past the window) does NOT excuse it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const { errors, annotated } = checkNonexistentIds(buildWindowFixture(30), 'docs/foo.md', rows);
  assert.equal(annotated.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
});

test('checkNonexistentIds: a heading-bounded section that is actually huge (heading far above, none below) falls back to the small window too', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // Uses A1 (an EXISTING row) for the nearby annotation sentence — a
  // nonexistent ID there would itself be a second, unrelated finding this
  // test isn't about, muddying the assertion below.
  const lines = ['# Some huge doc', '', 'register row A1 was discharged and no longer exists.'];
  for (let i = 0; i < 100; i++) lines.push(`filler line ${i}`);
  lines.push('See register row A9 for details.'); // far below the one heading, no heading after
  const { errors, annotated } = checkNonexistentIds(lines.join('\n'), 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
  assert.equal(annotated.length, 0);
});

// --- Check A: fence-aware, per checkNonexistentIds now calling stripFences ---

test('checkNonexistentIds: a citation inside a fenced code block is not scanned (mirrors parseRegisterRows\' own fence-awareness)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = ['```', 'See register row A9 for details.', '```'].join('\n');
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

// --- Check A / general citation-surface coverage (widened net) ---

test('checkNonexistentIds: a "Register row:" label line with no whitespace before the colon is now matched ("Register rows:" idiom)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '> Register row: [`onbox-acceptance-register.md` A44](onbox-acceptance-register.md)';
  const { errors } = checkNonexistentIds(text, 'docs/testing/foo-onbox-acceptance.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A44/);
});

test('checkNonexistentIds: a bold-wrapped ID in prose ("rows **C1** ... and **C2**") is matched', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Discharges register rows **A9** and **A1**.';
  const { errors } = checkNonexistentIds(text, 'docs/testing/foo-onbox-acceptance.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
});

test('checkNonexistentIds: an ANCHORED "### <ID> · ..." heading IS a citation (pass 6, PR #2630 finding A)', () => {
  // A48 does not exist in the fixture register (A1, A2, B1 only) — an
  // unannotated heading citing it is exactly PR #2630's finding A shape (a
  // uniform ID shift across a run of pack headings) and must error.
  const { rows } = parseRegisterRows(buildRegister());
  const text = '### A48 · Some pack section';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/testing/onbox-sitting-foo.md', rows);
  assert.equal(annotated.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A48/);
});

test('checkNonexistentIds: an UN-ANCHORED heading is still NOT a citation — the D13/D18 collision case the anchor was measured against', () => {
  // Real false positive this precision fix closes:
  // attribution-collapse-visibility-onbox-acceptance.md numbers its OWN
  // internal defects "## 5 · D13 verdict ..." / "## 3 · The D18-trap sanity
  // check" — a doc-local scheme that shares this register's [A-H]\d{1,3}
  // shape and an "onbox" filename, with no relationship to a register row at
  // all. The token in the ID POSITION there is "5"/"3", not "D13"/"D18" — an
  // ANCHORED `^#{2,6}\s+<ID>\s*·` never matches that heading shape at all,
  // which is exactly why it's the surface Check A now trusts (34 headings
  // tree-wide, 0 collisions, measured pass 6 of PR #2630).
  const { rows } = parseRegisterRows(buildRegister());
  const text = '## 5 · D13 verdict — some section title';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/testing/onbox-sitting-foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: a bare ID in a "row"-labelled table cell is NOT a citation — no "row(s)" context', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = ['| Pack file | Rows | Est. min |', '|---|---|---|', '| foo.md | A99 | 10 |'].join('\n');
  const inOnboxFile = checkNonexistentIds(text, 'docs/testing/onbox-sitting-plan.md', rows);
  assert.equal(inOnboxFile.errors.length, 0);
  assert.equal(inOnboxFile.annotated.length, 0);
});

// --- Check C: fails CLOSED, not open, on a subject absent from the register ---
//
// Real bug: a subject number that legitimately maps to no register row at
// all (its row discharged, or it never had one) made checkConflictingSubjects
// silently `continue` — but a subject leaves the register PRECISELY when its
// row discharges, which is the exact moment its citations start rotting.
// Paired control is the thread's own worked example: "Discharge register row
// C2 for #2187" (no current row) vs "...for #1969" (maps to A42) — both must
// now warn. Covered above (`checkConflictingSubjects: warns (unknownSubject,
// non-fatal) ...`), which pins this against the current wrongId/unknownSubject
// split (pass 7, finding G) rather than the old single-array return.

// --- Check B ownership: the plain "Full criteria:" label (unbolded) ---

test('parseRegisterRows: a "Full criteria:"-introduced run sheet (no bold) is classified as OWNED, matching the real C2/night-watch shape', () => {
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Thing (#1000)

Confirm the invariant end to end. Full criteria:
\`docs/testing/night-watch-onbox-acceptance.md\` §2A.5, and plan 247's target 1.

---
`;
  const { rows } = parseRegisterRows(text);
  assert.deepEqual([...rows.get('A1').runSheetPaths], [
    'docs/testing/night-watch-onbox-acceptance.md',
  ]);
});

test('parseRegisterRows: "Full criteria: `path`\'s ... section" (possessive) is still a borrowed reference, not ownership, even unbolded', () => {
  const text = `# On-box acceptance register

## At a glance

irrelevant table

## Group A — the GPU box

### A1 · Owns it (#1000)

Run sheet: \`docs/testing/thing-onbox-acceptance.md\`.

### A2 · Borrows a subsection (#1001)

Full criteria: \`docs/testing/thing-onbox-acceptance.md\`'s \`#1001 — extra\` section.

---
`;
  const { rows } = parseRegisterRows(text);
  assert.deepEqual([...rows.get('A2').runSheetPaths], []);
});

// --- Check C: `unknownSubject` is opt-in (--strict), off by default;
// `wrongId` is FATAL and unconditional (pass 7, finding G) ---
//
// Real repo integration, mirroring check-onbox-register.test.mjs's own
// runCli precedent: exercises the actual CLI flag-gating end to end against
// the real register and repo tree, rather than just the pure
// checkConflictingSubjects function (already covered above).

test('CLI: without --strict, Check C\'s exploratory half does not print and the success line says so', () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Check C — subject not found/);
  assert.match(result.stdout, /Check C's exploratory .* did NOT run/);
});

test('CLI: with --strict, Check C\'s exploratory half runs and prints under its own opt-in label, still non-fatal', () => {
  const result = runCli(['--strict']);
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /Check C — subject not found in any current register heading \(--strict, exploratory, not failing/,
  );
  assert.match(result.stdout, /Check C's exploratory .* found \d+ warning\(s\) above/);
});

test('CLI: Check C\'s wrongId half is FATAL and runs whether or not --strict is passed', () => {
  // The real tree at HEAD carries no existing-ID-cited-for-the-wrong-subject
  // citation, so both runs exit 0 — but the success line must name Check C's
  // wrongId half as one of the checks that ran and found nothing to fail on,
  // in BOTH invocations, proving it isn't gated by the flag.
  for (const args of [[], ['--strict']]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `expected exit 0 for args ${JSON.stringify(args)}`);
    assert.match(result.stdout, /existing row ID cited for the wrong subject.* half are the FATAL checks/);
  }
});

// --- Self-referential exclusion: this checker's own source and the sibling
// checker's test fixtures are never scanned as citation surfaces ---

test('CLI: this script\'s own source file does not self-flag on its explanatory-comment worked examples', () => {
  // scripts/check-register-citations.mjs's own comments cite "rows A46/B3"
  // and similar nonexistent IDs as worked examples of the citation idioms it
  // recognises — scanning the script as a citation surface made it
  // self-flagging (Check A fatal) before SELF_REFERENTIAL_PATHS excluded it.
  const result = runCli([]);
  assert.doesNotMatch(result.stdout, /check-register-citations\.mjs/);
});

test('CLI: the sibling check-onbox-register.mjs checker\'s test fixtures are excluded, same as this checker\'s own', () => {
  // check-onbox-register.test.mjs synthesizes nonexistent row IDs (F1, F2)
  // as fixture data for ITS OWN tests, not as real citations of anything in
  // the real register.
  const result = runCli([]);
  assert.doesNotMatch(result.stdout, /check-onbox-register\.test\.mjs/);
});

// Pass-6 review of PR #2630 (finding F-a): the test above alone can't fail
// even with the exclusion deleted — before Check A recognised the anchored
// heading surface, that sibling file's "### F1 · thing 1" / "### F2 · thing
// 2" fixtures weren't citations under any surface Check A trusted, so
// removing the path from SELF_REFERENTIAL_PATHS changed the CLI's output by
// zero characters and this test passed regardless. Now that headings ARE a
// Check A surface (see the "ANCHORED heading IS a citation" test above),
// the exclusion is genuinely load-bearing — this mutates the real script on
// disk, in-process, to prove it, then restores byte-for-byte.
test('CLI mutation: removing check-onbox-register.test.mjs from SELF_REFERENTIAL_PATHS makes it self-flag (proves the exclusion is load-bearing)', () => {
  const original = readFileSync(CLI_PATH, 'utf8');
  const needle = "  'scripts/tests/check-onbox-register.test.mjs',\n";
  assert.ok(original.includes(needle), 'fixture assumption: the exclusion entry must exist verbatim');
  const mutated = original.replace(needle, '');
  assert.notEqual(mutated, original);
  try {
    writeFileSync(CLI_PATH, mutated);
    const result = runCli([]);
    assert.equal(result.status, 1, 'mutated CLI should now fail on its own self-referential fixtures');
    assert.match(result.stderr, /check-onbox-register\.test\.mjs.*cited F1/);
    assert.match(result.stderr, /check-onbox-register\.test\.mjs.*cited F2/);
  } finally {
    writeFileSync(CLI_PATH, original);
    assert.equal(readFileSync(CLI_PATH, 'utf8'), original, 'restore must be byte-identical');
  }
});
