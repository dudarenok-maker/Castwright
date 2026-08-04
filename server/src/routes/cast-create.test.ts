/* Integration tests for the cast/create router.

   Seeds two books on disk — one with a cast.json (happy-path + collision +
   400 tests) and one WITHOUT a cast.json (409 test).

   No auth/CSRF middleware in the test harness — mirrors cast-add-from-roster.test.ts. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

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

  const [{ castCreateRouter }, { castMergeRouter }, { makeBookId }] = await Promise.all([
    import('./cast-create.js'),
    import('./cast-merge.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK_WITH_CAST);
  bookIdNoCast = makeBookId(AUTHOR, SERIES, BOOK_NO_CAST);

  app = express();
  app.use(express.json());
  app.use('/api/books', castCreateRouter);
  app.use('/api/books', castMergeRouter);
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
});

describe('POST /api/books/:bookId/cast/create — history-protected ids (srv-86 / #2085)', () => {
  const historyPath = () =>
    join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_WITH_CAST, '.audiobook', 'cast-id-history.json');
  const bookDir = () => join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_WITH_CAST);

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
    // beforeEach already seeds a book with no history file. Confirm create
    // proceeds without the history-check crashing or blocking anything.
    const res = await callCreate(bookId, { name: 'Nobody Retired This' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).toBe('nobody-retired-this');
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
});
