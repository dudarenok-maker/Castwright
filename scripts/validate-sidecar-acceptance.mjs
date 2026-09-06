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
export function loadRegisterRowIds(registerUrl = REGISTER_URL) {
  try {
    return new Set(parseRegisterRows(readFileSync(registerUrl, 'utf8')).rows.keys());
  } catch {
    return new Set();
  }
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
//   3. an indented code block  -- the `^ {0,3}` anchor on both patterns
//                                 below; a line indented 4+ spaces, or by a
//                                 tab, is a code block, not a paragraph
//   4. a multi-line inline span -- stripLinesInsideOpenInlineSpan
//
// The residual boundary, stated honestly because the comment that used to
// stand here stated it wrongly: a SAME-LINE inline span wrapping the whole
// line is rejected by the anchors themselves (a leading backtick is neither
// one of up to three leading spaces nor the literal prefix). A span OPENED
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

// A backtick run left unclosed on an earlier line of the SAME paragraph puts
// every following line of that paragraph inside one rendered code span. An
// inline span cannot cross a blank line (a paragraph boundary), so parity is
// tracked per paragraph and reset at every blank line. A run contributes its
// own length, so a doubled-backtick span stays even, and an honest body --
// whose acceptance line carries exactly two backticks, around the command --
// is unaffected. Runs AFTER fence and comment stripping, so backticks inside
// either of those cannot skew the parity.
function stripLinesInsideOpenInlineSpan(text) {
  const backtick = String.fromCharCode(0x60);
  const lines = text.split('\n');
  const kept = [];
  let ticks = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      ticks = 0;
      kept.push(line);
      continue;
    }
    kept.push(ticks % 2 === 1 ? '' : line);
    ticks += line.split(backtick).length - 1;
  }
  return kept.join('\n');
}

function stripNonPlainText(text) {
  return stripLinesInsideOpenInlineSpan(stripFencedBlocks(stripHtmlComments(text)));
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
const RECORDED_RUN_PATTERN =
  /^ {0,3}sidecar acceptance:\s*\u0060(npm run test:sidecar(?:[^\u0060\n]*)?)\u0060\s*(?:--|—|–)\s*(\d{4}-\d{2}-\d{2})\s*(?:--|—|–)\s*(passed|failed)\s*$/im;

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
const REGISTER_LINK_PREFIX_PATTERN = /^ {0,3}sidecar acceptance:/i;
const REGISTER_LINK_ROW_PATTERN =
  /onbox-acceptance-register\.md(?:#([A-Z]\d{1,3})\b|\b.*\brows?:?\s+([A-Z]\d{1,3})\b)/;

export function parseRegisterLink(body) {
  if (typeof body !== 'string') return null;
  for (const line of stripNonPlainText(body).split('\n')) {
    if (!REGISTER_LINK_PREFIX_PATTERN.test(line)) continue;
    const match = REGISTER_LINK_ROW_PATTERN.exec(line);
    if (match) return { rowId: match[1] ?? match[2] };
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
// `row A101` -- an id that has never existed in the register -- so the
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
  const rowIds = loadRegisterRowIds();
  if (!passesSidecarAcceptanceGate(files, body, rowIds)) {
    // A cited-but-nonexistent row is the one failure the generic help text
    // does not explain, so name it before printing that text.
    const link = parseRegisterLink(body);
    if (link && !rowIds.has(link.rowId)) {
      console.error(
        `Cited register row ${link.rowId} does not exist in docs/testing/onbox-acceptance-register.md.`,
      );
      console.error('');
    }
    console.error(helpMessage());
    process.exit(1);
  }
  console.log('Sidecar acceptance recorded.');
  process.exit(0);
}
