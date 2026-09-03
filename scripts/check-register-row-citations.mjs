// Mechanical checker for A\d+/E\d+-style register-row citations found in
// docs/testing/** and docs/features/** markdown against the on-box
// acceptance register's actual current row headings (#2831, decided in
// #2603's comment https://github.com/dudarenok-maker/Castwright/issues/2603#issuecomment-5484701257
// on 2026-09-01).
//
// Deliberately scoped narrower, and NAMED DIFFERENTLY, from the pre-existing
// scripts/check-register-citations.mjs (#2629/#2630) -- that checker already
// owns the `check:register-citations` npm script name and scans the WHOLE
// git-tracked tree with a much larger citation surface (a "Register row(s):"
// label idiom, anchored `### <ID> · ...` headings, discharge-annotation
// exemptions, run-sheet linkage, subject-conflict detection). This is a
// DIFFERENT, complementary v1 check per #2603's decision comment:
// docs/testing/** + docs/features/** only, a single narrow citation pattern,
// ID-existence resolution only. Do not fold the two together or rename this
// one to match -- the decision explicitly ships it as its own script, and
// picking the same npm script name would silently shadow the older,
// already-relied-upon checker.
//
// Scope, per the decision comment:
//   - docs/testing/** and docs/features/** markdown files only. GitHub issue
//     bodies are explicitly OUT of scope for v1 (would need `gh` API access
//     from a CI script -- disproportionate cost for this pass).
//   - Only two citation shapes count: the word "row"/"Row" immediately
//     followed by an ID (`\b(?:row|Row)\s+([AE]\d+)\b`), or a markdown link
//     into onbox-acceptance-register.md's own anchor for a row heading
//     (`onbox-acceptance-register.md#a41`/`#e3`, case-insensitive -- GitHub
//     lowercases heading anchors). A bare `A41`-shaped token with neither
//     surface is NOT a citation -- this avoids false-positiving on version
//     numbers or unrelated IDs.
//   - Only the register's own .md needs self-reference awareness: a row's
//     body citing its own row number (the "A39 says 'same as A39'" shape) is
//     tolerated, not flagged. No other citing surface has this shape.
//   - Resolution strength for v1 is ID-existence only -- the cited row must
//     exist as a current `### <ID>` heading in the register. Title-text
//     matching (does the citing prose's description match the row's actual
//     current title) is a stronger check, explicitly deferred as a
//     follow-up -- see docs/testing/onbox-acceptance-register.md's "Live
//     view" section and the backlog issue filed alongside this change.
//
// Shares row-heading parsing with check-onbox-register.mjs (`stripFences`,
// `parseAllRowHeadings`) per #2603's "share scanning logic where natural"
// note, rather than a second hand-rolled parser of the same heading shape.
//
// TWO ADDITIONS BEYOND THE LITERAL DECISION TEXT, both forced by a first
// real-tree run rather than invented speculatively -- an unqualified
// ID-existence check found 8 hits on `main` as shipped, and every one was a
// deliberately-annotated historical reference to a row this repo's own
// "annotate, don't renumber" convention keeps on record after a discharge
// (e.g. "register row A43 (discharged 2026-08-26, removed from the
// register)") -- not drift. Shipping the check unqualified would leave it
// permanently red against correct, intentional content:
//   1. Same-line discharge/removal annotation exemption (ANNOTATION_REGEX) --
//      a citation is downgraded to a printed, non-fatal NOTE (never silently
//      dropped) when its own physical line also says the row was discharged
//      or removed. Measured against all 8 real hits: every one carries the
//      annotation on the SAME line as the citation, so this narrow,
//      same-line-only rule (far simpler than the sibling checker's
//      multi-line clause-boundary version -- see its own header comment for
//      why IT needs that much machinery) fully accounts for them without
//      borrowing that complexity.
//   2. A short frozen-path list (FROZEN_EXACT/FROZEN_PREFIXES) for dated,
//      historical-transcript files where an ID is cited as "what the
//      register said on that date," not as a live pointer -- mirrors
//      scripts/check-register-citations.mjs's own exclusions for the exact
//      same two path shapes (onbox-acceptance-staleness-audit.md; the
//      onbox-wave{3,4,5}-results/ transcript directories), not a new policy.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readNormalized } from './lib/read-normalized.mjs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { scrubGitEnv } from './git-env.mjs';
import { stripFences, parseAllRowHeadings } from './check-onbox-register.mjs';

export const REGISTER_PATH = 'docs/testing/onbox-acceptance-register.md';
const SCAN_PREFIXES = ['docs/testing/', 'docs/features/'];

// The exact pattern from #2603's decision comment.
const ROW_WORD_CITATION_REGEX = /\b(?:row|Row)\s+([AE]\d+)\b/g;

// A markdown link whose target points into the register file's own anchor
// for a row heading. GitHub lowercases heading anchors, so the anchor half
// is matched case-insensitively even though a real row ID is always
// upper-case.
const REGISTER_LINK_REGEX = /onbox-acceptance-register\.md#([ae]\d+)\b/gi;

// See this file's header ("TWO ADDITIONS...") for why this exists and why
// same-line is enough for v1: measured against every real hit on the tree at
// the time this was added, the annotation always shares the citation's own
// physical line.
// NOTE: The annotation exemption is keyed to the SPECIFIC citation, not the
// entire line. A line can contain multiple citations, and only those where
// the annotation phrase is specifically tied to that citation ID are exempt.
// See the bug fix for #2831 for details.
// The 'g' flag is required for matchAll() in the citation-checking logic.
const ANNOTATION_REGEX = /\bdischarged?\b|\bno longer exists?\b|\bremoved from the register\b/gi;

// Join hard-wrapped continuation lines into a single logical line for checking.
// This ensures annotations on the next physical line after a citation are still recognized.
// Handles both blockquote continuations (lines starting with `> `) and prose wraps.
function normalizeLineContext(lines, lineNum) {
  let context = lines[lineNum - 1] ?? '';
  let nextIdx = lineNum;

  while (nextIdx < lines.length) {
    const currentLine = lines[nextIdx - 1];
    const nextLine = lines[nextIdx];

    if (!nextLine) break;

    // Blockquote continuation: both lines start with `> `
    const isBlockquoteContinuation = currentLine.startsWith('> ') && nextLine.startsWith('> ');

    // Prose continuation: both are prose (not markdown structural markers)
    const isCurrentProse =
      !currentLine.startsWith('> ') && !currentLine.startsWith('#') && currentLine.trim() !== '';
    const isNextProse =
      !nextLine.startsWith('> ') && !nextLine.startsWith('#') && nextLine.trim() !== '';
    const isProseContinuation = isCurrentProse && isNextProse;

    if (isBlockquoteContinuation) {
      // For blockquotes, remove the `> ` prefix from the continuation so the citation
      // regex can match across the joined lines (e.g., "row A99" split as "row" + "A99")
      const nextContent = nextLine.replace(/^> /, '');
      context += ' ' + nextContent;
      nextIdx++;
    } else if (isProseContinuation) {
      // For prose, just join with a space
      context += ' ' + nextLine;
      nextIdx++;
    } else {
      break;
    }
  }

  return context;
}

// Check if a citation (identified by its row ID) has a discharge/removal
// annotation that is specifically tied to that citation (not another citation
// on the same logical line). Uses a "nearest citation" rule: for each
// annotation phrase, the annotation applies to the citation nearest to its
// left. This prevents cross-contamination from multiple citations on the
// same line and handles hard-wrapped continuations.
function isCitationAnnotated(id, lines, lineNum) {
  const context = normalizeLineContext(lines, lineNum);

  // Find all "row ID" citations in the context
  const rowCitations = [...context.matchAll(/\brow\s+([AE]\d+)\b/gi)].map((m) => ({
    index: m.index,
    id: m[1].toUpperCase(),
    type: 'row',
  }));

  // Find all markdown link citations
  const linkCitations = [...context.matchAll(/onbox-acceptance-register\.md#([ae]\d+)\b/gi)].map(
    (m) => ({
      index: m.index,
      id: m[1].toUpperCase(),
      type: 'link',
    })
  );

  // Merge and sort by position
  const allCitations = [...rowCitations, ...linkCitations].sort((a, b) => a.index - b.index);

  // Check if our citation exists in the context
  const ourCitation = allCitations.find((c) => c.id === id);
  if (!ourCitation) return false;

  // Find all annotations in the context. Note: ANNOTATION_REGEX has the global
  // flag, so we must use matchAll() rather than test() to avoid state issues.
  const annotations = [...context.matchAll(ANNOTATION_REGEX)];
  if (annotations.length === 0) return false;

  // For each annotation, check if our citation is the nearest one to its left
  for (const annotation of annotations) {
    const annotationPos = annotation.index;

    // Find all citations to the left of this annotation
    const citationsToLeft = allCitations.filter((c) => c.index < annotationPos);
    if (citationsToLeft.length === 0) continue;

    // The nearest citation to the left is the last one
    const nearestCitation = citationsToLeft[citationsToLeft.length - 1];

    if (nearestCitation.id === id) {
      // Our citation is the nearest to this annotation, so it applies to us
      return true;
    }
  }

  return false;
}

// Dated historical-transcript files where an ID is cited as "what the
// register said on that date," not as a live pointer -- see this file's
// header comment. Mirrors scripts/check-register-citations.mjs's own
// FROZEN_EXACT/FROZEN_PREFIXES for the identical two path shapes.
const FROZEN_EXACT = new Set(['docs/testing/onbox-acceptance-staleness-audit.md']);
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

function repoRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

function gitLsFiles(prefix) {
  const out = execFileSync('git', ['ls-files', '--', prefix], {
    cwd: repoRoot(),
    env: scrubGitEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return out.split('\n').filter(Boolean);
}

// Every `.md` file git-tracked under docs/testing/** or docs/features/**, in
// a stable, de-duplicated order.
export function scannedFiles() {
  const files = new Set();
  for (const prefix of SCAN_PREFIXES) {
    for (const f of gitLsFiles(prefix)) {
      if (f.endsWith('.md')) files.add(f.replace(/\\/g, '/'));
    }
  }
  return [...files].sort();
}

// Finds every recognized citation in `text` (already fence-stripped),
// returning `{ line, id }[]` in ascending line order (1-based, uppercase
// id). The two regexes are scanned independently over the same text; they
// can never both match the same characters, since one requires "row "/"Row "
// immediately before the id and the other requires
// "onbox-acceptance-register.md#" immediately before it, so no citation is
// ever double-counted.
//
// To handle blockquote-prefixed citations (e.g., "> row\n> A99"), we
// normalize blockquote markers before scanning, removing the ">" prefix so
// the citation patterns can match across line breaks.
export function extractCitations(text) {
  // Remove blockquote prefixes to allow citation patterns to match across lines
  // (e.g., "row\nA99" becomes matchable even when formatted as "> row\n> A99").
  const normalizedText = text
    .split('\n')
    .map((line) => line.replace(/^> /, ''))
    .join('\n');

  const lines = text.split('\n');
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineForOffset = (idx) => {
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      if (idx >= lineStarts[i]) return i + 1;
    }
    return 1;
  };

  const citations = [];
  for (const m of normalizedText.matchAll(ROW_WORD_CITATION_REGEX)) {
    citations.push({ line: lineForOffset(m.index), id: m[1].toUpperCase() });
  }
  for (const m of normalizedText.matchAll(REGISTER_LINK_REGEX)) {
    citations.push({ line: lineForOffset(m.index), id: m[1].toUpperCase() });
  }
  citations.sort((a, b) => a.line - b.line);
  return citations;
}

// The row ID whose `### <ID>` heading `lineNumber` (1-based) falls under, in
// fence-stripped `strippedText` -- null before the first heading. Used only
// for the register's own self-reference exemption (see this file's header).
function rowIdAtLine(strippedText, lineNumber) {
  const lines = strippedText.split('\n');
  let current = null;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    const m = lines[i].match(/^### ([A-Z])(\d+)(?=\s|\r?$)/);
    if (m) current = `${m[1]}${m[2]}`;
  }
  return current;
}

// Runs the check over `files` (defaults to `scannedFiles()`), resolving each
// citation against the register's current row headings. `readFile` is
// injectable so tests never touch the real filesystem or `git ls-files`.
// Returns `{ error, failures, annotated, checkedFiles, citationCount }` --
// `error` is a non-null string when an unterminated fence is found (in either
// the register or any scanned file), which is a fatal check condition matching
// the ops-44/#1913 precedent of bailing on truncated reads rather than
// reporting "no errors" over missing content (see check-onbox-register.mjs's
// own handling for the same).
// `failures` is `{ file, line, id }[]`, empty when every recognized citation
// either resolves or carries a same-line discharge/removal annotation (see
// this file's header); `annotated` is the same shape, for citations that
// were excused that way -- printed as a note, never silently dropped.
export function checkRegisterRowCitations({
  files = scannedFiles(),
  readFile = (relPath) => readNormalized(join(repoRoot(), relPath)),
} = {}) {
  const registerFenceCheck = stripFences(readFile(REGISTER_PATH));
  if (registerFenceCheck.unterminatedFenceLine !== null) {
    return {
      error: `Unterminated fenced code block opened at line ${registerFenceCheck.unterminatedFenceLine} in ${REGISTER_PATH} — everything after it was ignored.`,
      failures: [],
      annotated: [],
      checkedFiles: 0,
      citationCount: 0,
    };
  }
  const { text: strippedRegisterText } = registerFenceCheck;
  const validIds = new Set(parseAllRowHeadings(strippedRegisterText).map((r) => r.id));

  const failures = [];
  const annotated = [];
  const fileErrors = [];
  let citationCount = 0;
  let checkedFilesCount = 0;
  for (const relPath of files) {
    const normalizedPath = relPath.replace(/\\/g, '/');
    if (isFrozenPath(normalizedPath)) continue;
    checkedFilesCount++;
    const isRegisterItself = normalizedPath === REGISTER_PATH;
    const fenceCheck = stripFences(readFile(relPath));
    if (fenceCheck.unterminatedFenceLine !== null) {
      fileErrors.push(
        `Unterminated fenced code block opened at line ${fenceCheck.unterminatedFenceLine} in ${normalizedPath} — everything after it was ignored.`
      );
      continue;
    }
    const { text: strippedText } = fenceCheck;
    const lines = strippedText.split('\n');
    for (const { line, id } of extractCitations(strippedText)) {
      citationCount++;
      if (isRegisterItself && rowIdAtLine(strippedText, line) === id) continue; // self-reference
      if (validIds.has(id)) continue;
      if (isCitationAnnotated(id, lines, line)) {
        annotated.push({ file: normalizedPath, line, id });
        continue;
      }
      failures.push({ file: normalizedPath, line, id });
    }
  }

  // If any files had unterminated fences, report them as a fatal error
  if (fileErrors.length > 0) {
    return {
      error: fileErrors.join('\n'),
      failures: [],
      annotated: [],
      checkedFiles: checkedFilesCount,
      citationCount,
    };
  }

  return { error: null, failures, annotated, checkedFiles: checkedFilesCount, citationCount };
}

// --- CLI --------------------------------------------------------------

// process.exit() terminates before Node flushes pending async stdout writes
// on POSIX (see scripts/lib/is-main-module.mjs's own comment) -- every exit
// below goes through this, mirroring check-onbox-register.mjs's own
// CliExitError pattern, so the process only ever terminates naturally once
// the event loop drains.
class CliExitError extends Error {
  constructor(code) {
    super(`CLI exit ${code}`);
    this.code = code;
  }
}

export function runCheckRegisterRowCitationsCli() {
  const { error, failures, annotated, checkedFiles, citationCount } = checkRegisterRowCitations();
  if (error !== null) {
    console.error(`check:register-row-citations: ${error}`);
    throw new CliExitError(1);
  }
  if (annotated.length > 0) {
    console.log(
      `check:register-row-citations: ${annotated.length} citation(s) name a discharged/removed ` +
        'row but say so on the same line -- printed as a note, not a failure:\n',
    );
    for (const { file, line, id } of annotated) {
      console.log(`- ${file}:${line} cites row ${id} (annotated as discharged/removed).`);
    }
    console.log('');
  }
  if (failures.length > 0) {
    console.error(
      `check:register-row-citations: ${failures.length} citation(s) cite a row that does ` +
        `not exist in ${REGISTER_PATH}:\n`,
    );
    for (const { file, line, id } of failures) {
      console.error(`- ${file}:${line} cites row ${id}, which has no current heading.`);
    }
    throw new CliExitError(1);
  }
  console.log(
    `check:register-row-citations: OK -- ${citationCount} citation(s) across ${checkedFiles} ` +
      'file(s) under docs/testing/** and docs/features/** all resolve.',
  );
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    runCheckRegisterRowCitationsCli();
  } catch (err) {
    if (err instanceof CliExitError) {
      process.exitCode = err.code;
    } else {
      throw err;
    }
  }
}
