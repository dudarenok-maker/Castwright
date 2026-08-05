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

/* #2123 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the lock-detector
   test at the bottom of this file can intercept this route's OWN in-lock
   `readJson(cast.json)` call. Defaults to a plain passthrough — every other
   test in this file behaves exactly as if this mock weren't here. Same
   idiom as the `scan.js` mock above and as voices.test.ts's /
   book-state.reparse.test.ts's own #1981 race tests. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
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

  const { castNotLinkedToRouter } = await import('./cast-not-linked-to.js');
  const { makeBookId } = await import('../workspace/paths.js');
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
    let responses: [{ status: number }, { status: number }] | undefined;
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
        ]).then((r) => {
          responses = r as [{ status: number }, { status: number }];
          return 'settled';
        }),
        new Promise((r) => setTimeout(() => r('DEADLOCK'), 2000)),
      ]);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.findBookByBookId);
    }
    expect(result).toBe('settled');

    /* #1981 fix-round Finding 3 — 'settled' alone doesn't rule out both
       requests 500ing after their second book lookup (the barrier only
       guarantees both reached that lookup, not that either succeeded).
       Assert the HTTP status AND that both sides of the symmetric pair
       actually landed on disk. Both calls write the SAME symmetric pair
       (just with source/other swapped), so the outcome is deterministic
       regardless of which request's critical section the lock let run
       first — appendNotLinked is idempotent, so the second call's write is
       a no-op once the first has already recorded the pair. */
    expect(responses?.[0].status).toBe(200);
    expect(responses?.[1].status).toBe(200);
    const wrenKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    const wrenExile = readCast(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    expect(wrenKeeper?.notLinkedTo).toEqual([{ bookId: exileBookId, characterId: 'wren' }]);
    expect(wrenExile?.notLinkedTo).toEqual([{ bookId: keeperBookId, characterId: 'wren' }]);
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

/* #2123 (srv-87) — cast-not-linked-to.ts was the only cast-lock-sweep site
   with no BEHAVIOURAL lock detector: the #1981 AB/BA test above defends
   ordering (a lock-order inversion), not the lock's existence — neutralise
   `withCastLocks` down to `return fn();`, or keep the wrapper in place but
   hoist `sourceCast`'s read back outside it (a rule-2 regression, the exact
   shape that bit library-cast-override.ts on this branch), and that test
   stays green either way.

   The racer here is a genuine `withCastLocks([bookDir], ...)` writer — the
   SAME primitive this route calls, not a different one (`withCastLock`
   singular has no reduceRight chain to bypass and this route never calls
   it) — touching a field this route never reads: `narrator.raceProbe`.
   Orthogonal by construction, so its survival (or loss) is a clean signal
   independent of the route's own notLinkedTo bookkeeping.

   The target's IN-LOCK read of `sourceCast` is gated via the hoisted
   `vi.mock` on state-io.js above — real bytes are read immediately (so the
   interception genuinely happens-before the racer's write), only the
   JS-visible resolution is held open. Firing the racer only once THAT read
   is confirmed intercepted matters: gating an earlier, outer read (e.g. one
   of the pre-lock `findBookByBookId` lookups) lets the racer finish before
   the target ever asks for its lock, which passes even with the lock
   primitive neutralised — a placebo. This construction catches both
   mutations without needing two separate tests:

   - Correct code: the target already holds the real per-key mutex on the
     keeper book when its read is intercepted, so the racer's own
     `withCastLocks` call queues behind it and only runs (re-reading FRESH
     bytes) after the target's write has landed and released the lock. Both
     changes survive.
   - Lock neutralised: the target's held-open read no longer implies any
     real mutex, so the racer — going through the same neutralised
     primitive — runs unimpeded during the gate window; the target then
     writes its STALE pre-racer snapshot back over it, and the racer's field
     is lost.
   - Read hoisted outside a retained lock: the target's read fires (and gets
     intercepted) before it ever calls `withCastLocks`, so no mutex is held
     yet; the racer acquires the real, unmutated lock uncontested and
     completes; the target then acquires the lock late and writes back its
     stale (pre-racer) snapshot, clobbering the racer's field the same way. */
describe('#2123 — cast.json lock is real, and its read stays inside it', () => {
  it('a concurrent withCastLocks writer on the same book survives a not-linked-to POST', async () => {
    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const { withCastLocks } = await import('../workspace/cast-lock.js');
    const keeperBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, KEEPER_BOOK);
    const keeperCastPath = castJsonPath(keeperBookDir);

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (!intercepted && path === keeperCastPath) {
        intercepted = true;
        const value = await actual.readJson(path); // real bytes, now — happens-before the racer's write
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    // Bypasses the spy entirely (uses `actual` directly) so the racer's own
    // read/write are never accidentally re-intercepted — it's a plain,
    // faithful `withCastLocks` consumer, same as any other real route.
    async function raceWrite(): Promise<void> {
      await withCastLocks([keeperBookDir], async () => {
        const cast = await actual.readJson<{
          characters: Array<Record<string, unknown>>;
        }>(keeperCastPath);
        const narrator = cast!.characters.find((c) => c.id === 'narrator')!;
        (narrator as Record<string, unknown>).raceProbe = 'concurrent-writer-survived';
        await actual.writeJsonAtomic(keeperCastPath, { characters: cast!.characters });
      });
    }

    let targetPromise: ReturnType<typeof callNotLinked> | undefined;
    let racePromise: Promise<void> | undefined;
    try {
      targetPromise = callNotLinked(keeperBookId, 'wren', {
        otherBookId: exileBookId,
        otherCharacterId: 'wren',
      });
      targetPromise.catch(() => {}); // supertest is lazy — force real dispatch now

      // Poll rather than a fixed sleep — same precedent as voices.test.ts's
      // and book-state.reparse.test.ts's own #1981 races.
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      racePromise = raceWrite();
      // Generous head start: completes fully when unlocked (the bug
      // window), or queues behind the target's held lock when locked (the
      // fix) — either way nothing depends on tuning a tight timing window.
      await new Promise((r) => setTimeout(r, 80));

      released();
      const [targetRes] = await Promise.all([targetPromise, racePromise]);
      expect(targetRes.status).toBe(200);
    } finally {
      // Idempotent: also fires here so a throw ANYWHERE above (before the
      // happy-path call) still releases a held `readJson` rather than
      // leaving it stuck on `await gate` forever. Resolving an
      // already-resolved promise a second time is a no-op.
      released();
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
      // On the failure path (an assertion above threw) these are still
      // in-flight — await them so the test can't return while either is
      // still running against fixtures `afterAll` is about to delete.
      await Promise.allSettled([targetPromise, racePromise]);
    }

    const wrenKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'wren',
    );
    expect(wrenKeeper?.notLinkedTo).toEqual([{ bookId: exileBookId, characterId: 'wren' }]);

    const narratorKeeper = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'narrator',
    );
    expect(narratorKeeper?.raceProbe).toBe('concurrent-writer-survived');
  });
});
