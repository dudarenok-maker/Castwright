// Mechanical checker for docs/testing/onbox-acceptance-register.md ROW-ID
// CITATIONS scattered across the repo (#2629 option 3).
//
// Register row IDs (A29, B2, E1...) are POSITIONAL: discharging a row
// deletes it and renumbers every later row in that group. A citation
// elsewhere in the repo ("register row A29") rots on every discharge. Four
// rounds of manual sweeping (docs/docs-register-row-refs) converged too
// slowly and too incompletely to trust — every miss was the same shape: one
// claim living on several surfaces, with only some of them corrected. This
// script exists to make that mechanical instead of eyeballed.
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
//      Note: 22 of 65 real register rows carry no issue/PR number in their
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
//      EXPLORATORY, OPT-IN, NEVER FATAL — pass `--strict` to run it at all;
//      it is skipped by default and prints nothing without the flag. The
//      "one subject, N surfaces" idea is sound, and its ground truth is
//      better than the original ±200-char window measurement showed: 22 of
//      the register's 65 real rows still carry no issue/PR number in their
//      heading at all (they cite a plan number instead, so those rows can
//      never be cross-checked in either direction — a real, permanent
//      coverage gap), and a "Register row(s):" list is not scanned by this
//      narrowed check at all (deliberately — see above), so it still can't
//      see every citation. But the ±200-char window's own 118-warning
//      measurement was of ONE PARAMETER (window size), not of the idea, and
//      the header comment's prior "no window size tried separates the real
//      hits from the rest" claim did not test the fix that actually works:
//      restricting to the two never-ambiguous surfaces (heading, `Criteria
//      source:`) leaves 2 residual warnings on the corpus as it stands
//      today (both a heading citing its issue AND its fixing PR, where the
//      register's own heading tracks only the issue — a structural
//      subject-set mismatch, not a wrong citation) and catches PR #2630's
//      finding A outright when reproduced. Kept exploratory/opt-in rather
//      than promoted to fatal in this same PR — that is a separate decision
//      this PR does not make — but it is no longer accurate to call its
//      ground truth "too thin to trust", only "incomplete".
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
// (checkConflictingSubjects) is narrower: it iterates ROW_CITATION_REGEX
// ONLY — never the label-line or heading surfaces — so a citation that
// exists solely as a "Register row(s):" line or a heading is invisible to
// Check C even when Check A sees it fine; do not describe Check C's
// coverage as matching Check A's.
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
// scannedFiles): 34 headings match, zero collide with D13/D18 or any other
// doc-local numbering scheme, and this is precisely the surface a uniform
// mechanical shift across a run of `### <ID> · …` headings (this repo's own
// PR #2630 finding A) rots first. A heading's ID is therefore a citation for
// Check A the same as the two idioms above — still subject to the same
// discharge/removal annotation exemption (enclosingSectionText), never a new
// unconditional failure mode.
const HEADING_ID_REGEX = /^#{2,6}\s+([A-Z]\d{1,3})\s*·/;

// Pulls the individual ID tokens back out of one ROW_CITATION_REGEX match's
// captured list, e.g. "A46/B3" -> ["A46", "B3"].
function splitCitedIds(list) {
  return list.match(new RegExp(ROW_ID_TOKEN, 'g')) ?? [];
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

const FROZEN_PREFIXES = [
  'docs/testing/onbox-wave3-results/',
  'docs/testing/onbox-wave4-results/',
  'docs/testing/onbox-wave5-results/',
  'docs/features/archive/',
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
// under `docs/superpowers/` is exempted from Check A any more — the
// annotation mechanism (a discharge/removal note near the citation, see
// enclosingSectionText) is what legitimately excuses a citation to an ID
// that has since moved on, same as anywhere else in the tree. Do not
// reintroduce a directory-wide or status-keyed exclusion for this scan.

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
const POSSESSIVE_SUBSECTION_REGEX = /^[`\])]*['’]s\b/;

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
 * ID. Row headings that appear OUTSIDE a `Group <Letter>` section (e.g. the
 * real register's "Blocked" section, which deliberately re-uses a live row's
 * ID heading for cross-reference, per this file's own comment above) are
 * NOT collected — mirrors check-onbox-register.mjs's own group-section
 * restriction, and for the same reason.
 *
 * @returns {{ rows: Map<string, { title: string, issues: Set<number>,
 *   runSheetPaths: Set<string>, mentionedRunSheetPaths: Set<string> }> }}
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

/**
 * Whether `sectionText` contains a discharge/removal annotation that
 * actually references `id` — not merely a discharge word somewhere in the
 * section, which a paired injection proved lets unrelated prose excuse a
 * genuine defect (see this constant's own comment above).
 */
function idSpecificAnnotationPresent(sectionText, id) {
  const idRegex = new RegExp(`\\b${id}\\b`, 'g');
  for (const m of sectionText.matchAll(idRegex)) {
    const start = Math.max(0, m.index - ID_PROXIMITY_CHARS);
    const end = Math.min(sectionText.length, m.index + m[0].length + ID_PROXIMITY_CHARS);
    if (DISCHARGE_ANNOTATION_REGEX.test(sectionText.slice(start, end))) return true;
  }
  return false;
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
 * @returns {Map<number, Set<string>>}
 */
function extractCitationsByLine(text) {
  const stripped = deBold(stripFences(text));
  const lines = stripped.split('\n');
  const byLine = new Map();
  const add = (i, ids) => {
    if (!ids.length) return;
    if (!byLine.has(i)) byLine.set(i, new Set());
    for (const id of ids) byLine.get(i).add(id);
  };

  lines.forEach((line, i) => {
    for (const m of line.matchAll(ROW_CITATION_REGEX)) {
      add(i, splitCitedIds(m[1]));
    }
    if (REGISTER_ROW_LABEL_LINE_REGEX.test(line)) {
      add(i, [...extractIdTokensWithRanges(line)]);
    }
    const headingMatch = line.match(HEADING_ID_REGEX);
    if (headingMatch) {
      add(i, [headingMatch[1]]);
    }
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
 * Builds subject-number -> legitimate-ID-set from the register's own rows.
 */
function buildLegitimateSubjectMap(registerRows) {
  const map = new Map();
  for (const [id, row] of registerRows) {
    for (const subject of row.issues) {
      if (!map.has(subject)) map.set(subject, new Set());
      map.get(subject).add(id);
    }
  }
  return map;
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
// rationale — this still can't see every citation (the 22-of-65 rows with
// no issue/PR number in their heading are still uncheckable in either
// direction, and a "Register row(s):" list is still not scanned here) — but
// its ground truth is no longer "too thin to trust", only "incomplete".
const CRITERIA_SOURCE_LINE_REGEX = /\bCriteria source:/i;

/**
 * A line counts as "citation-shaped" for Check C only when it names EXACTLY
 * ONE row unambiguously: an anchored `### <ID> · …` heading, or the sibling
 * `Criteria source:` idiom (every use in the corpus is a
 * `> **Criteria source:** ... <ID>.` line immediately under a pack section's
 * own heading). Deliberately narrower than Check A's three surfaces — the
 * "row(s) ID" prose idiom and a "Register row(s):" label line can both name
 * several rows on one physical line, which is exactly the shape that kept
 * two of the old window's false positives alive under same-line scoping
 * too (see this section's own comment above); Check C only trusts a line
 * that can't be ambiguous in that way.
 */
function citationShapedLineIds(line) {
  const ids = new Set();
  if (CRITERIA_SOURCE_LINE_REGEX.test(line)) {
    for (const id of extractIdTokensWithRanges(line)) ids.add(id);
  }
  const headingMatch = line.match(HEADING_ID_REGEX);
  if (headingMatch) ids.add(headingMatch[1]);
  return ids;
}

/**
 * @param {Map<string, string>} fileTexts — path -> full text, already
 *   filtered to non-frozen files.
 * @param {Map<string, object>} registerRows
 */
export function checkConflictingSubjects(fileTexts, registerRows) {
  const legitimate = buildLegitimateSubjectMap(registerRows);
  const errors = [];
  for (const [filePath, rawText] of fileTexts) {
    const text = deBold(stripFences(rawText));
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const citedIds = citationShapedLineIds(line);
      if (citedIds.size === 0) return;
      const nearbySubjects = extractSubjectNumbers(line);
      if (nearbySubjects.size === 0) return;
      for (const id of citedIds) {
        if (!registerRows.has(id)) continue; // Check A's territory, not this one.
        for (const subject of nearbySubjects) {
          const legitimateIds = legitimate.get(subject);
          if (!legitimateIds) {
            // The subject doesn't appear in ANY current register-row heading
            // at all — the exact moment its citations start rotting, since a
            // subject leaves the register precisely when its row discharges.
            // Failing open here (the earlier behaviour) silenced this check
            // at the one moment it was needed; see this file's header
            // comment for the worked example.
            errors.push(
              `${filePath}:${i + 1} — cited ${id} for #${subject}, but #${subject} does not ` +
                `appear in any current register row heading (its row may have discharged) — ` +
                `verify ${id} still applies`,
            );
          } else if (!legitimateIds.has(id)) {
            errors.push(
              `${filePath}:${i + 1} — cited ${id} for #${subject}, but the register's #${subject} ` +
                `maps to ${[...legitimateIds].sort().join('/')}, not ${id}`,
            );
          }
        }
      }
    });
  }
  return errors;
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
  });
  return out.split('\n').filter(Boolean);
}

function fileURLToPathSafe(url) {
  return url.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function readRepoFile(relPath) {
  return readNormalized(join(fileURLToPathSafe(REPO_ROOT), relPath));
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
    let text;
    try {
      text = readRepoFile(relPath);
    } catch {
      unreadableCount++; // binary or unreadable — nothing to cite here
      continue;
    }
    nonFrozenTexts.set(relPath, text);
    const found = checkNonexistentIds(text, relPath, rows);
    errorsA.push(...found.errors);
    annotatedA.push(...found.annotated);
  }

  const errorsB = checkRunSheetLinkage(rows, (p) => readRepoFile(p));
  const warningsC = strict ? checkConflictingSubjects(nonFrozenTexts, rows) : null;
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
  // findUnclassifiedRunSheetMentions' own comment. Check C is a THIRD
  // severity, opt-in: it only runs (and only ever prints) under `--strict` —
  // see this file's header comment for why its ground truth isn't precise
  // enough to trust unasked, let alone gate on.
  const fatalSections = [
    ['Check A — nonexistent row ID', errorsA],
    ['Check B — run sheet does not cite its row back', errorsB],
  ];
  const nonFatalSections = [
    ['Check A — nonexistent row ID, already annotated as discharged/removed (not failing)', annotatedA],
    ['Run sheets mentioned but not classified as owned (not checked)', unclassifiedRunSheets],
  ];
  if (strict) {
    nonFatalSections.push([
      'Check C — one subject, conflicting row IDs (--strict, exploratory, not failing — see header comment)',
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
    ? `Check C ran under --strict and found ${warningsC.length} warning(s) above — exploratory, ` +
      `never fatal (see header comment for its coverage gaps and why it stays opt-in).`
    : `Check C (one subject, conflicting row IDs) did NOT run — it is opt-in and exploratory; ` +
      `pass --strict to run it. It is never fatal even under --strict.`;

  if (!anyFatal) {
    const actuallyScanned = scannedFiles.length - unreadableCount;
    console.log(
      `\ncheck:register-citations: OK. Checks A (nonexistent ID) and B (run-sheet ` +
        `linkage) are the only FATAL checks and found nothing to fail on: ${actuallyScanned} ` +
        `scanned files (${frozenCount} frozen, ${selfReferentialCount} self-referential` +
        `${unreadableCount ? `, ${unreadableCount} unreadable/binary` : ''} excluded from the ` +
        `${allFiles.length}-file tree) carry no unannotated nonexistent-row-ID citation, and Check B verified all ` +
        `${ownedPairCount} owned run-sheet header pairs cite their row back. ${strictNote} The ` +
        `unclassified-run-sheet list above is printed but UNCHECKED — a mention Check B's ownership ` +
        `markers don't classify as owned (a borrowed reference, or an unrecognised phrasing) is never ` +
        `verified in either direction, by design; see findUnclassifiedRunSheetMentions' own comment. ` +
        `Citation surfaces: Check A covers the "row(s) ID" prose idiom, "Register row(s):" label ` +
        `lines (any decoration), and an anchored "### <ID> · ..." heading; Check C covers the prose ` +
        `idiom ONLY, not the other two — a bare ID with none of Check A's three surfaces, e.g. in a ` +
        `table cell or an un-anchored heading, is not a citation surface for either check (see header ` +
        `comment for why). Check B additionally parses the bare-ID/range idiom, but only inside a run ` +
        `sheet's own header region.`,
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
