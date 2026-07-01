/* Integration tests for the cast/create router.

   Seeds two books on disk — one with a cast.json (happy-path + collision +
   400 tests) and one WITHOUT a cast.json (409 test).

   No auth/CSRF middleware in the test harness — mirrors cast-add-from-roster.test.ts. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
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

  const [{ castCreateRouter }, { makeBookId }] = await Promise.all([
    import('./cast-create.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK_WITH_CAST);
  bookIdNoCast = makeBookId(AUTHOR, SERIES, BOOK_NO_CAST);

  app = express();
  app.use(express.json());
  app.use('/api/books', castCreateRouter);
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

  it('slugifies leading/trailing punctuation runs without leaving stray underscores', async () => {
    const res = await callCreate(bookId, { name: '__Weird--Name!!__' });
    expect(res.status).toBe(200);
    expect(res.body.character.id).toBe('weird_name');
  });

  it('409s when the book has no cast.json yet', async () => {
    const res = await callCreate(bookIdNoCast, { name: 'Ferra' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no cast/i);
  });
});
