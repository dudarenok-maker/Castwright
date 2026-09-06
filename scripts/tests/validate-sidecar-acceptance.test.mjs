// Tests for the sidecar-acceptance-gate validator (ops-74 / #3050).
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  touchesSidecar,
  parseFileList,
  parseRecordedRun,
  hasPassingRecordedRun,
  hasRegisterLink,
  passesSidecarAcceptanceGate,
} from '../validate-sidecar-acceptance.mjs';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'validate-sidecar-acceptance.mjs',
);

// --- touchesSidecar -------------------------------------------------------

test('touchesSidecar: true when any file is under server/tts-sidecar/', () => {
  assert.equal(touchesSidecar(['server/tts-sidecar/main.py']), true);
  assert.equal(
    touchesSidecar(['src/App.tsx', 'server/tts-sidecar/tests/test_smoke.py']),
    true,
  );
});

test('touchesSidecar: false for an empty list, non-array, or no sidecar path', () => {
  assert.equal(touchesSidecar([]), false);
  assert.equal(touchesSidecar(undefined), false);
  assert.equal(touchesSidecar(null), false);
  assert.equal(touchesSidecar(['src/App.tsx', 'server/src/tts/index.ts']), false);
});

// The trigger path is deliberately narrow -- server/src/tts/**,
// server/src/analyzer/**, server/src/gpu/** must NOT trip this gate (the
// earlier draft this issue explicitly rejected). A path that merely
// CONTAINS the substring "tts-sidecar" elsewhere in the tree (not as this
// exact directory prefix) must not false-positive either.
test('touchesSidecar: does not match the rejected wider paths or a substring elsewhere', () => {
  assert.equal(touchesSidecar(['server/src/tts/index.ts']), false);
  assert.equal(touchesSidecar(['server/src/analyzer/ollama.ts']), false);
  assert.equal(touchesSidecar(['server/src/gpu/active-generation-gate.ts']), false);
  assert.equal(touchesSidecar(['docs/notes/tts-sidecar-history.md']), false);
});

// --- parseFileList ----------------------------------------------------------

test('parseFileList: splits newline-separated text and drops blank lines', () => {
  assert.deepEqual(parseFileList('a.txt\nb.txt\n\nc.txt\n'), ['a.txt', 'b.txt', 'c.txt']);
});

test('parseFileList: empty diff (empty string) yields an empty array, not ["")', () => {
  assert.deepEqual(parseFileList(''), []);
});

test('parseFileList: non-string input yields an empty array', () => {
  assert.deepEqual(parseFileList(undefined), []);
});

// --- parseRecordedRun / hasPassingRecordedRun ------------------------------

const acceptedRecordedRuns = [
  'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
  'Sidecar acceptance: `npm run test:sidecar -- --require-venv` -- 2026-01-05 -- passed',
  'SIDECAR ACCEPTANCE: `npm run test:sidecar` -- 2026-09-06 -- PASSED',
  'Intro text.\n\nSidecar acceptance: `npm run test:sidecar` — 2026-09-06 — passed\n\nMore text.',
];

for (const body of acceptedRecordedRuns) {
  test(`hasPassingRecordedRun accepts: ${JSON.stringify(body)}`, () => {
    assert.equal(hasPassingRecordedRun(body), true);
  });
}

test('parseRecordedRun: extracts command, date, and outcome', () => {
  const parsed = parseRecordedRun(
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
  );
  assert.deepEqual(parsed, {
    command: 'npm run test:sidecar',
    date: '2026-09-06',
    outcome: 'passed',
  });
});

// A recorded FAILED run is a real, parseable record -- but must not satisfy
// the gate. This is the outcome-vocabulary check, not merely "some text
// present".
test('a recorded run with outcome "failed" parses but does not satisfy the gate', () => {
  const body = 'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- failed';
  assert.deepEqual(parseRecordedRun(body), {
    command: 'npm run test:sidecar',
    date: '2026-09-06',
    outcome: 'failed',
  });
  assert.equal(hasPassingRecordedRun(body), false);
});

const rejectedRecordedRuns = [
  '',
  'Ran the sidecar tests locally, all good.', // free prose, not the checkable format
  'Sidecar acceptance: npm run test:sidecar -- 2026-09-06 -- passed', // command not backticked
  'Sidecar acceptance: `npm test` -- 2026-09-06 -- passed', // wrong command
  'Sidecar acceptance: `npm run test:sidecar` -- 09-06-2026 -- passed', // non-ISO date
  'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- ok', // outcome not in vocabulary
];

for (const body of rejectedRecordedRuns) {
  test(`hasPassingRecordedRun rejects: ${JSON.stringify(body)}`, () => {
    assert.equal(hasPassingRecordedRun(body), false);
  });
}

test('hasPassingRecordedRun rejects non-string input', () => {
  assert.equal(hasPassingRecordedRun(undefined), false);
  assert.equal(hasPassingRecordedRun(null), false);
});

// --- hasRegisterLink --------------------------------------------------------

const acceptedRegisterLinks = [
  'Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row A101',
  'Sidecar acceptance: docs/testing/onbox-acceptance-register.md#C2',
  'sidecar acceptance: recorded at docs/testing/onbox-acceptance-register.md, row E101',
];

for (const body of acceptedRegisterLinks) {
  test(`hasRegisterLink accepts: ${JSON.stringify(body)}`, () => {
    assert.equal(hasRegisterLink(body), true);
  });
}

const rejectedRegisterLinks = [
  '',
  'See docs/testing/onbox-acceptance-register.md row A101', // no "Sidecar acceptance:" prefix on the line
  'Sidecar acceptance: docs/testing/onbox-acceptance-register.md', // no row ID
  // The register is mentioned elsewhere in the body, but not on a line that
  // also carries the "Sidecar acceptance:" prefix and a row id -- a bare,
  // unrelated mention must not satisfy the gate.
  'This references docs/testing/onbox-acceptance-register.md in passing.\n\nSidecar acceptance: pending.',
];

for (const body of rejectedRegisterLinks) {
  test(`hasRegisterLink rejects: ${JSON.stringify(body)}`, () => {
    assert.equal(hasRegisterLink(body), false);
  });
}

// --- passesSidecarAcceptanceGate -------------------------------------------

test('passesSidecarAcceptanceGate: a PR that does not touch the sidecar always passes', () => {
  assert.equal(passesSidecarAcceptanceGate(['src/App.tsx'], ''), true);
  assert.equal(passesSidecarAcceptanceGate([], 'no relevant text'), true);
});

test('passesSidecarAcceptanceGate: a sidecar-touching PR with neither form fails', () => {
  assert.equal(
    passesSidecarAcceptanceGate(['server/tts-sidecar/main.py'], 'Nothing relevant here.'),
    false,
  );
});

test('passesSidecarAcceptanceGate: a sidecar-touching PR with a passing recorded run passes', () => {
  assert.equal(
    passesSidecarAcceptanceGate(
      ['server/tts-sidecar/main.py'],
      'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
    ),
    true,
  );
});

test('passesSidecarAcceptanceGate: a sidecar-touching PR with a register link passes', () => {
  assert.equal(
    passesSidecarAcceptanceGate(
      ['server/tts-sidecar/main.py'],
      'Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row A101',
    ),
    true,
  );
});

// --- CLI mode ----------------------------------------------------------------
// This is what the workflow actually invokes -- unit tests above cover the
// exported functions directly, but nothing at that level proves the CLI
// wiring (argv, exit codes) actually works.

function runCli(files, body) {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-acceptance-'));
  try {
    const filesFile = join(dir, 'files.txt');
    const bodyFile = join(dir, 'body.txt');
    writeFileSync(filesFile, files);
    writeFileSync(bodyFile, body);
    return spawnSync(process.execPath, [scriptPath, filesFile, bodyFile], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: a non-sidecar PR passes regardless of body', () => {
  const result = runCli('src/App.tsx\n', 'no relevant text');
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
});

test('CLI: a sidecar-touching PR with neither form fails', () => {
  const result = runCli('server/tts-sidecar/main.py\n', 'Nothing relevant here.');
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
});

test('CLI: a sidecar-touching PR with a passing recorded run passes', () => {
  const result = runCli(
    'server/tts-sidecar/main.py\n',
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
});

test('CLI: a sidecar-touching PR with a register link passes', () => {
  const result = runCli(
    'server/tts-sidecar/main.py\n',
    'Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row A101',
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
});

test('CLI: a sidecar-touching PR with a FAILED recorded run still fails the gate', () => {
  const result = runCli(
    'server/tts-sidecar/main.py\n',
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- failed',
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
});
