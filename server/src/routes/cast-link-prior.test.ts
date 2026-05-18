/* Integration tests for the cast/link-prior router.

   Seeds two KOTLC books on disk — the current ("source") book contains
   the analyzer-named full-form character ("Dexter Alvin Diznee"); the
   prior ("target") book contains the canonical short form ("Dex"). The
   tests assert:

   - Success path appends source's name to target's aliases (case-insensitive
     dedup), writes target's cast.json atomically, and returns matchedFrom
     + voiceId for the frontend's applyManualMatch dispatch.
   - Idempotency: re-calling with the same body is a no-op on disk.
   - Series guard: a book in a different series, a standalone, or an
     unknown bookId all return 404.
   - Missing source/target character ids return 404.

   Same lazy-import pattern as the sibling route tests so WORKSPACE_DIR
   is set before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Shannon Messenger';
const SERIES = 'Keeper of the Lost Cities';
const KEEPER_BOOK = 'Keeper of the Lost Cities';
const NEW_BOOK = 'New KOTLC Book';
const OTHER_BOOK = 'Other Series Book';
const STANDALONE = 'Some Standalone';

let workspaceRoot: string;
let app: Express;
let keeperBookId: string;
let newBookId: string;
let otherBookId: string;
let standaloneBookId: string;

const initialKeeperCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'dex',
    name: 'Dex',
    role: 'character',
    color: 'unset',
    voiceId: 'v_dex',
    aliases: ['Dexter'],
  },
  { id: 'sophie', name: 'Sophie', role: 'character', color: 'unset', voiceId: 'v_sophie' },
];

const initialNewBookCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'dexter-alvin-diznee',
    name: 'Dexter Alvin Diznee',
    role: 'character',
    color: 'unset',
    aliases: ['Dizz'],
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-link-prior-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castLinkPriorRouter }, { makeBookId }] = await Promise.all([
    import('./cast-link-prior.js'),
    import('../workspace/paths.js'),
  ]);
  keeperBookId = makeBookId(AUTHOR, SERIES, KEEPER_BOOK);
  newBookId = makeBookId(AUTHOR, SERIES, NEW_BOOK);
  otherBookId = makeBookId(AUTHOR, 'Different Series', OTHER_BOOK);
  standaloneBookId = makeBookId(AUTHOR, SERIES, STANDALONE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castLinkPriorRouter);
});

/* Re-seed the books before every test so the alias-mutation cases don't
   bleed into each other. Cheap (4 books × 2 small files each). */
beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK, keeperBookId, initialKeeperCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, initialNewBookCast);
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

function callLink(bookId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/link-prior`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/link-prior', () => {
  it('rejects when any of the three body ids are missing', async () => {
    const res = await callLink(newBookId, { sourceCharacterId: 'dexter-alvin-diznee' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when targetBookId equals the path bookId', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: newBookId,
      targetCharacterId: 'dexter-alvin-diznee',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book is unknown', async () => {
    const res = await callLink('nope', {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the target book is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: 'nope',
      targetCharacterId: 'dex',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target book/i);
  });

  it('returns 404 when target book is in a different series', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: otherBookId,
      targetCharacterId: 'unrelated',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when target book is a standalone', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: standaloneBookId,
      targetCharacterId: 'lonely',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when the source character is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'missing',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source character/i);
  });

  it('returns 404 when the target character is unknown', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it('appends source.name to target.aliases on disk and returns matchedFrom + voiceId', async () => {
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matchedFrom: {
        bookId: keeperBookId,
        characterId: 'dex',
        bookTitle: KEEPER_BOOK,
        confidence: 1,
      },
      voiceId: 'v_dex',
    });

    const dexOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'dex',
    );
    expect(dexOnDisk).toBeDefined();
    expect(dexOnDisk?.aliases).toEqual(['Dexter', 'Dexter Alvin Diznee', 'Dizz']);
  });

  it('does not duplicate aliases on a repeat call (case-insensitive dedup)', async () => {
    /* First call adds Dexter Alvin Diznee + Dizz. Second call should be
       a no-op on disk. The route still returns 200 with matchedFrom so
       the frontend can re-dispatch applyManualMatch idempotently. */
    await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    const beforeSecond = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    const res2 = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    const afterSecond = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK);
    expect(res2.status).toBe(200);
    expect(afterSecond).toEqual(beforeSecond);
  });

  it("does not modify the source book's cast.json", async () => {
    const before = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK);
    await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    const after = readCast(workspaceRoot, AUTHOR, SERIES, NEW_BOOK);
    expect(after).toEqual(before);
  });

  it('drops target.name from the alias pool (no self-alias)', async () => {
    /* Edge case: source.aliases already contains the target's name.
       After the merge, target.aliases should NOT list its own name. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NEW_BOOK, newBookId, [
      {
        id: 'dexter-alvin-diznee',
        name: 'Dexter Alvin Diznee',
        role: 'character',
        color: 'unset',
        aliases: ['Dex'],
      },
    ]);
    const res = await callLink(newBookId, {
      sourceCharacterId: 'dexter-alvin-diznee',
      targetBookId: keeperBookId,
      targetCharacterId: 'dex',
    });
    expect(res.status).toBe(200);
    const dexOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, KEEPER_BOOK).characters.find(
      (c) => c.id === 'dex',
    );
    /* "Dex" was in source's aliases, but it equals target.name → filtered. */
    expect(dexOnDisk?.aliases).not.toContain('Dex');
    expect(dexOnDisk?.aliases).toContain('Dexter Alvin Diznee');
  });
});
