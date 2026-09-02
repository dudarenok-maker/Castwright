// Mechanical checker for docs/testing/onbox-acceptance-register.md ROW-ID
// CITATIONS scattered across the repo (#2629 option 3).
//
// Register row IDs (A29, B2, E1...) are allocated once and never renumbered
// or reused: discharging a row deletes it PERMANENTLY, so a citation
// elsewhere in the repo ("register row A29") that pointed at it goes
// permanently dangling on discharge, rather than silently re-pointing to
// whatever now occupies that slot (nothing ever does). Four
// rounds of manual sweeping (docs/docs-register-row-refs) converged too
// slowly and too incompletely to trust — every miss was the same shape: one
// claim living on several surfaces, with only some of them corrected. This
// script exists to make that mechanical instead of eyeballed.
//
// WIRING GAP, stated explicitly rather than left implicit (pass-9 review of
// PR #2630, finding AA): `package.json`'s `check:register-citations` script
// is invoked from exactly one place today —
// `scripts/tests/check-register-citations.test.mjs`'s own CLI-integration
// tests, run as part of `npm run test:hooks`. That means this checker only
// actually EXERCISES on a diff `verify-cache.mjs`'s `test:hooks` step
// considers in-scope: `docs/testing/**`, the register itself, `CLAUDE.md`,
// and `scripts/**` — NOT `docs/features/**`, `docs/superpowers/**`,
// `src/**`, `server/**`, or `e2e/**`, even though a citation can live in any
// of those and this checker's own real-tree run scans every one of them.
// There is no dedicated `.github/workflows/*.yml` step for this checker the
// way the sibling `check-onbox-register.mjs` has
// (`onbox-register-check.yml`) — `#2629`'s option 3 ("catches rot at PR
// time") is not fully true yet: rot in a file outside `test:hooks`' own
// scope is caught only the NEXT time some in-scope file changes too, or on
// a manual `npm run check:register-citations`. Widening `test:hooks`'
// inputs to the whole tree isn't the fix — this checker's own real-tree run
// reads essentially every tracked file, so declaring that as a `test:hooks`
// input would make the step un-cacheable for everyone, defeating the
// scope-gating `verify-cache.mjs` exists for. The right fix is a dedicated
// CI step (mirroring `onbox-register-check.yml`) that always runs this
// checker regardless of diff scope — a genuine design decision (schedule,
// gating, whether it belongs in `verify.yml` or its own workflow), not
// something to wire in blind here; tracked at `#2721`.
//
// Three checks, ordered by precision (least to most likely to need
// judgment):
//
//   A. Nonexistent ID — a cited row ID with no heading in the register.
//      Zero ambiguity as a FACT, but a correct tree legitimately contains
//      some of these on purpose: a fully-discharged row's ID is kept as a
//      historical annotation ("register row B3 was discharged ... and no
//      longer exists") rather than silently renumbered, per this repo's own
//      "annotate, don't renumber" rule — renumbering it to whatever now
//      occupies that slot would be the exact silent corruption this checker
//      exists to catch elsewhere. So a nonexistent-ID citation is an ERROR
//      unless a discharge/removal annotation appears NEAR the citation — see
//      enclosingSectionText's own comment for exactly how "near" is bounded —
//      in which case it is downgraded to a printed, non-fatal NOTE — still
//      visible, never silently dropped, but it doesn't fail the gate. An
//      *unannotated* nonexistent ID is still a hard error, always.
//
//      A citation must carry EXPLICIT "row(s)"/"Register row(s):" context,
//      OR be an anchored `### <ID> · …` heading (HEADING_ID_REGEX) — a bare
//      `[A-H]\d{1,3}` token in running prose or a table cell is still never
//      enough. An earlier version of this check also treated ANY bare ID in
//      a markdown heading or a "row"-labelled table cell (scoped to
//      onbox-acceptance-named files) as a citation, on the theory that the
//      filename scoping made it safe, then dropped the heading half entirely
//      on the strength of one measurement:
//      `attribution-collapse-visibility-onbox-acceptance.md` numbers its OWN
//      internal defects `D13`/`D18` in section headings ("## 5 · D13
//      verdict …"). That measurement was mis-read — the token in the ID
//      POSITION there is `5`, not `D13`; an ANCHORED `^#{2,6}\s+<ID>\s*·`
//      never matches that heading, or any other doc-local numbering scheme,
//      at all. Pass 6 of PR #2630 (finding A) re-measured tree-wide: 34
//      anchored headings across every non-frozen, non-self-referential file,
//      zero collisions. Table cells stay excluded (no anchor exists for
//      "a cell in a row-labelled table" the way `^#{2,6}\s+` anchors a
//      heading), and the broad bare-ID parsing still survives separately
//      inside Check B's run-sheet HEADER region (see below), where the
//      preceding "Register row(s):" label already supplies the context a
//      bare heading can't.
//   B. Bidirectional run-sheet linkage — a register row that OWNS its run
//      sheet (asserted via one of THREE markers measured in the real
//      register — the prose phrase "run sheet", the structured bold field
//      `*Criteria:*`, or the plain `Full criteria:` label) creates a
//      two-way link: that run sheet's own HEADER (its leading `> Register
//      row(s): ...` paragraph, not the whole file) must cite the row back. A
//      forward-only scan (does the row name a real file?) misses a run
//      sheet whose header still cites a stale ID — and a whole-file scan is
//      just as blind to it, since the body legitimately re-mentions the
//      correct ID elsewhere (Result lines, discharge notes); only the header
//      actually asserts ownership. A header with no such line is itself a
//      reportable finding, not a silent widen-the-scan fallback.
//
//      WHAT THIS DOES NOT CHECK, and says so out loud: a `*-onbox-
//      acceptance.md` path a row mentions but that neither marker
//      classifies as owned (a borrowed reference, e.g. A39 borrowing
//      fs38-wave3's section; or a phrasing this checker doesn't recognise
//      yet) is NEVER run through Check B — there is no third check that
//      verifies a borrowed reference's target. Those pairs are listed by
//      name in a dedicated "mentioned but not classified as owned" section
//      instead, precisely so a green exit here is never mistaken for "every
//      citation everywhere is verified." See findUnclassifiedRunSheetMentions.
//   C. One subject, conflicting IDs — the recurring "one claim, N surfaces"
//      defect. Built off the register's OWN heading-line issue/PR numbers as
//      ground truth: for each register row, the issue/PR numbers in its
//      heading line are its "subject numbers," and the set of row IDs a
//      subject legitimately maps to is whatever the register itself
//      currently says (a subject CAN legitimately span two rows — e.g. one
//      Group A row and one Group B row for the same issue — so a naive
//      "same subject cited near 2+ different IDs" rule would misfire on
//      that correct, current state). A citation is flagged when it pairs an
//      EXISTING row ID with a subject number that either (a) legitimately
//      maps to a DIFFERENT set of IDs — the dangerous case where a stale
//      citation still looks superficially valid because the ID happens to
//      exist, just for something else now — or (b) does not appear in any
//      current register row heading AT ALL, which is exactly what happens
//      the moment a subject's row discharges: the subject's citations start
//      rotting from that moment, so failing open here (as an earlier version
//      of this check did) silences the check exactly when it is needed.
//      Note: 21 of 65 real register rows carry no issue/PR number in their
//      heading at all (they cite a plan number instead), so this check's
//      ground truth is thin for roughly a third of the register — those rows
//      can never be cross-checked in either direction, a real coverage gap,
//      not a bug. Grounded in the register's own current state rather than a
//      heuristic — but the SUBJECT-to-citation association itself is still a
//      proximity heuristic (nearby issue numbers in the same sentence/
//      bullet), and that proximity can pick the wrong subject out of a
//      paragraph that mentions several (measured: two real cases where an
//      unrelated issue number sat next to an already-correct citation). A
//      same-line-only association over the FULL "row(s) ID"/"Register
//      row(s):" surface set does not remove either measured case — both
//      false positives share a physical line with the citation precisely
//      because a "Register row(s): A29, B3, A30, and A45 (#2128 ...)"-style
//      line legitimately names several rows at once, so "same line" alone
//      doesn't disambiguate which row a trailing issue number belongs to.
//      Pass 6 of PR #2630 (finding D) re-measured with the association
//      narrowed further, to only the two surfaces that can never name more
//      than one row on a line — an anchored `### <ID> · …` heading, or a
//      `Criteria source:` line — and that removes both known false
//      positives (see citationShapedLineIds' own comment).
//
//      TWO SEVERITIES, split by which of (a)/(b) above fired — this is new
//      in pass 7 of PR #2630 (finding G), replacing a single opt-in/never-
//      fatal check with a precise part that gates and a genuinely-ambiguous
//      part that doesn't:
//
//      - (b), "existing ID cited for the WRONG subject" (checkConflictingSubjects'
//        `wrongId`) is FATAL and runs BY DEFAULT, no flag needed. This is the
//        defect class PR #2630 exists to catch: a uniform mechanical ID
//        shift across a run of headings leaves each one citing an ID that
//        still exists, just for something else now — Check A can never see
//        it (the ID isn't nonexistent), and it is exactly what a correct
//        tree never legitimately contains, so there is nothing here for a
//        real annotation to excuse. Reproduced directly: re-injecting the
//        four wrong headings pass 6 originally found produces four `wrongId`
//        errors naming exactly those lines, and a default run (no flags)
//        now exits 1 because of them.
//      - (a), "subject not in any current register heading at all"
//        (checkConflictingSubjects' `unknownSubject`) stays EXPLORATORY,
//        OPT-IN, NEVER FATAL — pass `--strict` to see it; skipped and
//        printed nothing without the flag, same as the whole check used to
//        be. This is the genuinely thinner ground truth: 21 of the
//        register's 65 real rows carry no issue/PR number in their heading
//        at all (they cite a plan number instead, so those rows can never be
//        cross-checked in either direction — a real, permanent coverage
//        gap), a "Register row(s):" list is still not scanned by this
//        narrowed check at all (deliberately — see above), and the 2
//        residual warnings measured on the corpus as it stands today both
//        fall in this bucket (a heading citing its issue AND its fixing PR,
//        where the register's own heading tracks only the issue — a
//        structural subject-set mismatch, not a wrong citation; and a row
//        whose OWN register heading carries no issue number, so its subject
//        can never appear in the legitimate-subject map either way — the
//        21-of-65 gap from the other direction). Neither is a wrong
//        citation, so failing on either would be a false positive; that is
//        why this half is not promoted alongside `wrongId`.
//
//      The ±200-char window's original 118-warning measurement was of ONE
//      PARAMETER (window size), not of the idea, and restricting to the two
//      never-ambiguous surfaces (heading, `Criteria source:`) is what
//      actually separates the two classes above — a fix the header comment's
//      prior "no window size tried separates the real hits from the rest"
//      claim never tested. It is no longer accurate to call Check C's ground
//      truth "too thin to trust" for the `wrongId` half; "incomplete" (never
//      "wrong") is the honest description of the `unknownSubject` half.
//
//      MEASURED COVERAGE, not just precision — pass-8 review of PR #2630
//      (finding M/S): `wrongId` can only ever fire on a line that is BOTH
//      citation-shaped (an anchored heading or a `Criteria source:` line) AND
//      carries a subject number on that same physical line
//      (`extractSubjectNumbers`). Measured on the real corpus at the time of
//      this comment: 23 of the tree's 32 anchored headings carry a subject
//      number, across 5 files (all `docs/testing/onbox-sitting-*.md`); 0 of
//      its 32 `Criteria source:` lines do — every real instance in this
//      corpus cites its subject in a different sentence than the one naming
//      the row, or names no subject at all. So the `Criteria source:` surface
//      contributes NOTHING on the corpus as it stands, and the fatal half's
//      entire real coverage is those 23 lines in 5 files — `runCheckRegisterCitationsCli`'s
//      success line reports the live count each run rather than repeating
//      this frozen number, since the corpus changes under it. Two real
//      consequences follow, and this PR is explicit about both rather than
//      letting the success line imply broader coverage than this: (1) a
//      wrong ID cited via the "row(s) ID" prose idiom, a "Register row(s):"
//      label line, or a citation-shaped line with no subject number next to
//      it is invisible to `wrongId` — Check A only catches it if the ID is
//      also nonexistent, never merely wrong-for-its-subject; (2) a wrong ID
//      that arrives via a DISCHARGE — the cited ID still exists, just for a
//      DIFFERENT subject now, because the citation's own original subject's
//      row discharged and left the register entirely — used to route to the
//      non-fatal, opt-in `unknownSubject` bucket unconditionally, because the
//      discriminator between the two branches was "does the register still
//      know this subject at all", and a discharge answers no. #2721/#2833
//      widened `wrongId` to cover exactly this discharge class: when the
//      cited id's OWN current row tracks OTHER, known subjects (proof, from
//      the register's own text, that the id has moved on since this citation
//      was written), the subject is fatal `wrongId` rather than
//      `unknownSubject` — UNLESS a nearby discharge annotation for that same
//      id already documents the staleness (`annotatedDischarge`, non-fatal,
//      always printed, same philosophy as Check A's annotated bucket). A
//      subject cited against an id that carries NO subject metadata at all
//      (the 21-of-65-rows structural gap) still can't be confirmed or
//      refuted either way, and stays in the plain `unknownSubject` bucket.
//      See `recordSubjectConflict`'s own comment for the exact rule and the
//      real corpus cases (A19/A31 annotated-non-fatal, A34 unannotated-fatal,
//      A3 structural-gap-non-fatal) that motivated the split.
//
//      #2832's verify pass on #2721/#2833's own attempt found a THIRD gap in
//      the same territory: a subject that loses only ONE of several rows —
//      not a full discharge — still has a live row elsewhere, so citing the
//      discharged/re-minted sibling isn't a stale citation at all, but the
//      pre-#2842 code fired `wrongId` on it unconditionally (case (a) above,
//      "legitimately maps to a DIFFERENT set of IDs", didn't distinguish a
//      historically-legitimate sibling from a genuinely wrong id). #2721/
//      #2842 fixed this in `buildLegitimateSubjectMap` itself, which now
//      returns both the current subject->id map AND a historical one built
//      from each row's OWN body text (a discharge/re-mint annotation naming
//      a subject there is the register's own record of that row's history —
//      see `dischargedSubjectsMentionedIn`'s own comment). `wrongId` still
//      fires for an id with no such record, whether or not the subject has a
//      live row elsewhere — only a documented historical tie downgrades it
//      to `annotatedDischarge`.
//
// Frozen paths are excluded from all three checks — see isFrozenPath's own
// comment for why each one is frozen. This script's own source, its own test
// fixtures, and the sibling `check-onbox-register.mjs` checker's test
// fixtures are excluded from scanning entirely (not just Check A/B/C — see
// SELF_REFERENTIAL_PATHS) for the same reason SELF_TEST_PATH always was:
// they use this corpus's exact vocabulary ("row A46/B3", discharge wording,
// synthetic nonexistent IDs like `F1`/`F2`) as WORKED EXAMPLES in comments
// and fixtures, not as real citations of anything in the real register —
// scanning them made the checker self-flagging on its own explanatory prose.
//
// Citation-surface coverage (what counts as a "citation" at all): Check A
// recognises THREE surfaces — the prose idiom "row(s) [:]? ID[, ID ...]"
// (`deBold` strips `**...**` first, so bold decoration is tolerated; a
// backtick or a markdown-link wrapper directly around the ID, e.g. "row
// `A30`" or "row [A30](...)", is NOT — the regex needs the ID token
// characters immediately after the whitespace following "row(s)", so a
// backtick or `[` in between still misses; no live instance of this shape
// exists in the corpus today, so it is a latent gap, not a live miss), a
// "Register row(s):" label line anywhere in a scanned file (any decoration
// — this is the single most common citation shape in the corpus and the
// checker's own header used to falsely claim the plain-whitespace idiom
// above was "the citation idiom actually in use here"; measurement showed
// otherwise), and an anchored `### <ID> · …` section heading
// (HEADING_ID_REGEX, added pass 6 of PR #2630 — see finding A). Check C
// (checkConflictingSubjects) is DIFFERENT, not simply narrower: it reads
// citationShapedLineIds — an anchored `### <ID> · …` heading or a
// `Criteria source:` line, the two surfaces that can never name more than
// one row on a physical line — and NEVER the "row(s) ID" prose idiom or a
// "Register row(s):" label line at all, both of which CAN name several rows
// on one line (see Check C's own section below for why that ambiguity rules
// them out). Pass 7 review of PR #2630 (finding E): an earlier version of
// this comment, and the CLI's own success line, claimed the exact opposite —
// that Check C covers the prose idiom ONLY — which is backwards, and which
// the suite's own test ("the row(s) ID prose idiom alone is NOT a Check C
// surface any more") already asserted was false. Do not describe Check C's
// coverage as the inverse of what citationShapedLineIds actually reads.
//
// A bare ID with NONE of the three surfaces above — e.g. a table cell, or a
// heading that isn't anchored (`## 5 · D13 verdict`, where the token in the
// ID position is `5`, not `D13`) — is NOT a citation surface for either
// check: `attribution-collapse-visibility-onbox-acceptance.md`'s own
// `D13`/`D18` defect-numbering headings share this register's `[A-H]\d{1,3}`
// shape and an "onbox" filename with no relationship to a register row, and
// no bare-token surface can tell the two schemes apart (see Check A's own
// comment above). The bare-ID surface survives only inside Check B's
// run-sheet HEADER region, where "Register row(s):" already supplies the
// context. Anything outside those shapes is not examined; the CLI success
// line says so rather than claiming universal coverage.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubGitEnv } from './git-env.mjs';
import { readNormalized } from './lib/read-normalized.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const REPO_ROOT = new URL('..', import.meta.url);
const REGISTER_PATH = 'docs/testing/onbox-acceptance-register.md';
const LIVE_VIEW_PATH = 'docs/testing/onbox-acceptance-register-live-view.html';

// A cited row ID is always `<UppercaseLetter><1-3 digits>`, e.g. A29, B2,
// E11. Never more than one letter, never a leading zero group beyond what a
// real row count would need.
const ROW_ID_TOKEN = '[A-Z]\\d{1,3}';

// Matches `row`/`rows`, optionally followed by a colon, then one or more ID
// tokens separated by `/`, `,`, `&`, or `and` — covers every real shape found
// in this repo: "row A1", "rows A46/B3", "rows A2, A3", "row A28 and A29",
// "Register row: A30", "register rows: A32/A33". The colon is optional
// because "Register row(s):" — the single most common form in this corpus —
// was previously unmatchable (a bare `\s+` after "row(s)" doesn't allow the
// colon in between).
const ROW_CITATION_REGEX = new RegExp(
  `\\brows?:?\\s+(${ROW_ID_TOKEN}(?:\\s*(?:[/,&]|\\s+and\\s+)\\s*${ROW_ID_TOKEN})*)`,
  'gi',
);

// A line that carries the register's own canonical ownership/citation label
// ("Register row:"/"Register rows:", any decoration, any prefix like `>` or
// a markdown link/backtick wrapper before the first ID) — e.g. "> Register
// row: [`onbox-acceptance-register.md` A30](onbox-acceptance-register.md)".
// Every bare ID token on such a line counts as cited, via
// extractIdTokensWithRanges (shared with Check B's header-paragraph parsing,
// including en-dash range expansion).
const REGISTER_ROW_LABEL_LINE_REGEX = /\bRegister rows?:/i;

// Pass-6 review of PR #2630 (finding A / "add the heading surface"): an
// earlier version of this check dropped the bare-ID heading surface
// entirely because `attribution-collapse-visibility-onbox-acceptance.md`
// numbers its OWN internal defects `D13`/`D18` in section headings ("## 5 ·
// D13 verdict …") — but the token in the ID POSITION there is `5`, not
// `D13`; an anchored `^#{2,6}\s+<ID>\s*·` never matches that heading at all.
// Measured tree-wide (non-frozen, non-self-referential files, matching
// scannedFiles): 34 of 35 real pack-section headings match, zero collide
// with D13/D18 or any other doc-local numbering scheme, and this is
// precisely the surface a uniform mechanical shift across a run of
// `### <ID> · …` headings (this repo's own PR #2630 finding A) rots first.
// A heading's ID is therefore a citation for Check A the same as the two
// idioms above — still subject to the same discharge/removal annotation
// exemption (enclosingSectionText), never a new unconditional failure mode.
//
// Pass-7 review of PR #2630 (finding F): the 35th heading —
// `onbox-sitting-voice-design.md:80`'s `### A6 + A7 · …`, a section that
// covers two register rows at once — has no `·` immediately after the FIRST
// ID token, so the single-ID form above silently missed it (paired
// injection: `### A96 + A97 · …` passed with EXIT=0 and nothing reported,
// while the single-ID control `### A96 · …` correctly errored). The
// alternation below accepts one or more `<ID> + <ID> ...` tokens before the
// `·`, so a multi-row heading cites every ID it names, not just would-be
// first one.
const HEADING_ID_REGEX = /^#{2,6}\s+([A-Z]\d{1,3}(?:\s*\+\s*[A-Z]\d{1,3})*)\s*·/;

// Pulls the individual ID tokens back out of one ROW_CITATION_REGEX match's
// captured list, e.g. "A46/B3" -> ["A46", "B3"]. Also used to pull every ID
// out of a HEADING_ID_REGEX match's captured group, e.g. "A6 + A7" ->
// ["A6", "A7"] (see HEADING_ID_REGEX's own comment).
function splitCitedIds(list) {
  return list.match(new RegExp(ROW_ID_TOKEN, 'g')) ?? [];
}

// Every ID cited by a `### <ID> [+ <ID> ...] · …` heading on this line, or an
// empty array when the line isn't one. Shared by extractCitationsByLine
// (Check A) and citationShapedLineIds (Check C) so both surfaces see every
// ID a multi-row heading names, not just the first.
function headingCitedIds(line) {
  const m = line.match(HEADING_ID_REGEX);
  return m ? splitCitedIds(m[1]) : [];
}

// Issue/PR numbers, for Check C's subject grouping. Covers a github.com
// issues/pull URL and a bare `#1234` / `PR #1234`. Bare `#1234` is
// deliberately unqualified (no "issue"/"PR" required before it) because
// register row headings themselves use both forms interchangeably.
const SUBJECT_NUMBER_REGEX = /(?:github\.com\/[^)\s]+\/(?:issues|pull)\/(\d+))|#(\d+)/g;

function extractSubjectNumbers(text) {
  const nums = new Set();
  for (const m of text.matchAll(SUBJECT_NUMBER_REGEX)) {
    nums.add(Number(m[1] ?? m[2]));
  }
  return nums;
}

// #2721/#2833: numbers introduced by an explicit "PR #nnnn"/"PR [#nnnn](...)"
// marker specifically — this repo's own "(#issue, PR #pr)" heading
// convention for naming an issue's OWN fixing PR alongside it (e.g. A19's
// real register heading, "(#1976, PR [#1993](...))"). A citation can use this
// convention even when the REGISTER's own row heading for that id doesn't
// (a plan link stands in for the PR instead, as A32's real register heading
// does) — in which case the PR number can never appear in `legitimateMap` no
// matter how `buildLegitimateSubjectMap` is written, because the register's
// own heading text never carries it. Deliberately narrower than "any other
// subject on the same line/segment": pass-9 finding X's own pinned tests
// (a bare "see also (#1001)" aside, and a bare "(#1000, #9999)" list) prove a
// same-line/segment subject that ISN'T introduced this specific way must
// still be checked normally — only the "PR #" syntax itself is read as
// asserting "this number names the same work as the issue beside it", not
// mere physical proximity.
const PR_SUBJECT_REGEX = /\bPR\s*\[?#(\d+)/gi;

function extractPrSubjectNumbers(text) {
  const nums = new Set();
  for (const m of text.matchAll(PR_SUBJECT_REGEX)) nums.add(Number(m[1]));
  return nums;
}

// --- Frozen paths -----------------------------------------------------

// Each of these is a dated record or the source of truth itself; rewriting
// an ID inside it would falsify what actually happened, not fix drift. Per
// entry, not just as a class:
//   - onbox-acceptance-staleness-audit.md: a dated (2026-08-11) snapshot of
//     the register's OWN row numbering at that moment, cited by ID against
//     itself elsewhere in this file's own comments; renumbering it would
//     make the audit disagree with the history it recorded.
//   - onbox-wave3-plan.md: a dated (2026-08-20) re-derivation quoting the
//     register verbatim, with LINE NUMBERS, per row — the whole point of
//     the file is "what the register said, cited exactly, on this date";
//     silently renumbering an ID inside it breaks that citation without
//     fixing anything (the row IDs it names are historical facts, not live
//     pointers, unlike a `docs/superpowers/` spec's "Owed acceptance"
//     section — see finding B in PR #2630's pass 6 for why that distinction
//     matters).
//   - onbox-wave4-linkage.md: same shape as the wave3 plan — a dated
//     cross-reference audit of IDs as they stood at that date.
//   - release-notes-next.md / RELEASE_NOTES.md: shipped-entry diaries; an
//     entry describes what was true when it shipped, per this repo's
//     release-notes convention (CLAUDE.md "release notes = diary, not a
//     live index").
//   - the register itself and its live-view HTML: the source of truth — a
//     row's own heading citing itself is not a "citation" to check at all.
const FROZEN_EXACT = new Set([
  'docs/testing/onbox-acceptance-staleness-audit.md',
  'docs/testing/onbox-wave3-plan.md',
  'docs/testing/onbox-wave4-linkage.md',
  'docs/release-notes-next.md',
  'RELEASE_NOTES.md',
  REGISTER_PATH,
  LIVE_VIEW_PATH,
]);

// Per entry, why it's frozen as a PREFIX rather than a single FROZEN_EXACT
// path (mirrors the per-entry rationale above):
//   - onbox-wave{3,4,5}-results/: each file under these prefixes is a dated
//     per-step results transcript from a wave sweep — the same shape as
//     onbox-wave3-plan.md/onbox-wave4-linkage.md above (a FROZEN_EXACT entry
//     each, one file), just spread across many files instead of one. Every
//     file records what the register said AT THAT TIME, cited by ID/line
//     number as evidence of a specific run; silently renumbering an ID
//     inside one would make the transcript disagree with the run it
//     recorded, without fixing anything.
//
// `docs/features/archive/` used to be listed here too. Pass-7 review of PR
// #2630 (finding B) found that wrong: it is 193 of these 274 frozen files —
// by far the largest exclusion — and `status: stable`/`shipped` describes
// the *plan document*, not every claim inside it. An "on-box acceptance
// owed (register row <ID>)" pointer in an archived plan is exactly as live
// as one in a `docs/superpowers/` spec (see isFrozenPath's `status: stable`
// history below) — it stays owed, and its citation stays live (IDs are
// allocated once and never renumbered or reused), until the plan's own "Ship
// notes" section (or an equivalent annotation) records the discharge, at
// which point the citation goes permanently dangling rather than silently
// re-pointed. Measured directly: unfreezing the prefix and
// running Check A over all 193 archived files found exactly two real,
// unannotated nonexistent-ID citations —
// `docs/features/archive/283-castwright-local-rebind.md:9` and `:193`,
// both fixed in the same round as this comment by annotating them with the
// discharge the file's own "Ship notes" section already recorded — and zero
// false positives elsewhere in the 193. So the prefix is removed rather than
// narrowed to per-file exceptions: nothing in `docs/features/archive/`
// needs a blanket exemption from Check A.
const FROZEN_PREFIXES = [
  'docs/testing/onbox-wave3-results/',
  'docs/testing/onbox-wave4-results/',
  'docs/testing/onbox-wave5-results/',
];

export function isFrozenPath(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (FROZEN_EXACT.has(p)) return true;
  return FROZEN_PREFIXES.some((prefix) => p.startsWith(prefix));
}

// Pass-6 review of PR #2630 (finding B): this used to be `isStableSuperpowersDoc`,
// excluding any docs/superpowers/** file from Check A wholesale when ITS OWN
// leading frontmatter said `status: stable` — on the theory that a stable
// spec/plan is a frozen design record. That theory is false — a stable
// doc's "Owed acceptance (on-box)" section is a LIVE pointer, not history,
// and this exclusion hid exactly one going stale
// (2026-08-13-language-recurrence-and-prompt-design.md:722 cited nonexistent
// `A46`/`B3` while its sibling plan file, not excluded, had already been
// corrected to `A43`/`B2`). Frontmatter `status:` describes the *design*,
// not whether every citation inside the file is dated narrative, so nothing
// under `docs/superpowers/` — or, since pass 7, `docs/features/archive/` —
// is exempted from Check A any more — the annotation mechanism (a
// discharge/removal note near the citation, see enclosingSectionText) is
// what legitimately excuses a citation to an ID that has since moved on,
// same as anywhere else in the tree. Do not reintroduce a directory-wide or
// status-keyed exclusion for this scan.

// --- Register parsing ---------------------------------------------------

// Blanks fenced code blocks so an example heading inside a fence can't be
// mistaken for a real one — mirrors check-onbox-register.mjs's stripFences.
function stripFences(text) {
  const lines = text.split('\n');
  let openFence = null;
  return lines
    .map((line) => {
      const trimmed = line.trimStart();
      if (openFence) {
        if (trimmed.startsWith(openFence)) openFence = null;
        return '';
      }
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        openFence = trimmed.startsWith('```') ? '```' : '~~~';
        return '';
      }
      return line;
    })
    .join('\n');
}

function splitSections(text, headingRegex) {
  const matches = [...text.matchAll(headingRegex)];
  const sections = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    sections.push({ title: matches[i][1].trim(), body: text.slice(start, end) });
  }
  return sections;
}

const ROW_HEADING_REGEX = /^### ([A-Z]\d{1,3})\s*(?:·\s*(.*))?$/gm;
// The register lives IN docs/testing/, so its own relative links to sibling
// run sheets are routinely bare filenames ("Run sheet:
// [`sidecar-evict-latency-onbox-acceptance.md`](...)"), not the full
// `docs/testing/...` path other rows spell out — proven by measurement:
// roughly half the register's run-sheet mentions use each form. The
// `docs/testing/` prefix is therefore OPTIONAL here; normaliseRunSheetPath
// restores it before the path is used to read the file.
const RUN_SHEET_PATH_REGEX = /(?:docs\/testing\/)?[\w-]+-onbox-acceptance\.md/g;

function normaliseRunSheetPath(matchedPath) {
  return matchedPath.startsWith('docs/testing/') ? matchedPath : `docs/testing/${matchedPath}`;
}

// How many characters before a run-sheet path mention to search for an
// ownership marker — see extractRunSheetMentions' own comment.
const RUN_SHEET_PHRASE_WINDOW = 60;

// The register uses THREE distinct phrasings to assert ownership of a run
// sheet, all confirmed by direct measurement against the real register: the
// prose phrase "run sheet" ("the run sheet `docs/testing/...`", "Run sheet:
// [...]", "run sheet §3 in `...`"), the structured field `*Criteria:*` (bold
// markdown, e.g. "*Needs:* ... *Criteria:* [`language-recurrence-onbox-
// acceptance.md`](...) §Voice-design gate."), and the plain (unbolded) label
// "Full criteria:" — the one real instance is C2's own body ("`state.json`'s
// ... carries a populated `unresolved`. Full criteria:
// `docs/testing/night-watch-reanalysis-onbox-acceptance.md` §2A.5..."),
// which is genuine ownership, not a borrowed reference (measured: it is the
// ONLY "Full criteria:"/"criteria:" occurrence in the register with no
// possessive "'s" naming a subsection of someone else's file — see
// POSSESSIVE_SUBSECTION_REGEX below, which still guards this marker the same
// as the other two). Deliberately NOT matched: bare "criteria" without
// either "Full " or the bold markers — that generic a phrase would also
// match the "already exist in ...'s section" borrowed-reference prose, which
// the possessive-exclusion below is what actually tells apart, not the
// marker text itself; a still-broader "criteria:" marker was tried and does
// not misfire against the current register (verified), but "Full criteria:"
// is the narrowest marker that fixes the one measured miss without widening
// past what's demonstrated.
const OWNERSHIP_MARKER_REGEXES = [/run sheet/i, /\*criteria:\*/i, /\bfull criteria:/i];

// `*Criteria:*` (and `Full criteria:`) are NOT exclusively ownership markers
// — A39's own body uses `*Criteria:*` for exactly the same borrowed-
// subsection shape as "already exist in ...'s section": "*Criteria:*
// `docs/testing/fs38-wave3-onbox-acceptance.md`'s `#2026 — ...` section"
// cites fs38-wave3 (owned by A1) for a SUBSECTION, not as A39's own run
// sheet — measured directly: without this exclusion, A39 misclassifies as
// owning fs38-wave3 and Check B then reports a false failure (fs38-wave3's
// header correctly cites A1, not A39). The distinguishing shape in both
// borrowed forms is the possessive "'s" (straight or curly apostrophe)
// immediately following the path, naming a section WITHIN the file rather
// than the file as the criteria destination itself — the genuine
// `*Criteria:*`/`Full criteria:` ownership shape (language-recurrence's
// rows, C2's night-watch-reanalysis reference) never has this, it names the
// whole file, then a separate "§... gate."/"§2A.5" clause. A short lookahead
// (past an optional closing `` ` ``/`]`/`)` the path sits inside) is enough
// to tell the two apart.
const POSSESSIVE_SUBSECTION_REGEX = /^[\u0060\u005d)]*[\u0027\u2019]s\b/;

function isPossessiveSubsectionReference(rowBody, matchEnd) {
  return POSSESSIVE_SUBSECTION_REGEX.test(rowBody.slice(matchEnd, matchEnd + 8));
}

/**
 * Not every `docs/testing/*-onbox-acceptance.md` path mentioned in a row's
 * body is THAT row's own dedicated run sheet — a row can instead borrow a
 * subsection of another row's run sheet ("the complete criteria already
 * exist in `fs38-wave3-onbox-acceptance.md`'s `#2026 —...` section", A39's
 * real body) without claiming ownership of it, and that borrowing does NOT
 * create a two-way linkage obligation (the borrowed run sheet is free to
 * cite whichever row actually owns it, not every row that ever borrows from
 * it). A path mention only counts as OWNED when one of OWNERSHIP_MARKER_REGEXES
 * appears within RUN_SHEET_PHRASE_WINDOW characters immediately before it.
 *
 * Every mention — owned or not — is also returned separately, so a
 * mentioned-but-not-classified-as-owned pair (a borrowed reference, or a
 * phrasing this checker doesn't yet recognise) can be surfaced rather than
 * silently invisible: an ownership rule that only ever REPORTS what it
 * classifies can never reveal what it fails to classify in the first place.
 *
 * @returns {{ owned: string[], mentioned: string[] }}
 */
function extractRunSheetMentions(rowBody) {
  const owned = [];
  const mentioned = [];
  for (const m of rowBody.matchAll(RUN_SHEET_PATH_REGEX)) {
    const path = normaliseRunSheetPath(m[0]);
    mentioned.push(path);
    const windowStart = Math.max(0, m.index - RUN_SHEET_PHRASE_WINDOW);
    const preceding = rowBody.slice(windowStart, m.index);
    const hasMarker = OWNERSHIP_MARKER_REGEXES.some((re) => re.test(preceding));
    const matchEnd = m.index + m[0].length;
    if (hasMarker && !isPossessiveSubsectionReference(rowBody, matchEnd)) owned.push(path);
  }
  return { owned, mentioned };
}

/**
 * Parses the register's `## Group <Letter>` sections into a Map keyed by row
 * ID. Row headings that appear OUTSIDE a `Group <Letter>` section are NOT
 * collected — mirrors check-onbox-register.mjs's own group-section
 * restriction, and for the same reason: only a group section's headings are
 * real rows.
 *
 * The "Blocked" section USED TO borrow live row IDs (`E6`/`E8`) for
 * cross-reference, and this comment cited that as the restriction's reason.
 * It no longer does: #2634/#2653 removed those IDs because one ID naming two
 * rows broke every citation to either, so a Blocked heading now carries its
 * title alone and check-onbox-register renders its `num` cell as `—`.
 * The restriction stays regardless — it is structural, not a workaround for
 * that one shape, and nothing stops a future non-group section from carrying
 * an ID-shaped heading.
 *
 * @returns {{ rows: Map<string, { title: string, issues: Set<number>,
 *   runSheetPaths: Set<string>, mentionedRunSheetPaths: Set<string>,
 *   bodyText: string }> }}
 */
export function parseRegisterRows(text) {
  const stripped = stripFences(text);
  const groupSections = splitSections(stripped, /^## (.+)$/gm).filter((s) =>
    /^Group [A-Z]\b/.test(s.title),
  );
  const rows = new Map();
  for (const section of groupSections) {
    const rowMatches = [...section.body.matchAll(new RegExp(ROW_HEADING_REGEX.source, 'gm'))];
    for (let i = 0; i < rowMatches.length; i++) {
      const id = rowMatches[i][1];
      const headingRestOfLine = rowMatches[i][2] ?? '';
      const start = rowMatches[i].index + rowMatches[i][0].length;
      const end = i + 1 < rowMatches.length ? rowMatches[i + 1].index : section.body.length;
      const rowBody = section.body.slice(start, end);
      // Subject numbers come from the HEADING LINE only (title + the
      // parenthetical issue/PR refs directly after it) — that is the row's
      // canonical association. Pulling from the whole body would also catch
      // every issue mentioned in passing prose, which is not what "this
      // row's subject" means.
      const issues = extractSubjectNumbers(headingRestOfLine);
      const { owned, mentioned } = extractRunSheetMentions(rowBody);
      rows.set(id, {
        title: headingRestOfLine.trim(),
        issues,
        runSheetPaths: new Set(owned),
        mentionedRunSheetPaths: new Set(mentioned),
        bodyText: rowBody,
      });
    }
  }
  return { rows };
}

// --- Check A: nonexistent ID --------------------------------------------

// Words this repo's own "annotate, don't renumber" fixes actually use when
// recording a discharged/removed row ID as deliberate history, rather than
// leaving a plain stale citation — e.g. "register row B3 was discharged on
// 2026-08-21 and no longer exists", "DISCHARGED 2026-08-07", "Group F no
// longer exists". Matched case-insensitively; deliberately narrow (a handful
// of words actually observed in this corpus) rather than a generic "this
// might be intentional" catch-all, which would swallow real drift too.
const DISCHARGE_ANNOTATION_REGEX = /\bdischarged\b|\bno longer exists?\b|\bremoved from the register\b/i;

// A heading of any level, `#` through `######` — used to bound the section a
// citation lives in for annotation detection. Matches ROW_HEADING_REGEX's
// own register-heading assumptions loosely; this one is intentionally
// generic since it scans arbitrary repo markdown, not just the register.
const ANY_HEADING_REGEX = /^#{1,6}\s/;

// A "section" only counts as a genuine bound when it's actually small — see
// enclosingSectionText's comment. Most real markdown sections in this corpus
// are well under this; a file with NO headings at all (every .ts/.tsx/.mjs/
// .html/.json/.yml file, and some .md files) makes `enclosingSectionText`'s
// naive heading search return start=0/end=lines.length — the WHOLE FILE — a
// real, measured bug: one occurrence of "discharged" anywhere in such a file
// (however unrelated to the citation) silently excused every nonexistent-ID
// citation in it.
const MAX_ANNOTATION_SECTION_LINES = 60;

// When no small heading-bounded section applies, fall back to this many
// lines on each side of the citation — "nearby paragraphs", not the whole
// file — so the annotation must genuinely be adjacent to the citation it
// excuses. Widened from 5: measured against the real corpus, a legitimate
// annotation and the citation it excuses can sit up to ~23 lines apart
// inside one un-headinged blockquote paragraph
// (`docs/superpowers/plans/2026-08-05-device-token-scope.md`'s "Stale
// premise" notes, added after the fact above a step that still names the
// discharged group) — a 5-line window missed both real instances measured.
// 25 catches both while staying well under MAX_ANNOTATION_SECTION_LINES, so
// it's still "a handful of paragraphs," not the whole-file blind spot this
// fallback exists to avoid.
const ANNOTATION_WINDOW_LINES = 25;

// Pass-6 review of PR #2630 (finding C): a discharge word anywhere in the
// enclosing section/window used to excuse EVERY nonexistent-ID citation in
// it, not just the one it was actually written about — paired injection
// proved it: a discharge comment 7 lines above an unrelated UI-toast
// assertion (which itself happens to contain "no longer exists", about a
// character alias, not a register row) disarmed the check for a genuinely
// wrong ID on the SAME line as the toast assertion. Every one of the 10 live
// annotations in this corpus actually names the ID it excuses right next to
// the discharge word ("register row B4, DISCHARGED", "A45 — discharged
// 2026-08-11 ...") — so requiring the annotation to reference the SAME ID,
// not just contain the word "discharged" somewhere in the window, costs
// nothing on the real tree and closes the paired-injection gap. 120
// characters is roughly one sentence/short clause either side of the ID
// mention — wide enough for "A45 — discharged 2026-08-11" (an em-dash and a
// date between them) without being wide enough to reach across an unrelated
// paragraph.
const ID_PROXIMITY_CHARS = 120;

// A bare ID token, used to find every ID mention in a section so a discharge
// word can be bound to the right one(s) — see idSpecificAnnotationPresent's
// own comment for why "within 120 chars" alone isn't enough.
const ANY_ID_TOKEN_REGEX = /\b([A-Z]\d{1,3})\b/g;

// A clause boundary: a semicolon, an em/en-dash that introduces the actual
// "<ID> is discharged/removed/..." subject-verb clause — this corpus's own
// convention ("... and A45 (...) — **B3 is discharged ..."), OR a blank-line
// paragraph break. IMPORTANT: this runs against the ALREADY-DEBOLDED text
// (`enclosingSectionText` is built from `deBold`'d lines), so the "**" bold
// marker that visually introduces the clause in the source is already gone
// by the time this regex sees it — measured directly: a first version keyed
// on "dash immediately followed by `**`" and it silently never matched
// anything, because deBold had already stripped it. The dash-then-"<ID> is"
// shape survives deBolding and is what actually distinguishes a clause-
// opening dash from a plain mid-sentence one: measured, an em-dash NOT
// followed by "<ID> is", e.g. "... F3\" below) — see \`docs/...\`'s..." or
// "... Task A-T5 above — the ...", is a plain mid-sentence dash, not a
// clause break, and treating every dash as one broke two real multi-ID
// annotations. A plain sentence-ending `.` MID-TEXT is DELIBERATELY not a
// boundary here either: one real annotation (`2026-08-05-device-token-
// scope.md`'s "... no longer exists.** Same note as Task A-T5 above — the
// \"Add on-box row F3\" ...") legitimately spans a period between the
// discharge word and the ID it excuses. The semicolon IS a boundary —
// measured: the real corpus's own `cast-id-drift-onbox-acceptance.md`
// discharge clause ends its "B3 is discharged ... and A45 ..." sentence with
// one ("... (2026-08-11); neither is in the register any more ..."), and
// without that boundary the clause ran on through the rest of the same
// blockquote (no blank line separates them) and wrongly reached a citation
// several lines further down — the exact shape a paired real-tree injection
// needs to defeat (see finding D's INJ-A/INJ-B).
//
// Pass-8 review of PR #2630 (finding O): a single bare newline (no blank
// line) was NOT a boundary at all — deliberately, so a legitimate multi-line
// blockquote annotation (the device-token-scope example above, wrapped
// across five `>` lines with no blank line anywhere in it) still reads as
// one clause. But that same permissiveness let a discharge word on one table
// row / list item / blockquote line excuse a citation on an ADJACENT,
// unrelated row/item/line, with nothing but a bare newline between them
// (real-tree paired injections R1/R3/R4, plus a nested-list repro, all
// defeated the pre-pass-8 rule this way). Two more boundary shapes close
// that gap without touching the legitimate multi-line-quote case above
// (verified: neither shape's pattern occurs anywhere inside it):
//   - a newline immediately followed by the START of a NEW table row
//     (`|`), list item (`-`/`*`/`+`/`1.`), or blockquote line whose own
//     content begins a fresh sentence-ending-terminated clause is bounded by
//     the rule below; a bare list/table/quote line-start is always treated
//     as beginning its own clause, since a legitimate cross-item annotation
//     spanning two separate rows/bullets with no connecting punctuation is
//     not a real shape in this corpus;
//   - sentence-ending punctuation (`.`/`!`/`?`) immediately followed by a
//     newline into a new `>`-quoted line — i.e. a completed sentence that
//     happens to end exactly at a blockquote line break — closes the R4
//     shape ("Register rows: A99 (Wave 4).\n> Historical note: ... B3 was
//     discharged ...") without firing on the device-token-scope annotation,
//     none of whose internal line breaks follow a period (each one wraps
//     mid-sentence).
//
// Pass-9 review of PR #2630 (finding Y): the two shapes above only ever
// tolerate a BARE list/table line-start, and the punctuated-sentence rule
// only reaches a QUOTED continuation, not a quoted SOURCE line. Both gaps
// are real corpus shapes, not inventions — measured: 92 blockquoted list
// items across 21 files, 50 blockquoted table rows across 3 files,
// including two of the on-box documents where discharge annotations
// actually live (`onbox-sitting-plan.md`, `fs38-wave3-onbox-acceptance.md`).
// Two more alternatives close them, each the SAME construct already
// trusted above with a leading `>` tolerated in front of it — not a new
// rule:
//   - a blockquoted list item or table row (`> - ...`, `> | ... |`) is a
//     boundary the same way a bare one already is; verified this doesn't
//     touch the legitimate multi-line-quote annotation, which contains
//     neither a list marker nor a table pipe at any of its own line
//     breaks;
//   - a newline into a new `>`-quoted line is ALSO a boundary when the
//     PRECEDING line is itself a "Register rows?:" label line (this
//     checker's own REGISTER_ROW_LABEL_LINE_REGEX idiom) — that label is,
//     by definition, a complete citation on its own, so a line break
//     after it can never be "mid-sentence" the way the device-token-scope
//     annotation's un-punctuated wrap is (verified: that control's own
//     "Register row A99 no longer" has no colon, so the lookbehind below
//     does not match it). This closes the punctuation-optional case where
//     the label itself supplies the completeness signal that a period
//     otherwise would.
//   Left OPEN, deliberately: a fully generic "was the line before this
//   break an independently-complete sentence" rule, for a plain (non-
//   label, non-quoted) prose paragraph with no terminal punctuation at
//   all — no real corpus instance of this shape was found, and no narrow,
//   measured heuristic distinguishes it from the legitimate un-punctuated
//   multi-line-quote case above; that is a design decision, not a
//   mechanical follow-on to this fix.
//
// Pass-10 review of PR #2630 (finding AE): pass 9's four `>`-tolerant
// alternatives above only ever tolerated exactly ONE `>` (`>?`, zero or
// one), and the label alternative keyed on the literal string "Register
// rows?:". Two real corpus shapes defeated both:
//   - a NESTED blockquote (`> > - ...`, two markers) still isn't a bare
//     list/table line-start under a single optional `>` — measured: 10
//     nested-blockquote lines exist in the corpus today (none currently
//     carries a discharge marker, so this is latent, not yet a live miss,
//     but "a section covering two rows, titled once" nests exactly this
//     way elsewhere in this same review round — see finding AC).
//   - "Rows:" (no "Register" prefix) is the SAME citation label
//     `ROW_CITATION_REGEX` already recognises elsewhere in this file (its
//     own comment: "the colon is optional ... 'Register row(s):' — the
//     single most common form" — the "Register " part was never load-
//     bearing for THAT regex either), so a line reading "> Rows: A99 (Wave
//     4)" already supplies the same completeness signal a "Register rows:"
//     line does, but the boundary lookbehind didn't recognise it.
// Both alternatives below now accept `(?:>[ \t]*)+` (or `*` where the
// existing rule already tolerated zero) in place of the single `>?`, for
// arbitrary nesting depth, and the label lookbehind accepts an optional
// "Register " prefix rather than requiring it. Verified this doesn't touch
// the legitimate multi-line-quote annotation (device-token-scope.md) or any
// other pinned case: none of those wraps a list/table marker inside nested
// `>` markers, and none opens with a bare "rows?:" label at all. Left OPEN,
// same as before: a plain, unlabelled, unpunctuated blockquote continuation
// with no list/table marker at the break — that is D9's own design
// question, not a mechanical extension of this fix.
const CLAUSE_BOUNDARY_REGEX =
  /;|[—–](?=\s*[A-Z]\d{1,3}\s+is\b)|[.!?]\s*\r?\n[ \t]*(?:>[ \t]*)+|(?<=\b(?:Register )?[Rr]ows?:.*)\r?\n[ \t]*(?:>[ \t]*)+|\r?\n[ \t]*(?:>[ \t]*)*(?:[-*+]\s|\d+\.\s|\|)|\r?\n[ \t]*(?:>[ \t]*)*\r?\n/g;

/**
 * The `[start, end)` span of `text` around `pos` that is bounded by the
 * nearest CLAUSE_BOUNDARY_REGEX match on each side (or the text's own start/
 * end when none exists).
 */
function clauseBounds(text, pos) {
  let start = 0;
  let end = text.length;
  CLAUSE_BOUNDARY_REGEX.lastIndex = 0;
  let m;
  while ((m = CLAUSE_BOUNDARY_REGEX.exec(text))) {
    const boundaryEnd = m.index + m[0].length;
    if (boundaryEnd <= pos) {
      start = boundaryEnd;
    } else {
      end = m.index;
      break;
    }
  }
  return { start, end };
}

/**
 * Whether `sectionText` contains a discharge/removal annotation that
 * actually references `id` — not merely a discharge word somewhere in the
 * section, which a paired injection proved lets unrelated prose excuse a
 * genuine defect (see ID_PROXIMITY_CHARS's own comment above).
 *
 * Pass-7 review of PR #2630 (finding D): the prior version tested each
 * mention of `id` in isolation — "is there a discharge word within 120
 * chars of THIS ID?" — which is satisfied for every ID on a line that names
 * several at once, since the same discharge word then sits within 120 chars
 * of all of them. Paired injection on the real corpus's own multi-ID header
 * line proved it: `cast-id-drift-onbox-acceptance.md`'s "… A45 …, and A99
 * (Wave 4) — B3 is discharged (2026-08-21) …" excused a smuggled A99
 * citation, because the discharge word "discharged" sits within 120 chars
 * of A45, A99, AND the B3 it's actually written about.
 *
 * A single "nearest ID wins" rule (tried first, measured, and rejected) is
 * too strict in the other direction: this corpus's own REAL annotations
 * routinely discharge two or three IDs in one sentence — the same
 * `cast-id-drift-onbox-acceptance.md` line continues "**B3 is discharged
 * (2026-08-21)\nand A45 (2026-08-11); neither is in the register any
 * more...**", and `2026-08-05-device-token-scope.md`'s "the repo owner
 * discharged the whole ... group (`F1` and the plan to add `F2`/`F3`
 * below)" discharges three — and "nearest wins" alone measurably broke both
 * (verified: it excused only B3/F1 and left A45/F2/F3 as fresh false
 * positives, plus a THIRD failure mode — a bare `[A-Z]\d{1,3}` scan for
 * "every ID mentioned anywhere" also matches task-numbering shapes like
 * `A-T5`/`B-T5` as if `T5` were a register ID, and `T5` sitting textually
 * nearer to the discharge word than the real ID out-competed it).
 *
 * A general sentence-boundary rule (every `.`/`;`, tried second, also
 * measured and rejected) is ALSO too strict: a third real annotation
 * (`2026-08-05-device-token-scope.md`'s "no longer exists.** Same note as
 * Task A-T5 above — the \"Add on-box row F3\" ...") legitimately spans a
 * period between its discharge word and the ID it excuses, so splitting on
 * every period put them in different clauses and broke this one instead.
 *
 * The fix that measures correctly on all three real cases, plus the
 * injected attack: bind a discharge word to every ID mention in its own
 * CLAUSE, where a clause boundary is a semicolon, an em/en-dash that
 * introduces an "<ID> is ..." subject-verb clause — this corpus's own
 * convention for introducing a discharge sentence — or a blank-line
 * paragraph break (see CLAUSE_BOUNDARY_REGEX). The injected A99 sits right
 * before the em-dash that introduces "B3 is discharged ...", so it's
 * excluded by that boundary the same way "nearest" excluded it, without
 * needing a general sentence-ending rule that would have excluded A45's
 * second, legitimate mention (after the SAME em-dash) or F3's (across an
 * unrelated period).
 * ID_PROXIMITY_CHARS still caps the clause (measured: all three real
 * multi-ID annotations sit well under it — 28, 67, and 75 chars from the
 * discharge word to their farthest legitimate ID) so an unpunctuated run-on
 * paragraph, or a clause with no closing dash at all, can't turn into an
 * unbounded excuse.
 *
 * Pass-8 review of PR #2630 (finding O): the DISCHARGE-WORD SCAN runs
 * against a copy with single-backtick INLINE CODE SPANS blanked
 * (`stripInlineCodeSpans`), the same way `stripFences` blanks triple-
 * backtick blocks — a real-tree paired injection showed a discharge word
 * sitting inside an example command (`` `grep "register row A99 was
 * discharged" docs/` ``) disarming the check, even though the text is an
 * instruction to run a search, not an assertion about anything. Blanking
 * preserves length, so the match indices found against the blanked copy are
 * still valid offsets into `sectionText`. The ID-TOKEN SCAN deliberately
 * keeps reading the ORIGINAL, unblanked `sectionText` — a bare-ID code span
 * like the real corpus's `` `F1` ``/`` `F2` ``/`` `F3` `` is a legitimate
 * annotation (see deBold's own comment: "a single backtick pair around an
 * ID ... carries no ambiguity worth stripping"), and blanking it too broke
 * that real annotation (measured: `docs/superpowers/plans/2026-08-05-
 * device-token-scope.md`'s `F2`/`F3` citations went from correctly-excused
 * to falsely-flagged the first time this was tried).
 */
function idSpecificAnnotationPresent(sectionText, id) {
  const dischargeScanText = stripInlineCodeSpans(sectionText);
  const dischargeMatches = [
    ...dischargeScanText.matchAll(new RegExp(DISCHARGE_ANNOTATION_REGEX.source, 'gi')),
  ];
  if (dischargeMatches.length === 0) return false;
  for (const dm of dischargeMatches) {
    const { start, end } = clauseBounds(sectionText, dm.index);
    ANY_ID_TOKEN_REGEX.lastIndex = start;
    let occ;
    while ((occ = ANY_ID_TOKEN_REGEX.exec(sectionText)) && occ.index < end) {
      if (occ[1] === id) {
        const dischargeCenter = dm.index + dm[0].length / 2;
        const occCenter = occ.index + occ[1].length / 2;
        if (Math.abs(occCenter - dischargeCenter) <= ID_PROXIMITY_CHARS) return true;
      }
    }
  }
  return false;
}

// Blanks single-backtick inline code spans (never triple-backtick fences —
// those are already blanked by stripFences before this ever runs), so
// character offsets used elsewhere (clauseBounds, ID_PROXIMITY_CHARS) don't
// shift. Used for finding discharge-word matches (idSpecificAnnotationPresent),
// finding citation matches (extractCitationsByLine), and — since pass 10 —
// checkConflictingSubjects's own line scan: an example command's code span
// must not read as a real discharge annotation OR as a real citation;
// blanking only some of the three let another one fire falsely (see
// extractCitationsByLine's and checkConflictingSubjects's own comments).
// Never for ID-TOKEN scanning, which must still see a bare-ID code span like
// the real corpus's `` `F1` ``/`` `F2` ``/`` `F3` `` (legitimate
// annotations, per deBold's own comment above: "a single backtick pair
// around an ID ... carries no ambiguity worth stripping"). See
// idSpecificAnnotationPresent's own comment (pass-8 review of PR #2630,
// finding O) for why an example command inside a code span must not read as
// a real discharge annotation.
//
// Pass-10 review of PR #2630 (finding AD): blanking the WHOLE span with
// plain spaces was two bugs in one, both measured against the real corpus:
//
//   - MANUFACTURED citation: "Skip rows `1-3` A99 in the export table."
//     blanks `1-3` to spaces, and ROW_CITATION_REGEX's `\brows?:?\s+<ID>`
//     then lets its own `\s+` bridge straight across the blanked run to
//     reach "A99" — a token that was never actually adjacent to "rows" in
//     the source. A plain-space blank is indistinguishable from real
//     whitespace to `\s+`, so it creates adjacency that never existed.
//   - SILENT MISS: "See register row `A99` for the outstanding work." blanks
//     the ID itself away, even though a single backtick pair around a bare
//     ID is this repo's OWN documented in-house style for a legitimate
//     citation (the exact shape deBold's comment already carves out for the
//     discharge-annotation side) — `fs38-wave3-onbox-acceptance.md:2643`'s
//     `` Register row: `docs/testing/onbox-acceptance-register.md` A25. ``
//     is this corpus's own real instance of the idiom.
//
// Fixed by treating a span whose ENTIRE (trimmed) content is exactly one row
// ID token as the id itself rather than blank: the backticks and any
// interior padding are replaced with spaces, but the id text stays legible
// to every consumer of the blanked copy — length-preserving either way, so
// offsets are unaffected. Any OTHER span (an example command, a path, a
// non-ID token like `1-3`) is blanked with a placeholder that is neither
// whitespace nor an ID/word character (a Private Use Area codepoint, chosen
// because it is guaranteed not to occur in real markdown source — unlike
// the NUL byte, which this repo's own `BINARY_SNIFF_BYTES` comment notes
// DOES occur, as a composite-key separator, in two real tracked files) — so
// `\s+`-based regexes can no longer bridge across a blanked span the way a
// plain-space blank did.
const CODE_SPAN_BLANK_CHAR = '';
const SINGLE_ID_SPAN_REGEX = new RegExp(`^${ROW_ID_TOKEN}$`);

function stripInlineCodeSpans(text) {
  return text.replace(/\u0060([^\u0060\n]*)\u0060/g, (m, inner) => {
    const trimmed = inner.trim();
    if (SINGLE_ID_SPAN_REGEX.test(trimmed)) {
      const pad = m.length - trimmed.length;
      const before = Math.floor(pad / 2);
      const after = pad - before;
      return ' '.repeat(before) + trimmed + ' '.repeat(after);
    }
    return CODE_SPAN_BLANK_CHAR.repeat(m.length);
  });
}

/**
 * The text used to look for a discharge/removal annotation "near" a
 * citation at `lineIndex` (0-based). Prefers the smallest markdown section
 * containing the citation — from the nearest heading at or before it to the
 * next heading (any level) strictly after it, or EOF — but only when that
 * section is itself small (<= MAX_ANNOTATION_SECTION_LINES): a heading-
 * bounded "section" that turns out to be the entire file (no headings at
 * all, or headings too far away to be a real bound) is not actually bounded,
 * and is exactly the shape that let an unrelated "no longer exists" sentence
 * anywhere in a 2,000-line test file disarm this check for the whole file.
 * In that case, fall back to a small fixed window around the citation
 * itself — the annotation must be adjacent to the citation it excuses, not
 * merely present somewhere in the same document.
 */
function enclosingSectionText(lines, lineIndex) {
  let start = 0;
  for (let i = lineIndex; i >= 0; i--) {
    if (ANY_HEADING_REGEX.test(lines[i])) {
      start = i;
      break;
    }
  }
  let end = lines.length;
  for (let i = lineIndex + 1; i < lines.length; i++) {
    if (ANY_HEADING_REGEX.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end - start <= MAX_ANNOTATION_SECTION_LINES) {
    return lines.slice(start, end).join('\n');
  }
  const windowStart = Math.max(0, lineIndex - ANNOTATION_WINDOW_LINES);
  const windowEnd = Math.min(lines.length, lineIndex + ANNOTATION_WINDOW_LINES + 1);
  return lines.slice(windowStart, windowEnd).join('\n');
}

// De-bolds a line so a bold-wrapped ID ("Discharges register rows **C1** ...
// and **C2**") still matches the plain-token regexes below — `**` is
// markdown emphasis, never part of a real ID or a discharge-annotation word,
// so stripping it everywhere is safe. Triple-backtick/tilde FENCED blocks are
// blanked separately by stripFences before this ever runs; this only strips
// the inline `**...**` marker itself, not code spans (a single backtick pair
// around an ID, e.g. `` `A30` ``, doesn't interfere with the token regexes
// and carries no ambiguity worth stripping).
function deBold(text) {
  return text.replace(/\*\*/g, '');
}

/**
 * Every ID cited in `text`, keyed by (0-based) line index, from the three
 * surfaces Check A trusts — a bare token alone, e.g. in a table cell, is
 * still never enough (see this file's header comment for why the bare-ID
 * table-cell surface stays excluded even though the heading surface no
 * longer is):
 *   1. the "row(s) [:]? ID[, ID ...]" prose idiom (ROW_CITATION_REGEX);
 *   2. a "Register row(s):" label line, any decoration, any surrounding
 *      markdown (REGISTER_ROW_LABEL_LINE_REGEX + extractIdTokensWithRanges,
 *      including en-dash range expansion);
 *   3. an anchored `### <ID> · …` section heading (HEADING_ID_REGEX) — see
 *      this file's header comment for the zero-collision measurement.
 *
 * Pass-9 review of PR #2630 (finding AB): scanned against a copy with
 * single-backtick inline code spans blanked (`stripInlineCodeSpans`), the
 * same way `idSpecificAnnotationPresent` already blanks them before its own
 * discharge-word scan. Applying that ONLY on the discharge side was the
 * bug, not a design choice: an example command that happens to contain the
 * "row <ID>" idiom inside one code span (the real corpus's own
 * `` `grep -n "register row B3 was discharged 2026-08-21" docs/` `` audit
 * note) got treated as a live citation here while that SAME span's
 * discharge word was invisible to the annotation scan that would have
 * excused it — turning a documented example into a FATAL nonexistent-ID
 * error. `stripInlineCodeSpans` preserves length, so line indexing is
 * unaffected, and (measured against the real corpus) no live "row(s) ID"/
 * "Register row(s):"/heading citation is itself wrapped in a single-backtick
 * span, so this costs nothing on a real citation today.
 * @returns {Map<number, Set<string>>}
 */
function extractCitationsByLine(text) {
  const stripped = deBold(stripFences(text));
  const scanLines = stripInlineCodeSpans(stripped).split('\n');
  const byLine = new Map();
  const add = (i, ids) => {
    if (!ids.length) return;
    if (!byLine.has(i)) byLine.set(i, new Set());
    for (const id of ids) byLine.get(i).add(id);
  };

  scanLines.forEach((line, i) => {
    for (const m of line.matchAll(ROW_CITATION_REGEX)) {
      add(i, splitCitedIds(m[1]));
    }
    if (REGISTER_ROW_LABEL_LINE_REGEX.test(line)) {
      add(i, [...extractIdTokensWithRanges(line)]);
    }
    add(i, headingCitedIds(line));
  });

  return byLine;
}

/**
 * @returns {{ errors: string[], annotated: string[] }} — `errors` are
 *   unannotated nonexistent-ID citations (fail the gate); `annotated` are
 *   the same defect but with a discharge/removal annotation already present
 *   near the citation (printed, non-fatal — see this file's header comment
 *   for why a correct tree can legitimately contain these).
 */
export function checkNonexistentIds(text, filePath, registerRows) {
  const errors = [];
  const annotated = [];
  const lines = deBold(stripFences(text)).split('\n');
  const byLine = extractCitationsByLine(text);
  const sortedLineIndexes = [...byLine.keys()].sort((a, b) => a - b);
  for (const i of sortedLineIndexes) {
    for (const id of [...byLine.get(i)].sort()) {
      if (registerRows.has(id)) continue;
      const message = `${filePath}:${i + 1} — cited ${id} — no such row in ${REGISTER_PATH} (nonexistent ID)`;
      if (idSpecificAnnotationPresent(enclosingSectionText(lines, i), id)) {
        annotated.push(`${message} — annotated as discharged/removed, not failing`);
      } else {
        errors.push(message);
      }
    }
  }
  return { errors, annotated };
}

// --- Check B: bidirectional run-sheet linkage ---------------------------

/**
 * @param {Map<string, object>} registerRows
 * @param {(path: string) => string} readFile — reads a repo-relative path's
 *   text; thrown ENOENT is reported as an error rather than propagated.
 */
// Run sheets carry their own citation idiom, distinct from the "register
// row A29" prose used elsewhere: a header line ("Register rows:
// [A36–A38](...)"), or an en-dash/hyphen ID range — neither of which say the
// word "row" next to the ID every time. Requiring ROW_CITATION_REGEX here
// would make every one of those a false "doesn't cite back". (A criteria
// TABLE cell is not among these — this check only ever reads the header
// paragraph, and no real run-sheet header places a table there; see the
// paired test for what actually happens when a table appears below the
// header instead.)
//
// A whole-file bare-token scan (the first version of this check) is WRONG,
// not just imprecise: a real run sheet's body legitimately mentions its own
// row ID again in Result lines, discharge notes and cross-references, so a
// whole-file scan is satisfied by ANY mention anywhere — it never actually
// tests whether the file's own HEADER, the thing that asserts ownership,
// cites the right row. Proven false-negative: pasting a wrong ID into
// `sidecar-evict-latency-onbox-acceptance.md`'s header while its body still
// said "mark the register row A24 discharged" elsewhere passed silently.
// Check B's real job is narrower: does THIS run sheet's own header
// paragraph — the `> Register row(s): ...` line the register's own
// convention relies on existing — name the row that claims it.
//
// The header region is the file's leading blockquote block, ending at the
// first `\n---` horizontal rule (every real run sheet in this repo opens
// that way — title, blank line, a `>`-prefixed metadata block, blank line,
// `---`). Falls back to the first HEADER_FALLBACK_LINES lines when no `---`
// is found at all, rather than scanning the whole file — a file with no
// front-matter block has no header to check, which is itself reportable,
// not a reason to silently widen the scan back to "anywhere".
const HEADER_FALLBACK_LINES = 40;

function extractHeaderRegion(text) {
  // A file can open with its OWN `---`-fenced YAML frontmatter
  // (`---\nstatus: draft\n---`) before the title/metadata block this check
  // actually wants. Naively taking the first `\n---` would return just the
  // frontmatter's interior and miss the real header entirely — skip past a
  // leading frontmatter fence before looking for the header-ending `---`.
  let searchFrom = 0;
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const fmEnd = text.indexOf('\n---', 3);
    if (fmEnd !== -1) searchFrom = fmEnd + 4;
  }
  const idx = text.indexOf('\n---', searchFrom);
  if (idx !== -1) return text.slice(0, idx);
  return text.split('\n').slice(0, HEADER_FALLBACK_LINES).join('\n');
}

// Within the header region, the `Register row(s):` paragraph — the line
// itself plus any immediately-following `>`-prefixed continuation lines (the
// ort-marker run sheet wraps its row list across three), stopping at the
// first blank line or the end of the header region.
const REGISTER_ROW_LINE_REGEX = /^>?\s*Register rows?:.*$/im;

function extractRegisterRowParagraph(headerRegion) {
  const lines = headerRegion.split('\n');
  const startIdx = lines.findIndex((l) => REGISTER_ROW_LINE_REGEX.test(l));
  if (startIdx === -1) return null;
  const paragraph = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || !/^>/.test(line.trim())) break;
    paragraph.push(line);
  }
  return paragraph.join('\n');
}

// An en-dash/hyphen ID range ("A36–A38") names its endpoints but not the
// row(s) between them — a bare word-boundary scan alone would miss A37.
// Expanded only within the same letter, and only across a small span (a
// misparsed range spanning hundreds of numbers is a sign this matched
// something else, not a real range — silently emitting hundreds of bogus
// IDs would be worse than under-expanding).
const ROW_ID_RANGE_REGEX = /\b([A-Z])(\d{1,3})\s*[–—-]\s*([A-Z]?)(\d{1,3})\b/g;
const MAX_RANGE_SPAN = 20;

function extractIdTokensWithRanges(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\b([A-Z]\d{1,3})\b/g)) ids.add(m[1]);
  for (const m of text.matchAll(ROW_ID_RANGE_REGEX)) {
    const [, letter, startStr, endLetter, endStr] = m;
    if (endLetter && endLetter !== letter) continue; // e.g. "A36-E7", not a same-group range
    const start = Number(startStr);
    const end = Number(endStr);
    if (end < start || end - start > MAX_RANGE_SPAN) continue;
    for (let n = start; n <= end; n++) ids.add(`${letter}${n}`);
  }
  return ids;
}

export function checkRunSheetLinkage(registerRows, readFile) {
  const errors = [];
  for (const [id, row] of registerRows) {
    for (const runSheetPath of row.runSheetPaths) {
      let text;
      try {
        text = readFile(runSheetPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          errors.push(
            `${REGISTER_PATH} — row ${id} names run sheet ${runSheetPath}, but that file was not found`,
          );
          continue;
        }
        throw err;
      }
      const headerRegion = extractHeaderRegion(text);
      const paragraph = extractRegisterRowParagraph(headerRegion);
      if (paragraph === null) {
        errors.push(
          `${runSheetPath} — named by register row ${id} but has no "Register row(s):" header ` +
            `line for this check to verify`,
        );
        continue;
      }
      const citedIds = extractIdTokensWithRanges(paragraph);
      if (!citedIds.has(id)) {
        errors.push(
          `${runSheetPath} — named by register row ${id}, but its header cites ` +
            (citedIds.size > 0 ? `${[...citedIds].sort().join(', ')} instead` : 'no row ID at all'),
        );
      }
    }
  }
  return errors;
}

/**
 * Every `*-onbox-acceptance.md` path a register row mentions but that
 * extractRunSheetMentions did NOT classify as owned (a borrowed reference,
 * or a phrasing OWNERSHIP_MARKER_REGEXES doesn't recognise) — printed as its
 * own non-fatal list rather than left invisible. checkRunSheetLinkage only
 * ever evaluates `runSheetPaths` (the owned set); a pair excluded from that
 * set is a pair this checker NEVER verifies, and reporting only what got
 * classified can never reveal that exclusion. This is the fix for exactly
 * that blind spot (measured: a manual sweep found 8 owned run sheets before
 * `*Criteria:*` was recognised as an ownership marker here, while this
 * checker only evaluated 7 — the 8th was silently unclassified, not merely
 * unverified-but-visible).
 *
 * @returns {{ path: string, id: string }[]}
 */
export function findUnclassifiedRunSheetMentions(registerRows) {
  const unclassified = [];
  for (const [id, row] of registerRows) {
    for (const path of row.mentionedRunSheetPaths) {
      if (!row.runSheetPaths.has(path)) unclassified.push({ path, id });
    }
  }
  return unclassified;
}

// --- Check C: one subject, conflicting IDs -------------------------------

/**
 * Subject numbers found in the same discharge-word CLAUSE as a mention,
 * anywhere in one row's own body text — reuses the exact clause-bounding and
 * proximity-capping logic `idSpecificAnnotationPresent` uses
 * (DISCHARGE_ANNOTATION_REGEX + clauseBounds + ID_PROXIMITY_CHARS), just
 * scanning for subject-number tokens instead of ID tokens, because it answers
 * a different question: not "does this discharge note excuse a specific ID"
 * but "does this row's OWN section document which subject(s) it used to track
 * before discharging / being re-minted for different work". This is the
 * register's own record of a row's history — the only place that history can
 * live, since a re-minted row's CURRENT heading (`issues`) only ever reflects
 * what it tracks NOW.
 *
 * Pass-11 review of PR #2846 (finding #1, CRITICAL): polarity-check the
 * discharge word — "NOT discharged" (and similar negated contexts like "is
 * why A16 below is not fully discharged") must not match as affirmative
 * discharges. This is a polarity check `idSpecificAnnotationPresent` itself
 * does NOT have (it is unconcerned with polarity, since it only answers
 * whether a discharge word and a specific ID token co-occur in a clause, not
 * what either one asserts) — added here, scoped to `clauseBounds`, because
 * this function's answer of "did this row historically track this subject"
 * is exactly the kind of claim a negated sentence can falsify. Pass-15
 * review (finding new-B, SIGNIFICANT): the negation-word set is deliberately
 * broad (NOT/no/never/isn't/aren't/wasn't/weren't/hasn't/haven't/cannot/
 * can't/an "un-" prefix fused to the discharge word/"far from"/"nothing"),
 * since the first cut (just "NOT"/"no") missed most real negation phrasings.
 * Also applies the same ID_PROXIMITY_CHARS cap `idSpecificAnnotationPresent`
 * uses so a subject number far from its discharge word (>120 chars) is not
 * incorrectly attributed to a row that merely MENTIONS it in passing (e.g.
 * in discussion of another row's history), and (pass-15, finding new-A)
 * excludes a harvested number that `extractPrSubjectNumbers` identifies as a
 * "PR #nnnn" reference rather than a genuine subject number, the same
 * PR-vs-subject distinction the file already makes elsewhere.
 */
function dischargedSubjectsMentionedIn(rowBodyText) {
  const scanText = stripInlineCodeSpans(rowBodyText);
  const dischargeMatches = [
    ...scanText.matchAll(new RegExp(DISCHARGE_ANNOTATION_REGEX.source, 'gi')),
  ];
  const subjects = new Set();
  for (const dm of dischargeMatches) {
    // Get clause bounds first so we can use them for both polarity and subject scanning.
    const { start, end } = clauseBounds(scanText, dm.index);

    // Polarity check: scan within the same clause as the discharge word to look for
    // negation markers that would negate it. Bound the scan to the clause bounds
    // (not a flat window) to avoid matching unrelated negations across clause/list-item boundaries.
    // Recognize a broad set of negation patterns:
    // - "NOT", "no" (complete words)
    // - "never", "isn't", "aren't", "wasn't", "weren't" (contractions)
    // - "hasn't (been)", "haven't (been)" (auxiliary verbs with "have")
    // - "cannot be", "can't be" (modal verbs)
    // - "far from" (degree modifier)
    // - "nothing" followed (in the same clause) by "is" (negating existential)
    const polarityContext = scanText.slice(start, dm.index);
    // Apostrophes are '-escaped (not literal) so this regex literal
    // doesn't desync spawn-windows-hide.test.ts's quote-tracking scanner —
    // see that guard's own regexLiteralDesyncsQuoteTracking comment.
    const hasNegationWord =
      /\b(?:NOT|no|never|isn\u0027t|aren\u0027t|wasn\u0027t|weren\u0027t|hasn\u0027t|haven\u0027t|cannot|can\u0027t|far\s+from|nothing)\b/i.test(
        polarityContext,
      );
    // Also check if the discharge word itself is prefixed with "un-" (e.g., "undischarged", "un-discharged")
    const isUnPrefixed = /un-?discharged\b/i.test(scanText.slice(Math.max(0, dm.index - 10), dm.index + dm[0].length));
    if (hasNegationWord || isUnPrefixed) {
      // This discharge word is negated, skip it.
      continue;
    }

    // Scan for subject numbers in the clause, applying proximity cap.
    // Use scanText (not rowBodyText) so indices are consistent.
    // Extract text for the clause and scan it, adjusting indices back.
    const clauseText = scanText.slice(start, end);
    // Extract PR-marked subject numbers to exclude them from genuine subject
    // references (#2721 new-A: "PR #nnnn" is a reference to the PR itself, not a
    // subject the row discharged).
    const prSubjects = extractPrSubjectNumbers(clauseText);
    for (const smatch of clauseText.matchAll(SUBJECT_NUMBER_REGEX)) {
      const subject = Number(smatch[1] ?? smatch[2]);
      // Skip numbers that are marked with "PR #" — they reference a PR, not a subject.
      if (prSubjects.has(subject)) {
        continue;
      }
      // Measure character distance from discharge word center to subject center.
      // smatch.index is relative to clauseText, so convert to full scanText coords.
      const dischargeCenter = dm.index + dm[0].length / 2;
      const subjectIndex = start + smatch.index + (smatch[0].length / 2);
      if (Math.abs(subjectIndex - dischargeCenter) <= ID_PROXIMITY_CHARS) {
        subjects.add(subject);
      }
    }
  }
  return subjects;
}

/**
 * Builds the register's own answer to two questions `recordSubjectConflict`
 * needs — both derived from `registerRows`, so it never has to reach back
 * into `registerRows` itself (#2721/#2842: the previous version left that
 * reach-around AS a special case bolted onto `recordSubjectConflict`, rather
 * than folding it in here):
 *
 *   - `ownersOf(subject)`: which row IDs the register's CURRENT headings say
 *     legitimately own this subject (unchanged from before this fix — a
 *     subject CAN legitimately span two rows at once).
 *   - `historicalOwnersOf(subject)`: which row IDs the register's own text
 *     documents as having ONCE legitimately owned this subject, via a
 *     discharge/re-mint annotation in THAT ROW'S OWN body text (see
 *     `dischargedSubjectsMentionedIn`) — this is what lets
 *     `recordSubjectConflict` tell "this ID owned the subject once, before
 *     its own row discharged or was re-minted for other work" apart from "this
 *     ID never had anything to do with the subject at all", the distinction
 *     #2832's verify pass found missing (#2721/#2842).
 *   - `currentSubjectsOf(id)`: the subject set `id`'s row currently carries,
 *     i.e. what it tracks NOW if it moved on — used only for message text and
 *     for telling a re-minted row (carries other subject metadata) apart from
 *     a row that never carried any (the 21-of-65 structural gap).
 */
function buildLegitimateSubjectMap(registerRows) {
  const current = new Map();
  const historical = new Map();
  for (const [id, row] of registerRows) {
    for (const subject of row.issues) {
      if (!current.has(subject)) current.set(subject, new Set());
      current.get(subject).add(id);
    }
    for (const subject of dischargedSubjectsMentionedIn(row.bodyText)) {
      if (!historical.has(subject)) historical.set(subject, new Set());
      historical.get(subject).add(id);
    }
  }
  return {
    ownersOf: (subject) => current.get(subject),
    historicalOwnersOf: (subject) => historical.get(subject),
    currentSubjectsOf: (id) => registerRows.get(id)?.issues,
  };
}

// Pass-6 review of PR #2630 (finding D): the character-window approach this
// constant drove (±200 chars around a citation) produced 114 `--strict`
// warnings on the real tree, essentially all noise (an unrelated campaign/
// review/PR reference sharing a paragraph with an unrelated citation), which
// is what the header comment's "not trustworthy enough to gate on, or even
// to print unasked" verdict was measured against. That measurement was of
// the WINDOW, not of the underlying idea. Re-measured (own test, not taken
// on faith): restricting the subject<->ID association to the SAME LINE
// removes most, not all, of the 114 — the review's own reason still applies
// to a "Register row(s): A29, B3, A30, and A45 (#2128 ...)" label line
// listing several rows with only one of them plausibly tied to the trailing
// issue number; same physical line, still ambiguous. Scoping same-line
// association to ONLY the two surfaces that are never multi-row — an
// anchored `### <ID> · …` heading and a `Criteria source:` line, each
// naming exactly one row — removes ALL of that class: 2 residual warnings
// on the corpus as it stands today (a heading citing both an issue AND its
// fixing PR, where the register's own heading tracks only the issue — a
// structural mismatch in what counts as a row's "subject set", not a wrong
// citation), and catches PR #2630's finding A outright — injecting the
// original four wrong headings back produces 8 of 9 warnings naming exactly
// those four lines, each stating which ID the subject actually maps to.
// Kept exploratory/opt-in (never fatal) per the same header-comment
// rationale — this still can't see every citation (the 21-of-65 rows with
// no issue/PR number in their heading are still uncheckable in either
// direction, and a "Register row(s):" list is still not scanned here) — but
// its ground truth is no longer "too thin to trust", only "incomplete".
const CRITERIA_SOURCE_LINE_REGEX = /\bCriteria source:/i;

/**
 * A line counts as "citation-shaped" for Check C only when every row it
 * names is unambiguous: an anchored `### <ID> [+ <ID> ...] · …` heading, or
 * the sibling `Criteria source:` idiom (every use in the corpus is a
 * `> **Criteria source:** ... <ID>.` line immediately under a pack section's
 * own heading). Deliberately narrower than Check A's three surfaces — the
 * "row(s) ID" prose idiom and a "Register row(s):" label line can both name
 * several rows with NO fixed correspondence to the subjects also on the
 * line (which subject goes with which row is not recoverable from the text
 * at all), which is exactly the shape that kept two of the old window's
 * false positives alive under same-line scoping too (see this section's own
 * comment above). A multi-ID heading is different in kind, not just in
 * degree: `### A40 + A41 · Title1 (#2310) + Title2 (#2106)` names its rows
 * via a fixed, anchored syntax — pass-8 review of PR #2630 (finding R) — so
 * each id IS unambiguous, it just isn't positionally bound to a single
 * subject the way a one-id heading is; `headingTitleSegments` is what
 * accounts for that (see its own comment, pass-9 review finding X). Check C
 * only trusts a line whose id<->row correspondence can't be ambiguous the
 * way the two excluded surfaces are.
 */
function citationShapedLineIds(line) {
  const ids = new Set();
  if (CRITERIA_SOURCE_LINE_REGEX.test(line)) {
    for (const id of extractIdTokensWithRanges(line)) ids.add(id);
  }
  for (const id of headingCitedIds(line)) ids.add(id);
  return ids;
}

/**
 * Two severities of the same "one subject, conflicting IDs" defect — see this
 * file's header comment (Check C section) for the pass-7 split (finding G):
 *
 *   - `wrongId`: an EXISTING row ID cited for a subject that legitimately
 *     maps to a DIFFERENT set of IDs. Unambiguous — the register itself says
 *     what the subject's ID(s) should be — so this is FATAL and runs by
 *     default, no `--strict` needed.
 *   - `unknownSubject`: the subject doesn't appear in ANY current
 *     register-row heading at all. Still worth surfacing (a subject leaves
 *     the register precisely when its row discharges, so this is exactly
 *     when citations start rotting — failing open here, as an earlier
 *     version of this check did, silenced it at the one moment it was
 *     needed), but genuinely thinner ground truth (see header comment): kept
 *     EXPLORATORY, OPT-IN, NEVER FATAL, gated by `--strict` at the CLI.
 *
 * @param {Map<string, string>} fileTexts — path -> full text, already
 *   filtered to non-frozen files.
 * @param {Map<string, object>} registerRows
 * @returns {{ wrongId: string[], unknownSubject: string[] }}
 */
// Pass-8 review of PR #2630 (finding R) added a multi-ID exemption that
// pass-9 review (finding X) proved over-broad: exempting an id the moment it
// legitimately owned ANY subject on the line meant a THIRD subject that
// neither cited id owns — or, on a single-ID line with an unrelated "see
// also" subject, the id's own second subject — went unflagged too, since the
// exemption applied to the id as a whole rather than to the specific
// subject it actually explains. Fixed by pairing POSITIONALLY instead of
// exempting: a multi-ID heading whose title splits into exactly as many
// ` + `-joined segments as it has IDs (the real shape — "Title1 (#2310) +
// Title2 (#2106)") pairs each id with the subject(s) named in ITS OWN
// segment only, so a subject neither cited id's own segment claims is still
// evaluated normally, not waved through because a DIFFERENT id/subject pair
// on the same line happens to be correct. Returns null — meaning "check this
// id against every subject on the whole line, the pre-finding-R behaviour" —
// for a single-ID line, or a multi-ID heading whose title is ONE shared
// clause rather than a per-ID pairing (e.g. "### A2 + A1 · Some combined
// section (#1000)" — a single subject for a section that covers both IDs at
// once; splitting that title on ` + ` yields one segment against two IDs, a
// count mismatch that signals "not a per-ID pairing" rather than "pair id 1
// with an empty segment").
//
// Pass-10 review of PR #2630 (finding AC): the ` + `-with-matching-count
// shape is the ONLY one this function recognises, deliberately — it is the
// one spelling where positional pairing is unambiguous. Every OTHER
// multi-ID title shape (a comma or `&` between subjects, an en-dash, a
// segment/id count mismatch, a bold- or link-wrapped id) returns `null`
// here, same as before this pass. What changed is what `checkConflictingSubjects`
// does with that `null` — see its own comment below for why "check every id
// against every subject" (this function's pre-existing `null` contract) is
// no longer what happens next.
function headingTitleSegments(line) {
  const m = line.match(HEADING_ID_REGEX);
  if (!m) return null;
  const ids = splitCitedIds(m[1]);
  if (ids.length < 2) return null;
  const segments = line.slice(m[0].length).split(/\s\+\s/);
  if (segments.length !== ids.length) return null;
  // Pass-11 review of PR #2630 (finding AK): a matching segment/id count
  // alone doesn't prove the ` + ` split fell on the per-ID boundary — a
  // natural-language conjunction INSIDE one segment's own prose ("decode +
  // encode acceptance (#2310, #2106)") can split into the right NUMBER of
  // pieces by coincidence while mis-pairing every id, because the split
  // point isn't the one between the two titles at all. The one shape this
  // function is meant to recognise is "each id's own clause carries its own
  // subject(s)" — a segment with NO subject number at all means the split
  // didn't land where a real per-ID title boundary would put it (a genuine
  // per-ID segment always has something to cite), so falling through to
  // `null` here routes to `checkConflictingSubjects`' non-positional,
  // exemption-based path instead of pairing ids to the wrong segments.
  if (!segments.every((segment) => extractSubjectNumbers(segment).size > 0)) return null;
  return { ids, segments };
}

/**
 * Records one id/subject pairing's verdict — shared by the positional
 * (`headingTitleSegments`) and non-positional paths in `checkConflictingSubjects`
 * so both produce identically-worded messages. Never reaches into
 * `registerRows` directly — `legitimateMap` (`buildLegitimateSubjectMap`'s
 * return value) is the single source of truth for every register-derived
 * question this function asks (#2721/#2842 — see that function's own
 * comment for why the previous version's direct `registerRows.get(id)`
 * reach-around was itself the defect #2832's verify pass found).
 *
 * TWO branches, by whether the subject currently has ANY legitimate owner:
 *
 * `legitimateMap.ownersOf(subject)` is EMPTY/undefined — the subject doesn't
 * appear in any current register-row heading at all. #2721/#2833 widened
 * this from a single non-fatal `unknownSubject` bucket into three, by what
 * `id`'s own row proves:
 *
 *   - `legitimateMap.historicalOwnersOf(subject)` includes `id` — `id`'s own
 *     row documents (a discharge/re-mint annotation naming this subject in
 *     its own body text) that IT used to legitimately own this subject.
 *     Non-fatal, `annotatedDischarge`.
 *   - `legitimateMap.currentSubjectsOf(id)` is non-empty (and the above
 *     didn't already match) — the register's OWN text proves `id` currently
 *     tracks DIFFERENT, known work, but nothing on `id`'s own row explains
 *     THIS subject specifically. Under stable, allocate-once IDs (#2717),
 *     that is only possible because the subject's row discharged and `id`
 *     was later re-minted for unrelated work — unambiguous dangling, same as
 *     a uniform ID shift across headings. Fatal `wrongId`, UNLESS a discharge
 *     annotation naming THIS id sits near the CITATION itself
 *     (`idSpecificAnnotationPresent`, the same mechanism Check A uses — a
 *     file that documents its own staleness, e.g. "Register row: A19 —
 *     discharged...", is historical record, not a live defect). Printed
 *     non-fatal into `annotatedDischarge` instead.
 *   - Neither — `id` itself carries no subject metadata to compare against
 *     either (a plan-only row like A3, 21 of 65 real rows). A structural
 *     coverage gap, not a proven-wrong citation. Stays `unknownSubject`,
 *     exploratory/opt-in.
 *
 * `legitimateMap.ownersOf(subject)` is NON-EMPTY but doesn't include `id` —
 * the subject still has a live row, just not via this id. Before #2721/#2842
 * this was unconditionally fatal, which could not tell "genuinely wrong id,
 * never owned this subject" (the uniform-ID-shift class PR #2630 exists to
 * catch) apart from "this id owned the subject once too, before its own row
 * discharged/was re-minted, but the subject still has a live sibling row" —
 * a multi-row subject losing one of its rows, not leaving the register.
 * `legitimateMap.historicalOwnersOf(subject)` is exactly that distinction:
 * when it includes `id`, non-fatal (`annotatedDischarge`) regardless of
 * whether the CITATION itself is annotated — the register's own row already
 * documents the history, which is the ground truth this whole file is built
 * on. When it doesn't, `id` has no register-text tie to this subject at all:
 * fatal `wrongId`, unchanged from before.
 *
 * `isOwnedPrCompanion` is a THIRD, narrower exemption checked first: `subject`
 * was introduced by an explicit "PR #nnnn" marker (`extractPrSubjectNumbers`)
 * AND `id` already legitimately owns a DIFFERENT subject cited on the same
 * line/segment — read as a companion reference (the fixing PR of that other,
 * legitimately-owned issue) that the register's own heading simply never
 * recorded, not a citation defect, so nothing is printed. Measured real case:
 * A32's own citation pairs its tracked issue #2310 with its fixing PR #2316,
 * which the register's A32 heading never mentions (it links a design plan
 * instead) — #2316 can never appear in `legitimateMap` no matter how
 * `buildLegitimateSubjectMap` is written, because the register's own row
 * heading text doesn't carry it. Deliberately gated on the "PR #" marker,
 * not mere same-line/segment presence — see `extractPrSubjectNumbers`'s own
 * comment for why a broader "owns anything nearby" rule was tried and
 * rejected (it reopens pass-9 finding X's exact false-negative).
 */
function recordSubjectConflict(
  filePath,
  lineIndex,
  id,
  subject,
  legitimateMap,
  lines,
  isOwnedPrCompanion,
  wrongId,
  unknownSubject,
  annotatedDischarge,
) {
  // `isOwnedPrCompanion` is checked first, as its docstring claims — a PR
  // companion citation is exempt regardless of which branch it would
  // otherwise have taken, so check it unconditionally before any other logic.
  if (isOwnedPrCompanion) return;

  const legitimateIds = legitimateMap.ownersOf(subject);
  const historicalIds = legitimateMap.historicalOwnersOf(subject);
  const idHistoricallyOwnedThisSubject = historicalIds?.has(id) ?? false;

  if (!legitimateIds) {
    const currentSubjects = legitimateMap.currentSubjectsOf(id);
    if (idHistoricallyOwnedThisSubject) {
      const currentSubjectsText =
        currentSubjects && currentSubjects.size > 0
          ? `, but ${id} now tracks #${[...currentSubjects].sort((a, b) => a - b).join('/')}`
          : '';
      annotatedDischarge.push(
        `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}${currentSubjectsText} — ` +
          `${id}'s own row documents that #${subject} discharged — annotated as discharged, not failing`,
      );
      return;
    }
    if (currentSubjects && currentSubjects.size > 0) {
      const currentSubjectsText = [...currentSubjects].sort((a, b) => a - b).join('/');
      if (idSpecificAnnotationPresent(enclosingSectionText(lines, lineIndex), id)) {
        annotatedDischarge.push(
          `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but ${id} now tracks ` +
            `#${currentSubjectsText} (#${subject}'s row has discharged and ${id} was re-minted) — ` +
            `annotated as discharged, not failing`,
        );
      } else {
        wrongId.push(
          `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but #${subject} does not ` +
            `appear in any current register row heading and ${id} now tracks #${currentSubjectsText} ` +
            `instead — #${subject}'s row has fully discharged and ${id} was re-minted for different work`,
        );
      }
      return;
    }
    // The subject doesn't appear in ANY current register-row heading, and
    // `id` itself carries no subject metadata to compare against either — a
    // structural coverage gap (see this function's own comment above), not
    // a proven-wrong citation. Stays in the non-fatal, opt-in bucket.
    unknownSubject.push(
      `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but #${subject} does not ` +
        `appear in any current register row heading (its row may have discharged) — ` +
        `verify ${id} still applies`,
    );
  } else if (!legitimateIds.has(id)) {
    // The subject's ID set is known and doesn't include this ID. Before
    // #2721/#2842 this was unconditionally fatal — but a subject can lose
    // ONE of several rows without leaving the register: if `id`'s own row
    // documents (via a discharge/re-mint annotation naming this subject)
    // that it once legitimately owned this subject too, the sibling row(s)
    // in `legitimateIds` prove the subject is still live, so this is history,
    // not drift. Genuinely unrelated ids (the four-wrong-headings class PR
    // #2630 exists to catch) have no such record and stay fatal.
    if (idHistoricallyOwnedThisSubject) {
      annotatedDischarge.push(
        `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but the register's #${subject} ` +
          `now maps to ${[...legitimateIds].sort().join('/')} — ${id}'s own row documents that it once ` +
          `tracked #${subject} too, before discharging/being re-minted, and #${subject} still has a ` +
          `live row elsewhere — annotated as discharged, not failing`,
      );
      return;
    }
    wrongId.push(
      `${filePath}:${lineIndex + 1} — cited ${id} for #${subject}, but the register's #${subject} ` +
        `maps to ${[...legitimateIds].sort().join('/')}, not ${id}`,
    );
  }
}

export function checkConflictingSubjects(fileTexts, registerRows) {
  const legitimateMap = buildLegitimateSubjectMap(registerRows);
  const wrongId = [];
  const unknownSubject = [];
  const annotatedDischarge = [];
  for (const [filePath, rawText] of fileTexts) {
    // Pass-10 review of PR #2630 (finding AD): this scan used to read
    // `deBold(stripFences(rawText))` directly — the UNBLANKED path — so an
    // example command inside a single-backtick span (e.g. `` `grep -n
    // "Criteria source: A41 for #2310" docs/` ``) still tripped
    // `CRITERIA_SOURCE_LINE_REGEX` and fired a FATAL `wrongId`, the same
    // class of bug pass 9 (finding AB) already fixed for Check A's
    // `extractCitationsByLine` — just left armed one caller over. Routing
    // through the same `stripInlineCodeSpans` blanks that example the same
    // way, and does so without hiding a real single-backtick-wrapped ID
    // citation (see `stripInlineCodeSpans`'s own comment) — anchored
    // headings can't appear inside a code span at all (`^#{2,6}`), so this
    // only ever changes behaviour on the `Criteria source:` surface.
    const text = stripInlineCodeSpans(deBold(stripFences(rawText)));
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const citedIds = citationShapedLineIds(line);
      if (citedIds.size === 0) return;
      const nearbySubjects = extractSubjectNumbers(line);
      if (nearbySubjects.size === 0) return;

      const segmented = headingTitleSegments(line);
      if (segmented) {
        // Positional pairing: each id is checked only against its own
        // title segment's subject(s) — see headingTitleSegments' own
        // comment. Pass-10 review of PR #2630 (finding AH): iterating
        // `segmented.ids` BY INDEX (not through a Map keyed by id, as
        // before) means a duplicated id across two segments
        // ("### A40 + A40 · A (#2310) + B (#2106)") is checked against
        // BOTH segments rather than the second silently overwriting the
        // first's result.
        segmented.ids.forEach((id, idx) => {
          if (!registerRows.has(id)) return; // Check A's territory, not this one.
          const ownSubjects = extractSubjectNumbers(segmented.segments[idx]);
          const prSubjects = extractPrSubjectNumbers(segmented.segments[idx]);
          for (const subject of ownSubjects) {
            // #2721/#2833: a "PR #nnnn"-marked companion WITHIN THE SAME
            // SEGMENT is exempted the same way the non-positional path
            // exempts one — see recordSubjectConflict's own comment (the
            // A32-shaped "(#issue, PR #pr)" case). Gated on the PR marker,
            // not mere co-occurrence, so pass-9 finding X's injected "third,
            // unrelated subject in the same segment" still fires below.
            const isOwnedPrCompanion =
              prSubjects.has(subject) &&
              [...ownSubjects].some((s) => s !== subject && legitimateMap.ownersOf(s)?.has(id));
            recordSubjectConflict(
              filePath,
              i,
              id,
              subject,
              legitimateMap,
              lines,
              isOwnedPrCompanion,
              wrongId,
              unknownSubject,
              annotatedDischarge,
            );
          }
        });
        return;
      }

      // Pass-10 review of PR #2630 (finding AC): a multi-ID line whose
      // title ISN'T the one recognised positional shape used to fall back
      // to "check every id against every subject on the line" — the exact
      // full cross product finding R (pass 8) was raised about, reopened
      // for every title shape but the one pinned ` + `-with-matching-count
      // test: a comma ("Wave 4 acceptance (#2310, #2106)"), an en-dash, an
      // `&`, or a segment/id count mismatch ("decode (#2310) + addendum
      // (#2106) + notes") all produced two FATAL false positives on a
      // CORRECT heading, each the exact inversion pass 8 quoted.
      //
      // The bounded fix — the one pass 9 offered first, before positional
      // segmentation was tried: this is pass-8 finding R's ORIGINAL
      // principle (an id legitimately owning ANY subject on a shared
      // multi-ID line is enough to explain it against the line's OTHER
      // subjects too), applied only where segmentation doesn't. It is
      // deliberately less precise than the positional path above — it
      // cannot isolate a THIRD, unrelated subject on the line the way
      // `headingTitleSegments` can (see finding X, which is exactly why
      // finding R's original rule was narrowed to segments in the first
      // place) — a real, named trade, not an oversight: measured zero real
      // instances of that residual shape on the corpus as it stands.
      //
      // An id that owns NONE of the line's subjects gets no such pass — it
      // is checked against every subject on the line, same as a single-ID
      // line (see the "A2 + A1 · Some combined section" pinned test below:
      // one shared subject, one id owns it, the other doesn't, and the one
      // that doesn't must still fire).
      // Pass-11 review of PR #2630 (finding AI): the exemption below used to
      // gate on `citedIds.size >= 2` — every citation-shaped ID TOKEN on the
      // line, register row or not. `citedIds` isn't filtered to real rows,
      // so a token that is provably not a row at all (nonexistent, or an
      // annotated-discharged id no longer in `registerRows`) still counted
      // toward "two ids explain this line", buying the exemption for the id
      // that IS real even though nothing actually explains the line's other
      // subject(s). Gate on the ids that resolve to a real row instead —
      // `rowIds`, not the raw token set — so a fake second id can no longer
      // disarm the check for the real one.
      const rowIds = [...citedIds].filter((rid) => registerRows.has(rid));
      const prSubjectsOnLine = extractPrSubjectNumbers(line);
      for (const id of citedIds) {
        if (!registerRows.has(id)) continue; // Check A's territory, not this one.
        const ownsAnySubjectHere = [...nearbySubjects].some((subject) =>
          legitimateMap.ownersOf(subject)?.has(id),
        );
        if (ownsAnySubjectHere && rowIds.length >= 2) continue;
        // #2721/#2833: a "PR #nnnn"-marked companion is exempted from the new
        // `wrongId`-widening/`unknownSubject` split the same way the
        // segmented path exempts one — see recordSubjectConflict's own
        // comment (the A32-shaped "(#issue, PR #pr)" case). Gated on the PR
        // marker, not `ownsAnySubjectHere` itself, so a genuinely unrelated
        // same-line subject (finding X's own "see also" pinned test) still
        // fires below exactly as before this widening.
        for (const subject of nearbySubjects) {
          const isOwnedPrCompanion =
            prSubjectsOnLine.has(subject) &&
            [...nearbySubjects].some((s) => s !== subject && legitimateMap.ownersOf(s)?.has(id));
          recordSubjectConflict(
            filePath,
            i,
            id,
            subject,
            legitimateMap,
            lines,
            isOwnedPrCompanion,
            wrongId,
            unknownSubject,
            annotatedDischarge,
          );
        }
      }
    });
  }
  return { wrongId, unknownSubject, annotatedDischarge };
}

/**
 * Pass-8 review of PR #2630 (finding M/S): the CLI's success line used to
 * claim broad coverage for Check C's fatal (`wrongId`) half without ever
 * measuring how many lines it can actually fire on. `citationShapedLineIds`
 * only trusts two surfaces (an anchored heading, or a `Criteria source:`
 * line), and `wrongId` additionally requires a subject number on THAT SAME
 * line (`checkConflictingSubjects`'s `extractSubjectNumbers(line)`) — a
 * heading or `Criteria source:` line with no subject number at all can never
 * fire `wrongId`, only (at most) `unknownSubject`'s non-fatal, opt-in
 * sibling, or nothing. This measures the real corpus directly, at CLI-run
 * time, rather than asserting a number that goes stale the moment the
 * corpus changes.
 *
 * Pass-9 review of PR #2630 (finding Z): the first version of this function
 * RE-IMPLEMENTED Check C's eligibility rule inline (its own `headingCitedIds`/
 * `CRITERIA_SOURCE_LINE_REGEX` calls) instead of calling
 * `citationShapedLineIds` — the function Check C itself uses — so the two
 * could silently disagree: deleting the heading half of
 * `citationShapedLineIds` makes Check C detect nothing at all while this
 * measurement kept reporting full coverage, because it never actually
 * consulted the mutated function. Eligibility is now gated through
 * `citationShapedLineIds` directly, so a change to what Check C trusts as
 * citation-shaped moves this count in lockstep — they cannot disagree,
 * because one calls the other. Two smaller inaccuracies close in the same
 * pass: `wrongId` additionally requires `registerRows.has(id)` (a line
 * citing only a NONEXISTENT id can never fire `wrongId`, so it isn't
 * "eligible" either — Check A's territory, not this one), and a line that is
 * both an anchored heading AND a `Criteria source:` line no longer risks
 * being counted into the wrong bucket by reusing the same set for both
 * classifications — `headingCitedIds`/`CRITERIA_SOURCE_LINE_REGEX` are still
 * used, but only to classify WHICH surface(s) an already-`citationShapedLineIds`-
 * eligible line matched, never to decide eligibility on their own.
 *
 * @param {Map<string, string>} fileTexts — path -> full text (non-frozen,
 *   non-self-referential — same set Check C itself reads).
 * @param {Map<string, object>} registerRows
 * @returns {{ headingLines: number, headingFiles: number,
 *   criteriaLines: number, criteriaFiles: number }}
 */
export function measureWrongIdEligibleLines(fileTexts, registerRows) {
  const headingFiles = new Set();
  const criteriaFiles = new Set();
  let headingLines = 0;
  let criteriaLines = 0;
  for (const [filePath, rawText] of fileTexts) {
    // Pass-10 review of PR #2630 (finding AD): must read the SAME blanked
    // copy `checkConflictingSubjects` now does (stripInlineCodeSpans) — the
    // finding-Z coupling this function exists to preserve ("this measures
    // the real corpus directly ... rather than asserting a number that goes
    // stale") is a coupling to what Check C actually evaluates, so scanning
    // an unblanked copy here would silently disagree with Check C again the
    // moment a `Criteria source:`-shaped example command inside a code span
    // is counted as eligible here but is (correctly) blanked away there.
    const text = stripInlineCodeSpans(deBold(stripFences(rawText)));
    for (const line of text.split('\n')) {
      if (extractSubjectNumbers(line).size === 0) continue;
      const shapedIds = citationShapedLineIds(line);
      if (![...shapedIds].some((id) => registerRows.has(id))) continue;
      if (headingCitedIds(line).length > 0) {
        headingLines++;
        headingFiles.add(filePath);
      }
      if (CRITERIA_SOURCE_LINE_REGEX.test(line)) {
        criteriaLines++;
        criteriaFiles.add(filePath);
      }
    }
  }
  return {
    headingLines,
    headingFiles: headingFiles.size,
    criteriaLines,
    criteriaFiles: criteriaFiles.size,
  };
}

// --- CLI ------------------------------------------------------------------

class CliExitError extends Error {
  constructor(code) {
    super(`CLI exit ${code}`);
    this.code = code;
  }
}

function gitLsFiles() {
  const out = execFileSync('git', ['ls-files'], {
    cwd: fileURLToPathSafe(REPO_ROOT),
    env: scrubGitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split('\n').filter(Boolean);
}

function fileURLToPathSafe(url) {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function readRepoFile(relPath) {
  return readNormalized(join(fileURLToPathSafe(REPO_ROOT), relPath));
}

// Pass-9 review of PR #2630 (finding U): `readNormalized` is a bare
// `readFileSync(path, 'utf8')` — Node's utf8 decoder never throws on
// invalid byte sequences, it substitutes U+FFFD, so a binary file (a PNG
// under `public/`, a font under `public/fonts/`, ...) was silently
// "readable" — `readRepoFile`'s `catch` could only ever fire on a genuine
// I/O error (ENOENT between `git ls-files` and the read, a permission
// error), never on the binary case the CLI's own success-line clause ("N
// unreadable/binary excluded") claims to cover, making `unreadableCount`
// structurally 0 for the case that clause names. Sniffed the way `git`
// itself decides "binary" for diff purposes: a NUL byte anywhere in the
// first BINARY_SNIFF_BYTES bytes. Deliberately narrow (a Buffer read + one
// byte scan) rather than a content-sniffing library — this only needs to
// answer "would decoding this as text produce garbage", not classify a
// MIME type.
const BINARY_SNIFF_BYTES = 8000;

export function isLikelyBinaryFile(absPath) {
  const buf = readFileSync(absPath);
  const scanLen = Math.min(buf.length, BINARY_SNIFF_BYTES);
  return buf.subarray(0, scanLen).includes(0);
}

// This checker's own source and its own test fixtures — plus the sibling
// `check-onbox-register.mjs` checker's test fixtures — deliberately use the
// discharge/removal vocabulary (DISCHARGE_ANNOTATION_REGEX), the "row(s) ID"
// idiom, and synthetic nonexistent IDs (`A46`, `B3`, `F1`, `F2`, ...) as
// EXAMPLES in comments and fixtures, not as real citations of anything in
// the real register. Scanning any of them as if they were a real citation
// surface means this checker's own green depends on its explanatory prose
// and the sibling checker's test wording (measured: this file's own source
// comment for ROW_CITATION_REGEX cites "rows A46/B3" as a worked example and
// self-flagged; `check-onbox-register.test.mjs` synthesizes `F1`/`F2` as
// fixture row IDs and self-flagged too). Exclude the instrument's own
// corpus, the same way FROZEN_EXACT excludes the register itself.
const SELF_REFERENTIAL_PATHS = new Set([
  'scripts/check-register-citations.mjs',
  'scripts/tests/check-register-citations.test.mjs',
  'scripts/tests/check-onbox-register.test.mjs',
]);

export function runCheckRegisterCitationsCli(options = {}) {
  const strict = options.strict ?? process.argv.includes('--strict');

  const registerText = readRepoFile(REGISTER_PATH);
  const { rows } = parseRegisterRows(registerText);

  const allFiles = gitLsFiles();
  let frozenCount = 0;
  let selfReferentialCount = 0;
  const scannedFiles = allFiles.filter((p) => {
    if (isFrozenPath(p)) {
      frozenCount++;
      return false;
    }
    if (SELF_REFERENTIAL_PATHS.has(p)) {
      selfReferentialCount++;
      return false;
    }
    return true;
  });

  const errorsA = [];
  const annotatedA = [];
  const nonFrozenTexts = new Map();
  let unreadableCount = 0;
  for (const relPath of scannedFiles) {
    const absPath = join(fileURLToPathSafe(REPO_ROOT), relPath);
    let text;
    try {
      // See isLikelyBinaryFile's own comment (finding U): a plain
      // `readFileSync(path, 'utf8')` never throws on binary content, so the
      // binary case has to be detected explicitly, before decoding — not
      // discovered via a catch that can never fire for it.
      if (isLikelyBinaryFile(absPath)) {
        unreadableCount++;
        continue;
      }
      text = readNormalized(absPath);
    } catch {
      unreadableCount++; // genuine I/O error — nothing to cite here
      continue;
    }
    nonFrozenTexts.set(relPath, text);
    const found = checkNonexistentIds(text, relPath, rows);
    errorsA.push(...found.errors);
    annotatedA.push(...found.annotated);
  }

  const errorsB = checkRunSheetLinkage(rows, (p) => readRepoFile(p));
  // Check C now runs UNCONDITIONALLY — `nonFrozenTexts` is already built
  // above regardless of `--strict` — because its `wrongId` half is FATAL by
  // default (pass 7, finding G; see checkConflictingSubjects' own comment).
  // Only its `unknownSubject` half stays gated behind `--strict`. #2721/#2833
  // widened `wrongId` to also cover a fully-discharged subject (an id that
  // currently tracks different, known work) — `annotatedDischarge` is that
  // same discharge class, but with a nearby annotation excusing it, so it
  // prints unconditionally (like Check A's annotated bucket) rather than
  // failing the gate or hiding behind `--strict`.
  const {
    wrongId: errorsC,
    unknownSubject: unknownSubjectC,
    annotatedDischarge: annotatedDischargeC,
  } = checkConflictingSubjects(nonFrozenTexts, rows);
  const warningsC = strict ? unknownSubjectC : null;
  const unclassifiedRunSheets = findUnclassifiedRunSheetMentions(rows).map(
    ({ path, id }) => `${path} — mentioned by register row ${id}`,
  );

  // Two severities. FATAL sections fail the gate (exit 1); NOTE/WARNING
  // sections always print — nothing is dropped silently — but never cause a
  // correct tree to go red. Check A's annotated bucket lives here because
  // this repo's own "annotate, don't renumber" rule deliberately keeps some
  // nonexistent-ID citations as history — see each list's own definition
  // above for why. The unclassified-run-sheet list is non-fatal for the same
  // reason a borrowed reference is legitimate (A39 borrowing fs38-wave3's
  // section) — but it MUST print, because a pair excluded from Check B's
  // owned set is one Check B will never evaluate at all; see
  // findUnclassifiedRunSheetMentions' own comment. Check C's `unknownSubject`
  // half is a THIRD severity, opt-in: it only runs (and only ever prints)
  // under `--strict` — see this file's header comment for why its ground
  // truth isn't precise enough to trust unasked, let alone gate on. Check
  // C's `wrongId` half is fatal and unconditional, alongside A and B — see
  // the same header comment for why that half IS precise enough to gate on.
  const fatalSections = [
    ['Check A — nonexistent row ID', errorsA],
    ['Check B — run sheet does not cite its row back', errorsB],
    ['Check C — existing row ID cited for the wrong subject', errorsC],
  ];
  const nonFatalSections = [
    ['Check A — nonexistent row ID, already annotated as discharged/removed (not failing)', annotatedA],
    [
      'Check C — existing row ID cited for a fully-discharged subject, already annotated as discharged (not failing)',
      annotatedDischargeC,
    ],
    ['Run sheets mentioned but not classified as owned (not checked)', unclassifiedRunSheets],
  ];
  if (strict) {
    nonFatalSections.push([
      'Check C — subject not found in any current register heading (--strict, exploratory, not failing — see header comment)',
      warningsC,
    ]);
  }

  let anyFatal = false;
  for (const [label, errors] of fatalSections) {
    if (errors.length === 0) continue;
    anyFatal = true;
    console.error(`\n${label} (${errors.length}):`);
    for (const e of errors) console.error(`  ${e}`);
  }
  for (const [label, notes] of nonFatalSections) {
    if (notes.length === 0) continue;
    console.log(`\n${label} (${notes.length}):`);
    for (const n of notes) console.log(`  ${n}`);
  }

  const ownedPairCount = [...rows.values()].reduce((n, r) => n + r.runSheetPaths.size, 0);
  const strictNote = strict
    ? `Check C's exploratory "subject not found in any current register heading" half ran under ` +
      `--strict and found ${unknownSubjectC.length} warning(s) above — non-fatal (see header comment ` +
      `for its coverage gaps and why it stays opt-in). Check C's "existing row ID cited for the wrong ` +
      `subject" half always runs and is FATAL, whether or not --strict is passed — see the fatal ` +
      `sections above.`
    : `Check C's exploratory "subject not found in any current register heading" half did NOT run — ` +
      `it is opt-in; pass --strict to see it, and it is never fatal even then. Check C's "existing row ` +
      `ID cited for the wrong subject" half always runs and is FATAL — it is one of the fatal checks ` +
      `named above, gated by neither this flag nor any other.`;

  if (!anyFatal) {
    const actuallyScanned = scannedFiles.length - unreadableCount;
    const coverage = measureWrongIdEligibleLines(nonFrozenTexts, rows);
    console.log(
      `\ncheck:register-citations: OK. Checks A (nonexistent ID), B (run-sheet ` +
        `linkage), and C's "existing row ID cited for the wrong subject" half are the FATAL checks ` +
        `and found nothing to fail on: ${actuallyScanned} ` +
        `scanned files (${frozenCount} frozen, ${selfReferentialCount} self-referential` +
        `${unreadableCount ? `, ${unreadableCount} unreadable/binary` : ''} excluded from the ` +
        `${allFiles.length}-file tree) carry no unannotated nonexistent-row-ID citation, no existing-ID- ` +
        `cited-for-the-wrong-subject citation on Check C's two surfaces, and Check B verified all ` +
        `${ownedPairCount} owned run-sheet header pairs cite their row back. ${strictNote} The ` +
        `unclassified-run-sheet list above is printed but UNCHECKED — a mention Check B's ownership ` +
        `markers don't classify as owned (a borrowed reference, or an unrecognised phrasing) is never ` +
        `verified in either direction, by design; see findUnclassifiedRunSheetMentions' own comment. ` +
        `Citation surfaces: Check A covers the "row(s) ID" prose idiom, "Register row(s):" label ` +
        `lines (any decoration), and an anchored "### <ID> · ..." heading; Check C covers the ` +
        `anchored heading and "Criteria source:" line ONLY, never the prose idiom or the label ` +
        `line — a bare ID with none of Check A's three surfaces, e.g. in a ` +
        `table cell or an un-anchored heading, is not a citation surface for either check (see header ` +
        `comment for why). Check B additionally parses the bare-ID/range idiom, but only inside a run ` +
        `sheet's own header region. MEASURED coverage of Check C's fatal half, on this corpus: it can ` +
        `only ever fire on an anchored heading or "Criteria source:" line that ALSO carries a subject ` +
        `number on the same physical line — right now that is ${coverage.headingLines} anchored-heading ` +
        `line(s) in ${coverage.headingFiles} file(s) and ${coverage.criteriaLines} "Criteria source:" ` +
        `line(s) in ${coverage.criteriaFiles} file(s) (Check A, by contrast, sees every "row(s) ID"/ ` +
        `"Register row(s):"/heading occurrence tree-wide). A wrong ID cited in the "row(s) ID" prose ` +
        `idiom, in a "Register row(s):" label line, or on a heading/"Criteria source:" line with no ` +
        `subject number next to it is NOT DETECTED by Check C's fatal half at all — Check A only ` +
        `catches it if the ID is nonexistent, not merely wrong-for-its-subject. A wrong ID that arrives ` +
        `via a DISCHARGE (the cited ID still exists, for something else, but its subject left the ` +
        `register entirely) IS caught by the fatal half since #2721/#2833 — but only when the re-minted ` +
        `id's own current row carries subject metadata to contradict the citation with; an id that has ` +
        `never carried a subject number at all (a real, permanent gap, 21 of 65 rows today) still can't ` +
        `be told apart from a fresh mint, and a discharge that's already self-annotated near the citation ` +
        `prints non-fatal instead of failing — see recordSubjectConflict's own comment for the exact rule.`,
    );
    return;
  }
  throw new CliExitError(1);
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    runCheckRegisterCitationsCli();
  } catch (err) {
    if (err instanceof CliExitError) {
      process.exitCode = err.code;
    } else {
      throw err;
    }
  }
}
