/* Integration test for POST /api/books/:bookId/cast/tier.
   Sets up a tempdir workspace mirroring the voices.test.ts fixture: two
   books in one series, one book in a different series, all sharing voiceId
   'v_wren'. Verifies the endpoint writes ttsModelKey series-wide and 404s
   for unknown books. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Vera Castlen';
const SERIES = 'The Iron Shore';
const BOOK_A = 'Book A';
const BOOK_B = 'Book B';
const OTHER_SERIES = 'The Drift';
const OTHER_BOOK = 'Other Book';

let workspaceRoot: string;
let app: Express;
let bookAId: string;
let bookBId: string;

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  isStandalone = false,
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

function readCastFromDisk(workspace: string, author: string, series: string, title: string) {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-tier-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [paths, { castTierRouter }] = await Promise.all([
    import('../workspace/paths.js'),
    import('./cast-tier.js'),
  ]);
  bookAId = paths.makeBookId(AUTHOR, SERIES, BOOK_A);
  bookBId = paths.makeBookId(AUTHOR, SERIES, BOOK_B);

  const char = (_bookId: string) => ({
    id: 'char-wren',
    name: 'Wren',
    role: 'protagonist',
    color: 'blue',
    voiceId: 'v_wren',
    gender: 'female',
    ageRange: 'adult',
    attributes: ['Female', 'Adult'],
    lines: 40,
    scenes: 4,
    ttsEngine: 'qwen',
  });

  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_A, bookAId, [char(bookAId)]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_B, bookBId, [char(bookBId)]);
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    OTHER_SERIES,
    OTHER_BOOK,
    paths.makeBookId(AUTHOR, OTHER_SERIES, OTHER_BOOK),
    [char('other')],
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', castTierRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/cast/tier', () => {
  it('pins the tier series-wide and returns the count', async () => {
    const res = await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: 'qwen3-tts-1.7b' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThan(0);
    const castB = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_B);
    expect(castB.characters[0].ttsModelKey).toBe('qwen3-tts-1.7b');

    /* Cleanup */
    await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: null });
  });

  it('does not touch the other-series book', async () => {
    await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: 'qwen3-tts-1.7b' });

    const other = readCastFromDisk(workspaceRoot, AUTHOR, OTHER_SERIES, OTHER_BOOK);
    expect(other.characters[0].ttsModelKey).toBeUndefined();

    /* Cleanup */
    await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: null });
  });

  it('clears the tier when ttsModelKey is null', async () => {
    await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: 'qwen3-tts-1.7b' });
    const res = await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: null });
    expect(res.status).toBe(200);
    const castA = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_A);
    expect(castA.characters[0].ttsModelKey).toBeUndefined();
  });

  it('400 when voiceId is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ ttsModelKey: 'qwen3-tts-1.7b' });
    expect(res.status).toBe(400);
  });

  it('400 when ttsModelKey is invalid', async () => {
    const res = await request(app)
      .post(`/api/books/${bookAId}/cast/tier`)
      .send({ voiceId: 'v_wren', ttsModelKey: 'qwen3-tts-0.6b' });
    expect(res.status).toBe(400);
  });

  it('404 when book is unknown', async () => {
    const res = await request(app)
      .post('/api/books/no-such-book/cast/tier')
      .send({ voiceId: 'v_wren', ttsModelKey: 'qwen3-tts-1.7b' });
    expect(res.status).toBe(404);
  });
});
