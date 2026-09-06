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

export function touchesSidecar(files) {
  if (!Array.isArray(files)) return false;
  return files.some((f) => typeof f === 'string' && f.startsWith(SIDECAR_PREFIX));
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

// Checkable format (command, date, outcome) -- NOT free prose. Matches a
// line of the shape:
//   Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed
// The command must be the literal `npm run test:sidecar` (optionally with
// trailing flags, e.g. `-- --require-venv`), backtick-wrapped; the date is
// ISO (YYYY-MM-DD); the outcome is a fixed vocabulary, matched but not
// itself sufficient -- only "passed" satisfies the gate (see
// hasPassingRecordedRun below). Separator is `--`, `—`, or `-` with spaces
// on both sides, to tolerate a PR author's editor auto-converting `--` to
// an em/en-dash.
const RECORDED_RUN_PATTERN =
  /^\s*sidecar acceptance:\s*`(npm run test:sidecar(?:[^`\n]*)?)`\s*(?:--|—|–)\s*(\d{4}-\d{2}-\d{2})\s*(?:--|—|–)\s*(passed|failed)\s*$/im;

export function parseRecordedRun(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(RECORDED_RUN_PATTERN);
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
  const match = body.match(REGISTER_LINK_PATTERN);
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
