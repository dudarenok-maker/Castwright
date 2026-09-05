// Tests for scripts/check-register-citations.mjs — the mechanical checker
// for docs/testing/onbox-acceptance-register.md row-ID citations scattered
// across the repo (issue #2629 option 3). Most unit tests below use
// synthetic register/file fixtures (buildRegister()) rather than the real
// register, which changes under us. The CLI-mutation tests near the bottom
// of this file are the exception: they exercise the real register/corpus on
// purpose (real end-to-end wiring, not just the pure functions), so they
// derive their target ID/subject/heading FROM the real register at test
// run time rather than hardcoding one — see the "finding N/W" mutation
// test's own comment for why a hardcoded row ID doesn't survive a discharge.

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
  measureWrongIdEligibleLines,
  isLikelyBinaryFile,
  checkCitationTitleDrift,
} from '../check-register-citations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'check-register-citations.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8', timeout: 60000 });
}

// A minimal but structurally real register: two groups, a run-sheet
// cross-reference on one row, and a "Blocked" section whose heading reuses a
// live row's ID. The real register no longer has that shape — #2634/#2653
// removed the borrowed E6/E8 IDs — but the fixture keeps it deliberately:
// it is the adversarial case parseRegisterRows's group-section restriction
// exists to reject, and it must keep working whether or not the real file
// happens to contain it. Parsing must not be fooled by it.
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

// #2858: idSpecificAnnotationPresent was polarity-blind — it only asked
// whether a discharge word and a specific ID token co-occur in a clause, not
// what the discharge word actually asserts. A negated discharge sentence
// ("was NOT discharged") could therefore be misread as affirmatively
// excusing a nonexistent-ID citation from Check A's fatal path. This is now
// closed by wiring idSpecificAnnotationPresent to the same
// isDischargeAssertionNegated helper dischargedSubjectsMentionedIn already
// used (#2721/#2846) — this is the synthetic regression fixture proving it,
// since no row in the real corpus exercises this shape today.
test('checkNonexistentIds: a NEGATED discharge annotation does not excuse the cited ID (finding #2858)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Register row: A9 — was NOT discharged; it is still live.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(annotated.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A9/);
});

test('checkNonexistentIds: paired control — the same shape WITHOUT negation still excuses the cited ID (#2858)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Register row: A9 — was discharged; it is no longer live.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A9/);
});

// --- Pass-8 review of PR #2630 (finding O): the clause-bound annotation
// rule was defeated by ordinary markdown shapes a bare newline (not a blank
// line) doesn't bound — table rows, list items, a blockquote continuation,
// and an inline code span. Each has a paired control proving the mechanism
// still works where it should. ---

test('checkNonexistentIds: a discharge word on one TABLE ROW does not excuse a wrong ID on the NEXT row (finding O)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '| `foo-onbox-acceptance.md` | register row B3 — discharged 2026-08-21 | 0 |\n' +
    '| `bar-onbox-acceptance.md` | register row A99                        | 30 |\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — the same discharge word on the SAME table row still excuses it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '| `foo-onbox-acceptance.md` | register row A99 — discharged 2026-08-21 | 0 |\n' +
    '| `bar-onbox-acceptance.md` | register row B1 (unrelated, real row)    | 30 |\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

test('checkNonexistentIds: a discharge word on one NESTED LIST ITEM does not excuse a wrong ID on the next item (finding O)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '- tracked as register row B3, discharged 2026-08-21\n' +
    '- tracked as register row A99 — still owed, run it\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — the same discharge word on the SAME list item still excuses it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '- tracked as register row A99, discharged 2026-08-21\n' +
    '- tracked as register row B1 (unrelated, real row)\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

// --- Pass-9 review of PR #2630 (finding Y): pass 8's fix (finding O) only
// tolerated a BARE list item / table row, and only a QUOTED continuation
// after sentence punctuation — the same shapes with a `>` in front (a
// blockquoted list item, a blockquoted table row) or without any terminal
// punctuation at all before a "Register rows?:" label line defeated it.
// Measured as real corpus shapes (92 blockquoted list items across 21
// files, 50 blockquoted table rows across 3 files), not inventions. ---

test('checkNonexistentIds: a discharge word on one BLOCKQUOTED LIST ITEM does not excuse a wrong ID on the next blockquoted item (finding Y)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> - tracked as register row B3, discharged 2026-08-21\n' +
    '> - tracked as register row A99 — still owed, run it\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — the same discharge word on the SAME blockquoted list item still excuses it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> - tracked as register row A99, discharged 2026-08-21\n' +
    '> - tracked as register row B1 (unrelated, real row)\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

test('checkNonexistentIds: a discharge word on one BLOCKQUOTED TABLE ROW does not excuse a wrong ID on the next blockquoted row (finding Y)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> | `foo-onbox-acceptance.md` | register row B3 — discharged 2026-08-21 | 0 |\n' +
    '> | `bar-onbox-acceptance.md` | register row A99                        | 30 |\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — the same discharge word on the SAME blockquoted table row still excuses it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> | `foo-onbox-acceptance.md` | register row A99 — discharged 2026-08-21 | 0 |\n' +
    '> | `bar-onbox-acceptance.md` | register row B1 (unrelated, real row)    | 30 |\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

test('checkNonexistentIds: an UNPUNCTUATED "Register rows:" label line still bounds its own clause from the next quoted line (finding Y)', () => {
  // No period before the line break — the punctuated version of this exact
  // shape was already covered by finding O ("R4"); this is that same shape
  // with the trailing period removed, which used to defeat the rule.
  const { rows } = parseRegisterRows(buildRegister());
  const text = '> Register rows: A99 (Wave 4)\n> Historical note: row B3 was discharged 2026-08-21 and no longer exists.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — an un-punctuated multi-line blockquote annotation with no "Register rows:" label still spans the break (finding Y regression check)', () => {
  // Mirrors the real corpus's own device-token-scope.md shape (already
  // pinned above) — must still NOT be bounded by the new label-line
  // alternative, since its first line is not a "Register rows?:" label.
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> Register row A99 no longer\n' +
    '> exists.** The repo owner discharged the whole group (A99 and the plan to re-add it).\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

// --- Pass-10 review of PR #2630 (finding AE): pass 9's `>`-tolerant
// boundaries only ever tolerated exactly ONE `>` (nested `> >` blockquotes
// still defeated them), and the label lookbehind keyed on the literal
// string "Register rows?:" (a bare "Rows:" label — the SAME citation idiom
// ROW_CITATION_REGEX already recognises elsewhere in this file — didn't
// bound). Both are real corpus shapes (10 nested-blockquote lines; "Rows:"
// is the same prose idiom already matched without "Register"), not
// inventions. ---

test('checkNonexistentIds: a discharge word on one NESTED (>  >) BLOCKQUOTED LIST ITEM does not excuse a wrong ID on the next nested item (finding AE)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> > - tracked as register row B3, discharged 2026-08-21\n' +
    '> > - tracked as register row A99 — still owed, run it\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — the same discharge word on the SAME nested blockquoted list item still excuses it', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> > - tracked as register row A99, discharged 2026-08-21\n' +
    '> > - tracked as register row B1 (unrelated, real row)\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

test('checkNonexistentIds: a "Rows:" label line (no "Register" prefix) still bounds its own clause from the next quoted line (finding AE)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '> Rows: A99 (Wave 4)\n> Historical note: row B3 was discharged 2026-08-21 and no longer exists.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — a legitimate multi-line blockquote annotation still spans the break, unaffected by the "Rows:" label widening', () => {
  // Mirrors the real corpus's own device-token-scope.md shape (already
  // pinned above): its first line is "Register row A99 no longer" — no
  // colon at all — so it must not be bounded by either label alternative.
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> Register row A99 no longer\n' +
    '> exists.** The repo owner discharged the whole group (A99 and the plan to re-add it).\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

test('checkNonexistentIds: a BLOCKQUOTE CONTINUATION line opening a new sentence does not let its discharge word reach a citation one line above (finding O)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> Register rows: A99 (Wave 4).\n' +
    '> Historical note: row B3 was discharged on 2026-08-21 and no longer exists.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /B3/);
});

test('checkNonexistentIds: paired control — a legitimate multi-line blockquote annotation (no period at the line break) still spans the break', () => {
  // Mirrors the real corpus's own device-token-scope.md shape: the line
  // break falls MID-SENTENCE (no period immediately before it), not after a
  // completed sentence — the period-before-quote-continuation boundary must
  // not fire here.
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    '> Register row A99 no longer\n' +
    '> exists.** The repo owner discharged the whole group (A99 and the plan to re-add it).\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

test('checkNonexistentIds: a discharge word INSIDE AN INLINE CODE SPAN (an example command) does not excuse a real citation (finding O)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    'Audit with `grep "register row was discharged" docs/` before the run.\n' +
    'Acceptance is tracked as register row A99 until run.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: a citation and its OWN discharge-word annotation sitting in the SAME inline code span is not a live citation at all (finding AB)', () => {
  // Pass-9 review of PR #2630 (finding AB): the fixture above moves A99
  // OUT of the code span, so it can never see this shape — the real bug is
  // an example command where the citation and its annotation are the SAME
  // code span (the real corpus's own audit note:
  // "`grep -n \"register row B3 was discharged 2026-08-21\" docs/`"). Before
  // the fix, ID scanning read the unblanked text (so A99 registered as a
  // live citation) while discharge-word scanning read the blanked copy (so
  // the SAME span's "discharged" was invisible to excuse it) — turning a
  // documented example into a FATAL nonexistent-ID error. The fix makes
  // citation scanning blank code spans too, so this line carries no
  // citation for Check A to evaluate at all.
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    'Audit with `grep -n "register row A99 was discharged 2026-08-21" docs/` before the sweep.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: paired control — the same discharge word OUTSIDE a code span still excuses the citation', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text =
    'Audit results: register row was discharged 2026-08-21 previously.\n' +
    'Acceptance is tracked as register row A99 until run.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 1);
  assert.match(annotated[0], /A99/);
});

// --- Pass-10 review of PR #2630 (finding AD): the single blanking strategy
// finding AB introduced (blank a whole code span with equal-length spaces)
// was two new bugs, both directions of the same defect class this checker
// exists to close. Fixed by only blanking a span whose content ISN'T a bare
// row-ID token, and blanking with a non-whitespace placeholder rather than
// spaces — see stripInlineCodeSpans' own comment. ---

test('checkNonexistentIds: a non-ID code span does NOT manufacture a citation by letting `\\s+` bridge across it (finding AD)', () => {
  // "Skip rows `1-3` A99" — under finding AB's plain-space blanking, "rows"
  // + the blanked run + "A99" reads as "rows   A99", and ROW_CITATION_REGEX's
  // own `\s+` bridges straight across to a token ("A99") that was never
  // actually adjacent to "rows" in the source.
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Skip rows `1-3` A99 in the export table.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: paired control — the same shape with the code span removed still manufactures nothing ("1-3" is not an ID)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Skip rows 1-3 A99 in the export table.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 0);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: a single-backtick-wrapped ID in the "row(s) ID" idiom is STILL a live citation, not silently dropped (finding AD)', () => {
  // "See register row `A99`" — finding AB's whole-span blanking erased the
  // ID itself, even though this repo's own in-house style treats a single
  // backtick pair around a bare ID as carrying no ambiguity (deBold's own
  // comment). A99 doesn't exist in the register, so this must still be a
  // hard, fatal citation error — not a silent miss.
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'See register row `A99` for the outstanding work.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 0);
});

test('checkNonexistentIds: a backticked ID on a "Register rows:" label line is still recognised alongside a bare one (finding AD)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'Register rows: `A99`, A2 — both need a look.\n';
  const { errors, annotated } = checkNonexistentIds(text, 'docs/foo.md', rows);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /A99/);
  assert.equal(annotated.length, 0);
});

test('checkConflictingSubjects: a "Criteria source:" phrase INSIDE an example command\'s code span does not fatally fire (finding AD)', () => {
  // Check C used to read the UNBLANKED text — the same class of bug finding
  // AB already fixed for Check A's citation scan, left armed one caller
  // over. #1001 legitimately maps to A2/B1, not A1, so the unblanked
  // reading of this example grep command would fire FATAL wrongId.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', 'Audit with `grep -n "Criteria source: A1 for #1001" docs/` before the sweep.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: paired control — the same "Criteria source:" phrase OUTSIDE a code span still fires', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', 'Audit results: Criteria source: A1 for #1001 in the sweep.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
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

test('checkConflictingSubjects: a CORRECT multi-ID/multi-subject heading does not false-fire (finding R)', () => {
  // Pass-8 review of PR #2630 (finding R): a fully correct multi-ID heading
  // — A1 legitimately owns #1000, A2 legitimately owns #1001 — used to be
  // scored via a cross product against every subject on the line, producing
  // two FATAL false positives exactly inverted from the truth ("cited A1 for
  // #1001, but #1001 maps to A2", "cited A2 for #1000, but #1000 maps to
  // A1"). Each id legitimately owns ONE of the line's subjects, which is
  // enough to explain it against the OTHER subject too.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Title one (#1000) + Title two (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: control — a GENUINELY WRONG multi-ID heading still fails (finding R)', () => {
  // Paired control for the fix above: A1 has no legitimate claim to #1001 at
  // all (only A2/B1 do), so it must still fire even though it shares a line
  // with A2, which DOES legitimately own #1001.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Title one (#1001) + Title two (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
});

test('checkConflictingSubjects: warns (unknownSubject, non-fatal) when the cited id itself carries no subject metadata at all (structural gap)', () => {
  // #2721/#2833 split the old single `unknownSubject` bucket by cause — see
  // recordSubjectConflict's own comment. This is the A3-shaped real case
  // that STAYS non-fatal: A9's own register heading carries no issue/PR
  // number at all (15 of 66 real rows are this shape), so there's nothing on
  // A9's own row to confirm OR contradict the citation's claimed subject
  // with — a permanent structural gap, not a proven-wrong citation.
  const text = `# Register

## Group A

### A9 · Untracked-subject row, no issue/PR number in its own heading

Body.
`;
  const { rows } = parseRegisterRows(text);
  const files = new Map([
    // #9999 is in no register heading — a "Criteria source:" line naming A9
    // for it must still warn rather than silently pass, but as the
    // exploratory/non-fatal `unknownSubject` class, not `wrongId`.
    ['docs/bar.md', '> **Criteria source:** `onbox-acceptance-register.md` A9 for #9999.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.equal(unknownSubject.length, 1);
  assert.match(unknownSubject[0], /A9/);
  assert.match(unknownSubject[0], /9999/);
  assert.match(unknownSubject[0], /does not appear in any current register row heading/);
});

test('checkConflictingSubjects: fires (wrongId, FATAL) when the cited id now tracks a DIFFERENT, known subject and the citation is unannotated — full discharge (#2721/#2833)', () => {
  // A19/A31/A34-shaped real corpus case (see recordSubjectConflict's own
  // comment): under stable, allocate-once IDs (#2717), an id that currently
  // tracks OTHER known subjects proves — from the register's own text alone
  // — that it moved on since this citation was written. A1 legitimately owns
  // only #1000 today; citing it for a subject (#9999) the register has never
  // heard of, with no discharge annotation nearby, is unambiguous dangling,
  // the same class as a uniform ID shift across headings. Mutation-provable:
  // deleting the `row.issues.size > 0` branch (reverting to the pre-#2721
  // behaviour) turns this red -> green (fatal -> non-fatal), i.e. this test
  // fails without the widening and passes with it.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 · Some stale section (#9999)\n\nBody, no discharge wording anywhere.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #9999/);
  assert.match(wrongId[0], /1000/); // names what A1 tracks now
});

test('checkConflictingSubjects: control — the SAME shape stays non-fatal (annotatedDischarge) when self-annotated as discharged', () => {
  // A19/A31's real shape: the file already documents its own staleness
  // ("Register row: A1 — discharged ...") — historical record per this
  // repo's "annotate, don't renumber" convention, not a live defect, same
  // philosophy as Check A's annotated bucket.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    [
      'docs/bar.md',
      '### A1 · Some stale section (#9999)\n\n' +
        '> **Register row: A1 — discharged 2026-08-26, row removed from the register**\n',
    ],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /A1/);
  assert.match(annotatedDischarge[0], /9999/);
});

// --- #2721/#2842 (rework of #2833's own #2832-FAIL'd attempt): a subject
// still has a LIVE sibling row after one of its rows discharges/is
// re-minted for other work — citing the discharged/re-minted sibling must
// NOT be fatal, because the subject itself hasn't left the register. This is
// the `legitimateMap.ownersOf(subject)` NON-EMPTY branch of
// `recordSubjectConflict`, distinguished from a genuinely wrong/mechanically
// -shifted id by `legitimateMap.historicalOwnersOf(subject)` — built from a
// discharge/re-mint annotation naming the subject in the CITED id's OWN row
// body (`dischargedSubjectsMentionedIn`), not from anything near the
// citation itself.

function buildMultiRowDischargeRegister({ includeLiveSibling }) {
  const liveSibling = includeLiveSibling
    ? `### A22 · Live sibling row for the same subject (#2040)\n\nBody.\n\n`
    : '';
  return `# Register

## Group A

${liveSibling}### A34 · Re-minted for new work (#2350)

This row's earlier work on #2040 discharged; A34 was re-minted for this new work.
`;
}

test('checkConflictingSubjects: does NOT fire (wrongId, non-fatal) citing a re-minted sibling id, unannotated at the citation, when the subject still has a live row elsewhere (#2721/#2842)', () => {
  // Reproduction from #2842's own issue body: subject #2040 owned by live
  // row A22 and re-minted row A34 (A34's OWN row documents its #2040 history,
  // but its current heading tracks #2350 instead). Citing A34 for #2040, with
  // NO discharge annotation anywhere near the citation itself, must NOT be
  // fatal — the subject still has a live row (A22), only one of its rows
  // has moved on. Mutation-provable: reverting `recordSubjectConflict`'s
  // `else if (!legitimateIds.has(id))` branch to the pre-#2842 unconditional
  // `wrongId.push` (deleting the `idHistoricallyOwnedThisSubject` check)
  // turns this red (wrongId.length === 1) -> this test is the one that pins
  // it green.
  const { rows } = parseRegisterRows(buildMultiRowDischargeRegister({ includeLiveSibling: true }));
  const files = new Map([
    ['docs/bar.md', '### A34 · Some citing section (#2040)\n\nBody, no discharge wording anywhere.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /A34/);
  assert.match(annotatedDischarge[0], /2040/);
  assert.match(annotatedDischarge[0], /A22/); // names the still-live sibling
});

test('checkConflictingSubjects: control — the SAME shape stays non-fatal even when the subject\'s LAST live row ALSO discharges (full discharge, #2721/#2842)', () => {
  // Paired control for the test above, per #2842's checklist item 3(b-
  // control): drop A22 entirely, so #2040 no longer has ANY live row.
  // A34's own row still documents that IT once tracked #2040 — that
  // self-annotation is real regardless of whether a sibling survives, so
  // this stays annotatedDischarge (not failing), matching the pre-existing
  // "self-annotated discharge" philosophy this PR does not regress.
  const { rows } = parseRegisterRows(buildMultiRowDischargeRegister({ includeLiveSibling: false }));
  const files = new Map([
    ['docs/bar.md', '### A34 · Some citing section (#2040)\n\nBody, no discharge wording anywhere.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /A34/);
  assert.match(annotatedDischarge[0], /2040/);
});

test('checkConflictingSubjects: control — a genuinely unrelated id with NO historical tie to the subject still fires (wrongId, FATAL) even though the subject has a live sibling row (#2721/#2842)', () => {
  // The multi-row-live-sibling exemption above must not become a blanket
  // "subject has a live row somewhere -> never fatal" rule — that would gut
  // the mechanical-ID-shift class PR #2630 exists to catch. A99 is a real
  // register row (so Check A doesn't already own this citation), but its own
  // body never mentions #2040 anywhere, discharged or otherwise — nothing in
  // the register's own text ties it to this subject, so it must still fire.
  const text = `# Register

## Group A

### A22 · Live row for the subject (#2040)

Body.

### A99 · Unrelated row tracking different work (#3000)

Plain body text about this row's own work, nothing else.
`;
  const { rows } = parseRegisterRows(text);
  const files = new Map([
    ['docs/bar.md', '### A99 · Wrong citation (#2040)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A99 for #2040/);
  assert.match(wrongId[0], /A22/); // names the legitimate owner
});

test('checkConflictingSubjects: an untracked "PR #nnnn" companion beside an owned issue number is silently correct, not even a warning (#2721/#2833)', () => {
  // A32's real shape: the register's own A1 (standing in for A32) heading
  // tracks only its issue (#1000, standing in for #2310), never its fixing
  // PR — no matter how buildLegitimateSubjectMap is written, the register's
  // OWN text never carries the PR number, so this can never be "fixed" by
  // widening the map itself (see recordSubjectConflict's own comment).
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([['docs/bar.md', '### A1 · Some section (#1000, PR #9998)\n\nBody.\n']]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
});

test('checkConflictingSubjects: the "PR #nnnn" companion exemption also applies within a positional multi-ID segment', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Title one (#1000, PR #9998) + Title two (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
});

test('checkConflictingSubjects: the "PR #nnnn" companion exemption applies in the second branch (non-segmented path) when the subject exists but is owned by a different ID (#2721/finding 3)', () => {
  // Regression test for the bug fixed in PR #2846 finding 3: isOwnedPrCompanion
  // was only checked in the `if (!legitimateIds)` branch, not in the `else if
  // (!legitimateIds.has(id))` branch. This test constructs a citation that
  // would fall into the SECOND branch:
  //   - #1001 legitimately exists and is owned by A2 (so legitimateIds != null)
  //   - The cited ID is A1, which is NOT in legitimateIds (so !legitimateIds.has(A1))
  //   - But A1 owns #1000 on the same line, and #1001 is marked with "PR #"
  //   - So isOwnedPrCompanion should be true
  //   - This should NOT fire any error (exempt as a PR companion)
  //
  // Before the fix, this fired a wrongId because the isOwnedPrCompanion check
  // was only in the first branch. After the fix, it's checked first and
  // exempts this citation.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 · Title (#1000, PR #1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0, 'PR companion should not fire wrongId');
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
});

// --- Pass-9 review of PR #2630 (finding X): the multi-ID exemption
// (finding R) exempted an id from EVERY subject on its line once it
// legitimately owned ANY subject on that line — silencing a genuinely wrong
// citation whenever a DIFFERENT subject on the same line belongs to nobody
// cited, or (on a single-ID line) to a wholly unrelated id. Fixed with
// POSITIONAL pairing (headingTitleSegments): a multi-ID heading's own title
// segments, not the line's whole subject set. ---

test('checkConflictingSubjects: a THIRD subject that NEITHER cited id owns still fires, even though each id owns its OWN segment (finding X)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // A1 legitimately owns #1000; A2 legitimately owns #1001 — both segments
  // are individually correct. Injecting a THIRD, unrelated subject (#9999,
  // owned by neither) into A1's own segment must still fire against A1 —
  // the old rule exempted A1 from #9999 too, purely because A1 owns #1000
  // elsewhere on the same line. #2721/#2833: "still fires" is now the
  // widened, more precise `wrongId` — A1's OWN row tracks #1000, which
  // proves (from the register's own text) that #9999 isn't legitimately
  // A1's either — rather than the old, less precise `unknownSubject`. #9999
  // carries no "PR #" marker tying it to #1000, so the companion exemption
  // (see the "PR #nnnn" tests above) does not apply here either.
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Title one (#1000, #9999) + Title two (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.equal(wrongId.length, 1); // #9999 is in no register heading, and A1 tracks other work
  assert.match(wrongId[0], /A1/);
  assert.match(wrongId[0], /9999/);
});

test('checkConflictingSubjects: a SINGLE-ID heading with an unrelated "see also" subject still fires against that subject (finding X)', () => {
  // A1 legitimately owns #1000 (matches its own citation) but is also
  // paired, on the same line, with an unrelated #1001 (A2/B1's subject, not
  // A1's) via a "see also" idiom. The old rule exempted A1 from #1001 too,
  // once it saw A1 legitimately owned #1000 ANYWHERE on the line.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 · Drift Wave 1 (#1000) — see also (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
});

// --- Pass-10 review of PR #2630 (finding AC): `headingTitleSegments` only
// recognises ONE positional shape (` + `-joined titles with a matching
// segment/id count) — every OTHER multi-ID title shape used to fall back to
// the pre-finding-R full cross product, reopening finding R's own false
// positive for a CORRECT heading in every shape but the one pinned test.
// Enumerated here: a comma, an `&`, an en-dash, and a segment/id count
// mismatch — all four correct on the same A1(#1000)/A2(#1001) pairing the
// existing finding-R tests above use, so a regression in any one of them
// shows up as a false FATAL, same as finding R originally did. ---

test('checkConflictingSubjects: a correct multi-ID heading with a COMMA between subjects does not false-fire (finding AC)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Wave 4 acceptance (#1000, #1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: a correct multi-ID heading joined by "&" does not false-fire (finding AC)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · decode (#1000) & addendum (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: a correct multi-ID heading joined by an EN-DASH does not false-fire (finding AC)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · decode (#1000) – addendum (#1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: a correct multi-ID heading with a SEGMENT/ID COUNT MISMATCH (3 segments, 2 ids) does not false-fire (finding AC)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · decode (#1000) + addendum (#1001) + notes\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: control — a GENUINELY WRONG comma-joined multi-ID heading still fires (finding AC)', () => {
  // Paired control for the four fixes above: #1001 legitimately maps to
  // A2/B1, never A1 — A1 has no legitimate claim to it at all, so citing A1
  // for #1001 alongside A2 (who DOES own it) must still fire, proving the
  // bounded fix doesn't just stop flagging everything on a multi-ID line.
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Wave 4 acceptance (#1001, #1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
});

// --- Pass-10 review of PR #2630 (finding AH): a duplicated ID across two
// title segments used to key `subjectsForId` through a Map by id, so the
// SECOND segment's subject set silently overwrote the first's — the first
// segment's check never ran at all. Iterating positionally (by index, not
// through a Map) fixes it: A1 (cited twice) is wrong for its FIRST segment's
// subject and right for its second — the old code kept only the second
// check and missed the defect entirely. ---

test('checkConflictingSubjects: a DUPLICATED ID across two title segments is checked against BOTH, not just the last (finding AH)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    // A1 legitimately owns only #1000. Its first segment names #1001 (wrong
    // for A1), its second names #1000 (right for A1) — a Map keyed by id
    // would have the second `.set()` erase the first's wrong-subject check.
    ['docs/bar.md', '### A1 + A1 · Title one (#1001) + Title two (#1000)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
});

// --- Pass-11 review of PR #2630 (finding AI): the multi-ID exemption gated
// on `citedIds.size >= 2` — every citation-shaped ID TOKEN on the line,
// register row or not — instead of on how many of those tokens actually
// resolve to a real row. A token that is provably NOT a row (nonexistent, or
// an annotated-discharged id that has left the register entirely) still
// counted as "a second id explains this line", silently exempting a real,
// wrong id from a subject it doesn't own. ---

test('checkConflictingSubjects: control — the exemption still applies when TWO REAL rows share a line (finding AI)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · Wave 4 acceptance (#1000, #1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: the exemption no longer applies when one of the ID tokens is NOT a register row (finding AI)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // A99 doesn't exist in the register at all. A1 legitimately owns only
  // #1000; #1001 belongs to A2/B1. Before the fix, `citedIds.size >= 2`
  // counted A99 as a second id "explaining" the line and silently exempted
  // A1 from #1001 too, even though nothing legitimately explains it there.
  const files = new Map([
    ['docs/bar.md', '### A1 + A99 · Wave 4 acceptance (#1000, #1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
});

test('checkConflictingSubjects: composite — an ANNOTATED-DISCHARGED id shares the exemption bug\'s shape and is fixed the same way (finding AI)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // Mirrors the pass-11 composite: a live row (A1) sharing a heading with an
  // id whose row has since discharged ("B3" — absent from buildRegister()'s
  // rows, same as a nonexistent id from Check C's point of view; Check A's
  // separate "annotate, don't renumber" carve-out doesn't add B3 back into
  // `registerRows`). This is exactly the shape that, pre-fix, silenced
  // Check C's FATAL bucket for the whole line — the one this checker exists
  // to catch a mechanical ID shift with.
  const files = new Map([
    [
      'docs/bar.md',
      '### A1 + B3 · Wave 4 acceptance (#1000, #1001)\n\n' +
        'Register row B3 was discharged on 2026-08-21 and no longer exists.\n',
    ],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 1);
  assert.match(wrongId[0], /cited A1 for #1001/);
});

// --- Pass-11 review of PR #2630 (finding AK): `headingTitleSegments` only
// checked that the ` + `-split segment count matched the id count — a
// natural-language "+" INSIDE one segment's own prose can produce that same
// count by coincidence while landing the split in the wrong place entirely,
// mis-pairing every id to the wrong segment. ---

test('headingTitleSegments / checkConflictingSubjects: a natural-language "+" inside the title prose no longer mis-pairs positionally (finding AK)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // "decode + encode acceptance (#1000, #1001)" splits into 2 segments on
  // `\s\+\s` purely by coincidence with the 2 ids — the "+" is a natural
  // conjunction in the prose, not a per-ID boundary, and the first segment
  // ("decode") never carries a subject of its own at all. Before the fix
  // this was accepted as positional and fatally mis-fired "cited A2 for
  // #1000" even though A2 correctly owns only #1001 and never claimed
  // #1000 — the exact false positive this heading shape must not produce.
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · decode + encode acceptance (#1000, #1001)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
});

test('checkConflictingSubjects: control — a genuine per-ID positional heading still pairs correctly and fires on a real mismatch (finding AK)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // Each segment carries its own subject, so this is the real positional
  // shape — and it is deliberately SWAPPED (A1 paired with #1001, A2 paired
  // with #1000) to prove the fix didn't just widen the fallback and lose
  // the positional path's precision.
  const files = new Map([
    ['docs/bar.md', '### A1 + A2 · decode (#1001) + encode (#1000)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject } = checkConflictingSubjects(files, rows);
  assert.equal(unknownSubject.length, 0);
  assert.equal(wrongId.length, 2);
  const joined = wrongId.join('\n');
  assert.match(joined, /cited A1 for #1001/);
  assert.match(joined, /cited A2 for #1000/);
});

// --- Pass-9 review of PR #2630 (finding Z): measureWrongIdEligibleLines
// used to re-implement Check C's eligibility rule inline instead of calling
// citationShapedLineIds — the function Check C itself uses — so the two
// could silently disagree. ---

// --- #2721: dischargedSubjectsMentionedIn must apply proximity cap + polarity check ---
//
// Real bug: dischargedSubjectsMentionedIn scanned for discharge words anywhere
// in a clause and extracted subject numbers from the same clause, without
// checking (a) proximity (120-char cap like idSpecificAnnotationPresent uses),
// (b) polarity (negated "NOT discharged" got treated as affirmative), or (c)
// that the discharge actually concerns THIS row's subject. Measured: A1's row
// body mentions "— NOT discharged" in discussing A16's discharge history —
// A16 mentions #1969 there — so A1's dischargedSubjectsMentionedIn returned
// {1969}, falsely excusing A1 when cited for #1969 (which A36 actually owns).
// Citing A1 for #1969 should still fire wrongId (fatal), not annotatedDischarge
// (non-fatal).

test('checkConflictingSubjects: negated discharge prose ("NOT discharged") in another row\'s history does NOT match as an affirmative discharge in this row (#2721)', () => {
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

[#1969] is why A16 below is not fully discharged — A16 cannot close yet.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // A1 citing #1969 should fire wrongId (FATAL), not annotatedDischarge,
  // because A1's own row body never affirmatively discharges #1969. The
  // "NOT discharged" language in A1's body text is about A16's history, not
  // A1's own discharge of #1969.
  assert.equal(wrongId.length, 1);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.match(wrongId[0], /cited A1 for #1969/);
  assert.match(wrongId[0], /A36/); // names the legitimate owner
});

test('checkConflictingSubjects: control — an affirmative discharge of a subject in THIS row\'s own body still resolves non-fatal (#2721)', () => {
  // Paired control: when A1 once tracked a subject and documents discharging
  // it in its OWN row body (without negation), citing A1 for that subject
  // should be annotatedDischarge (non-fatal), not wrongId (fatal) — because
  // A1's own row documents the history. A1's heading currently tracks #2040
  // (re-minted for new work), but its body documents discharging #1969,
  // which is now owned by A36.
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Earlier work on subject 1969, now re-minted for new work (#2040)

This row's earlier work on #1969 is now discharged and resolved.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // A1 citing #1969 should now be annotatedDischarge (non-fatal) because
  // A1's own row body affirmatively discharges #1969 — it's history, not a
  // mistake. The subject is still live (A36 owns it now), so not fatal.
  assert.equal(wrongId.length, 0);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /cited A1 for #1969/);
  assert.match(annotatedDischarge[0], /A36/); // names the current owner
});

// Pass-2 review of PR #2846 (finding new-B): the polarity scan now recognizes
// a broader set of negation patterns (not just "NOT" and "no"), and bounds the
// scan to the clause instead of a flat 30-char window.

test('checkConflictingSubjects: negation pattern "is never discharged" is now recognized and suppresses false matches (#2846 finding new-B)', () => {
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

Discussion: subject #1969 is never discharged — A16 still tracks it below.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // The negated "is never discharged" should NOT suppress the wrongId — A1's
  // body doesn't affirmatively discharge #1969, only DISCUSSES its discharge
  // in a negated context.
  assert.equal(wrongId.length, 1);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.match(wrongId[0], /cited A1 for #1969/);
});

test('checkConflictingSubjects: negation pattern "isn\'t discharged" is now recognized and suppresses false matches (#2846 finding new-B)', () => {
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

Note: subject #1969 isn't discharged, A16 still owns it.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // The negated "isn't discharged" should NOT suppress the wrongId.
  assert.equal(wrongId.length, 1);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.match(wrongId[0], /cited A1 for #1969/);
});

test('checkConflictingSubjects: negation pattern "un-discharged" (prefix negation) is now recognized and suppresses false matches (#2846 finding new-B)', () => {
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

Related: subject #1969 remains un-discharged in A16's row.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // The negated "un-discharged" should NOT suppress the wrongId.
  assert.equal(wrongId.length, 1);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.match(wrongId[0], /cited A1 for #1969/);
});

test('checkConflictingSubjects: a distant, unrelated negation in the SAME paragraph does not suppress a genuine discharge (#2846 finding new-G)', () => {
  // clauseBounds doesn't treat ". " as a boundary, so this whole sentence
  // pair is one "clause" — but the negation-to-discharge distance (47
  // chars, measured) exceeds POLARITY_PROXIMITY_CHARS (30), so it must not
  // suppress the genuine, unnegated discharge later in the same paragraph.
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

The repair rewrote metadata, not the audio bytes on disk. Subject #1969 was discharged.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0, 'the genuine discharge must not be suppressed by a distant, unrelated "not"');
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /cited A1 for #1969/);
});

test('checkConflictingSubjects: "no longer exists" (itself an affirmative discharge phrase) does not falsely negate a LATER discharge word (#2846 finding new-G)', () => {
  // DISCHARGE_ANNOTATION_REGEX treats "no longer exists" as its OWN
  // affirmative discharge phrase. A bare \bno\b polarity check would
  // misread that "no" as negating a later, unrelated "discharged" match in
  // the same paragraph — the negative lookahead (?!\s+longer\s+exists?)
  // excludes it.
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

Group Q no longer exists. Subject #1969 was discharged then.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0, 'the genuine discharge must not be suppressed by "no" inside "no longer exists"');
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /cited A1 for #1969/);
});

test('checkConflictingSubjects: clause-bounded polarity scan does not suppress a genuine discharge across an unrelated list-item boundary (#2846 finding new-B)', () => {
  const registerText = `# Register

## Group A

### A36 · Voice work (#1969)

Body.

### A1 · Unrelated work (#2040)

- 3: not tracked.
- 4: #1969 discharged.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  // Item 3's unrelated "not" sits within the OLD flat 30-char polarity window
  // of Item 4's discharge word (measured: 24 chars) but across a list-item
  // clause boundary — it must not bleed across that boundary and suppress
  // Item 4's genuine, unnegated discharge (the false-CLOSED direction of a
  // flat, un-clause-bounded polarity window). A1's own row DOES document
  // discharging #1969, so citing A1 for #1969 should resolve non-fatal.
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  assert.equal(wrongId.length, 0, "the genuine discharge in Item 4 must not be suppressed by Item 3's unrelated negation");
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 1);
  assert.match(annotatedDischarge[0], /cited A1 for #1969/);
});

test('checkConflictingSubjects: ID_PROXIMITY_CHARS cap prevents distant subject numbers from matching (finding new-D)', () => {
  // A subject number far (>120 chars) from the discharge word in the same clause
  // must NOT be treated as discharging that subject.
  const registerText = `# Register

## Group A

### A1 · Earlier work, now re-minted (#2040)

Subject #1969 mentioned here at start. Filler text: xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx xxxxx. discharged 2026-08-01.

### A36 · Voice work (#1969)

Body.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A1 · Some section (#1969)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // A1 citing #1969 should fire wrongId (FATAL), not annotatedDischarge,
  // because the #1969 mention and the "discharged" word in A1's body are too far apart
  // (well over 120 chars), so the proximity cap prevents dischargedSubjectsMentionedIn
  // from attributing the discharge to #1969. A36 legitimately owns #1969, so A1's
  // citation is genuinely wrong.
  assert.equal(wrongId.length, 1);
  assert.equal(unknownSubject.length, 0);
  assert.equal(annotatedDischarge.length, 0);
  assert.match(wrongId[0], /cited A1 for #1969/);
  assert.match(wrongId[0], /A36/); // names the legitimate owner
});

test('checkConflictingSubjects: "PR #nnnn" references in discharge text are excluded from harvested subjects (#2721 new-A)', () => {
  // #2846 pass-2 review finding new-A: dischargedSubjectsMentionedIn harvests ANY
  // number in a discharge clause without verifying it's a genuine subject reference
  // rather than a PR number reference. A18 in the real register has "PR #1978"
  // mentioned near a discharge word, causing 1978 to be incorrectly included in A18's
  // historical subjects if the PR marker isn't stripped first.
  //
  // This test creates a minimal fixture reproducing that shape: a row A18 whose
  // body mentions "PR #1978" in a discharge context, and a separate subject #1978
  // that belongs to A36. Citing A18 for #1978 should fire wrongId (FATAL), not
  // annotatedDischarge — the discharge annotation is invalid because A18 never
  // actually tracked #1978 (only PR #1978 is mentioned, not subject #1978).
  const registerText = `# Register

## Group A

### A18 · Latent equivalence (#2000)

Decode equivalence was measured during PR #1978's review and PR #1978 was discharged during the work. The equivalence metric is now in the codebase.

### A36 · Some other work (#1978)

Body.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A18 · Some section (#1978)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // A18 citing #1978 must fire wrongId (FATAL), not annotatedDischarge,
  // because even though A18's body mentions "PR #1978" near a discharge word,
  // the PR marker means it's not a genuine subject reference — A36 legitimately owns #1978.
  assert.equal(wrongId.length, 1, 'should have exactly one wrongId finding');
  assert.equal(unknownSubject.length, 0, 'should have zero unknownSubject findings');
  assert.equal(annotatedDischarge.length, 0, 'should have zero annotatedDischarge findings');
  assert.match(wrongId[0], /cited A18 for #1978/);
  assert.match(wrongId[0], /A36/); // names the legitimate owner
});

test('checkConflictingSubjects: control — a genuine subject discharge (not a PR reference) still works correctly (#2721 new-A control)', () => {
  // Control test: verify that genuine subject discharges (without PR marker) still
  // work correctly after the PR-reference exclusion is in place.
  const registerText = `# Register

## Group A

### A18 · Latent equivalence (#2000)

Latent equivalence was measured and #1978 was discharged during this work.

### A36 · Some other work (#1978)

Body.
`;
  const { rows } = parseRegisterRows(registerText);
  const files = new Map([
    ['docs/bar.md', '### A18 · Some section (#1978)\n\nBody.\n'],
  ]);
  const { wrongId, unknownSubject, annotatedDischarge } = checkConflictingSubjects(files, rows);
  // A18 citing #1978 must fire annotatedDischarge (non-fatal), not wrongId,
  // because A18's body genuinely documents discharging #1978 (no PR marker).
  assert.equal(wrongId.length, 0, 'should have zero wrongId findings');
  assert.equal(unknownSubject.length, 0, 'should have zero unknownSubject findings');
  assert.equal(annotatedDischarge.length, 1, 'should have exactly one annotatedDischarge finding');
  assert.match(annotatedDischarge[0], /cited A18 for #1978/);
});

test('measureWrongIdEligibleLines: agrees with checkConflictingSubjects about which lines are eligible (finding Z)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([
    // Existing id, wrong subject -> eligible AND produces a wrongId finding.
    ['docs/one.md', '### A2 · Some pack section (#1000)\n\nBody.\n'],
    // A99 doesn't exist in the register at all — Check A's territory, not
    // eligible for Check C's measurement (the registerRows.has(id) gate).
    ['docs/two.md', '### A99 · Some pack section (#1000)\n\nBody.\n'],
  ]);
  const { headingLines, headingFiles } = measureWrongIdEligibleLines(files, rows);
  const { wrongId } = checkConflictingSubjects(files, rows);
  assert.equal(headingLines, 1);
  assert.equal(headingFiles, 1);
  assert.equal(wrongId.length, 1);
});

test('measureWrongIdEligibleLines: a heading citing only a NONEXISTENT id is not counted eligible (finding Z)', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const files = new Map([['docs/one.md', '### A99 · Some pack section (#1000)\n\nBody.\n']]);
  const { headingLines, headingFiles, criteriaLines, criteriaFiles } = measureWrongIdEligibleLines(
    files,
    rows,
  );
  assert.equal(headingLines, 0);
  assert.equal(headingFiles, 0);
  assert.equal(criteriaLines, 0);
  assert.equal(criteriaFiles, 0);
});

// --- Check D: heading title drift (v2, #2871, tuning doc #2870) ---
//
// Per the tuning doc's own recommendation, only the anchored heading surface
// carries a usable signal — the prose-idiom/label-line surfaces are skipped
// entirely, so these fixtures only exercise `### <ID> · ...` headings.

test('checkCitationTitleDrift: does not fire when the heading echoes the row\'s current title', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '### A2 · Second thing (#1001)\n\nBody two.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0);
});

// Constructed the same way the tuning doc's synthetic mismatches were: the
// citing text is scored against a title that describes clearly different
// work, not a hand-picked easy negative.
test('checkCitationTitleDrift: fires (advisory) when the heading describes clearly different work than the row\'s current title', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '### A2 · Completely unrelated volume normalization audio pipeline redesign\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /A2/);
  assert.match(findings[0], /docs\/foo\.md/);
  assert.match(findings[0], /Second thing/);
});

test('checkCitationTitleDrift: does not fire on a nonexistent ID — that is Check A\'s job, not this one\'s', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = '### A99 · Completely unrelated volume normalization audio pipeline redesign\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0);
});

test('checkCitationTitleDrift: skips the prose-idiom surface entirely, even when it clearly does not restate the title', () => {
  const { rows } = parseRegisterRows(buildRegister());
  const text = 'This discharged register row A2 as numbered before the volume normalization redesign shipped.';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0);
});

test('checkCitationTitleDrift: a multi-row heading ("A6 + A7 · ...") is checked against each row\'s own title', () => {
  const { rows } = parseRegisterRows(buildRegister());
  // A2/B1 borrowed here as a stand-in multi-row heading — B1's real title is
  // "Language gate (#1001)", clearly different from A2's "Second thing
  // (#1001)", so only B1 should flag.
  const text = '### A2 + B1 · Second thing (#1001)\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /B1/);
});

test('checkCitationTitleDrift: correctly flags drift when row title contains a markdown link with URL boilerplate that would otherwise mask the drift via shared-token false positives', () => {
  // A register row whose title contains a GitHub issue link. The markdown
  // link's URL parts (github, com, issues, dudarenok, maker, castwright) are
  // boilerplate that should NOT be counted as shared tokens, otherwise a
  // completely unrelated heading that ALSO contains the same markdown link
  // would rack up >= 2 shared tokens from the URL alone, failing the
  // TITLE_DRIFT_MIN_SHARED_TOKENS gate and masking the drift.
  const registerText = `# On-box acceptance register

## Group A — test group

### A9 · feature deployment ([#1234](https://github.com/dudarenok-maker/Castwright/issues/1234))

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  // A heading whose text-echo is completely unrelated to A9's "feature
  // deployment" but happens to cite the same GitHub issue link. Before the
  // fix, the URL tokens (github, com, issues, dudarenok, maker, castwright,
  // 1234) would be counted as shared tokens >= 2, and the drift would not
  // fire. After the fix, only the shared words count (none, in this case),
  // and drift correctly fires.
  const text = '### A9 · completely unrelated volume audio normalization ([#1234](https://github.com/dudarenok-maker/Castwright/issues/1234))\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /A9/);
  assert.match(findings[0], /feature deployment/);
  assert.match(findings[0], /completely unrelated volume audio normalization/);
});

test('checkCitationTitleDrift: does not fire (false positive) when row title contains backtick-wrapped text and heading echoes it exactly — the citing side must strip inline code spans symmetrically with the row side', () => {
  // A register row whose title contains backtick-wrapped text — a real
  // shape from the live register (A17's title starts with `` `/health` ``).
  // The heading citation echoes the title byte-for-byte, including the
  // backticks. Before the fix, stripInlineCodeSpans was applied to the
  // heading side (titleEcho) during extractHeadingTitleEchoes, blanking the
  // backtick span, but NOT to the row's title before tokenizing in
  // titleDriftTokens — so the two sides had different token sets and
  // falsely reported drift even though the heading is an accurate echo.
  //
  // We use a title where the backticked part is the DOMINANT content —
  // stripping it from one side but not the other creates a clear token
  // mismatch that produces drift even though the heading is exact. The row
  // title starts with the backticked command and adds minimal extra text,
  // so losing the backticked tokens creates a clear similarity drop.
  const registerText = `# On-box acceptance register

## Group A — test group

### A10 · \`npm run test:golden-audio --bless\` (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  // A heading that echoes the row title exactly, including the backticks.
  // Before the fix, the backticked content gets blanked on the heading side
  // only, creating tokens ["1234"] vs ["npm", "run", "test", "golden", "audio", "bless", "1234"],
  // which scores as 1 shared / 7 union = 0.14 similarity, below the 0.3 threshold.
  // After the fix, both sides get stripped the same way and produce the same tokens.
  const text = '### A10 · `npm run test:golden-audio --bless` (#1234)\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0, 'Expected no drift when heading echoes row title exactly, even with inline code spans');
});

// --- Testing the two tuned constants (TITLE_DRIFT_RATIO_THRESHOLD and
// TITLE_DRIFT_MIN_SHARED_TOKENS) and the filters (stopwords, ID tokens) ---
//
// Finding 4 & 6 from PR #2878 review: the ratio floor (0.30) and shared-
// token minimum (2) are not currently tested, and mutations to either
// constant leave the existing suite fully green. These tests verify both
// constants are load-bearing and that the stopword and ID-token filters
// are necessary for correctness.

test('checkCitationTitleDrift: the ratio floor (0.30) is load-bearing — ratio just above 0.30 prevents flag despite shared < 2', () => {
  // ratio = 1/3 ≈ 0.33 > 0.30 with shared = 1 should not flag.
  // Arithmetic: title = {apple, berry} (2 tokens, no numbers to avoid confusion),
  // heading = {apple, cherry} (2 tokens),
  // shared = 1 (apple), union = 2 + 2 - 1 = 3, ratio = 1/3 ≈ 0.333 > 0.30.
  const registerText = `# On-box acceptance register

## Group A — test group

### A30 · apple berry

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A30 · apple cherry\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0, 'ratio ≈0.333 > 0.30 prevents flag even with shared=1 < 2');
});

test('checkCitationTitleDrift: the ratio floor (0.30) is load-bearing — low ratio causes flag with shared < 2', () => {
  // Mismatched titles with only one shared token and a large union yield
  // ratio = 1/6 ≈ 0.167 ≤ 0.30, causing a flag.
  // Arithmetic: title tokens = {alpha, beta, charlie} (3),
  // heading tokens = {alpha, delta, echo, foxtrot} (4),
  // shared = 1 (alpha), union = 3 + 4 - 1 = 6, ratio = 1/6 ≈ 0.167.
  const registerText = `# On-box acceptance register

## Group A — test group

### A31 · alpha beta charlie (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A31 · alpha delta echo foxtrot\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 1, 'Low ratio (≈0.167 ≤ 0.30) with shared < 2 should flag');
  assert.match(findings[0], /A31/);
});

test('checkCitationTitleDrift: the shared-token minimum (2) is load-bearing — shared >= 2 prevents flag even with ratio ≤ 0.30', () => {
  // Two shared tokens with low ratio (≈0.286 ≤ 0.30) should not flag because
  // shared >= 2. This proves the shared-token gate is necessary.
  // Arithmetic: title = {alpha, beta, charlie, delta} (4),
  // heading = {alpha, beta, echo, foxtrot, golf} (5),
  // shared = 2 (alpha, beta), union = 4 + 5 - 2 = 7, ratio = 2/7 ≈ 0.286.
  const registerText = `# On-box acceptance register

## Group A — test group

### A32 · alpha beta charlie delta (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A32 · alpha beta echo foxtrot golf\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0, 'Shared >= 2 should prevent flag even with ratio ≤ 0.30');
});

test('checkCitationTitleDrift: the ratio edge case (shared = 1, tiny union) is reachable — ratio = 0.5 > 0.30 prevents flag', () => {
  // When shared = 1 and union = 2, ratio = 0.5 > 0.30, no flag. This
  // demonstrates the ratio floor's genuine edge case is reachable and works.
  // Arithmetic: title = {alpha} (1), heading = {alpha, beta} (2),
  // shared = 1, union = 1 + 2 - 1 = 2, ratio = 1/2 = 0.5.
  const registerText = `# On-box acceptance register

## Group A — test group

### A33 · alpha (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A33 · alpha beta\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 0, 'Edge case: shared=1, union=2 yields ratio=0.5 > 0.30, no flag');
});

test('checkCitationTitleDrift: the stopword filter is load-bearing — stopwords are not counted as shared tokens', () => {
  // Two titles that differ only in stopwords should flag if the shared count
  // were inflated by stopwords. By filtering stopwords, they share zero
  // content tokens. With ratio also low, this correctly flags as drift.
  // Title tokens after filtering = {quick} (1, "the" removed),
  // heading tokens after filtering = {slow} (1, "the" removed),
  // shared = 0, union = 1 + 1 - 0 = 2, ratio = 0/2 = 0.
  // If stopwords weren't filtered: shared would include {the}, but even then
  // shared = 1 < 2, and ratio = 1/2 = 0.5 > 0.30, so the non-filtered case
  // wouldn't flag. This test shows stopwords are correctly excluded.
  const registerText = `# On-box acceptance register

## Group A — test group

### A40 · the quick

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A40 · the slow\n\nBody.\n';
  const { findings } = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(findings.length, 1, 'Stopwords filtered out, leaving no shared content tokens; ratio=0 should flag');
  assert.match(findings[0], /A40/);
});

test('checkCitationTitleDrift: the ID-token filter is load-bearing — ID-shaped tokens are not counted as shared tokens', () => {
  // A title and heading that both contain an ID token (e.g., "a15") should
  // not let that ID inflate their shared count. After filtering the ID token,
  // they share zero content tokens, and the drift correctly flags.
  // Title: "a15 quick" → {quick} (1, "a15" matches ID pattern),
  // heading: "a15 slow" → {slow} (1, "a15" filtered),
  // shared = 0, union = 2, ratio = 0, should flag.
  // If ID tokens weren't filtered, shared would be {a15} = 1, and
  // ratio = 1/2 = 0.5 > 0.30, so it wouldn't flag — demonstrating the
  // filter's necessity.
  const registerText = `# On-box acceptance register

## Group A — test group

### A41 · a15 quick

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A41 · a15 slow\n\nBody.\n';
  const result = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(result.findings.length, 1, 'ID token "a15" filtered out, no shared content; ratio=0 should flag');
  assert.match(result.findings[0], /A41/);
  assert.equal(result.annotatedFindings.length, 0);
});

// --- Check D: annotation-exemption for drift (like Checks A and C) ---

test('checkCitationTitleDrift: a heading with low title similarity returns { findings, annotatedFindings }', () => {
  // #2838 v2: Check D returns an object with both buckets, like Checks A and
  // C, instead of just an array. An unannotated drift finding goes in
  // `findings`; an annotated one goes in `annotatedFindings`.
  const registerText = `# On-box acceptance register

## Group A — test group

### A41 · historical work for old issue (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = '### A41 · current work for new issue\n\nBody.\n';
  const result = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(typeof result, 'object');
  assert.ok(Array.isArray(result.findings));
  assert.ok(Array.isArray(result.annotatedFindings));
});

test('checkCitationTitleDrift: a heading with low title similarity but a nearby discharge annotation moves to annotatedFindings, not findings', () => {
  // #2838: independent review found ALL SIX real Check D detections were
  // correctly-annotated historical references. This test creates that shape:
  // a heading with clearly different text from the current title, BUT with a
  // nearby discharge annotation naming that same ID — should not flag as drift.
  const registerText = `# On-box acceptance register

## Group A — test group

### A41 · historical work for old issue (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  // Heading has low similarity to current title, but a nearby discharge
  // annotation exists for this ID.
  const text = [
    '## Some section',
    '',
    '### A41 · old feature implementation (now archived)',
    '',
    'A41 was discharged and no longer exists, replaced by work under new issues.',
    '',
  ].join('\n');
  const result = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(result.findings.length, 0, 'unannotated drift should be empty');
  assert.equal(result.annotatedFindings.length, 1, 'annotated drift should be in separate bucket');
  assert.match(result.annotatedFindings[0], /A41/);
  assert.match(result.annotatedFindings[0], /annotated as discharged/);
});

test('checkCitationTitleDrift: a heading with low title similarity WITHOUT a nearby annotation still flags as drift', () => {
  // Paired control: without an annotation, the drift finding should still appear
  // in `findings` (not `annotatedFindings`), so drift without annotation is
  // not silently passing.
  const registerText = `# On-box acceptance register

## Group A — test group

### A41 · historical work for old issue (#1234)

Some body text.
`;
  const { rows } = parseRegisterRows(registerText);
  // Heading has low similarity, NO discharge annotation nearby.
  const text = '### A41 · completely different work\n\nBody.\n';
  const result = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  assert.equal(result.findings.length, 1, 'unannotated drift should flag');
  assert.equal(result.annotatedFindings.length, 0, 'no annotation, so not in annotated bucket');
  assert.match(result.findings[0], /A41/);
  assert.ok(!result.findings[0].includes('annotated as discharged'));
});

test('checkCitationTitleDrift: an annotation for a DIFFERENT ID does not excuse this ID\'s drift', () => {
  // Paired injection: an annotation for ID B1 near a heading citing A41 must
  // not excuse A41's drift — the annotation must name the SAME ID.
  const registerText = `# On-box acceptance register

## Group A — test group

### A41 · historical work for old issue (#1234)

Some body text.

### B1 · other row (#1235)

Other body.
`;
  const { rows } = parseRegisterRows(registerText);
  const text = [
    '## Some section',
    '',
    '### A41 · completely different work',
    '',
    'B1 was discharged and no longer exists.',
    '',
  ].join('\n');
  const result = checkCitationTitleDrift(text, 'docs/foo.md', rows);
  // A41's drift should still flag — the annotation is for B1, not A41.
  assert.equal(result.findings.length, 1, 'drift should flag when annotation names different ID');
  assert.match(result.findings[0], /A41/);
  assert.equal(result.annotatedFindings.length, 0);
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

// Pass-8 review of PR #2630 (finding N): the property that Check C's
// `wrongId` half is FATAL — the entire reason PR #2630 exists — was pinned
// by no test that actually exercises the wiring from `checkConflictingSubjects`
// through to the CLI's exit code. `fatalSections` (`['Check C — ...',
// errorsC]`) can have its `wrongId` entry deleted and the suite stayed
// 54/54 green, because the two tests above assert `status === 0` on a clean
// tree (trivially true either way) and a regex against the checker's OWN
// success-line copy — a template literal the mutation doesn't touch — never
// against actual FAILING behaviour. This mutates the real script on disk to
// prove the fix is load-bearing, same technique as the SELF_REFERENTIAL_PATHS
// mutation test above: with `fatalSections` intact, a real wrong-ID heading
// on the real tree exits 1 and names the defect; with the `Check C` entry
// deleted from `fatalSections`, the same tree exits 0 with zero output
// naming it.
// Pass-9 review of PR #2630 (finding W): the first version of this test
// pinned two things by VERBATIM SOURCE TEXT rather than by behaviour — the
// full real-register "A42" heading (including its URL and PR number), and
// the exact `fatalSections` array-entry line, `errorsC` variable name
// included. Both are brittle in the two ways this session has repeatedly
// been burned by: a routine register discharge that renumbers A42 (the
// EXACT event this tool exists to manage) breaks the fixture assumption,
// and a pure behaviour-preserving rename (`errorsC` -> anything else)
// throws "fixture assumption: the fatalSections entry must exist verbatim"
// even though the mutation being tested for — Check C's fatality — is
// completely unaffected. Fixed by deriving both from the CURRENT real
// register/corpus at test run time (an owning ID + its subject number,
// found generically, never hardcoded) and by matching the fatalSections
// entry SHAPE (the label text plus ANY identifier after the comma) rather
// than its exact characters.
test('CLI mutation: deleting Check C from fatalSections un-gates a real wrong-ID heading (proves the fatality is load-bearing, finding N/W)', () => {
  const REGISTER_PATH = join(HERE, '..', '..', 'docs', 'testing', 'onbox-acceptance-register.md');
  const { rows } = parseRegisterRows(readFileSync(REGISTER_PATH, 'utf8'));

  // Find any row that legitimately owns a subject number, then a DIFFERENT
  // existing row that does not — this is exactly `legitimate.get(subject)`
  // vs. an id absent from it, derived fresh from whatever the register
  // currently says rather than a row ID pinned in the test's own source.
  let ownerId, subject;
  outer: for (const [id, row] of rows) {
    for (const s of row.issues) {
      ownerId = id;
      subject = s;
      break outer;
    }
  }
  assert.ok(ownerId, 'fixture assumption: at least one real register row carries an issue/PR number');
  let wrongIdCandidate;
  for (const [id, row] of rows) {
    if (id !== ownerId && !row.issues.has(subject)) {
      wrongIdCandidate = id;
      break;
    }
  }
  assert.ok(
    wrongIdCandidate,
    'fixture assumption: at least two real register rows exist with non-overlapping subjects',
  );

  // A non-frozen, non-register file to inject a synthetic wrong-ID heading
  // into — the shape this checker exists to catch, built from live register
  // data rather than quoting a specific row's own heading text.
  const TARGET = join(HERE, '..', '..', 'docs', 'testing', 'onbox-sitting-plan.md');
  const originalTarget = readFileSync(TARGET, 'utf8');
  const injected = `\n### ${wrongIdCandidate} · Synthetic finding-N/W pin (#${subject})\n`;
  const mutatedTarget = originalTarget + injected;
  assert.notEqual(mutatedTarget, originalTarget);

  const originalCli = readFileSync(CLI_PATH, 'utf8');
  const fatalSectionsRegex =
    /\[\s*'Check C — existing row ID cited for the wrong subject'\s*,\s*\w+\s*\],?\n?/;
  assert.match(
    originalCli,
    fatalSectionsRegex,
    'fixture assumption: a fatalSections entry with this label must exist, whatever its variable is named',
  );
  const mutatedCli = originalCli.replace(fatalSectionsRegex, '');
  assert.notEqual(mutatedCli, originalCli);

  try {
    writeFileSync(TARGET, mutatedTarget);

    // Baseline: with the checker unmutated, the wrong-ID heading is FATAL.
    const baseline = runCli([]);
    assert.equal(baseline.status, 1, 'a wrong-ID heading must fail the gate by default');
    assert.match(baseline.stderr, /existing row ID cited for the wrong subject/);
    assert.match(
      baseline.stderr,
      new RegExp(`cited ${wrongIdCandidate} for #${subject}.*maps to .*${ownerId}`),
    );

    // Mutant: delete Check C from fatalSections — the defect class this PR
    // exists to catch must no longer be silently ungated.
    writeFileSync(CLI_PATH, mutatedCli);
    const mutant = runCli([]);
    assert.equal(mutant.status, 0, 'mutant should incorrectly pass once Check C is un-gated');
    assert.doesNotMatch(mutant.stderr, new RegExp(`cited ${wrongIdCandidate} for #${subject}`));
  } finally {
    writeFileSync(TARGET, originalTarget);
    writeFileSync(CLI_PATH, originalCli);
    assert.equal(
      Buffer.compare(Buffer.from(readFileSync(TARGET, 'utf8')), Buffer.from(originalTarget)),
      0,
    );
    assert.equal(
      Buffer.compare(Buffer.from(readFileSync(CLI_PATH, 'utf8')), Buffer.from(originalCli)),
      0,
    );
  }
});

// --- Pass-9 review of PR #2630 (finding U): `readNormalized` never throws
// on binary content (Node's utf8 decoder substitutes U+FFFD rather than
// erroring), so `unreadableCount` was structurally 0 for the case the
// success line's "N unreadable/binary excluded" clause claims to cover. ---

test('isLikelyBinaryFile: a real tracked PNG is detected as binary', () => {
  const PNG = join(HERE, '..', '..', 'apps', 'android', 'android', 'app', 'src', 'main', 'res',
    'mipmap-hdpi', 'ic_launcher.png');
  assert.equal(isLikelyBinaryFile(PNG), true);
});

test('isLikelyBinaryFile: paired control — a real tracked text file is NOT detected as binary', () => {
  assert.equal(isLikelyBinaryFile(CLI_PATH), false);
});

test('CLI: the real tree scan finds at least one binary file, and the success line reports it (finding U)', () => {
  // Reproduces the actual defect on the real corpus, not just the pure
  // helper: before the fix, this clause never printed at all, on any tree,
  // because unreadableCount could never leave 0.
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\d+ unreadable\/binary excluded/);
});

// --- Check D: title drift is advisory, non-fatal even under --strict ---
//
// Finding 5: Check D's findings must be advisory-only and NEVER escalate to
// fatal, even under `--strict` (unlike Check C's wrongId half, which does
// escalate under some conditions). This test exercises the CLI with `--strict`,
// triggers a Check D finding, and asserts the exit code stays 0.

test('CLI: with --strict, Check D finds title drift but does NOT fail the gate (finding 5)', () => {
  const TEST_FILE = join(HERE, '..', '..', 'docs', 'testing', 'onbox-sitting-plan.md');
  const original = readFileSync(TEST_FILE, 'utf8');

  // Find a real register row with a heading to mutate for the drift test.
  // We'll inject a heading that cites a real row ID but with completely
  // different text, triggering Check D's drift detection.
  const registerPath = join(HERE, '..', '..', 'docs', 'testing', 'onbox-acceptance-register.md');
  const registerText = readFileSync(registerPath, 'utf8');
  const { rows } = parseRegisterRows(registerText);

  // Pick the first row that exists in the real register.
  let targetId = null;
  for (const id of rows.keys()) {
    targetId = id;
    break;
  }
  assert.ok(targetId, 'fixture assumption: at least one real register row exists');

  // Create a heading that cites this row but with completely different text.
  // This triggers Check D's drift detection: the heading's text ("unrelated
  // work") shares zero tokens with the row's current title.
  const driftHeading = `### ${targetId} · unrelated work completely different`;

  // Inject at the end of the test file so it's scanned but doesn't break
  // anything else (it's a heading in the middle of prose, not a real row).
  const mutated = original + '\n\n' + driftHeading + '\n\nThis is test text.\n';

  try {
    writeFileSync(TEST_FILE, mutated);
    const result = runCli(['--strict']);

    // Exit code must be 0: Check D findings do not fail the gate, even with --strict.
    assert.equal(result.status, 0, 'Check D drift findings are advisory, should not fail');

    // The finding must be Check D's OWN message for THIS injected heading —
    // not merely some unrelated "cited <id>" substring elsewhere in the much
    // larger combined CLI output (Check C's exploratory findings use that
    // exact word too, e.g. "cited A3 for #1230"). Match the single real line
    // precisely: file:line, "heading cites <id>", and the injected echo text,
    // all on one line, with no 's' (dotall) flag to allow cross-output drift.
    assert.match(
      result.stdout,
      new RegExp(
        `onbox-sitting-plan\\.md:\\d+ — heading cites ${targetId} — .*unrelated work completely different.*review for drift\\)`,
      ),
      'Check D drift finding for the injected heading should be visible in output',
    );

    // The injected heading has no nearby discharge annotation, so it must
    // land in the plain drift bucket, not the annotated-exemption bucket.
    assert.doesNotMatch(
      result.stdout,
      new RegExp(`heading cites ${targetId} — .*unrelated work completely different.*annotated as discharged`),
      'an unannotated heading must not be excused into the annotated bucket',
    );

    // Verify the Check D section header is present in output.
    assert.match(result.stdout, /Check D.*heading title drift.*advisory/i);
  } finally {
    writeFileSync(TEST_FILE, original);
    assert.equal(readFileSync(TEST_FILE, 'utf8'), original, 'restore must be byte-identical');
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
