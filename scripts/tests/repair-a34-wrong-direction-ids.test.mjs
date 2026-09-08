/* Tests for scripts/repair-a34-wrong-direction-ids.mjs (register row A34,
   #2584/#2040, parent #2903, step 2).

   Run via: node --test scripts/tests/repair-a34-wrong-direction-ids.test.mjs

   Covers the pure planning helpers (isAsciiKebabId, normaliseForMatch,
   planBookRepairs, planWorkspaceRepairs) with no server/dist build needed,
   plus fs-fixture tests that drive the REAL, exported applyBookPlan and
   backupBeforeApply against a fake retireCharacterId/writeJsonAtomic (no
   server/dist import here either — only main()'s own dynamic import() of
   server/dist is left to a live run, per this repo's existing convention
   for this class of script).

   Do NOT re-implement applyBookPlan's body here and assert on the copy.
   That is what the first revision did, and a review proved it invisible to
   four separate mutations of the real function — including swapping
   retireCharacterId's last two arguments, which re-inflicts the exact A34
   defect this script exists to repair. A second implementation that happens
   to agree with the first is not coverage.

   Also covers ALLOW_STANDING_PORTS / parseStandingPorts, imported from
   repair-cast-id-drift.mjs: this script shares that liveness probe, and the
   port-skipping behaviour it inherits had no test of its own anywhere. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import {
  parseArgs,
  isAsciiKebabId,
  normaliseForMatch,
  planBookRepairs,
  planWorkspaceRepairs,
  applyBookPlan,
  backupBeforeApply,
  main,
} from '../repair-a34-wrong-direction-ids.mjs';
import { parseStandingPorts, probePortRangeRefused, AUTO_REBIND_RANGE } from '../repair-cast-id-drift.mjs';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: no --apply -> dry run', () => {
  assert.deepEqual(parseArgs([]), { apply: false });
});

test('parseArgs: --apply -> apply true', () => {
  assert.deepEqual(parseArgs(['--apply']), { apply: true });
});

// ---------------------------------------------------------------------------
// isAsciiKebabId
// ---------------------------------------------------------------------------

test('isAsciiKebabId: plain ascii kebab id -> true', () => {
  assert.equal(isAsciiKebabId('oduvan'), true);
  assert.equal(isAsciiKebabId('brann-wire'), true);
  assert.equal(isAsciiKebabId('unknown-male'), true);
});

test('isAsciiKebabId: non-ascii id -> false', () => {
  assert.equal(isAsciiKebabId('одуван'), false);
});

test('isAsciiKebabId: leading/trailing hyphen -> false', () => {
  assert.equal(isAsciiKebabId('-oduvan'), false);
  assert.equal(isAsciiKebabId('oduvan-'), false);
});

test('isAsciiKebabId: double hyphen -> false', () => {
  assert.equal(isAsciiKebabId('oduvan--wire'), false);
});

test('isAsciiKebabId: uppercase -> false (kebab ids are lowercase only)', () => {
  assert.equal(isAsciiKebabId('Oduvan'), false);
});

// ---------------------------------------------------------------------------
// normaliseForMatch — must stay behaviour-identical to server/src/util/text-match.ts
// ---------------------------------------------------------------------------

test('normaliseForMatch: lowercases and collapses whitespace', () => {
  assert.equal(normaliseForMatch('  Одуван   Петров  '), 'одуван петров');
});

test('normaliseForMatch: folds smart quotes and dashes', () => {
  // Smart quotes fold to ASCII quotes, em/en-dash to '-'; only the OUTER
  // edges are trimmed (of whitespace/quote chars) — an interior quote stays.
  assert.equal(normaliseForMatch('“Hello” — world'), 'hello" - world');
  // Edge-trimming only strips whitespace/quote chars, never '-' — so a
  // leading/trailing dash (unlike a leading/trailing quote above) survives.
  assert.equal(normaliseForMatch('— world —'), '- world -');
});

test('normaliseForMatch: same name, same result regardless of case', () => {
  assert.equal(normaliseForMatch('Одуван'), normaliseForMatch('одуван'));
});

/* Edge-trim class, pinned character by character.

   normaliseForMatch's isEdge regex writes its quote and backtick as \uXXXX
   escapes rather than literally, because an unpaired quote/backtick inside a
   regex literal desyncs the source scanner in
   server/src/spawn-windows-hide.test.ts, which fails loud on that shape for
   every file under scripts/ (#2747, closed by #2764). That rewrite is
   behaviour-preserving, and these cases are what makes that claim testable
   rather than prose: each of the four class members is asserted to be
   trimmed at BOTH edges, and one non-member is asserted to survive, so
   dropping or adding a member from the class turns one of them red.

   The '`' case is the one with no other coverage in this file at all: the
   smart-quote test above reaches '"' via folding and the whitespace test
   reaches \s, but nothing else exercises the backtick or a bare apostrophe. */
test('normaliseForMatch: edge-trim class strips whitespace, ", \u0027 and ` at both edges', () => {
  assert.equal(normaliseForMatch('\u0060oduvan\u0060'), 'oduvan');
  assert.equal(normaliseForMatch("'oduvan'"), 'oduvan');
  assert.equal(normaliseForMatch('"oduvan"'), 'oduvan');
  assert.equal(normaliseForMatch(' \toduvan\t '), 'oduvan');
  // Mixed, and repeated: the trim loops run until a non-member is reached.
  assert.equal(normaliseForMatch(' \u0060"\u0027oduvan\u0027"\u0060 '), 'oduvan');
});

test('normaliseForMatch: edge-trim class does NOT strip a non-member', () => {
  // '-' and '.' are deliberately outside the class; if either were added,
  // this goes red. Guards the "unchanged class" claim in the other
  // direction from the test above.
  assert.equal(normaliseForMatch('-oduvan-'), '-oduvan-');
  assert.equal(normaliseForMatch('.oduvan.'), '.oduvan.');
});

// ---------------------------------------------------------------------------
// planBookRepairs — the core detector
// ---------------------------------------------------------------------------

function bakIndex(entries) {
  const m = new Map();
  for (const [id, name] of entries) m.set(id, { name, ambiguous: false, distinctNames: [name] });
  return m;
}

test('planBookRepairs: correct direction detected and reversed', () => {
  const input = {
    liveCast: [{ id: 'одуван', name: 'Одуван' }],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' }]);
  assert.deepEqual(reportOnly, []);
});

test('planBookRepairs: a correctly-oriented (already-ASCII-live) entry is left untouched', () => {
  // ASCII -> ASCII (e.g. an id-format cleanup or a fold onto unknown-male) —
  // not the wrong-direction shape at all.
  const input = {
    liveCast: [{ id: 'unknown-male', name: 'Unknown' }],
    supersededBy: { pavel: 'unknown-male' },
    bakNameIndex: bakIndex([]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, []);
});

test('planBookRepairs: non-ASCII -> ASCII is the designed "genuine improvement" direction, left alone', () => {
  const input = {
    liveCast: [{ id: 'mairin', name: 'Mairin' }],
    supersededBy: { мэйрин: 'mairin' },
    bakNameIndex: bakIndex([]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, []);
});

test('planBookRepairs: wrong-direction shape but target id no longer live -> not actionable', () => {
  const input = {
    liveCast: [{ id: 'someone-else', name: 'Someone Else' }],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, []);
});

test('planBookRepairs: no bak evidence -> report-only, never auto-repaired', () => {
  const input = {
    liveCast: [{ id: 'одуван', name: 'Одуван' }],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: bakIndex([]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', reason: 'no-name-evidence' }]);
});

test('planBookRepairs: ambiguous bak evidence -> report-only, never auto-repaired', () => {
  const input = {
    liveCast: [{ id: 'одуван', name: 'Одуван' }],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: new Map([['oduvan', { name: undefined, ambiguous: true, distinctNames: ['одуван', 'кто-то'] }]]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', reason: 'no-name-evidence' }]);
});

test('planBookRepairs: bak name does not match live name -> report-only, not a false positive', () => {
  // Same id-shape, but the bak evidence says the ASCII id used to belong to
  // a DIFFERENT character than the one now living at the non-ASCII id — a
  // genuine Tier-3 alias merge, not the #2584 coincidence.
  const input = {
    liveCast: [{ id: 'борис-игнатьевич', name: 'Борис Игнатьевич' }],
    supersededBy: { shef: 'борис-игнатьевич' },
    bakNameIndex: bakIndex([['shef', 'Шеф']]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, [{ asciiId: 'shef', nonAsciiId: 'борис-игнатьевич', reason: 'name-mismatch' }]);
});

test('planBookRepairs: bakAvailable false withholds the pair even though the name index agrees', () => {
  /* #2135's fail-open shape, one script over. `collectBakNameEntries`
     returns `{entries, bakAvailable}`; `bakAvailable: false` means the
     directory could not be enumerated OR at least one cast.json.bak.* that
     EXISTS failed to parse. The unparseable file is swallowed to null and
     contributes zero entries, so buildNameIndex's `normSet.size > 1` reads
     the survivors as UNAMBIGUOUS — but the file it could not read might
     have named this very id something else. Evidence lost is not evidence
     of agreement. The sibling script gates on exactly this
     (repair-cast-id-drift.mjs:2605,2641); this one discarded the field. */
  const input = {
    liveCast: [{ id: 'одуван', name: 'Одуван' }],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
    bakAvailable: false,
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, [], 'lost bak evidence must never produce a confirmed repair');
  assert.deepEqual(reportOnly, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', reason: 'bak-evidence-unreadable' }]);
});

test('planBookRepairs: bakAvailable true (or absent) still confirms — the gate is not a blanket refusal', () => {
  const base = {
    liveCast: [{ id: 'одуван', name: 'Одуван' }],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
  };
  const expected = [{ asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' }];
  assert.deepEqual(planBookRepairs({ ...base, bakAvailable: true }).repairs, expected);
  // Absent is NOT read as false — a caller with no bak index at all already
  // gets `no-name-evidence` per id; only an explicit false means "lost".
  assert.deepEqual(planBookRepairs(base).repairs, expected);
});

test('planBookRepairs: two live rows share the confirmed name -> withheld, the tie rule is not optional', () => {
  /* resolveTierAName (repair-cast-id-drift.mjs:378-384) returns undefined on
     a tie, and its own comment forbids reintroducing a looser rule. Minor
     cast routinely shares a display name. Nothing on disk says WHICH
     "Солдат" the retired `soldier` was, and --apply would permanently bind
     the retired id, and every attribution behind it, to whichever row the
     history entry happened to point at — a different voiceUuid, so the
     mis-bound character renders in the wrong voice. */
  const input = {
    liveCast: [
      { id: 'soldier-one', name: 'Солдат', voiceUuid: 'VOICE-A' },
      { id: 'солдат', name: 'Солдат', voiceUuid: 'VOICE-B' },
    ],
    supersededBy: { soldier: 'солдат' },
    bakNameIndex: bakIndex([['soldier', 'Солдат']]),
    bakAvailable: true,
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, [], 'a shared display name cannot confirm which character the retired id was');
  assert.deepEqual(reportOnly, [{ asciiId: 'soldier', nonAsciiId: 'солдат', reason: 'live-name-not-unique' }]);
});

test('planBookRepairs: the tie is counted under normaliseForMatch, not raw equality', () => {
  // "солдат" vs " Солдат " fold to the same normalised name, so this is a
  // tie even though the raw strings differ. A census keyed on the raw name
  // would miss it.
  const input = {
    liveCast: [
      { id: 'soldier-one', name: ' Солдат ' },
      { id: 'солдат', name: 'солдат' },
    ],
    supersededBy: { soldier: 'солдат' },
    bakNameIndex: bakIndex([['soldier', 'Солдат']]),
    bakAvailable: true,
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, [{ asciiId: 'soldier', nonAsciiId: 'солдат', reason: 'live-name-not-unique' }]);
});

test('planBookRepairs: the ASCII id is somehow live too -> report-only, never a duplicate-id write', () => {
  /* Should not happen given retireCharacterId's invariants, but this script
     never assumes a file it did not write is well-formed. Turning this
     branch into a repair writes a cast.json with TWO rows carrying the id
     `oduvan`, which buildCastResolver's byId silently resolves to whichever
     came first. */
  const input = {
    liveCast: [
      { id: 'одуван', name: 'Одуван' },
      // A distinct name on purpose, so this test can only be about the
      // already-live branch and never about the uniqueness tie rule.
      { id: 'oduvan', name: 'Одуван Старший' },
    ],
    supersededBy: { oduvan: 'одуван' },
    bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
    bakAvailable: true,
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, [], 'never rename onto an id that is already live');
  assert.deepEqual(reportOnly, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', reason: 'ascii-id-already-live' }]);
});

test('planBookRepairs: empty supersededBy -> nothing to do', () => {
  const input = { liveCast: [{ id: 'одуван', name: 'Одуван' }], supersededBy: {}, bakNameIndex: bakIndex([]) };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, []);
  assert.deepEqual(reportOnly, []);
});

test('planBookRepairs: multiple entries in one book — only the wrong-direction, confirmed one is picked', () => {
  const input = {
    liveCast: [
      { id: 'одуван', name: 'Одуван' },
      { id: 'unknown-male', name: 'Unknown' },
      { id: 'mairin', name: 'Mairin' },
    ],
    supersededBy: {
      oduvan: 'одуван', // wrong-direction, confirmed
      pavel: 'unknown-male', // ascii->ascii, not this shape
      мэйрин: 'mairin', // non-ascii->ascii, designed direction
    },
    bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
  };
  const { repairs, reportOnly } = planBookRepairs(input);
  assert.deepEqual(repairs, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' }]);
  assert.deepEqual(reportOnly, []);
});

test('planBookRepairs: mutation guard — flipping the direction test misdetects', () => {
  // Pins the exact boolean the detector relies on: `from` ASCII AND `to`
  // NOT ASCII. A mutant that only checks `!isAsciiKebabId(asciiId)` (drops
  // the `to`-side check) would wrongly flag a bare id-format cleanup
  // (ascii -> ascii) as a repair candidate whenever the FIRST id also
  // happens to be ascii-kebab — which is every ascii->ascii entry. This
  // test reddens under that mutation.
  const input = {
    liveCast: [{ id: 'unknown-male', name: 'Someone' }],
    supersededBy: { pavel: 'unknown-male' },
    bakNameIndex: bakIndex([['pavel', 'Someone']]),
  };
  const { repairs } = planBookRepairs(input);
  assert.deepEqual(repairs, [], 'ascii -> ascii must never be treated as the wrong-direction shape');
});

// ---------------------------------------------------------------------------
// planWorkspaceRepairs — books with zero confirmed repairs are dropped
// ---------------------------------------------------------------------------

test('planWorkspaceRepairs: a book with no confirmed pair is excluded from bookPlans entirely', () => {
  const bookInputs = [
    {
      label: 'Book A',
      bookDir: '/books/a',
      castPath: '/books/a/.audiobook/cast.json',
      liveCast: [{ id: 'unknown-male', name: 'Unknown' }],
      supersededBy: { pavel: 'unknown-male' },
      bakNameIndex: bakIndex([]),
    },
    {
      label: 'Book B',
      bookDir: '/books/b',
      castPath: '/books/b/.audiobook/cast.json',
      liveCast: [{ id: 'одуван', name: 'Одуван' }],
      supersededBy: { oduvan: 'одуван' },
      bakNameIndex: bakIndex([['oduvan', 'Одуван']]),
    },
  ];
  const { bookPlans, reportOnly } = planWorkspaceRepairs(bookInputs);
  assert.equal(bookPlans.length, 1);
  assert.equal(bookPlans[0].book, 'Book B');
  assert.deepEqual(bookPlans[0].repairs, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' }]);
  assert.deepEqual(reportOnly, []);
});

test('planWorkspaceRepairs: report-only pairs are tagged with their book label', () => {
  const bookInputs = [
    {
      label: 'Book C',
      bookDir: '/books/c',
      castPath: '/books/c/.audiobook/cast.json',
      liveCast: [{ id: 'одуван', name: 'Одуван' }],
      supersededBy: { oduvan: 'одуван' },
      bakNameIndex: bakIndex([]),
    },
  ];
  const { bookPlans, reportOnly } = planWorkspaceRepairs(bookInputs);
  assert.deepEqual(bookPlans, []);
  assert.deepEqual(reportOnly, [{ asciiId: 'oduvan', nonAsciiId: 'одуван', reason: 'no-name-evidence', book: 'Book C' }]);
});

// ---------------------------------------------------------------------------
// Integration: dry-run makes no filesystem writes; --apply writes cast.json
// and calls retireCharacterId in the correct direction. Exercises main()'s
// write-side helpers via fs fixtures + a fake retireCharacterId/
// writeJsonAtomic (server/dist itself is not required for these tests —
// only main()'s dynamic import of it would need a build, and these tests
// call the exported plan/apply-shaped helpers directly instead).
// ---------------------------------------------------------------------------

/** Builds a minimal on-disk workspace fixture, shaped exactly like
 *  `collectBooks` expects: `<root>/books/<author>/<series>/<title>/.audiobook/
 *  {cast.json,state.json,cast-id-history.json,cast.json.bak.*}`. Returns the
 *  workspace root and the paths to the one book's cast.json/history file so
 *  a test can assert on them after calling `main()`. */
function buildFixtureWorkspace(tmp) {
  const bookDir = join(tmp, 'books', 'Author', 'Series', 'Title');
  const audiobookDir = join(bookDir, '.audiobook');
  mkdirSync(audiobookDir, { recursive: true });
  const castPath = join(audiobookDir, 'cast.json');
  const historyPath = join(audiobookDir, 'cast-id-history.json');
  const castBefore = { characters: [{ id: 'одуван', name: 'Одуван' }] };
  const historyBefore = { schema: 1, supersededBy: { oduvan: 'одуван' } };
  writeFileSync(castPath, JSON.stringify(castBefore));
  writeFileSync(join(audiobookDir, 'state.json'), JSON.stringify({ title: 'Title', chapters: [] }));
  writeFileSync(historyPath, JSON.stringify(historyBefore));
  writeFileSync(
    join(audiobookDir, 'cast.json.bak.castfix'),
    JSON.stringify({ characters: [{ id: 'oduvan', name: 'Одуван' }] }),
  );
  return { castPath, historyPath, castBefore, historyBefore };
}

test('main dry-run makes no filesystem writes (real collectBooks + detector, end to end)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-dry-'));
  try {
    const { castPath, historyPath, castBefore, historyBefore } = buildFixtureWorkspace(tmp);

    await main([], tmp);

    assert.equal(readFileSync(castPath, 'utf8'), JSON.stringify(castBefore));
    assert.equal(readFileSync(historyPath, 'utf8'), JSON.stringify(historyBefore));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main --apply refuses when a server is live on PORT — the liveness-probe blocks the write', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-liveness-'));
  const server = net.createServer();
  const prevPort = process.env.PORT;
  const prevLan = process.env.LAN_HTTPS_PORT;
  try {
    const { castPath, historyPath, castBefore, historyBefore } = buildFixtureWorkspace(tmp);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const livePort = server.address().port;
    // Point both probed ports at the live listener and its own auto-rebind
    // range floor so this test cannot accidentally land on a real free port
    // elsewhere on the box.
    process.env.PORT = String(livePort);
    process.env.LAN_HTTPS_PORT = String(livePort);

    await main(['--apply'], tmp);

    // Refused before ever loading server/dist or writing anything — the
    // probe's whole point (module doc comment) is that this must fire
    // before either file is touched.
    assert.equal(process.exitCode, 1, 'main must set a non-zero exit code on refusal');
    assert.equal(readFileSync(castPath, 'utf8'), JSON.stringify(castBefore), 'cast.json must be untouched');
    assert.equal(readFileSync(historyPath, 'utf8'), JSON.stringify(historyBefore), 'cast-id-history.json must be untouched');
  } finally {
    process.exitCode = 0;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevLan === undefined) delete process.env.LAN_HTTPS_PORT;
    else process.env.LAN_HTTPS_PORT = prevLan;
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmp, { recursive: true, force: true });
  }
});

/* Apply-path fixture. Drives the REAL, exported `applyBookPlan` — never a
   re-implementation of it. The first revision of this file copied
   `applyBookPlan`'s body inline and asserted on the copy; a review proved
   that four separate mutations to the real function (swapping
   `retireCharacterId`'s last two arguments, stubbing the whole function to
   `return;`, deleting the partial-repair refusal, and turning the
   ascii-id-already-live branch into a repair) all left the suite 27/27
   green. Every test below calls `applyBookPlan(plan, fakeMods)`. */
function buildApplyFixture(tmp, opts = {}) {
  const bookDir = join(tmp, 'book');
  const audiobookDir = join(bookDir, '.audiobook');
  mkdirSync(audiobookDir, { recursive: true });
  const castPath = join(audiobookDir, 'cast.json');
  const historyPath = join(audiobookDir, 'cast-id-history.json');
  const castBefore = opts.cast ?? {
    characters: [
      { id: 'одуван', name: 'Одуван', role: 'Мастер-кузнец', lines: 28 },
      { id: 'other', name: 'Other' },
    ],
  };
  const historyBefore = opts.history ?? { schema: 1, supersededBy: { oduvan: 'одуван' } };
  writeFileSync(castPath, JSON.stringify(castBefore));
  writeFileSync(historyPath, JSON.stringify(historyBefore));

  const calls = [];
  const fakeMods = {
    retireCharacterId: async (dir, from, to) => {
      calls.push({ op: 'retire', bookDir: dir, from, to });
      if (opts.retireThrows) throw new Error(opts.retireThrows);
    },
    writeJsonAtomic: async (p, value) => {
      calls.push({ op: 'write', path: p });
      writeFileSync(p, JSON.stringify(value));
    },
  };
  const plan = {
    book: 'Test Book',
    bookDir,
    castPath,
    repairs: opts.repairs ?? [{ asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' }],
  };
  return { bookDir, audiobookDir, castPath, historyPath, castBefore, historyBefore, calls, fakeMods, plan };
}

test('applyBookPlan: renames the cast.json id and retires non-ASCII -> ASCII (real function, not a copy)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-apply-'));
  try {
    const { castPath, calls, fakeMods, plan, bookDir } = buildApplyFixture(tmp);

    await applyBookPlan(plan, fakeMods);

    const written = JSON.parse(readFileSync(castPath, 'utf8'));
    assert.deepEqual(
      written.characters.find((c) => c.id === 'oduvan'),
      { id: 'oduvan', name: 'Одуван', role: 'Мастер-кузнец', lines: 28 },
      'the reinstated character keeps every other field untouched',
    );
    assert.equal(
      written.characters.some((c) => c.id === 'одуван'),
      false,
      'the non-ASCII id must not remain live after repair',
    );
    assert.deepEqual(written.characters.find((c) => c.id === 'other'), { id: 'other', name: 'Other' });

    /* The argument order is the whole point of this assertion. Swapping the
       last two arguments of the `retireCharacterId` call inside
       applyBookPlan does not merely fail to repair: it drives
       retireCharacterId's FORWARD branch instead of its direct-reversal
       branch and writes supersededBy["oduvan"] = "одуван" — re-inflicting
       the exact A34 defect this script exists to remove, on a book whose
       cast.json it has already rewritten. */
    assert.deepEqual(
      calls.filter((c) => c.op === 'retire'),
      [{ op: 'retire', bookDir, from: 'одуван', to: 'oduvan' }],
      'retireCharacterId(bookDir, nonAsciiId, asciiId) — retiring the non-ASCII id IN FAVOUR OF the ASCII one',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyBookPlan: writes cast-id-history BEFORE cast.json, so a part-way failure never orphans the live id', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-order-'));
  try {
    const { calls, fakeMods, plan } = buildApplyFixture(tmp);

    await applyBookPlan(plan, fakeMods);

    /* Order is a correctness argument, not taste (module doc comment).
       History first leaves the intermediate state "live id still non-ASCII,
       history says non-ASCII -> ASCII", where buildCastResolver hits the
       live id in byId exactly. Cast first leaves "live id ASCII, history
       still ASCII -> non-ASCII", where cast-resolve.ts:113-118 drops the
       entry (its target is no longer live) and normaliseIdKey does not
       transliterate — so every attribution pointing at the non-ASCII id
       becomes an orphan. */
    assert.deepEqual(
      calls.map((c) => c.op),
      ['retire', 'write'],
      'retireCharacterId must run before writeJsonAtomic(cast.json)',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyBookPlan: backs up cast.json AND cast-id-history.json before either write', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-backup-'));
  try {
    const { audiobookDir, fakeMods, plan, castBefore, historyBefore } = buildApplyFixture(tmp);

    const { backups } = await applyBookPlan(plan, fakeMods);

    assert.equal(backups.length, 2, 'both files get a pre-repair copy');
    const baks = readdirSync(audiobookDir).filter((f) => f.includes('.bak.a34-'));
    assert.equal(baks.length, 2, `expected 2 a34 backups, saw ${baks.join(', ')}`);
    const castBak = backups.find((p) => p.includes('cast.json.bak.a34-'));
    const histBak = backups.find((p) => p.includes('cast-id-history.json.bak.a34-'));
    assert.ok(castBak && histBak, 'one backup per file, each named after its own source');
    // The copies hold the PRE-repair content — that is what makes them an undo.
    assert.deepEqual(JSON.parse(readFileSync(castBak, 'utf8')), castBefore);
    assert.deepEqual(JSON.parse(readFileSync(histBak, 'utf8')), historyBefore);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyBookPlan: a throwing retireCharacterId surfaces as an error naming the backups, and cast.json stays unwritten', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-throw-'));
  try {
    const { castPath, castBefore, fakeMods, plan } = buildApplyFixture(tmp, {
      retireThrows: 'LockAcquisitionTimeoutError: cast-id-history:...',
    });

    await assert.rejects(
      () => applyBookPlan(plan, fakeMods),
      (err) => {
        assert.match(err.message, /repair failed part-way/);
        assert.match(err.message, /Pre-repair copies:/);
        assert.match(err.message, /cast\.json\.bak\.a34-/);
        assert.match(err.message, /cast-id-history\.json\.bak\.a34-/);
        return true;
      },
    );
    assert.equal(
      readFileSync(castPath, 'utf8'),
      JSON.stringify(castBefore),
      'the history write failed, so cast.json must not have been rewritten',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyBookPlan: refuses a partial repair — plan names an id cast.json no longer has', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-partial-'));
  try {
    // cast.json moved under us since planning: only ONE of the two planned
    // non-ASCII ids is still present.
    const { castPath, castBefore, calls, fakeMods, plan, audiobookDir } = buildApplyFixture(tmp, {
      cast: { characters: [{ id: 'одуван', name: 'Одуван' }] },
      repairs: [
        { asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' },
        { asciiId: 'soldier', nonAsciiId: 'солдат', name: 'Солдат' },
      ],
    });

    await assert.rejects(
      () => applyBookPlan(plan, fakeMods),
      /expected to rename 2 character\(s\), renamed 1 .* refusing to write a partial repair/s,
    );
    assert.deepEqual(calls, [], 'refuses before it writes or retires anything');
    assert.equal(readFileSync(castPath, 'utf8'), JSON.stringify(castBefore), 'cast.json untouched');
    assert.deepEqual(
      readdirSync(audiobookDir).filter((f) => f.includes('.bak.a34-')),
      [],
      'and before it even takes a backup — nothing was going to be written',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('applyBookPlan: a malformed cast.json at apply time is refused, not written over', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-malformed-'));
  try {
    const { castPath, calls, fakeMods, plan } = buildApplyFixture(tmp);
    writeFileSync(castPath, '{ not json');

    await assert.rejects(() => applyBookPlan(plan, fakeMods), /cast\.json missing or malformed at apply time/);
    assert.deepEqual(calls, []);
    assert.equal(readFileSync(castPath, 'utf8'), '{ not json');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('backupBeforeApply: returns null and copies nothing when the source does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-nobak-'));
  try {
    const missing = join(tmp, 'cast-id-history.json');
    assert.equal(backupBeforeApply(missing), null);
    assert.equal(existsSync(`${missing}.bak.a34-${new Date().toISOString().slice(0, 10)}`), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// PR #3057 review pass 2, correctness: a second run on the same day used to
// silently clobber the first run's pre-repair copy (date-only stamp, plain
// copyFileSync). This is the exact operator sequence the finding describes:
// run 1 dies part-way, leaving the source half-repaired; the operator (or an
// error message that reads like a transient lock timeout) retries the same
// day; run 2's backup must NOT become the half-repaired file overwriting the
// only genuine pre-repair copy.
test('backupBeforeApply: a same-day retry does not destroy the first run\'s pre-repair copy', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-retry-'));
  try {
    const filePath = join(tmp, 'cast.json');
    const preRepair = { pre: true, characters: ['original'] };
    writeFileSync(filePath, JSON.stringify(preRepair));

    const first = backupBeforeApply(filePath);
    assert.ok(first, 'first run makes a backup');
    assert.deepEqual(JSON.parse(readFileSync(first, 'utf8')), preRepair);

    // Simulate run 1 dying part-way through: the source is now half-repaired.
    const halfRepaired = { pre: false, characters: ['half-repaired'] };
    writeFileSync(filePath, JSON.stringify(halfRepaired));

    const second = backupBeforeApply(filePath);
    assert.ok(second, 'the retry also makes a backup');
    assert.notEqual(second, first, 'the retry must land at a distinct path, never the first run\'s path');

    assert.deepEqual(
      JSON.parse(readFileSync(first, 'utf8')),
      preRepair,
      "the FIRST run's pre-repair copy must still hold the original content after a same-day retry",
    );
    assert.deepEqual(JSON.parse(readFileSync(second, 'utf8')), halfRepaired);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A forced exact-timestamp collision (simulated via a deps.fs stub that
// throws EEXIST once) proves the retry-on-collision path itself, not just
// that two calls a few milliseconds apart happen to land on different
// stamps. Drives the real backupBeforeApply, not a reimplementation.
test('backupBeforeApply: an exact stamp collision retries to a distinct path instead of overwriting', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-collide-'));
  try {
    const filePath = join(tmp, 'cast.json');
    writeFileSync(filePath, JSON.stringify({ pre: true }));

    let attempts = 0;
    const fakeFs = {
      existsSync,
      copyFileSync: (src, dest, flags) => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('EEXIST: file already exists');
          err.code = 'EEXIST';
          throw err;
        }
        copyFileSync(src, dest, flags);
      },
    };

    const backupPath = backupBeforeApply(filePath, { fs: fakeFs });
    assert.ok(backupPath, 'succeeds after retrying past the simulated collision');
    assert.equal(attempts, 2, 'retried exactly once after the simulated EEXIST');
    assert.deepEqual(JSON.parse(readFileSync(backupPath, 'utf8')), { pre: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End to end through main(): the bakAvailable gate must survive the wiring,
// not just hold in planBookRepairs. Driven by a genuinely unparseable
// cast.json.bak.* on disk, exactly #2135's repro.
// ---------------------------------------------------------------------------

test('main dry-run: an unparseable cast.json.bak.* downgrades a would-be confirmed repair to report-only', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-corruptbak-'));
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const bookDir = join(tmp, 'books', 'Author', 'Series', 'Title');
    const audiobookDir = join(bookDir, '.audiobook');
    mkdirSync(audiobookDir, { recursive: true });
    writeFileSync(join(audiobookDir, 'cast.json'), JSON.stringify({ characters: [{ id: 'одуван', name: 'Одуван' }] }));
    writeFileSync(join(audiobookDir, 'state.json'), JSON.stringify({ title: 'Title', chapters: [] }));
    writeFileSync(join(audiobookDir, 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy: { oduvan: 'одуван' } }));
    // One good snapshot naming oduvan "Одуван" — on its own this confirms.
    writeFileSync(
      join(audiobookDir, 'cast.json.bak.castfix'),
      JSON.stringify({ characters: [{ id: 'oduvan', name: 'Одуван' }] }),
    );
    // ...and one truncated mid-JSON. Its real content could have named
    // oduvan anything, so the evidence for that id is UNKNOWN, not clean.
    writeFileSync(join(audiobookDir, 'cast.json.bak.2026-01-01'), '{"characters":[{"id":"oduvan","na');

    await main([], tmp);

    const out = lines.join('\n');
    assert.match(out, /bak-evidence-unreadable/, 'the lost-evidence reason must reach the operator');
    assert.doesNotMatch(out, /confirmed repairs: /, 'and nothing may be reported as confirmed');
  } finally {
    console.log = realLog;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// droppedBooks (PR #3057 review pass 2, same shape as C2/`bakAvailable`):
// collectBooks's second return field used to be destructured away here, so
// a book whose cast.json is present-but-unreadable vanished silently — its
// wrong-direction evidence was LOST, not merely absent, and the workspace
// still read as clean. Mirrors repair-cast-id-drift.mjs's own #2097/#2108
// handling of the same collectBooks output.
// ---------------------------------------------------------------------------

/** Same rationale as repair-cast-id-drift.test.mjs's own `findVerifiedFreeRange`
 *  (M5, independent review 2026-08-05): a hardcoded "high, unusual" base port
 *  is a guess, not a guarantee, on a shared CI/dev box. This proves a
 *  `rangeSize`-port CONSECUTIVE window is free by actually binding a real
 *  listener on every port in it, then releases them immediately before the
 *  probe under test runs. Not imported from that file because the helper
 *  isn't exported there — duplicated deliberately rather than exported
 *  speculatively for a single other caller. */
async function findVerifiedFreeRange(rangeSize, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const servers = [];
    try {
      for (let i = 0; i < rangeSize; i += 1) {
        const s = net.createServer();
        await new Promise((resolve, reject) => {
          s.once('error', reject);
          s.listen(base + i, host, resolve);
        });
        servers.push(s);
      }
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
      return base;
    } catch {
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(() => resolve()))));
    }
  }
  throw new Error(`could not find ${rangeSize} consecutive free ports after 25 attempts`);
}

/** One good, cleanly-scannable book, plus one book whose cast.json is
 *  truncated mid-JSON (present but unreadable — evidence LOST) alongside a
 *  cast-id-history.json carrying a wrong-direction entry. The broken book's
 *  wrong-direction pair can never be confirmed or repaired because its live
 *  cast can't even be read — that is exactly the finding: it must be NAMED
 *  as dropped, never silently absorbed into "0 confirmed pairs". */
function buildMixedGoodAndUnreadableWorkspace(tmp) {
  const goodDir = join(tmp, 'books', 'Author', 'Series', 'GoodBook', '.audiobook');
  mkdirSync(goodDir, { recursive: true });
  writeFileSync(join(goodDir, 'cast.json'), JSON.stringify({ characters: [{ id: 'other', name: 'Other' }] }));
  writeFileSync(join(goodDir, 'state.json'), JSON.stringify({ title: 'GoodBook', chapters: [] }));

  const brokenDir = join(tmp, 'books', 'Author', 'Series', 'BrokenBook', '.audiobook');
  mkdirSync(brokenDir, { recursive: true });
  const brokenCastPath = join(brokenDir, 'cast.json');
  const brokenHistoryPath = join(brokenDir, 'cast-id-history.json');
  writeFileSync(brokenCastPath, '{"characters":[{"id":"od'); // truncated mid-JSON
  writeFileSync(join(brokenDir, 'state.json'), JSON.stringify({ title: 'BrokenBook', chapters: [] }));
  writeFileSync(brokenHistoryPath, JSON.stringify({ schema: 1, supersededBy: { oduvan: 'одуван' } }));

  return { brokenCastPath, brokenHistoryPath };
}

test('main dry-run: a book with a present-but-unreadable cast.json is NAMED as dropped, not silently absorbed', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-unreadable-dry-'));
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    buildMixedGoodAndUnreadableWorkspace(tmp);

    await main([], tmp);

    const out = lines.join('\n');
    assert.match(out, /books DROPPED/, 'the dropped book must be surfaced, not silently discarded');
    assert.match(out, /BrokenBook/, 'the specific dropped book must be named');
  } finally {
    console.log = realLog;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main --apply: a book with a present-but-unreadable cast.json REFUSES the write, even though the good book has nothing to repair', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-unreadable-apply-'));
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const prevPort = process.env.PORT;
  const prevLan = process.env.LAN_HTTPS_PORT;
  try {
    const { brokenCastPath, brokenHistoryPath } = buildMixedGoodAndUnreadableWorkspace(tmp);
    const brokenCastBefore = readFileSync(brokenCastPath, 'utf8');
    const brokenHistoryBefore = readFileSync(brokenHistoryPath, 'utf8');

    // Two disjoint verified-free ranges so the liveness probe (which must
    // pass for this test to reach the collectBooks-driven refusal at all)
    // never reports a false live listener.
    const httpBase = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    const lanBase = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    process.env.PORT = String(httpBase);
    process.env.LAN_HTTPS_PORT = String(lanBase);

    await main(['--apply'], tmp);

    assert.equal(process.exitCode, 1, 'main must refuse rather than report a clean apply');
    const errOut = errors.join('\n');
    assert.match(errOut, /Refusing --apply/);
    assert.match(errOut, /BrokenBook/, 'the refusal must name which book is unreadable');
    // Never touched — refusal fires before any write, including to the
    // one broken book itself.
    assert.equal(readFileSync(brokenCastPath, 'utf8'), brokenCastBefore);
    assert.equal(readFileSync(brokenHistoryPath, 'utf8'), brokenHistoryBefore);
  } finally {
    console.error = realError;
    process.exitCode = 0;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevLan === undefined) delete process.env.LAN_HTTPS_PORT;
    else process.env.LAN_HTTPS_PORT = prevLan;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main dry-run: a zero-book workspace reads as "nothing was examined", distinguishable from "nothing to repair"', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-emptyws-'));
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    // No books/ directory at all — the emptiest possible workspace.
    await main([], tmp);

    const out = lines.join('\n');
    assert.match(out, /books scanned: 0/);
    assert.match(
      out,
      /WARNING: nothing was examined/,
      'a zero-book scan must call itself out, not read like an ordinary clean-zero count',
    );
    assert.match(out, /0 confirmed wrong-direction pairs — nothing to repair\./);
  } finally {
    console.log = realLog;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('main --apply: a zero-book workspace refuses rather than silently succeeding (E2 — the fourth #2097/#2108 helper wired in)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-emptyws-apply-'));
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const prevPort = process.env.PORT;
  const prevLan = process.env.LAN_HTTPS_PORT;
  try {
    // No books/ directory at all — the emptiest possible workspace.
    const httpBase = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    const lanBase = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    process.env.PORT = String(httpBase);
    process.env.LAN_HTTPS_PORT = String(lanBase);

    await main(['--apply'], tmp);

    assert.equal(process.exitCode, 1, 'must refuse --apply against a zero-book scan, not exit 0 having written nothing');
    const errOut = errors.join('\n');
    assert.match(errOut, /Refusing --apply/);
    assert.match(errOut, /0 books found/);
  } finally {
    console.error = realError;
    process.exitCode = 0;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevLan === undefined) delete process.env.LAN_HTTPS_PORT;
    else process.env.LAN_HTTPS_PORT = prevLan;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E1 (PR #3057 review): a present-but-unreadable cast-id-history.json used to
// read as "no history file" — readJsonSync collapsed ENOENT/EACCES/parse
// failure to one `null`, and supersededBy is the only thing planBookRepairs
// iterates, so a corrupt history silently produced zero repairs while still
// counting toward "books scanned". The reviewer's own control/probe pair
// (two fixtures differing only in whether cast-id-history.json is readable)
// is reproduced directly below.
// ---------------------------------------------------------------------------

test('main dry-run: control (history intact, confirmed repair) vs probe (same book, history truncated) are distinguishable', async () => {
  const control = mkdtempSync(join(tmpdir(), 'a34-repair-history-control-'));
  const probe = mkdtempSync(join(tmpdir(), 'a34-repair-history-probe-'));
  const realLog = console.log;
  try {
    buildFixtureWorkspace(control);
    const { historyPath } = buildFixtureWorkspace(probe);
    writeFileSync(historyPath, '{"schema":1,"supersededBy":{"oduvan"'); // truncated mid-JSON

    const controlLines = [];
    console.log = (...args) => controlLines.push(args.join(' '));
    await main([], control);
    const controlOut = controlLines.join('\n');

    const probeLines = [];
    console.log = (...args) => probeLines.push(args.join(' '));
    await main([], probe);
    const probeOut = probeLines.join('\n');

    // CONTROL: history readable, wrong-direction entry confirmed and reported.
    assert.match(controlOut, /confirmed repairs: 1/, 'control must find the confirmed pair');
    assert.doesNotMatch(controlOut, /books DROPPED/, 'control has nothing dropped');

    // PROBE: history truncated — must be NAMED as dropped, never silently
    // read as "this book has no history, therefore nothing to repair".
    assert.match(probeOut, /books DROPPED/, 'a book with unreadable history must be named as dropped');
    assert.match(probeOut, /cast-id-history\.json/);
    assert.match(probeOut, /0 confirmed wrong-direction pairs — nothing to repair\./);

    // The two outputs must actually differ — this is the reviewer's own
    // demonstrated defect: CONTROL and PROBE printed byte-identical
    // "0 confirmed..." / "1 confirmed..." framing with no distinguishing
    // line at all before this fix.
    assert.notEqual(controlOut, probeOut);
  } finally {
    console.log = realLog;
    rmSync(control, { recursive: true, force: true });
    rmSync(probe, { recursive: true, force: true });
  }
});

test('main --apply: a book with a present-but-unreadable cast-id-history.json REFUSES the write, even though its cast.json is otherwise fine', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-history-unreadable-apply-'));
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const prevPort = process.env.PORT;
  const prevLan = process.env.LAN_HTTPS_PORT;
  try {
    const { castPath, historyPath, castBefore } = buildFixtureWorkspace(tmp);
    writeFileSync(historyPath, '{"schema":1,"supersededBy":{"oduvan"'); // truncated mid-JSON
    const historyBeforeRaw = readFileSync(historyPath, 'utf8');

    const httpBase = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    const lanBase = await findVerifiedFreeRange(AUTO_REBIND_RANGE, '127.0.0.1');
    process.env.PORT = String(httpBase);
    process.env.LAN_HTTPS_PORT = String(lanBase);

    await main(['--apply'], tmp);

    assert.equal(process.exitCode, 1, 'main must refuse rather than report a clean apply on unreadable history');
    const errOut = errors.join('\n');
    assert.match(errOut, /Refusing --apply/);
    assert.match(errOut, /cast-id-history\.json/);
    // Never touched — refusal fires before any write.
    assert.equal(readFileSync(castPath, 'utf8'), JSON.stringify(castBefore));
    assert.equal(readFileSync(historyPath, 'utf8'), historyBeforeRaw);
  } finally {
    console.error = realError;
    process.exitCode = 0;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevLan === undefined) delete process.env.LAN_HTTPS_PORT;
    else process.env.LAN_HTTPS_PORT = prevLan;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ALLOW_STANDING_PORTS — the liveness probe's port-skipping opt-in, shared
// with repair-cast-id-drift.mjs's main(). Previously a hardcoded
// `new Set([8090])`, which is this repo's OWN worktree slot-1 PORT
// (scripts/tests/wt-new.test.mjs:83) and sits inside the default 8080
// auto-rebind walk — so the exception blinded an apply-time safety probe to
// a port a real Castwright server binds. Nothing covered it.
// ---------------------------------------------------------------------------

test('parseStandingPorts: empty/unset -> no port is skipped', () => {
  assert.deepEqual([...parseStandingPorts(undefined)], []);
  assert.deepEqual([...parseStandingPorts('')], []);
  assert.deepEqual([...parseStandingPorts('  ,  ')], []);
});

test('parseStandingPorts: 8090 is NOT skipped by default — it is this repo\u0027s slot-1 PORT', () => {
  assert.equal(parseStandingPorts(undefined).has(8090), false);
  assert.equal(parseStandingPorts('8090').has(8090), true, 'only an explicit per-run opt-in skips it');
});

test('parseStandingPorts: parses a list, ignores out-of-range and junk tokens (fail closed = probe it)', () => {
  assert.deepEqual([...parseStandingPorts('8090, 9000')], [8090, 9000]);
  // A typo must fall back to PROBING the port, never to skipping something.
  assert.deepEqual([...parseStandingPorts('80090')], []);
  assert.deepEqual([...parseStandingPorts('abc')], []);
  assert.deepEqual([...parseStandingPorts('0')], []);
  assert.deepEqual([...parseStandingPorts('-1')], []);
  assert.deepEqual([...parseStandingPorts('8090.5')], []);
});

test('probePortRangeRefused: a live listener inside the range is reported by default, and skipped only when opted out', async () => {
  const server = net.createServer();
  const prev = process.env.ALLOW_STANDING_PORTS;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const livePort = server.address().port;
    // Start the probe a few ports below the listener so the listener sits
    // INSIDE the auto-rebind walk rather than at its floor — the #2090 shape.
    const startPort = Math.max(1, livePort - 3);

    delete process.env.ALLOW_STANDING_PORTS;
    const seen = await probePortRangeRefused(startPort, '127.0.0.1');
    assert.ok(
      seen.includes(livePort),
      `default probe must see the live listener on ${livePort}; saw ${JSON.stringify(seen)}`,
    );

    process.env.ALLOW_STANDING_PORTS = String(livePort);
    const opted = await probePortRangeRefused(startPort, '127.0.0.1');
    assert.equal(opted.includes(livePort), false, 'an explicitly opted-out port is skipped');
  } finally {
    if (prev === undefined) delete process.env.ALLOW_STANDING_PORTS;
    else process.env.ALLOW_STANDING_PORTS = prev;
    await new Promise((resolve) => server.close(resolve));
  }
});
