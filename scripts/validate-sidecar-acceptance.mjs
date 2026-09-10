// Sidecar-acceptance-gate validator for the sidecar-acceptance-gate CI check
// (.github/workflows/sidecar-acceptance-gate.yml). ops-74 / #3050 — commit-gate
// rebalance design Part 6. See docs/superpowers/specs/2026-09-05-commit-gate-
// rebalance-design.md ("Part 6 — Scope-triggered local acceptance for the
// sidecar") and CONTRIBUTING.md "Sidecar acceptance fast-path" for the format
// this validates and why it exists (the 38 `pytest.importorskip("torch")`
// tests, 14 files, that run ONLY via a local `npm run test:sidecar` on real
// hardware, never in CI).
//
// Trigger path is `server/tts-sidecar/**` ONLY — deliberately narrower than
// an earlier draft that also listed server/src/tts/**, server/src/analyzer/**,
// server/src/gpu/** (177 TypeScript test files Ubuntu CI already covers). Do
// not widen this; see the design doc's Part 6 for why that draft was rejected.

import { readFileSync } from 'node:fs';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { parseRegisterRows } from './check-register-citations.mjs';

const SIDECAR_PREFIX = 'server/tts-sidecar/';

// The register the link form of this gate points at. Parsed with
// check-register-citations.mjs's own parseRegisterRows -- IMPORTED, not
// reimplemented, so this gate and that checker can never disagree about what
// counts as a row.
const REGISTER_URL = new URL('../docs/testing/onbox-acceptance-register.md', import.meta.url);

// The set of row IDs that actually exist in the register. Fails CLOSED: an
// unreadable or unparseable register yields an empty set, so the link form
// satisfies nothing and the author is sent to the help text. The opposite
// (treating "cannot read the register" as "any id is fine") would put a
// required check green on a body citing a row that does not exist, which is
// the defect this exists to close (#3053 review pass 2, N1).
//
// `readable` is carried alongside the ids because failing closed and
// DIAGNOSING closed are different jobs: with the ids alone, an unreadable
// register is indistinguishable from a made-up row, and the CLI told the
// author "Cited register row A1 does not exist" for a row that does exist,
// sending them to change a correct line (#3053 review pass 3, P5). The catch
// covers both a read failure and a parseRegisterRows throw -- from the
// author's side those are the same fact ("this gate could not confirm your
// row"), and neither is a defect in the PR body.
export function readRegisterRowIds(registerUrl = REGISTER_URL) {
  try {
    const rows = parseRegisterRows(readFileSync(registerUrl, 'utf8')).rows;
    return { rowIds: new Set(rows.keys()), readable: true };
  } catch {
    return { rowIds: new Set(), readable: false };
  }
}

export function loadRegisterRowIds(registerUrl = REGISTER_URL) {
  return readRegisterRowIds(registerUrl).rowIds;
}

// `git diff --name-only` (the producer -- see sidecar-acceptance-gate.yml)
// emits a path containing any non-ASCII or control character QUOTED and
// C-escaped under git's default `core.quotepath=true`, e.g.
//   "server/tts-sidecar/tests/test_caf\303\251.py"
// -- a leading double-quote, so a raw startsWith(SIDECAR_PREFIX) does not
// match and the gate silently does not fire. Unquote before prefix-matching.
// The \NNN escapes are UTF-8 BYTES, so decoding them per-char yields
// mojibake for the non-ASCII tail; that is fine and deliberate here, because
// only the ASCII directory prefix has to survive for the match to be right.
export function unquoteGitPath(path) {
  if (typeof path !== 'string') return path;
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' };
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== '\\') {
      out += inner[i];
      continue;
    }
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      out += String.fromCharCode(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const next = inner[i + 1];
    out += Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
    i += 1;
  }
  return out;
}

export function touchesSidecar(files) {
  if (!Array.isArray(files)) return false;
  return files.some((f) => typeof f === 'string' && unquoteGitPath(f).startsWith(SIDECAR_PREFIX));
}

// Splits a newline-separated file list (the shape `git diff --name-only`
// emits) into an array, dropping blank lines -- a diff with zero changed
// files is an empty string, which .split('\n') would otherwise turn into
// [''] and reject as "touches nothing" only by accident.
export function parseFileList(text) {
  if (typeof text !== 'string') return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Both helpMessage() below and CONTRIBUTING.md "Sidecar acceptance
// fast-path" tell the author to write the acceptance line PLAINLY, not
// inside a code block. Enforce that rather than merely asking for it: the
// documented copy-paste example in CONTRIBUTING.md is itself a fenced block
// carrying a real date and a real row id, so without stripping, pasting that
// file (or any commented-out draft) into a PR body passes a gate on a PR
// where nothing was run. Mirrors scripts/validate-pr-issue-link.mjs:29-70,
// whose own history records a code-span false positive as a real incident.
//
// CommonMark has FOUR ways to render a line as code, and this gate is only
// as strong as the weakest one it handles (#3053 review pass 2, N2 -- the
// first round covered backtick fences alone, while a tilde fence, a 4-space
// indent, a tab indent, and a span opened on the previous line all still
// satisfied the gate). All four are covered now:
//   1. a backtick fence        -- stripFencedBlocks
//   2. a tilde fence           -- stripFencedBlocks (same function, own char)
//   3. an indented code block  -- stripIndentedCodeBlocks. NOT an indent
//                                 limit on the line patterns below: indent
//                                 alone does not make a line code, and an
//                                 anchor that assumed it did rejected three
//                                 shapes GitHub renders as plain text
//                                 (#3053 review pass 3, P1) -- see that
//                                 function's own comment.
//   4. a multi-line inline span -- stripLinesInsideOpenInlineSpan
//
// The residual boundary, stated honestly because the comment that used to
// stand here stated it wrongly: a SAME-LINE inline span wrapping the whole
// line is rejected by the anchors themselves (a leading backtick is not part
// of the accepted list/blockquote prefix, nor the literal prefix). A span OPENED
// BY A TRAILING BACKTICK ON AN EARLIER LINE leaves the acceptance line
// starting with the bare prefix, so the anchor matched while the rendered
// body showed one code span -- that is the case
// stripLinesInsideOpenInlineSpan closes. Spans are still not stripped
// wholesale the way scripts/validate-pr-issue-link.mjs does, because this
// gate's recorded-run format REQUIRES the command backtick-wrapped, so
// blanking every span would blank the very token being matched.
//
// A fenced code block's delimiter must be alone on its own line (optionally
// indented up to 3 spaces) per CommonMark; a stray mid-line ``` is not a
// fence and must not open one. A fence closes only on a run of the SAME
// character at least as long as the opener, so a tilde line inside a
// backtick-fenced block is content, not a close.
function stripFencedBlocks(text) {
  const lines = text.split('\n');
  const kept = [];
  let fenceChar = null;
  let fenceLength = 0;
  for (const line of lines) {
    const fence = /^ {0,3}(\u0060{3,}|~{3,})/.exec(line);
    if (fence && fenceChar === null) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      kept.push('');
      continue;
    }
    if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLength) {
      fenceChar = null;
      fenceLength = 0;
      kept.push('');
      continue;
    }
    kept.push(fenceChar === null ? line : '');
  }
  return kept.join('\n');
}

// An HTML comment is invisible in the rendered PR body, so a line inside one
// is not a record of anything. Blanked (rather than deleted) so surrounding
// lines keep their own line boundaries and cannot coalesce into one line
// that then matches.
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

// Tabs are code-block indentation too, and a tab stop here is four columns.
function expandTabs(text) {
  return text.replace(/\t/g, '    ');
}

function indentWidthOf(line) {
  return expandTabs(/^[ \t]*/.exec(line)[0]).length;
}

// CommonMark's third code spelling, and the one where "the line is indented
// four spaces" is NOT sufficient on its own: an indented code block may not
// interrupt a paragraph, and inside a list item four spaces is the item's
// own content indentation. Code-ness is therefore a BLOCK property, decided
// here once, rather than an indent limit on the line patterns below.
//
// The earlier `^ {0,3}` anchor assumed indent alone settled it and so
// rejected three shapes GitHub renders as plain text -- including a `- [ ]`
// checklist item, which is exactly where .github/pull_request_template.md
// invites the author to write this line (#3053 review pass 3, P1). Rendered
// through GitHub's own POST /markdown (mode: gfm), of the four indented
// shapes an author actually writes only the last is code:
//
//   - [ ] Sidecar acceptance: ...            -> <li>            (plain text)
//   - Ran it.  <blank>  ....Sidecar: ...     -> <p> in the <li> (plain text)
//   Ran it.  <newline>  ....Sidecar: ...     -> one <p>         (plain text)
//   Ran it.  <blank>    ....Sidecar: ...     -> <pre><code>     (code)
//
// So a line is code here only when it is indented at least four columns PAST
// the enclosing list item's content indent (zero at top level) AND it opens
// a block -- i.e. the previous line was blank, or was itself code in the
// same block. Runs after fence stripping, so a fenced block's own lines are
// already blank by the time this sees them.
function stripIndentedCodeBlocks(text) {
  const lines = text.split('\n');
  const kept = [];
  let prevBlank = true; // start of document opens a block, same as a blank line
  let inCode = false;
  let listContentIndent = null;
  for (const line of lines) {
    if (line.trim() === '') {
      // A blank line closes neither a code block nor a list item.
      kept.push(line);
      prevBlank = true;
      continue;
    }
    const indent = indentWidthOf(line);
    if ((inCode || prevBlank) && indent >= (listContentIndent ?? 0) + 4) {
      inCode = true;
      prevBlank = false;
      kept.push('');
      continue;
    }
    inCode = false;
    prevBlank = false;
    const marker = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(line);
    if (marker) listContentIndent = expandTabs(marker[0]).length;
    else if (listContentIndent !== null && indent < listContentIndent) listContentIndent = null;
    kept.push(line);
  }
  return kept.join('\n');
}

// A backtick run left unclosed on an earlier line of the SAME paragraph puts
// every following line of that paragraph inside one rendered code span. An
// inline span cannot cross a blank line (a paragraph boundary), so state is
// tracked per paragraph and reset at every blank line.
//
// Tracked as CommonMark specifies it -- a run of N backticks opens a span
// that only a later run of exactly N closes -- and not as character parity,
// which was wrong for every even-length unmatched run: a trailing run of
// TWO (the standard idiom for a span containing a backtick) left parity
// even, so the counter reported "no span open" while GitHub rendered the following
// lines inside <code> (#3053 review pass 3, P3). An honest body -- whose
// acceptance line carries a run of one on each side of the command -- opens
// and closes on its own line and is unaffected. Runs AFTER fence and comment
// stripping, so backticks inside either of those cannot skew the state.
//
// Deliberately conservative in one direction: a run that never closes before
// the paragraph ends renders as literal text on GitHub, but is treated here
// as opening a span, so the lines after it are dropped. That over-rejects an
// exotic body and never under-rejects, which is the right way round for a
// required check.
function stripLinesInsideOpenInlineSpan(text) {
  const backtickRun = new RegExp(String.fromCharCode(0x60) + '+', 'g');
  const lines = text.split('\n');
  const kept = [];
  let openRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      openRun = 0;
      kept.push(line);
      continue;
    }
    kept.push(openRun > 0 ? '' : line);
    for (const run of line.matchAll(backtickRun)) {
      if (openRun === 0) openRun = run[0].length;
      else if (run[0].length === openRun) openRun = 0;
    }
  }
  return kept.join('\n');
}

function stripNonPlainText(text) {
  return stripLinesInsideOpenInlineSpan(
    stripIndentedCodeBlocks(stripFencedBlocks(stripHtmlComments(text))),
  );
}

// Checkable format (command, date, outcome) -- NOT free prose. Matches a
// line of the shape:
//   Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed
// The command must be the literal `npm run test:sidecar` (optionally with
// trailing flags, e.g. `-- --require-venv`), backtick-wrapped; the date is
// ISO (YYYY-MM-DD); the outcome is a fixed vocabulary, matched but not
// itself sufficient -- only "passed" satisfies the gate (see
// hasPassingRecordedRun below). Separator is `--`, an em dash, or an en
// dash, to tolerate a PR author's editor auto-converting `--`; a single
// ASCII hyphen is NOT accepted (CONTRIBUTING.md documents `--` only).
//
// The three backticks are escaped as \u0060 rather than written literally:
// an unpaired backtick inside a REGEX LITERAL desyncs the source scanner in
// server/src/spawn-windows-hide.test.ts, which scans scripts/**, and that
// guard throws rather than silently blanking the rest of this file (#2747).
// The escape is required INSIDE A REGEX LITERAL only -- elsewhere in this
// file (comments, strings) a literal backtick is fine and preferred.
//
// What may precede the prefix on its line, shared by both patterns below.
// Code-ness is settled by stripIndentedCodeBlocks, so this carries no indent
// limit of its own; what it does carry is the ordinary markdown furniture an
// author puts in front of a sentence -- each of which GitHub renders as
// plain text, and each of which the previous `^ {0,3}` anchor rejected
// (#3053 review pass 3, P1): any indentation, blockquote markers, a bullet
// or ordered-list marker, a task-list checkbox (the shape
// .github/pull_request_template.md itself invites), and a bold label.
// Mirrors the tolerance of the sibling this file follows,
// scripts/validate-pr-issue-link.mjs, which carries no line anchor at all.
const LINE_PREFIX =
  '^[ \\t]*(?:>[ \\t]*)*(?:[-*+]|\\d{1,9}[.)])?[ \\t]*(?:\\[[ xX]\\][ \\t]*)?(?:\\*\\*|__)?';
const RECORDED_RUN_PATTERN = new RegExp(
  LINE_PREFIX + 'sidecar acceptance:(?:\\*\\*|__)?' + '\\s*\\u0060(npm run test:sidecar(?:[^\\u0060\\n]*)?)\\u0060\\s*(?:--|—|–)\\s*(\\d{4}-\\d{2}-\\d{2})\\s*(?:--|—|–)\\s*(passed|failed)\\s*$',
  'im',
);

export function parseRecordedRun(body) {
  if (typeof body !== 'string') return null;
  const match = stripNonPlainText(body).match(RECORDED_RUN_PATTERN);
  if (!match) return null;
  return { command: match[1].trim(), date: match[2], outcome: match[3].toLowerCase() };
}

export function hasPassingRecordedRun(body) {
  const parsed = parseRecordedRun(body);
  return parsed !== null && parsed.outcome === 'passed';
}

// Alternative to a recorded run: a line naming this acceptance and pointing
// at a specific onbox-acceptance-register.md row (its ID scheme is a
// letter-group prefix plus digits -- see that file's "next-id" convention).
// Requires the register filename, the literal word `row`/`rows`, and the id
// itself, all on the SAME line as the "Sidecar acceptance:" prefix -- not
// merely present anywhere in the body, since a bare, unrelated mention of
// the register elsewhere in a large PR body must not satisfy this gate.
//
// Three things this deliberately does NOT do, each of which let a body that
// says the run was not done pass a REQUIRED check (#3053 review pass 2, N1):
//   - it does not match an id case-insensitively. The prefix half is matched
//     case-insensitively on its own line below, so the id half can stay
//     case-SENSITIVE; under a whole-pattern /i flag, `[A-Z]` also matched
//     lowercase and "until Q3." parsed as a row citation.
//   - it does not accept a bare id-shaped token anywhere on the line. The
//     id must be introduced either by the word `row`/`rows` or as the
//     register link's own `#` anchor, so ordinary prose ("will file in v2",
//     "blocked until Q3") is not a citation.
//   - it does not stop at shape. hasRegisterLink below checks the cited row
//     EXISTS in the register -- see loadRegisterRowIds.
const REGISTER_LINK_PREFIX_PATTERN = new RegExp(LINE_PREFIX + 'sidecar acceptance:', 'i');
const REGISTER_LINK_ROW_PATTERN =
  /onbox-acceptance-register\.md(?:#([A-Za-z]\d{1,3})\b|\b.*\brows?:?\s+([A-Z]\d{1,3})\b)/;

export function parseRegisterLink(body) {
  if (typeof body !== 'string') return null;
  for (const line of stripNonPlainText(body).split('\n')) {
    if (!REGISTER_LINK_PREFIX_PATTERN.test(line)) continue;
    const match = REGISTER_LINK_ROW_PATTERN.exec(line);
    // The `#` anchor half is matched case-INSENSITIVELY and normalised
    // here, because GitHub lowercases heading anchors -- so #a1, not #A1,
    // is the form a real link into the register carries (the same fact
    // scripts/check-register-row-citations.mjs:26-28 already records).
    // The `row`/`rows` half stays case-SENSITIVE on purpose: there the id
    // sits in ordinary prose with no delimiter of its own, and a
    // case-insensitive `[A-Z]` is what let "until Q3." parse as a row
    // citation (#3053 review pass 2, N1). A literal `#` immediately
    // before the id is the delimiter that prose lacks, so relaxing case
    // on that branch alone reopens nothing (#3053 review pass 3, P2).
    if (match) return { rowId: match[1] ? match[1].toUpperCase() : match[2] };
  }
  return null;
}

// `rowIds` is the set of ids the register actually contains; it defaults to
// reading the register off disk (the gate workflow does a full checkout, so
// it is always there in CI). Passed explicitly by the tests so a fixture id
// need not be a real row.
export function hasRegisterLink(body, rowIds = loadRegisterRowIds()) {
  const parsed = parseRegisterLink(body);
  return parsed !== null && rowIds.has(parsed.rowId);
}

export function passesSidecarAcceptanceGate(files, body, rowIds = loadRegisterRowIds()) {
  if (!touchesSidecar(files)) return true;
  return hasPassingRecordedRun(body) || hasRegisterLink(body, rowIds);
}

// The examples here are PLACEHOLDERS on purpose. This whole message used to
// be a passing body: it carried a real ISO date, the outcome `passed`, and
// `A101` -- an id that has never existed in the register -- so the
// honest path was "check goes red -> author copies the example -> check goes
// green", with nothing run and no row filed (#3053 review pass 2, N1). A
// help text must not itself satisfy the gate it explains; the paired test
// `helpMessage() fed whole as a PR body does NOT satisfy the gate` pins that.
export function helpMessage() {
  return [
    `This PR touches server/tts-sidecar/**, which carries 38`,
    `pytest.importorskip("torch") tests (14 files) that run ONLY via a local`,
    `"npm run test:sidecar" on real hardware -- never in CI.`,
    ``,
    `Record acceptance in the PR body, written plainly (not inside backticks`,
    `or a code block), as one of -- filling in the <placeholders>:`,
    ``,
    '  Sidecar acceptance: `npm run test:sidecar` -- <YYYY-MM-DD> -- passed',
    `  Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row <ID>`,
    ``,
    `<ID> must be a row that EXISTS in that register (e.g. the row this`,
    `acceptance is tracked on); a made-up id is rejected.`,
    ``,
    `See CONTRIBUTING.md "Sidecar acceptance fast-path" for the full format.`,
  ].join('\n');
}

// The diagnosis that precedes the generic help text, or null
// when the generic text says it all. Separated from the CLI so both
// branches are testable without a subprocess -- the register-unreadable
// branch is otherwise reachable only from a checkout with no docs/ tree.
//
// The two failures it distinguishes are NOT the same fact and used to
// print the same sentence: an unreadable register made the gate say
// "Cited register row A1 does not exist" about a row that does exist,
// sending the author to change a correct line (#3053 review pass 3, P5).
export function failureDetail(link, { rowIds, readable }) {
  if (!readable) {
    return [
      'Could not read or parse docs/testing/onbox-acceptance-register.md, so no',
      'cited row could be confirmed. This gate fails closed. Your PR body may',
      'well be correct -- check the register is present and parseable in this',
      'checkout before changing the body.',
    ].join('\n');
  }
  if (link && !rowIds.has(link.rowId)) {
    return `Cited register row ${link.rowId} does not exist in docs/testing/onbox-acceptance-register.md.`;
  }
  return null;
}

// CLI mode: node scripts/validate-sidecar-acceptance.mjs <pr-files-file> <pr-body-file>
// <pr-files-file> is a newline-separated list of changed files (the shape
// `git diff --name-only` emits); <pr-body-file> is the raw PR body.
if (isDirectlyInvoked(import.meta.url)) {
  const filesPath = process.argv[2];
  const bodyPath = process.argv[3];
  if (!filesPath || !bodyPath) {
    console.error(
      'Usage: validate-sidecar-acceptance.mjs <pr-files-file> <pr-body-file>',
    );
    process.exit(2);
  }
  const files = parseFileList(readFileSync(filesPath, 'utf8'));
  const body = readFileSync(bodyPath, 'utf8');
  if (!touchesSidecar(files)) {
    console.log(
      'This PR does not touch server/tts-sidecar/** -- sidecar acceptance gate does not apply.',
    );
    process.exit(0);
  }
  const register = readRegisterRowIds();
  if (!passesSidecarAcceptanceGate(files, body, register.rowIds)) {
    // A cited-but-nonexistent row, and a register this gate could not read
    // at all, are the two failures the generic help text does not explain.
    // Name whichever applies before printing that text.
    const detail = failureDetail(parseRegisterLink(body), register);
    if (detail !== null) {
      console.error(detail);
      console.error('');
    }
    console.error(helpMessage());
    process.exit(1);
  }
  console.log('Sidecar acceptance recorded.');
  process.exit(0);
}
