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

const SIDECAR_PREFIX = 'server/tts-sidecar/';

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
// INLINE spans are deliberately NOT stripped here (unlike that sibling):
// this gate's own recorded-run format REQUIRES the command backtick-wrapped,
// so stripping inline spans would blank the very token being matched. An
// inline span wrapping the WHOLE line is already rejected regardless,
// because both patterns anchor on `^\s*sidecar acceptance:` and a leading
// backtick is neither whitespace nor the literal prefix.
//
// A fenced code block's delimiter must be alone on its own line (optionally
// indented up to 3 spaces) per CommonMark; a stray mid-line ``` is not a
// fence and must not open one.
function stripFencedBlocks(text) {
  const lines = text.split('\n');
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    if (/^ {0,3}\u0060{3,}/.test(line)) {
      inFence = !inFence;
      kept.push('');
      continue;
    }
    kept.push(inFence ? '' : line);
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

function stripNonPlainText(text) {
  return stripFencedBlocks(stripHtmlComments(text));
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
  /^\s*sidecar acceptance:\s*\u0060(npm run test:sidecar(?:[^\u0060\n]*)?)\u0060\s*(?:--|—|–)\s*(\d{4}-\d{2}-\d{2})\s*(?:--|—|–)\s*(passed|failed)\s*$/im;

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
// letter-group prefix plus digits, e.g. A101, C2, E101 -- see that file's
// "next-id" convention). Requires both the register filename and a
// row-id-shaped token on the SAME line as the "Sidecar acceptance:" prefix,
// not merely present anywhere in the body -- a bare, unrelated mention of
// the register elsewhere in a large PR body must not satisfy this gate.
const REGISTER_LINK_PATTERN =
  /^\s*sidecar acceptance:.*onbox-acceptance-register\.md.*\b([A-Z]\d{1,4})\b/im;

export function parseRegisterLink(body) {
  if (typeof body !== 'string') return null;
  const match = stripNonPlainText(body).match(REGISTER_LINK_PATTERN);
  if (!match) return null;
  return { rowId: match[1] };
}

export function hasRegisterLink(body) {
  return parseRegisterLink(body) !== null;
}

export function passesSidecarAcceptanceGate(files, body) {
  if (!touchesSidecar(files)) return true;
  return hasPassingRecordedRun(body) || hasRegisterLink(body);
}

export function helpMessage() {
  return [
    `This PR touches server/tts-sidecar/**, which carries 38`,
    `pytest.importorskip("torch") tests (14 files) that run ONLY via a local`,
    `"npm run test:sidecar" on real hardware -- never in CI.`,
    ``,
    `Record acceptance in the PR body, written plainly (not inside backticks`,
    `or a code block), as one of:`,
    ``,
    '  Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
    `  Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row A101`,
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
  if (!passesSidecarAcceptanceGate(files, body)) {
    console.error(helpMessage());
    process.exit(1);
  }
  console.log('Sidecar acceptance recorded.');
  process.exit(0);
}
