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
//      unless the same markdown SECTION (bounded by the nearest enclosing
//      heading of any level) also contains an explicit discharge/removal
//      annotation, in which case it is downgraded to a printed,
//      non-fatal NOTE — still visible, never silently dropped, but it
//      doesn't fail the gate. An *unannotated* nonexistent ID is still a
//      hard error, always.
//   B. Bidirectional run-sheet linkage — a register row that OWNS its run
//      sheet (asserted via one of TWO markers measured in the real
//      register — the prose phrase "run sheet", or the structured bold
//      field `*Criteria:*`) creates a two-way link: that run sheet's own
//      HEADER (its leading `> Register row(s): ...` paragraph, not the
//      whole file) must cite the row back. A forward-only scan (does the
//      row name a real file?) misses a run sheet whose header still cites a
//      stale ID — and a whole-file scan is just as blind to it, since the
//      body legitimately re-mentions the correct ID elsewhere (Result
//      lines, discharge notes); only the header actually asserts ownership.
//      A header with no such line is itself a reportable finding, not a
//      silent widen-the-scan fallback.
//
//      WHAT THIS DOES NOT CHECK, and says so out loud: a `*-onbox-
//      acceptance.md` path a row mentions but that neither marker
//      classifies as owned (a borrowed reference, e.g. A39 borrowing
//      fs38-wave3's section; or a phrasing this checker doesn't recognise
//      yet, e.g. plain "Full criteria:" without the bold) is NEVER run
//      through Check B — there is no third check that verifies a borrowed
//      reference's target. Those pairs are listed by name in a dedicated
//      "mentioned but not classified as owned" section instead, precisely
//      so a green exit here is never mistaken for "every citation
//      everywhere is verified." See findUnclassifiedRunSheetMentions.
//   C. One subject, conflicting IDs — the recurring "one claim, N surfaces"
//      defect. Built off the register's OWN heading-line issue/PR numbers as
//      ground truth: for each register row, the issue/PR numbers in its
//      heading line are its "subject numbers," and the set of row IDs a
//      subject legitimately maps to is whatever the register itself
//      currently says (a subject CAN legitimately span two rows — e.g. one
//      Group A row and one Group B row for the same issue — so a naive
//      "same subject cited near 2+ different IDs" rule would misfire on
//      that correct, current state). A citation is flagged only when it
//      pairs an EXISTING row ID with a subject number whose legitimate set
//      does not include that ID — the dangerous case where a stale citation
//      still looks superficially valid because the ID happens to exist,
//      just for something else now. Grounded in the register's own current
//      state rather than a heuristic — but the SUBJECT-to-citation
//      association itself is still a proximity heuristic (nearby issue
//      numbers in the same sentence/bullet), and that proximity can pick
//      the wrong subject out of a paragraph that mentions several (measured:
//      two real cases where an unrelated issue number sat next to an
//      already-correct citation). A tighter same-line-only association was
//      tried and does not remove either measured case — both false
//      positives already share a physical line with the citation — so this
//      check is a printed, non-fatal WARNING rather than an error: real
//      enough to always show, not precise enough to fail the gate on.
//
// Frozen paths are excluded from all three checks — see isFrozenPath's own
// comment for why each one is frozen.

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

// Matches `row`/`rows` followed by one or more ID tokens separated by `/`,
// `,`, `&`, or `and` — covers every real shape found in this repo: "row
// A1", "rows A46/B3", "rows A2, A3", "row A28 and A29". Deliberately
// requires the literal word "row(s)" directly before the first token: that
// is the citation idiom actually in use here ("register row A29", "on-box
// register row E10", "discharge register row C2") — see this file's own
// header for why a wider net (bare "(A29)") was left out rather than
// chasing every prose shape.
const ROW_CITATION_REGEX = new RegExp(
  `\\brows?\\s+(${ROW_ID_TOKEN}(?:\\s*(?:[/,&]|\\s+and\\s+)\\s*${ROW_ID_TOKEN})*)`,
  'gi',
);

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
// an ID inside it would falsify what actually happened, not fix drift.
const FROZEN_EXACT = new Set([
  'docs/testing/onbox-acceptance-staleness-audit.md',
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

// A docs/superpowers/** file is excluded only when it has shipped
// (`status: stable`) — CLAUDE.md's Ship-notes convention. Everything else
// under docs/superpowers/ stays IN SCOPE: excluding the whole directory
// wholesale is exactly the assumption that let a blocking citation bug
// through review twice (see this repo's history — do not reintroduce it).
export function isStableSuperpowersDoc(relPath, text) {
  const p = relPath.replace(/\\/g, '/');
  if (!p.startsWith('docs/superpowers/')) return false;
  return /^status:\s*stable\s*$/m.test(text);
}

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

// The register uses TWO distinct phrasings to assert ownership of a run
// sheet, both confirmed by direct measurement against the real register:
// the prose phrase "run sheet" ("the run sheet `docs/testing/...`", "Run
// sheet: [...]", "run sheet §3 in `...`"), and the structured field
// `*Criteria:*` (bold markdown, e.g. "*Needs:* ... *Criteria:*
// [`language-recurrence-onbox-acceptance.md`](...) §Voice-design gate.").
// Deliberately NOT matched: plain "Full criteria:"/"criteria" without the
// bold markers — that phrasing introduces night-watch-reanalysis's mention
// at register.md:2866, which is prose pointing at detail, not a structured
// ownership field, the same distinction as the "already exist in ...'s
// section" borrowed-reference shape below. Loosening this to bare
// "criteria" would misclassify that reference as ownership.
const OWNERSHIP_MARKER_REGEXES = [/run sheet/i, /\*criteria:\*/i];

// `*Criteria:*` is NOT exclusively an ownership marker — A39's own body uses
// it for exactly the same borrowed-subsection shape as "already exist in
// ...'s section": "*Criteria:* `docs/testing/fs38-wave3-onbox-acceptance
// .md`'s `#2026 — ...` section" cites fs38-wave3 (owned by A1) for a
// SUBSECTION, not as A39's own run sheet — measured directly: without this
// exclusion, A39 misclassifies as owning fs38-wave3 and Check B then reports
// a false failure (fs38-wave3's header correctly cites A1, not A39). The
// distinguishing shape in both borrowed forms is the possessive "'s"
// (straight or curly apostrophe) immediately following the path, naming a
// section WITHIN the file rather than the file as the criteria destination
// itself — the genuine `*Criteria:*` ownership shape (language-recurrence's
// rows) never has this, it names the whole file, then a separate "§...
// gate." clause. A short lookahead (past an optional closing `` ` ``/`]`/`)`
// the path sits inside) is enough to tell the two apart.
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

/**
 * The text of the smallest markdown section containing `lineIndex` (0-based):
 * from the nearest heading at or before it, to the next heading (any level)
 * strictly after it, or EOF. A citation with no heading above it at all (a
 * file with no headings, or one at the very top before any heading) uses the
 * whole file — there is no smaller enclosing unit to bound it to.
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
  return lines.slice(start, end).join('\n');
}

/**
 * @returns {{ errors: string[], annotated: string[] }} — `errors` are
 *   unannotated nonexistent-ID citations (fail the gate); `annotated` are
 *   the same defect but with a discharge/removal annotation already present
 *   in the citation's own section (printed, non-fatal — see this file's
 *   header comment for why a correct tree can legitimately contain these).
 */
export function checkNonexistentIds(text, filePath, registerRows) {
  const errors = [];
  const annotated = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(ROW_CITATION_REGEX)) {
      for (const id of splitCitedIds(m[1])) {
        if (registerRows.has(id)) continue;
        const message = `${filePath}:${i + 1} — cited ${id} — no such row in ${REGISTER_PATH} (nonexistent ID)`;
        if (DISCHARGE_ANNOTATION_REGEX.test(enclosingSectionText(lines, i))) {
          annotated.push(`${message} — annotated as discharged/removed, not failing`);
        } else {
          errors.push(message);
        }
      }
    }
  });
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
// [A36–A38](...)"), an en-dash/hyphen ID range, or a criteria table's
// "Register row" column — none of which say the word "row" next to the ID
// every time. Requiring ROW_CITATION_REGEX here would make every one of
// those a false "doesn't cite back".
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

// Context window (characters) searched around a row citation for a nearby
// subject number — wide enough for "register row A2's own fixture (#1969)"
// shapes but scoped to roughly one sentence/paragraph so an unrelated issue
// number elsewhere on the page can't pair with it.
const SUBJECT_CONTEXT_WINDOW = 200;

/**
 * @param {Map<string, string>} fileTexts — path -> full text, already
 *   filtered to non-frozen files.
 * @param {Map<string, object>} registerRows
 */
export function checkConflictingSubjects(fileTexts, registerRows) {
  const legitimate = buildLegitimateSubjectMap(registerRows);
  const errors = [];
  for (const [filePath, text] of fileTexts) {
    for (const m of text.matchAll(ROW_CITATION_REGEX)) {
      const citedIds = splitCitedIds(m[1]);
      const windowStart = Math.max(0, m.index - SUBJECT_CONTEXT_WINDOW);
      const windowEnd = Math.min(text.length, m.index + m[0].length + SUBJECT_CONTEXT_WINDOW);
      const nearbySubjects = extractSubjectNumbers(text.slice(windowStart, windowEnd));
      const lineNo = text.slice(0, m.index).split('\n').length;
      for (const id of citedIds) {
        if (!registerRows.has(id)) continue; // Check A's territory, not this one.
        for (const subject of nearbySubjects) {
          const legitimateIds = legitimate.get(subject);
          if (!legitimateIds) continue; // subject not in the register at all — can't validate
          if (!legitimateIds.has(id)) {
            errors.push(
              `${filePath}:${lineNo} — cited ${id} for #${subject}, but the register's #${subject} ` +
                `maps to ${[...legitimateIds].sort().join('/')}, not ${id}`,
            );
          }
        }
      }
    }
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

export function runCheckRegisterCitationsCli() {
  const registerText = readRepoFile(REGISTER_PATH);
  const { rows } = parseRegisterRows(registerText);

  const allFiles = gitLsFiles();
  const scannedFiles = allFiles.filter((p) => {
    if (isFrozenPath(p)) return false;
    return true;
  });

  const errorsA = [];
  const annotatedA = [];
  const nonFrozenTexts = new Map();
  for (const relPath of scannedFiles) {
    let text;
    try {
      text = readRepoFile(relPath);
    } catch {
      continue; // binary or unreadable — nothing to cite here
    }
    if (isStableSuperpowersDoc(relPath, text)) continue;
    nonFrozenTexts.set(relPath, text);
    const found = checkNonexistentIds(text, relPath, rows);
    errorsA.push(...found.errors);
    annotatedA.push(...found.annotated);
  }

  const errorsB = checkRunSheetLinkage(rows, (p) => readRepoFile(p));
  const warningsC = checkConflictingSubjects(nonFrozenTexts, rows);
  const unclassifiedRunSheets = findUnclassifiedRunSheetMentions(rows).map(
    ({ path, id }) => `${path} — mentioned by register row ${id}`,
  );

  // Two severities. FATAL sections fail the gate (exit 1); NOTE/WARNING
  // sections always print — nothing is dropped silently — but never cause a
  // correct tree to go red. Check A's annotated bucket and Check C both live
  // here: Check A because this repo's own "annotate, don't renumber" rule
  // deliberately keeps some nonexistent-ID citations as history, and Check C
  // because its subject-to-citation pairing is a proximity heuristic that
  // measurably still produces the occasional benign false positive (see
  // this file's header comment) — see each list's own definition above for
  // why. The unclassified-run-sheet list is non-fatal for the same reason a
  // borrowed reference is legitimate (A39 borrowing fs38-wave3's section) —
  // but it MUST print, because a pair excluded from Check B's owned set is
  // one Check B will never evaluate at all; see
  // findUnclassifiedRunSheetMentions' own comment.
  const fatalSections = [
    ['Check A — nonexistent row ID', errorsA],
    ['Check B — run sheet does not cite its row back', errorsB],
  ];
  const nonFatalSections = [
    ['Check A — nonexistent row ID, already annotated as discharged/removed (not failing)', annotatedA],
    ['Check C — one subject, conflicting row IDs (WARNING, not failing — see header comment)', warningsC],
    ['Run sheets mentioned but not classified as owned (not checked)', unclassifiedRunSheets],
  ];

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

  if (!anyFatal) {
    console.log(`\ncheck:register-citations: OK — no broken register-row citations found.`);
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
