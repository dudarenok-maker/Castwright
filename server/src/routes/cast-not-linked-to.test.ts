/* Integration tests for the cast/:characterId/not-linked-to router (plan 101).

   Seeds two the Hollow Tide books on disk: book A ("The Hollow Tide")
   with a "wren" character, book B ("The Ebb") with a "wren" character
   that the analyzer named the same way but is intentionally a separate
   variant. The tests assert:

   - Symmetric pair-write: after success, both books' cast.json carry
     the matching entry in their `notLinkedTo` arrays.
   - Idempotency: re-calling the same body is a no-op.
   - 400 on missing body, self-pair, same-bookId.
   - 404 on unknown book, unknown character, cross-series, standalone.

   Same lazy-import pattern as cast-link-prior.test.ts so WORKSPACE_DIR
   is set before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* #1981 (Task 8) — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the AB/BA
   deadlock test at the bottom of this file can deterministically intercept
   this route's OWN `findBookByBookId` calls (bound at scan.js's own
   module-load time). Defaults to a plain passthrough — every other test in
   this file behaves exactly as if this mock weren't here. See that test's
   own header comment for why a bare `Promise.all` of two live requests
   can't reliably exercise this path (going from "outer lock acquired" to
   "inner lock requested" is a same-tick microtask with no code seam of its
   own to hold open — a race at the HTTP layer almost always lets one
   request win outright before the other even asks for its first lock). */
vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return { ...actual, findBookByBookId: vi.fn(actual.findBookByBookId) };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const KEEPER_BOOK = 'The Hollow Tide';
const EXILE_BOOK = 'The Ebb';
const OTHER_BOOK = 'Other Series Book';
const STANDALONE = 'Some Standalone';

let workspaceRoot: string;
let app: Express;
let keeperBookId: string;
let exileBookId: string;
let otherBookId: string;
let standaloneBookId: string;

const initialKeeperCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'wren',
    name: 'Wren Sparrow',
    role: 'character',
    color: 'unset',
    voiceId: 'v_wren_the Hollow Tide',
  },
];

const initialExileCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'wren',
    name: 'Wren',
    role: 'character',
    color: 'unset',
    voiceId: 'v_wren_exile',
  },
];

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  opts: { isStandalone?: boolean } = {},
) {
  const dir = join(workspace, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: opts.isStandalone === true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return dir;
}

function readCast(
  workspace: string,
  author: string,
  series: string,
  title: string,
): { characters: Array<Record<string, unknown>> } {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-not-linked-to-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castNotLinkedToRouter }, { makeBookId }] = await Promise.all([
    import('./cast-not-linked-to.js'),
    import('../workspace/paths.js'),
  ]);
  keeperBookId = makeBookId(AUTHOR, SERIES, KEEPER_BOOK);
  exileBookId = makeBookId(AUTHOR, SERIES, EXILE_BOOK);
  otherBookId = makeBookId(AUTHOR, 'Different Series', OTHER_BOOK);
  standaloneBookId = makeBookId(AUTHOR, SERIES, STANDALONE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castNotLinkedToRouter);
});

beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, initialKeeperCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK, exileBookId, initialExileCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, 'Different Series', OTHER_BOOK, otherBookId, [
    { id: 'unrelated', name: 'Unrelated', role: 'character', color: 'unset' },
  ]);
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    STANDALONE,
    standaloneBookId,
    [{ id: 'lonely', name: 'Lonely', role: 'character', color: 'unset' }],
    { isStandalone: true },
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callNotLinked(bookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/${characterId}/not-linked-to`)
    .set('Content-Type', 'application/json')
    .send(body);
}

function callUnmark(bookId: string, characterId: string, body: object) {
  return request(app)
    .delete(`/api/books/${bookId}/cast/${characterId}/not-linked-to`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/:characterId/not-linked-to', () => {
  it('rejects when body fields are missing', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects same-bookId pair', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {
      otherBookId: keeperBookId,
      otherCharacterId: 'narrator',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cross-book/i);
  });

  it('rejects self-pair', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {
      otherBookId: keeperBookId,
      otherCharacterId: 'wren',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 on cross-series pair', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {
      otherBookId,
      otherCharacterId: 'unrelated',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when other book is a standalone', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {
      otherBookId: standaloneBookId,
      otherCharacterId: 'lonely',
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when source character is unknown', async () => {
    const res = await callNotLinked(keeperBookId, 'missing', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source character/i);
  });

  it('returns 404 when other character is unknown', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/other character/i);
  });

  it('writes a symmetric pair record to both cast.json files', async () => {
    const res = await callNotLinked(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pair: {
        a: { bookId: keeperBookId, characterId: 'wren' },
        b: { bookId: exileBookId, characterId: 'wren' },
      },
    });

    const wrenKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    const wrenExile = readCast(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    expect(wrenKeeper?.notLinkedTo).toEqual([{ bookId: exileBookId, characterId: 'wren' }]);
    expect(wrenExile?.notLinkedTo).toEqual([{ bookId: keeperBookId, characterId: 'wren' }]);
  });

  it('is idempotent: a repeat call does not duplicate the array entries', async () => {
    await callNotLinked(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    const before = {
      keeper: readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK),
      exile: readCast(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK),
    };
    const res2 = await callNotLinked(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    const after = {
      keeper: readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK),
      exile: readCast(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK),
    };
    expect(res2.status).toBe(200);
    expect(after).toEqual(before);
  });

  /* #1981 (Task 8) — this route now holds withCastLocks([source, other])
     across its read-through-write span, sorted so a concurrent call with
     the two books in opposite roles can't AB/BA the promise-chain mutex.

     A bare `Promise.all` of the two live requests (no scripting) turns out
     NOT to exercise this reliably: going from "outer lock granted" to
     "inner lock requested" inside withCastLocks's reduceRight chain is a
     same-tick microtask with no application code — and no seam to hold
     open — in between, so whichever request's preamble (two real
     `findBookByBookId` disk reads) happens to finish first typically wins
     BOTH its lock acquisitions before the second request even asks for its
     first. Verified empirically: with `withCastLocks`'s `.sort()` removed,
     a bare-`Promise.all` version of this test still passed 5/5 runs — a
     placebo that would never catch a real regression.

     Instead, script the interleaving deterministically: intercept BOTH
     requests' SECOND `findBookByBookId` call (each request's `otherBookId`
     lookup — the one immediately preceding withCastLocks) and hold each
     one's resolution open until BOTH have arrived. Because the fixture
     books are the same two ids in swapped roles, the second-ever lookup of
     `keeperBookId` is deterministically call2's "other" lookup, and the
     second-ever lookup of `exileBookId` is deterministically call1's
     "other" lookup — true regardless of which physical request reaches
     that point first. Once both are waiting, release both at once: their
     continuations resume back-to-back on the microtask queue (JS drains
     one fully, through its outer lock's synchronous registration and up to
     its own first internal await, before starting the next) — the exact
     mechanics cast-lock.test.ts's own AB/BA test relies on when it calls
     `withCastLocks` directly, reproduced here through the real route. No
     external timeout is needed to trigger the release (the barrier is
     self-releasing once both arrive); the outer `Promise.race` only exists
     to catch an actual deadlock, per the module header's mock rationale. */
  it('#1981 — two concurrent calls with the books in opposite argument order do not deadlock', async () => {
    const scan = await import('../workspace/scan.js');
    const actual = await vi.importActual<typeof import('../workspace/scan.js')>(
      '../workspace/scan.js',
    );
    const seen: Record<string, number> = {};
    let arrived = 0;
    let releaseBoth!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const spy = vi.mocked(scan.findBookByBookId).mockImplementation(async (id: string) => {
      seen[id] = (seen[id] ?? 0) + 1;
      const isOtherLookup =
        seen[id] === 2 && (id === keeperBookId || id === exileBookId);
      const result = await actual.findBookByBookId(id); // real read, now
      if (isOtherLookup) {
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await gate; // hold the RESOLUTION open until both requests arrive
      }
      return result;
    });

    let result: unknown;
    try {
      result = await Promise.race([
        Promise.all([
          callNotLinked(keeperBookId, 'wren', {
            otherBookId: exileBookId,
            otherCharacterId: 'wren',
          }),
          callNotLinked(exileBookId, 'wren', {
            otherBookId: keeperBookId,
            otherCharacterId: 'wren',
          }),
        ]).then(() => 'settled'),
        new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000)),
      ]);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.findBookByBookId);
    }
    expect(result).toBe('settled');
  });
});

describe('DELETE /api/books/:bookId/cast/:characterId/not-linked-to (fs-11)', () => {
  it('removes the symmetric pair from BOTH cast.json files', async () => {
    /* Mark first, then unmark. */
    await callNotLinked(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    const res = await callUnmark(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pair: {
        a: { bookId: keeperBookId, characterId: 'wren' },
        b: { bookId: exileBookId, characterId: 'wren' },
      },
    });
    const wrenKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    const wrenExile = readCast(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    expect(wrenKeeper?.notLinkedTo).toEqual([]);
    expect(wrenExile?.notLinkedTo).toEqual([]);
  });

  it('is idempotent: deleting an absent pair is a 200 no-op', async () => {
    const res = await callUnmark(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    expect(res.status).toBe(200);
    const wrenKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    /* No notLinkedTo written (never marked) — field absent or empty. */
    expect(wrenKeeper?.notLinkedTo ?? []).toEqual([]);
  });

  it('removes the entry only on the side that has it (asymmetric on-disk start)', async () => {
    /* Simulate a half-state where only the keeper side carries the entry
       (e.g. a prior failed symmetric write). DELETE still settles both. */
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, KEEPER_BOOK);
    const cast = JSON.parse(readFileSync(join(dir, '.audiobook', 'cast.json'), 'utf8'));
    cast.characters.find((c: { id: string }) => c.id === 'wren').notLinkedTo = [
      { bookId: exileBookId, characterId: 'wren' },
    ];
    writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify(cast));
    const res = await callUnmark(keeperBookId, 'wren', {
      otherBookId: exileBookId,
      otherCharacterId: 'wren',
    });
    expect(res.status).toBe(200);
    const wrenKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    expect(wrenKeeper?.notLinkedTo).toEqual([]);
  });

  it('rejects same-bookId and self-pair', async () => {
    const sameBook = await callUnmark(keeperBookId, 'wren', {
      otherBookId: keeperBookId,
      otherCharacterId: 'narrator',
    });
    expect(sameBook.status).toBe(400);
    const selfPair = await callUnmark(keeperBookId, 'wren', {
      otherBookId: keeperBookId,
      otherCharacterId: 'wren',
    });
    expect(selfPair.status).toBe(400);
  });

  it('returns 404 on cross-series / standalone other book', async () => {
    const crossSeries = await callUnmark(keeperBookId, 'wren', {
      otherBookId,
      otherCharacterId: 'unrelated',
    });
    expect(crossSeries.status).toBe(404);
    const standalone = await callUnmark(keeperBookId, 'wren', {
      otherBookId: standaloneBookId,
      otherCharacterId: 'lonely',
    });
    expect(standalone.status).toBe(404);
  });
});
