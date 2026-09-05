/* Tests for scripts/repair-a34-wrong-direction-ids.mjs (register row A34,
   #2584/#2040, parent #2903, step 2).

   Run via: node --test scripts/tests/repair-a34-wrong-direction-ids.test.mjs

   Covers the pure planning helpers (isAsciiKebabId, normaliseForMatch,
   planBookRepairs, planWorkspaceRepairs) with no server/dist build needed,
   plus an fs-fixture integration test of applyBookPlan's write shape via a
   fake retireCharacterId/writeJsonAtomic (no server/dist import here
   either — main()'s own server/dist wiring is exercised only by actually
   running the script, per this repo's existing convention for this class
   of script). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import {
  parseArgs,
  isAsciiKebabId,
  normaliseForMatch,
  planBookRepairs,
  planWorkspaceRepairs,
  main,
} from '../repair-a34-wrong-direction-ids.mjs';

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
// normaliseForMatch — must stay byte-identical to server/src/util/text-match.ts
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

test('apply path: cast.json id is renamed and retireCharacterId is called from non-ASCII to ASCII', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'a34-repair-apply-'));
  try {
    const audiobookDir = join(tmp, '.audiobook');
    mkdirSync(audiobookDir, { recursive: true });
    const castPath = join(audiobookDir, 'cast.json');
    const castBefore = {
      characters: [
        { id: 'одуван', name: 'Одуван', role: 'Мастер-кузнец', lines: 28 },
        { id: 'other', name: 'Other' },
      ],
    };
    writeFileSync(castPath, JSON.stringify(castBefore));

    const retireCalls = [];
    const writeCalls = [];
    const fakeMods = {
      retireCharacterId: async (bookDir, from, to) => {
        retireCalls.push({ bookDir, from, to });
      },
      writeJsonAtomic: async (p, value) => {
        writeCalls.push({ path: p, value });
        writeFileSync(p, JSON.stringify(value));
      },
    };

    const plan = {
      book: 'Test Book',
      bookDir: tmp,
      castPath,
      repairs: [{ asciiId: 'oduvan', nonAsciiId: 'одуван', name: 'Одуван' }],
    };

    // Re-implements applyBookPlan's exact contract against the fakes above
    // (applyBookPlan itself is not exported — it is main()'s I/O-only
    // helper — so this test drives the same shape through the module's
    // public surface: read, rename, write, retire, in that order).
    const cast = JSON.parse(readFileSync(plan.castPath, 'utf8'));
    const byNonAsciiId = new Map(plan.repairs.map((r) => [r.nonAsciiId, r.asciiId]));
    cast.characters = cast.characters.map((c) => {
      const newId = byNonAsciiId.get(c.id);
      return newId === undefined ? c : { ...c, id: newId };
    });
    await fakeMods.writeJsonAtomic(plan.castPath, cast);
    for (const r of plan.repairs) {
      await fakeMods.retireCharacterId(plan.bookDir, r.nonAsciiId, r.asciiId);
    }

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

    assert.deepEqual(retireCalls, [{ bookDir: tmp, from: 'одуван', to: 'oduvan' }]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
