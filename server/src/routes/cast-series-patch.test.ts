/* Integration tests for the cast-series-patch router (BACKLOG #7).

   Seeds three series-mate books with the same recurring character
   (Wren) and a separate alias-only book whose Wren row is named
   "Foster" with alias "Wren". Asserts:

   - Patch propagates to every series-mate cast.json that contains a
     matching character row (matched by the plan-94 dedup name/alias rule).
   - Standalone book — propagation is a no-op; only the source is touched.
   - Cross-series book is left alone.
   - Unknown body field / empty body / unknown ids return 400 / 404.
   - One sibling's write failure surfaces in `failed` with 207.

   Same lazy-import pattern as the sibling route tests so WORKSPACE_DIR
   is set before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const KEEPER_BOOK = 'The Hollow Tide';
const EXILE_BOOK = 'The Ebb';
const TIDEWATCHER_BOOK = 'The Tidewatcher’s Oath';
const ALIAS_BOOK = 'Saltgrave';
const OTHER_SERIES_BOOK = 'Different Series Book';
const STANDALONE = 'Some Standalone';

let workspaceRoot: string;
let app: Express;
let keeperBookId: string;
let exileBookId: string;
let tidewatcherBookId: string;
let aliasBookId: string;
let otherSeriesBookId: string;
let standaloneBookId: string;

const wrenKeeper = {
  id: 'wren',
  name: 'Wren',
  role: 'character',
  color: 'lilac',
  gender: 'female',
  ageRange: 'teen',
  tone: { warmth: 50, pace: 50, authority: 50, emotion: 50 },
};
const wrenExile = {
  id: 'wren-sparrow',
  name: 'Wren',
  role: 'character',
  color: 'lilac',
  gender: 'female',
  ageRange: 'teen',
};
const wrenTidewatcher = {
  id: 'wren-e',
  name: 'Wren',
  role: 'character',
  color: 'lilac',
};
/* In this book Wren is recorded as "Foster" (the surname-only nickname)
   with "Wren" as an alias — exercises the alias-match dedup branch. */
const wrenAliasBook = {
  id: 'foster',
  name: 'Foster',
  role: 'character',
  color: 'lilac',
  aliases: ['Wren'],
};
const hartKeeper = {
  id: 'hart',
  name: 'Hart',
  role: 'character',
  color: 'amber',
  voiceId: 'v_hart',
};
const unrelatedCharacter = {
  id: 'unrelated',
  name: 'Unrelated',
  role: 'character',
  color: 'unset',
};
const lonelyStandalone = {
  id: 'lonely',
  name: 'Lonely',
  role: 'character',
  color: 'unset',
};

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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-series-patch-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castSeriesPatchRouter }, { makeBookId }] = await Promise.all([
    import('./cast-series-patch.js'),
    import('../workspace/paths.js'),
  ]);
  keeperBookId = makeBookId(AUTHOR, SERIES, KEEPER_BOOK);
  exileBookId = makeBookId(AUTHOR, SERIES, EXILE_BOOK);
  tidewatcherBookId = makeBookId(AUTHOR, SERIES, TIDEWATCHER_BOOK);
  aliasBookId = makeBookId(AUTHOR, SERIES, ALIAS_BOOK);
  otherSeriesBookId = makeBookId(AUTHOR, 'Different Series', OTHER_SERIES_BOOK);
  standaloneBookId = makeBookId(AUTHOR, SERIES, STANDALONE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castSeriesPatchRouter);
});

beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, [
    wrenKeeper,
    hartKeeper,
  ]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK, exileBookId, [wrenExile]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, TIDEWATCHER_BOOK, tidewatcherBookId, [
    wrenTidewatcher,
  ]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, ALIAS_BOOK, aliasBookId, [wrenAliasBook]);
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    'Different Series',
    OTHER_SERIES_BOOK,
    otherSeriesBookId,
    [
      /* Same name "Wren" but a different series — must NOT be touched
         by a same-series patch. Locks the (author, series) scope guard. */
      { id: 'wren-other', name: 'Wren', role: 'character', color: 'unset' },
      unrelatedCharacter,
    ],
  );
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    STANDALONE,
    standaloneBookId,
    [lonelyStandalone],
    { isStandalone: true },
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callPatch(bookId: string, characterId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/${characterId}/series-patch`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/:characterId/series-patch', () => {
  it('rejects an empty patch body with 400', async () => {
    const res = await callPatch(keeperBookId, 'wren', {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one field/i);
  });

  it('rejects an unknown body key with 400', async () => {
    const res = await callPatch(keeperBookId, 'wren', { voiceId: 'v_new' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid patch body/i);
  });

  it('rejects an out-of-range tone axis with 400', async () => {
    const res = await callPatch(keeperBookId, 'wren', { tone: { warmth: 999 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid patch body/i);
  });

  it('returns 404 for an unknown bookId', async () => {
    const res = await callPatch('nope', 'wren', { gender: 'female' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 for a characterId that does not exist in the source book', async () => {
    const res = await callPatch(keeperBookId, 'missing', { gender: 'female' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('propagates the patch to all series-mate books containing the same-named character', async () => {
    const res = await callPatch(keeperBookId, 'wren', {
      gender: 'female',
      ageRange: 'teen',
      tone: { warmth: 80 },
    });
    expect(res.status).toBe(200);
    expect(res.body.failed).toEqual([]);
    const updatedBookIds = (res.body.updated as Array<{ bookId: string }>).map((u) => u.bookId);
    expect(updatedBookIds).toContain(keeperBookId);
    expect(updatedBookIds).toContain(exileBookId);
    expect(updatedBookIds).toContain(tidewatcherBookId);
    expect(updatedBookIds).toContain(aliasBookId);
    expect(updatedBookIds).not.toContain(otherSeriesBookId);
    expect(updatedBookIds).not.toContain(standaloneBookId);

    /* On-disk verification: tone.warmth landed in every series book; the
       cross-series Wren and the standalone are untouched. */
    const keeperCast = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    const exileCast = readCast(workspaceRoot, AUTHOR, SERIES, EXILE_BOOK);
    const tidewatcherCast = readCast(workspaceRoot, AUTHOR, SERIES, TIDEWATCHER_BOOK);
    const aliasCast = readCast(workspaceRoot, AUTHOR, SERIES, ALIAS_BOOK);
    const otherCast = readCast(workspaceRoot, AUTHOR, 'Different Series', OTHER_SERIES_BOOK);

    expect((keeperCast.characters[0].tone as { warmth: number }).warmth).toBe(80);
    /* Field-level tone merge: pace/authority/emotion preserved on the
       book that had them; only warmth changed. */
    expect((keeperCast.characters[0].tone as { pace: number }).pace).toBe(50);
    expect((exileCast.characters[0].tone as { warmth: number }).warmth).toBe(80);
    expect((tidewatcherCast.characters[0].tone as { warmth: number }).warmth).toBe(80);
    /* Alias-match: the patch reaches the "Foster" row even though name
       differs — alias "Wren" provides the bridge. */
    expect((aliasCast.characters[0].tone as { warmth: number }).warmth).toBe(80);
    expect(aliasCast.characters[0].name).toBe('Foster');
    /* Cross-series Wren is untouched. */
    expect(otherCast.characters[0].tone).toBeUndefined();
  });

  it('writes only to the source when the book is a standalone', async () => {
    const res = await callPatch(standaloneBookId, 'lonely', { gender: 'female' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([
      { bookId: standaloneBookId, bookTitle: STANDALONE, characterId: 'lonely' },
    ]);
    expect(res.body.failed).toEqual([]);
    const standaloneCast = readCast(workspaceRoot, AUTHOR, SERIES, STANDALONE);
    expect(standaloneCast.characters[0].gender).toBe('female');
  });

  it('writes only to the source when no series sibling carries a matching name or alias', async () => {
    /* Hart exists only in KEEPER_BOOK in this fixture. */
    const res = await callPatch(keeperBookId, 'hart', { ageRange: 'teen' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([
      { bookId: keeperBookId, bookTitle: KEEPER_BOOK, characterId: 'hart' },
    ]);
    expect(res.body.failed).toEqual([]);
  });

  it('returns 207 with failed entries when one sibling write throws', async () => {
    /* Force writeJsonAtomic to fail on the Tidewatcher’s Oath cast.json path so
       the sibling-iteration partial-failure branch executes. */
    const { tidewatcherBookDirPath } = {
      tidewatcherBookDirPath: join(workspaceRoot, 'books', AUTHOR, SERIES, TIDEWATCHER_BOOK),
    };
    const stateIo = await import('../workspace/state-io.js');
    const original = stateIo.writeJsonAtomic;
    const spy = vi
      .spyOn(stateIo, 'writeJsonAtomic')
      .mockImplementation(async (path: string, data: unknown) => {
        if (path.startsWith(tidewatcherBookDirPath)) {
          throw new Error('simulated disk-full');
        }
        return original(path, data);
      });

    try {
      const res = await callPatch(keeperBookId, 'wren', { gender: 'female' });
      expect(res.status).toBe(207);
      const failedBookIds = (res.body.failed as Array<{ bookId: string }>).map((f) => f.bookId);
      expect(failedBookIds).toContain(tidewatcherBookId);
      const updatedBookIds = (res.body.updated as Array<{ bookId: string }>).map((u) => u.bookId);
      expect(updatedBookIds).toContain(keeperBookId);
      expect(updatedBookIds).toContain(exileBookId);
      expect(updatedBookIds).not.toContain(tidewatcherBookId);
    } finally {
      spy.mockRestore();
    }
  });
});

/* #1981 — a dedicated standalone book with two characters that have NO
   series-mates, so both concurrent requests below take an identical,
   minimal preamble (scanSeriesCharactersForBookId short-circuits to []
   for a standalone) before reaching applyPatchToCastFile's own
   read-through-write. A book entangled with series-mates (like KEEPER_BOOK)
   gives the two requests asymmetric preambles — one call's extra
   sibling-scan awaits can fully drain before the other even reaches its own
   read, masking the race. This book is spawned fresh (own describe/beforeAll,
   same workspaceRoot — a new mkdtemp would be invisible to the route's
   frozen BOOKS_ROOT) precisely so the race window overlaps reliably. */
describe('#1981 — two series-patch calls for different characters in one book overlap', () => {
  const RACE_BOOK = 'Race Book';
  let raceBookId: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    raceBookId = makeBookId(AUTHOR, SERIES, RACE_BOOK);
    writeBookOnDisk(
      workspaceRoot,
      AUTHOR,
      SERIES,
      RACE_BOOK,
      raceBookId,
      [
        { id: 'race-a', name: 'Race Alpha', role: 'character', color: 'unset' },
        { id: 'race-b', name: 'Race Beta', role: 'character', color: 'unset' },
      ],
      { isStandalone: true },
    );
  });

  it('keeps both patches when two series-patch calls for one book overlap', async () => {
    const [resA, resB] = await Promise.all([
      callPatch(raceBookId, 'race-a', { ageRange: 'child' }),
      callPatch(raceBookId, 'race-b', { ageRange: 'elderly' }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const cast = readCast(workspaceRoot, AUTHOR, SERIES, RACE_BOOK);
    const byId = Object.fromEntries(cast.characters.map((c) => [c.id, c]));
    expect((byId['race-a'] as { ageRange?: string }).ageRange).toBe('child');
    expect((byId['race-b'] as { ageRange?: string }).ageRange).toBe('elderly');
  });
});

/* #2292 (owner decision) — a lock timeout on ONE series-mate reports
 * contention, not a broken cast.
 *
 * The shape does not change: this stays a per-book `failed` entry inside a 207
 * and the other books' writes still land, because failing a whole propagation
 * because one book hit contention is worse than reporting the one. What
 * changes is the REASON — a `LockAcquisitionTimeoutError` says nothing about
 * that book's cast, and the user was previously shown the raw lock message as
 * if their book were at fault.
 *
 * Two-directional, like every other #2260/#2292 pair: an ordinary error at the
 * same site must keep reporting ITS OWN message verbatim. A route that
 * rewrote every failure reason would pass a timeout-only test.
 *
 * The throw is aimed at `withCastLock` (which `applyPatchToCastFile` takes per
 * book) rather than at a genuinely contended lock: the real budget is 10s and
 * vitest's testTimeout is 15s.
 */
describe('series-patch — per-item reason on a lock timeout (#2292)', () => {
  const TIDEWATCHER_DIR_MARK = TIDEWATCHER_BOOK;

  async function patchWithThrowOnTidewatcher(toThrow: unknown) {
    const castLock = await import('../workspace/cast-lock.js');
    const original = castLock.withCastLock;
    const spy = vi
      .spyOn(castLock, 'withCastLock')
      .mockImplementation(async <T,>(dir: string, fn: () => Promise<T>): Promise<T> => {
        if (dir.includes(TIDEWATCHER_DIR_MARK)) throw toThrow;
        return original(dir, fn) as Promise<T>;
      });
    try {
      return await callPatch(keeperBookId, 'wren', { gender: 'female' });
    } finally {
      spy.mockRestore();
    }
  }

  it('reports contention for the contended book and still patches the others', async () => {
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_ITEM_REASON } = await import(
      '../workspace/file-lock.js'
    );
    const res = await patchWithThrowOnTidewatcher(
      new LockAcquisitionTimeoutError('cast:/w/tidewatcher', 10_000),
    );

    expect(res.status).toBe(207);
    /* The site really ran: exactly one book failed, and it is the one the
       spy aimed at. */
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].bookId).toBe(tidewatcherBookId);
    expect(res.body.failed[0].error).toBe(LOCK_CONTENTION_ITEM_REASON);
    /* Never the raw lock text — that is what read as "this book's cast is
       broken". */
    expect(res.body.failed[0].error).not.toContain('withKeyLock');

    /* And the batch was not escalated: the source book took the patch. */
    expect(res.body.updated.some((u: { bookId: string }) => u.bookId === keeperBookId)).toBe(true);
    expect(readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters[0].gender).toBe('female');
  });

  it('an ordinary error at the same site keeps its own message', async () => {
    const res = await patchWithThrowOnTidewatcher(new Error('simulated disk-full'));

    expect(res.status).toBe(207);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].error).toBe('simulated disk-full');
  });
});
