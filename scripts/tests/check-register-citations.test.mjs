// Tests for scripts/check-register-citations.mjs — the mechanical checker
// for docs/testing/onbox-acceptance-register.md row-ID citations scattered
// across the repo (issue #2629 option 3). Uses synthetic register/file
// fixtures rather than the real register, which changes under us.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseRegisterRows,
  isFrozenPath,
  isStableSuperpowersDoc,
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
  const errors = checkConflictingSubjects(files, rows);
  assert.equal(errors.length, 0);
});

test('checkConflictingSubjects: fires when a citation pairs an existing ID with the wrong subject', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // #1000 legitimately maps only to A1 in the register. Citing A2 for #1000
  // is an existing-but-wrong citation — the dangerous "looks valid" case.
  const files = new Map([['docs/bar.md', 'See register row A2 (#1000) for the fix.']]);
  const errors = checkConflictingSubjects(files, rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A2/);
  assert.match(errors[0], /1000/);
  assert.match(errors[0], /A1/); // names the legitimate ID(s) for the subject
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
  assert.equal(isFrozenPath('docs/features/archive/44-pr-hygiene.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-acceptance-register.md'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-acceptance-register-live-view.html'), true);
  assert.equal(isFrozenPath('docs/testing/onbox-sitting-plan.md'), false);
  assert.equal(isFrozenPath('docs/features/278-cast-character-identity.md'), false);
});

test('isStableSuperpowersDoc: excludes only a status: stable file whose OWN leading frontmatter says so', () => {
  assert.equal(
    isStableSuperpowersDoc('docs/superpowers/plans/x.md', '---\nstatus: stable\n---\n\nblah'),
    true,
  );
  assert.equal(
    isStableSuperpowersDoc('docs/superpowers/plans/x.md', '---\nstatus: active\n---\n\nblah'),
    false,
  );
  assert.equal(isStableSuperpowersDoc('docs/features/x.md', '---\nstatus: stable\n---\n'), false);
});

test('isStableSuperpowersDoc: a file with NO leading frontmatter fence is never excluded, even if the phrase appears in prose', () => {
  // Real bug: docs/superpowers/plans/2026-07-05-github-issues-kanban-board.md
  // has no frontmatter at all and opens with a heading — its only
  // `status: stable` match was inside a FENCED YAML EXAMPLE later in the
  // body, instructing the reader to write that frontmatter into a DIFFERENT
  // file. A whole-file regex excluded all 1,900 live lines of that plan from
  // every check.
  const text = [
    '# GitHub Projects Kanban Board Implementation Plan',
    '',
    'Some intro. See register row A99.',
    '',
    '```yaml',
    '---',
    'status: stable',
    'shipped: 2026-07-05',
    '---',
    '```',
    '',
  ].join('\n');
  assert.equal(isStableSuperpowersDoc('docs/superpowers/plans/x.md', text), false);
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

test('checkNonexistentIds: a bare ID in a markdown heading, even in an onbox-named file, is NOT a citation — no "row(s)" context', () => {
  // Real false positive this precision fix closes:
  // attribution-collapse-visibility-onbox-acceptance.md numbers its OWN
  // internal defects "## 5 · D13 verdict ..." / "## 3 · The D18-trap sanity
  // check" — a doc-local scheme that shares this register's [A-H]\d{1,3}
  // shape and an "onbox" filename, with no relationship to a register row at
  // all. An earlier version of this check treated a bare ID in a heading of
  // an onbox-named file as a citation and self-flagged on exactly this file.
  const { rows } = parseRegisterRows(buildRegister());
  const text = '### A99 · Some pack section';
  const inOnboxFile = checkNonexistentIds(text, 'docs/testing/onbox-sitting-foo.md', rows);
  assert.equal(inOnboxFile.errors.length, 0);
  assert.equal(inOnboxFile.annotated.length, 0);

  const elsewhere = checkNonexistentIds(text, 'docs/superpowers/specs/some-design.md', rows);
  assert.equal(elsewhere.errors.length, 0);
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
// Paired control below is the thread's own worked example: "Discharge
// register row C2 for #2187" (no current row) vs "...for #1969" (maps to
// A42) — both must now warn.

test('checkConflictingSubjects: warns (not silently passes) when the paired subject number maps to NO current register row at all', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', 'Discharge register row A1 for #9999.'], // #9999 is in no heading
  ]);
  const errors = checkConflictingSubjects(files, rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A1/);
  assert.match(errors[0], /9999/);
  assert.match(errors[0], /does not appear in any current register row heading/);
});

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

// --- Check C is opt-in (--strict), off by default ---
//
// Real repo integration, mirroring check-onbox-register.test.mjs's own
// runCli precedent: exercises the actual CLI flag-gating end to end against
// the real register and repo tree, rather than just the pure
// checkConflictingSubjects function (already covered above).

test('CLI: without --strict, Check C does not run and the success line says so', () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Check C —/);
  assert.match(result.stdout, /Check C .* did NOT run — it is opt-in and exploratory/);
});

test('CLI: with --strict, Check C runs and prints under its own opt-in label, still non-fatal', () => {
  const result = runCli(['--strict']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Check C — one subject, conflicting row IDs \(--strict, exploratory, not failing/);
  assert.match(result.stdout, /Check C ran under --strict and found \d+ warning\(s\) above/);
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
