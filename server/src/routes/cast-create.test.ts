/* Integration tests for the cast/create router.

   Seeds two books on disk — one with a cast.json (happy-path + collision +
   400 tests) and one WITHOUT a cast.json (409 test).

   No auth/CSRF middleware in the test harness — mirrors cast-add-from-roster.test.ts. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { buildCastResolver } from '../store/cast-resolve.js';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK_WITH_CAST = 'The Hollow Tide Book One';
const BOOK_NO_CAST = 'The Hollow Tide Book Two';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookIdNoCast: string;

const initialCast = [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' }];

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  id: string,
  characters: object[],
  opts: { omitCast?: boolean } = {},
) {
  const dir = join(workspace, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  if (!opts.omitCast) {
    writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  }
  return dir;
}

function readCastJson(bookDir: string): { characters: Array<Record<string, unknown>> } {
  const path = join(bookDir, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-create-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castCreateRouter }, { castMergeRouter }, { castRejectOrphanRouter }, { makeBookId }] =
    await Promise.all([
      import('./cast-create.js'),
      import('./cast-merge.js'),
      import('./cast-reject-orphan.js'),
      import('../workspace/paths.js'),
    ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK_WITH_CAST);
  bookIdNoCast = makeBookId(AUTHOR, SERIES, BOOK_NO_CAST);

  app = express();
  app.use(express.json());
  app.use('/api/books', castCreateRouter);
  app.use('/api/books', castMergeRouter);
  app.use('/api/books', castRejectOrphanRouter);
});

beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, initialCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_NO_CAST, bookIdNoCast, [], {
    omitCast: true,
  });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callCreate(id: string, body: object) {
  return request(app)
    .post(`/api/books/${id}/cast/create`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/create (fs-58 Unit B)', () => {
  it('mints a new character and appends it to cast.json', async () => {
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_WITH_CAST);
    const res = await callCreate(bookId, { name: 'Ferra', gender: 'female' });
    expect(res.status).toBe(200);
    expect(res.body.character.name).toBe('Ferra');
    expect(res.body.character.id).toMatch(/ferra/);
    expect(res.body.character.voiceState).toBe('generated');
    expect(res.body.character.color).toBe('unset');
    // confirm it is on disk
    const cast = readCastJson(bookDir);
    expect(cast.characters.some((c) => c['id'] === res.body.character.id)).toBe(true);
    // original characters still present
    expect(cast.characters).toHaveLength(initialCast.length + 1);
  });

  it('suffixes the id on collision', async () => {
    await callCreate(bookId, { name: 'Ferra' });
    const res2 = await callCreate(bookId, { name: 'Ferra' });
    expect(res2.status).toBe(200);
    expect(res2.body.character.id).not.toBe('ferra');
    expect(res2.body.character.id).toMatch(/ferra/);
  });

  it('400s on empty name', async () => {
    const res = await callCreate(bookId, { name: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('slugifies leading/trailing punctuation runs without leaving stray hyphens', async () => {
    const res = await callCreate(bookId, { name: '__Weird--Name!!__' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).toBe('weird-name');
  });

  it('mints hyphen ids, matching the analyzer (RC2, #2040)', async () => {
    const res = await callCreate(bookId, { name: 'The Torment' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).toBe('the-torment');
  });

  it('preserves Cyrillic (and other non-Latin) letters instead of collapsing to "character" (#2040)', async () => {
    const res = await callCreate(bookId, { name: 'Мэйрин' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).toBe('мэйрин');
  });

  it('mints three distinct ids for three characters sharing a name', async () => {
    const res1 = await callCreate(bookId, { name: 'Alden' });
    const res2 = await callCreate(bookId, { name: 'Alden' });
    const res3 = await callCreate(bookId, { name: 'Alden' });
    const ids = [res1.body.character.id, res2.body.character.id, res3.body.character.id];
    expect(new Set(ids).size).toBe(3);
  });

  it('409s when the book has no cast.json yet', async () => {
    const res = await callCreate(bookIdNoCast, { name: 'Ferra' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no cast/i);
  });

  /* #1981 — two concurrent /create calls for the SAME book race cast.json.
     Unlocked, both requests' readJson resolve before either writeJsonAtomic
     lands, so the later write replays a `characters` snapshot taken before
     the earlier write happened and silently drops it. */
  it('#1981 — keeps both new characters when two /create calls for one book overlap', async () => {
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_WITH_CAST);
    const [resA, resB] = await Promise.all([
      callCreate(bookId, { name: 'Alpha' }),
      callCreate(bookId, { name: 'Beta' }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const cast = readCastJson(bookDir);
    const ids = cast.characters.map((c) => c['id']);
    expect(ids).toContain(resA.body.character.id);
    expect(ids).toContain(resB.body.character.id);
    expect(cast.characters).toHaveLength(initialCast.length + 2);
  });
});

describe('POST /api/books/:bookId/cast/create — history-protected ids (srv-86 / #2085)', () => {
  const historyPath = () =>
    join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_WITH_CAST, '.audiobook', 'cast-id-history.json');
  const bookDir = () => join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_WITH_CAST);

  // The outer `beforeEach` (module-level) only rewrites cast.json/state.json
  // via `writeBookOnDisk` — it never touches cast-id-history.json, so a file
  // one test writes (directly, or via a real merge) survives into the next
  // test in this describe unless removed here. Review round 1 (Important)
  // caught the "no history file" test below running with a stale history
  // file left behind by an earlier test, passing for the wrong reason.
  beforeEach(() => {
    rmSync(historyPath(), { force: true });
  });

  it('does not re-mint an id a merge retired — the merge-then-recreate repro', async () => {
    // Seed a cast with the two characters the issue's repro merges.
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'anton', name: 'Anton', role: 'character', color: 'unset' },
      { id: 'антон', name: 'Антон', role: 'character', color: 'unset' },
    ]);

    // 1. Merge "anton" into "антон" — the real route, so cast-id-history.json
    //    gets its "anton" -> "антон" entry the same way a user's merge would.
    const mergeRes = await request(app)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'anton', targetId: 'антон' });
    expect(mergeRes.status).toBe(200);
    const historyAfterMerge = JSON.parse(readFileSync(historyPath(), 'utf8'));
    expect(historyAfterMerge.supersededBy).toEqual({ anton: 'антон' });

    // 2. Create a brand-new character named "Anton" — the exact name whose
    //    naive mint is the retired id.
    const createRes = await callCreate(bookId, { name: 'Anton' });
    expect(createRes.status).toBe(200);

    // The new character must NOT have re-minted "anton" — that id is still
    // protecting every segment the original Anton rendered (they now
    // resolve, via history, onto "антон"). Reusing it here would hijack that
    // protection onto this brand-new, empty character (spec §4.3/§4.4).
    expect(createRes.body.character.id).not.toBe('anton');
    expect(createRes.body.character.name).toBe('Anton');

    // The history entry itself must survive untouched — this route avoids
    // the id rather than dropping the entry (unlike the analyzer paths,
    // this route controls its own mint and doesn't need to).
    const historyAfterCreate = JSON.parse(readFileSync(historyPath(), 'utf8'));
    expect(historyAfterCreate.supersededBy).toEqual({ anton: 'антон' });
  });

  it('is reported, not silent, when a history-protected id is avoided', async () => {
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'антон', name: 'Антон', role: 'character', color: 'unset' },
    ]);
    mkdirSync(join(bookDir(), '.audiobook'), { recursive: true });
    writeFileSync(historyPath(), JSON.stringify({ schema: 1, supersededBy: { anton: 'антон' } }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await callCreate(bookId, { name: 'Anton' });
      expect(res.status).toBe(200);
      expect(res.body.character.id).not.toBe('anton');
      const messages = logSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('avoided re-minting "anton"'))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('mints normally when no cast-id-history.json exists yet (the common case)', async () => {
    // This describe's own beforeEach (above) removes any history file left
    // behind by a previous test, so this genuinely exercises
    // loadCastIdHistory's `raw === null` (absent-file) branch.
    expect(existsSync(historyPath())).toBe(false);
    const res = await callCreate(bookId, { name: 'Nobody Retired This' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).toBe('nobody-retired-this');
  });

  it('does not re-mint an id whose history key is a differently-spelled encoding of the same name (review round 1, Critical)', async () => {
    // Real-workspace shape (docs/testing/cast-id-drift-onbox-acceptance.md):
    // cast.json historically held the pre-RC2 underscore id "the_torment"
    // for "The Torment", while frozen segments already carried the
    // analyzer's hyphen spelling "the-torment", resolving via the
    // normalised-id tier. A merge folding "the_torment" into some other
    // character records history keyed on the RAW pre-RC2 spelling.
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'lightning-dave', name: 'Lightning Dave', role: 'character', color: 'unset' },
    ]);
    mkdirSync(join(bookDir(), '.audiobook'), { recursive: true });
    writeFileSync(
      historyPath(),
      JSON.stringify({ schema: 1, supersededBy: { the_torment: 'lightning-dave' } }),
    );

    // A naive re-create of "The Torment" mints safeId's hyphen normal form,
    // "the-torment" — NOT a raw match for the history key "the_torment".
    // Only a normalised comparison catches the collision.
    const res = await callCreate(bookId, { name: 'The Torment' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).not.toBe('the-torment');

    // The history entry survives — this route avoids the id, it doesn't
    // drop the entry.
    const history = JSON.parse(readFileSync(historyPath(), 'utf8'));
    expect(history.supersededBy).toEqual({ the_torment: 'lightning-dave' });
  });

  it('does not re-mint an id that collides, only after normalisation, with a LIVE character — no history involved (review round 1, sibling defect)', async () => {
    // Same encoding gap, no merge/history at all: a live character already
    // holds the pre-RC2 underscore spelling. Re-creating under the name
    // whose normal-form mint is the hyphen spelling used to collide with it
    // only after normalisation — invisible to a raw existingIds check, but
    // it collapses `byNormId` for both spellings the instant it lands.
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'the_torment', name: 'The Torment', role: 'character', color: 'unset' },
    ]);

    // Review round 2 (M4) — this avoidance used to be silent (the report
    // only fired for a history match). Assert it's reported too, naming the
    // live id it collided with, not just that a suffixed id was minted.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await callCreate(bookId, { name: 'The Torment' });
      expect(res.status).toBe(200);
      expect(res.body.character.id).not.toBe('the-torment');
      const messages = logSpy.mock.calls.map((call) => String(call[0]));
      expect(
        messages.some(
          (m) => m.includes('normalises the same as live character id "the_torment"'),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('still mints ordinary same-name collisions silently — the widened report does not fire for a plain raw collision (review round 2, M4 scope)', async () => {
    // Two live characters already sharing a name is the mundane, pre-#2085
    // path (safeId's own hash-suffix + this route's -n loop) — unrelated to
    // history/normalisation protection, and was never logged before this
    // fix existed. The widened report (M4) must not start logging it now.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await callCreate(bookId, { name: 'Alden' });
      await callCreate(bookId, { name: 'Alden' });
      const res3 = await callCreate(bookId, { name: 'Alden' });
      expect(res3.status).toBe(200);
      const messages = logSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('avoided re-minting'))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('creates successfully rather than 500ing when cast.json has a row with a missing/non-string id (review round 2, I1)', async () => {
    // cast.json is read via an unvalidated readJson<CastFile> on this route
    // — characterSchema is never applied — so a corrupt/hand-edited file can
    // carry a row with no `id` at all. Before review round 2, the new
    // normaliseIdKey calls this fix added would dereference that id and
    // throw a TypeError instead of the route degrading gracefully.
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { name: 'No Id At All', role: 'character', color: 'unset' },
      { id: 'антон', name: 'Антон', role: 'character', color: 'unset' },
    ]);

    const res = await callCreate(bookId, { name: 'Anton' });
    expect(res.status).toBe(200);
    expect(res.body.character.name).toBe('Anton');
  });

  it('does not crash and does not block minting when cast-id-history.json is malformed', async () => {
    mkdirSync(join(bookDir(), '.audiobook'), { recursive: true });
    writeFileSync(historyPath(), '{not valid json');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await callCreate(bookId, { name: 'Ferra' });
      expect(res.status).toBe(200);
      expect(res.body.character.id).toBe('ferra');
      // Absent/unreadable history must not silently disable the protection
      // without a trace — one warning naming the path.
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('cast-id-history.json') && m.includes('unreadable'))).toBe(
        true,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  /* F1 (fix round 2, #2163) — a THIRD path to #2110's end state, reachable by
     UI clicks alone with no analysis run: "Not the same character"
     (`cast-reject-orphan.ts`'s POST) calls `forgetSupersededId`, which
     deletes `supersededBy[from]` unconditionally on every successful
     reject — so unlike the drop path C1 covers (`displacedKeys`), the freed
     key doesn't even land in `displaced`; it survives ONLY inside
     `rejectedPairs`. Drives the full chain through the REAL routes (reject,
     then create by the same name) rather than hand-writing
     cast-id-history.json, so a regression in either route's own write path
     would also be caught. */
  it('F1 — a name minted after "Not the same character" does not re-mint the rejected id (#2163)', async () => {
    // 1. Seed the auto-reconciled state: "marrow" is live, "mayrin" is an
    //    orphaned id currently redirecting onto it via supersededBy (as if a
    //    merge/analysis had recorded that alias).
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'marrow', name: 'Marrow', role: 'character', color: 'unset' },
    ]);
    mkdirSync(join(bookDir(), '.audiobook'), { recursive: true });
    writeFileSync(historyPath(), JSON.stringify({ schema: 1, supersededBy: { mayrin: 'marrow' } }));

    // 2. Click "Not the same character" on the (marrow, mayrin) pair — the
    //    real reject-orphan-match route, so forgetSupersededId's delete and
    //    rejectOrphanedPair's write both happen exactly as the UI triggers
    //    them.
    const rejectRes = await request(app)
      .post(`/api/books/${bookId}/cast/marrow/reject-orphan-match`)
      .set('Content-Type', 'application/json')
      .send({ orphanedId: 'mayrin' });
    expect(rejectRes.status).toBe(200);

    const historyAfterReject = JSON.parse(readFileSync(historyPath(), 'utf8'));
    // supersededBy.mayrin is gone (forgetSupersededId) — the only surviving
    // record of "mayrin" is rejectedPairs[].from.
    expect(historyAfterReject.supersededBy).toEqual({});
    expect(historyAfterReject.rejectedPairs).toEqual([
      { from: 'mayrin', to: 'marrow', forgotSupersededTo: 'marrow' },
    ]);

    // 3. Create a brand-new character named "Mayrin" — the naive mint is the
    //    now-unprotected-by-supersededBy, but still-rejected, bare id.
    const createRes = await callCreate(bookId, { name: 'Mayrin' });
    expect(createRes.status).toBe(200);
    expect(createRes.body.character.id).not.toBe('mayrin');

    // 4. resolve('mayrin') must not land on the new row (or anywhere else) —
    //    the segments that still carry the raw id "mayrin" must not silently
    //    start reading as the brand-new, empty character.
    const castAfterCreate = JSON.parse(readFileSync(join(bookDir(), '.audiobook', 'cast.json'), 'utf8'));
    const historyAfterCreate = JSON.parse(readFileSync(historyPath(), 'utf8'));
    const resolution = buildCastResolver(castAfterCreate.characters, historyAfterCreate).resolve(
      'mayrin',
    );
    expect(resolution).toBeUndefined();
  });
});
