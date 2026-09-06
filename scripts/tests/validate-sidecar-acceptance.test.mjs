// Tests for the sidecar-acceptance-gate validator (ops-74 / #3050).
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  touchesSidecar,
  unquoteGitPath,
  parseFileList,
  parseRecordedRun,
  hasPassingRecordedRun,
  hasRegisterLink,
  parseRegisterLink,
  passesSidecarAcceptanceGate,
  helpMessage,
  loadRegisterRowIds,
} from '../validate-sidecar-acceptance.mjs';

// Synthetic register row IDs, used ONLY as fixtures for this validator's
// regex. Composed at runtime instead of written literally because
// scripts/check-register-citations.mjs reads the literal "row <ID>" idiom in
// any tracked file as a CITATION of a real register row -- and these are not
// citations, they are inputs to a pattern. Written literally they made that
// checker exit 1 on the whole tree and, through it, disarmed its own
// mutation test (`CLI mutation: deleting Check C from fatalSections ...`),
// which proves its fatality by asserting a mutant PASSES. The runtime string
// each test actually exercises is unchanged.
const row = (group, n) => `${group}${n}`;
const FIXTURE_ROW_ID = row('A', 101);
const FIXTURE_ROW_ID_ALT = row('E', 101);

// The gate now checks that a cited row EXISTS (#3053 review pass 2, N1), so
// every syntax-level assertion below hands it this explicit set rather than
// the real register -- keeping the pattern fixtures synthetic, exactly as
// the comment above requires.
const FIXTURE_ROWS = new Set([FIXTURE_ROW_ID, FIXTURE_ROW_ID_ALT, row('C', 2)]);

// The real register's row ids, for the existence half. Read through the
// SAME parser the validator uses, so a fixture id can never drift from what
// the register actually contains.
const REAL_ROW_IDS = loadRegisterRowIds();
const A_REAL_ROW_ID = [...REAL_ROW_IDS].sort()[0];

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
  // en dash -- the third accepted separator, and the one the code comment
  // used to omit while naming a single ASCII hyphen it does not accept
  'Sidecar acceptance: `npm run test:sidecar` – 2026-09-06 – passed',
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
  // A SINGLE ASCII hyphen is not one of the three accepted separators
  // (`--`, em dash, en dash). The code comment used to claim it was; this
  // fixture is what keeps comment and code from drifting apart again.
  'Sidecar acceptance: `npm run test:sidecar` - 2026-09-06 - passed',
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
  `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID}`,
  'Sidecar acceptance: docs/testing/onbox-acceptance-register.md#C2',
  `sidecar acceptance: recorded at docs/testing/onbox-acceptance-register.md, row ${FIXTURE_ROW_ID_ALT}`,
];

for (const body of acceptedRegisterLinks) {
  test(`hasRegisterLink accepts: ${JSON.stringify(body)}`, () => {
    assert.equal(hasRegisterLink(body, FIXTURE_ROWS), true);
  });
}

const rejectedRegisterLinks = [
  '',
  `See docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID}`, // no "Sidecar acceptance:" prefix on the line
  'Sidecar acceptance: docs/testing/onbox-acceptance-register.md', // no row ID
  // The register is mentioned elsewhere in the body, but not on a line that
  // also carries the "Sidecar acceptance:" prefix and a row id -- a bare,
  // unrelated mention must not satisfy the gate.
  'This references docs/testing/onbox-acceptance-register.md in passing.\n\nSidecar acceptance: pending.',
];

for (const body of rejectedRegisterLinks) {
  test(`hasRegisterLink rejects: ${JSON.stringify(body)}`, () => {
    assert.equal(hasRegisterLink(body, FIXTURE_ROWS), false);
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
      `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID}`,
      FIXTURE_ROWS,
    ),
    true,
  );
});

// --- "written plainly": fenced blocks and HTML comments ---------------------
// helpMessage() and CONTRIBUTING.md "Sidecar acceptance fast-path" both tell
// the author to write the line plainly, NOT inside a code block. Without
// stripping, that instruction was unenforced and the documented copy-paste
// block was itself a passing body.

const FENCE = '`'.repeat(3);

test('a recorded run inside a fenced code block does NOT satisfy the gate', () => {
  const body = [
    'We did not get to the box this round.',
    '',
    FENCE,
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
    FENCE,
  ].join('\n');
  assert.equal(hasPassingRecordedRun(body), false);
  assert.equal(passesSidecarAcceptanceGate(['server/tts-sidecar/main.py'], body), false);
});

test('a register link inside a fenced code block does NOT satisfy the gate', () => {
  const body = [
    FENCE,
    `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID}`,
    FENCE,
  ].join('\n');
  assert.equal(hasRegisterLink(body, FIXTURE_ROWS), false);
  assert.equal(
    passesSidecarAcceptanceGate(['server/tts-sidecar/main.py'], body, FIXTURE_ROWS),
    false,
  );
});

test('an acceptance line inside an HTML comment does NOT satisfy the gate', () => {
  const body = [
    'Nothing was run.',
    '',
    '<!--',
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
    '-->',
  ].join('\n');
  assert.equal(hasPassingRecordedRun(body), false);
  assert.equal(passesSidecarAcceptanceGate(['server/tts-sidecar/main.py'], body), false);
});

// A real, unfenced line still passes -- the stripping must not be so broad
// that it eats the documented plain form (which legitimately carries INLINE
// backticks around the command).
test('stripping leaves a plainly-written line, inline backticks and all, passing', () => {
  const body = [
    'Some prose.',
    '',
    FENCE,
    'an unrelated code sample',
    FENCE,
    '',
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed',
  ].join('\n');
  assert.equal(hasPassingRecordedRun(body), true);
  assert.equal(passesSidecarAcceptanceGate(['server/tts-sidecar/main.py'], body), true);
});

// The strongest form of the above: the ACTUAL "Sidecar acceptance fast-path"
// section of the real CONTRIBUTING.md, whose documented copy-paste block
// carries a real date and a real row id. Pasting the docs is the honest
// copy-paste path, not gaming -- and it must not pass a gate for a PR where
// nothing was run.
test('the real CONTRIBUTING.md, fed whole as a PR body, does NOT satisfy the gate', () => {
  const contributing = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CONTRIBUTING.md'),
    'utf8',
  );
  // Guard the guard: if the fixture stops containing the documented example
  // at all, this test would pass vacuously and prove nothing.
  assert.ok(
    contributing.includes('Sidecar acceptance: `npm run test:sidecar`'),
    'CONTRIBUTING.md no longer carries the documented acceptance example -- fixture is stale',
  );
  assert.equal(passesSidecarAcceptanceGate(['server/tts-sidecar/main.py'], contributing), false);
});

// --- unquoteGitPath ---------------------------------------------------------
// `git diff --name-only` quotes and C-escapes any path with a non-ASCII or
// control character under the default core.quotepath=true, so the raw name
// starts with a double quote and a bare prefix match misses it entirely.

test('unquoteGitPath decodes a git-quoted, C-escaped path', () => {
  assert.equal(
    unquoteGitPath('"server/tts-sidecar/tests/test_caf\\303\\251.py"'),
    'server/tts-sidecar/tests/test_cafÃ©.py',
  );
  // Unquoted paths pass through untouched.
  assert.equal(unquoteGitPath('server/tts-sidecar/main.py'), 'server/tts-sidecar/main.py');
});

test('touchesSidecar fires on a git-quoted non-ASCII sidecar path', () => {
  assert.equal(touchesSidecar(['"server/tts-sidecar/tests/test_caf\\303\\251.py"']), true);
  // and still does not false-positive on a quoted path outside the prefix
  assert.equal(touchesSidecar(['"server/src/tts/caf\\303\\251.ts"']), false);
});

test('a sidecar-touching PR named only by a git-quoted path still needs acceptance', () => {
  assert.equal(
    passesSidecarAcceptanceGate(
      ['"server/tts-sidecar/tests/test_caf\\303\\251.py"'],
      'Nothing relevant here.',
    ),
    false,
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

// The CLI reads the REAL register, so this fixture must cite a row that
// really exists -- taken from the register through the validator's own
// loader rather than hard-coded, so it cannot go stale.
test('CLI: a sidecar-touching PR citing a REAL register row passes', () => {
  const result = runCli(
    'server/tts-sidecar/main.py\n',
    `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${A_REAL_ROW_ID}`,
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
});

// ... and the same line citing a row that does NOT exist must fail, with the
// id named. Before #3053 review pass 2's N1 fix this exited 0: the gate
// checked the id's SHAPE and never that it was a row.
test('CLI: a sidecar-touching PR citing a NONEXISTENT register row fails', () => {
  assert.equal(
    REAL_ROW_IDS.has(FIXTURE_ROW_ID),
    false,
    `fixture is stale -- ${FIXTURE_ROW_ID} is now a real register row, so this test would pass vacuously`,
  );
  const result = runCli(
    'server/tts-sidecar/main.py\n',
    `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID}`,
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, new RegExp(`Cited register row ${FIXTURE_ROW_ID} does not exist`));
});

test('CLI: a sidecar-touching PR with a FAILED recorded run still fails the gate', () => {
  const result = runCli(
    'server/tts-sidecar/main.py\n',
    'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- failed',
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
});

// --- N1: the cited row must EXIST, and prose is not a citation --------------
// #3053 review pass 2. The link half checked the SHAPE of an id and nothing
// else, under a whole-pattern /i flag that made `[A-Z]` match lowercase too
// -- so a body whose own words were "NOT RUN" satisfied a REQUIRED check by
// parsing "until Q3." as a row citation.

const SIDECAR_FILES = ['server/tts-sidecar/main.py'];

const bodiesThatSayNothingWasRun = {
  'NOT RUN ... blocked until Q3':
    'Sidecar acceptance: NOT RUN. docs/testing/onbox-acceptance-register.md\n' +
    'has no row yet; blocked on box time until Q3.',
  'deferred, will file in v2':
    'Sidecar acceptance: deferred, see docs/testing/onbox-acceptance-register.md — will file in v2',
  'a made-up row id': `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${row('Z', 999)}`,
};

for (const [label, body] of Object.entries(bodiesThatSayNothingWasRun)) {
  test(`a body that records no run does NOT satisfy the gate: ${label}`, () => {
    assert.equal(passesSidecarAcceptanceGate(SIDECAR_FILES, body), false);
  });
}

// The PATTERN half, separated from the EXISTENCE half on purpose: with only
// the existence check in place, prose still PARSES as a citation and merely
// fails to resolve, so a later widening of the id pattern would go unnoticed.
// This pins that ordinary prose is not a citation at all.
test('prose that merely mentions the register parses as NO citation', () => {
  const proseBodies = [
    'Sidecar acceptance: NOT RUN. docs/testing/onbox-acceptance-register.md\nhas no row yet; blocked on box time until Q3.',
    'Sidecar acceptance: deferred, see docs/testing/onbox-acceptance-register.md — will file in v2',
    // lowercase id-shaped token: the old whole-pattern /i flag made `[A-Z]`
    // match this too
    'Sidecar acceptance: docs/testing/onbox-acceptance-register.md row a1',
  ];
  for (const body of proseBodies) {
    assert.equal(parseRegisterLink(body), null, `parsed a citation out of prose: ${body}`);
  }
});

test('a register link whose row does not exist does NOT satisfy the gate', () => {
  const body = `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID}`;
  // Guard the guard: the syntax half must still match, so the rejection is
  // proven to come from the EXISTENCE check and not from the pattern.
  assert.equal(hasRegisterLink(body, new Set([FIXTURE_ROW_ID])), true);
  assert.equal(hasRegisterLink(body, REAL_ROW_IDS), false);
  assert.equal(passesSidecarAcceptanceGate(SIDECAR_FILES, body), false);
});

test('a register link naming a REAL row still satisfies the gate', () => {
  assert.ok(A_REAL_ROW_ID, 'the register parsed to zero rows -- fixture is broken');
  assert.equal(
    passesSidecarAcceptanceGate(
      SIDECAR_FILES,
      `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${A_REAL_ROW_ID}`,
    ),
    true,
  );
});

// An unreadable register must fail CLOSED -- "cannot read the register" must
// never read as "any id is fine".
test('loadRegisterRowIds returns an empty set (fail closed) when the register is unreadable', () => {
  const missing = new URL('file:///nonexistent-register-that-should-not-exist.md');
  assert.equal(loadRegisterRowIds(missing).size, 0);
});

// The gate's own help text must not be a passing body. It used to be: it
// carried a real ISO date, `passed`, and `row A101` -- an id that has never
// existed -- so "check goes red -> copy the example -> check goes green" was
// the honest path.
test('helpMessage() fed whole as a PR body does NOT satisfy the gate', () => {
  const help = helpMessage();
  // Guard the guard: if the examples ever stop being present at all, this
  // test would pass vacuously.
  assert.ok(
    help.includes('Sidecar acceptance: `npm run test:sidecar`'),
    'helpMessage no longer shows the recorded-run example -- fixture is stale',
  );
  assert.ok(
    help.includes('Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row'),
    'helpMessage no longer shows the register-link example -- fixture is stale',
  );
  assert.equal(passesSidecarAcceptanceGate(SIDECAR_FILES, help), false);
});

// --- N2: the other three CommonMark spellings of "inside a code block" ------
// The first round stripped backtick fences only. A tilde fence, a 4-space
// indent, a tab indent, and an inline span opened by a trailing backtick on
// the previous line all still satisfied the gate while rendering as code.

const RUN_LINE = 'Sidecar acceptance: `npm run test:sidecar` -- 2026-09-06 -- passed';
const LINK_LINE = `Sidecar acceptance: see docs/testing/onbox-acceptance-register.md row ${FIXTURE_ROW_ID_ALT}`;
const TILDE_FENCE = '~'.repeat(3);

const codeBlockSpellings = {
  'four-space-indented code block': ['Nothing was run.', '', `    ${RUN_LINE}`].join('\n'),
  'tab-indented code block': ['Nothing was run.', '', `\t${RUN_LINE}`].join('\n'),
  'tilde-fenced code block': [TILDE_FENCE, RUN_LINE, TILDE_FENCE].join('\n'),
  'inline span opened on the previous line': [
    'Draft, do not read as a record: `',
    RUN_LINE,
    '`',
  ].join('\n'),
};

for (const [label, body] of Object.entries(codeBlockSpellings)) {
  test(`a recorded run inside a ${label} does NOT satisfy the gate`, () => {
    assert.equal(hasPassingRecordedRun(body), false);
    assert.equal(passesSidecarAcceptanceGate(SIDECAR_FILES, body), false);
  });
}

// The register-link half shares the anchors and the stripping, so it must
// behave identically -- checked rather than assumed.
const linkCodeBlockSpellings = {
  'four-space-indented code block': ['Nothing was run.', '', `    ${LINK_LINE}`].join('\n'),
  'tab-indented code block': ['Nothing was run.', '', `\t${LINK_LINE}`].join('\n'),
  'tilde-fenced code block': [TILDE_FENCE, LINK_LINE, TILDE_FENCE].join('\n'),
  'inline span opened on the previous line': [
    'Draft, do not read as a record: `',
    LINK_LINE,
    '`',
  ].join('\n'),
};

for (const [label, body] of Object.entries(linkCodeBlockSpellings)) {
  test(`a register link inside a ${label} does NOT satisfy the gate`, () => {
    assert.equal(hasRegisterLink(body, FIXTURE_ROWS), false);
    assert.equal(passesSidecarAcceptanceGate(SIDECAR_FILES, body, FIXTURE_ROWS), false);
  });
}

// The stripping must not be so broad that it eats honest bodies. Each of
// these carries code ELSEWHERE and a plainly-written acceptance line, and
// must still pass -- otherwise the fix above is just a rejection of
// everything.
const honestBodiesWithCodeElsewhere = {
  'after a tilde-fenced sample': [TILDE_FENCE, 'a sample', TILDE_FENCE, '', RUN_LINE].join('\n'),
  'after a paragraph carrying an inline span': ['See `npm test` first.', '', RUN_LINE].join('\n'),
  'after an indented code block': ['Sample:', '', '    some code', '', RUN_LINE].join('\n'),
  'indented up to three spaces (still a paragraph, not code)': `   ${RUN_LINE}`,
};

for (const [label, body] of Object.entries(honestBodiesWithCodeElsewhere)) {
  test(`a plainly-written acceptance line still passes: ${label}`, () => {
    assert.equal(hasPassingRecordedRun(body), true);
    assert.equal(passesSidecarAcceptanceGate(SIDECAR_FILES, body), true);
  });
}

// A tilde line inside a backtick fence is content, not a close -- otherwise
// the fence state machine reopens and lines after it stop being stripped.
test('a tilde line inside a backtick fence does not close it', () => {
  const body = [FENCE, TILDE_FENCE, RUN_LINE, FENCE].join('\n');
  assert.equal(hasPassingRecordedRun(body), false);
});
