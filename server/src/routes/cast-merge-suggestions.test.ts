/* Integration tests for the cast-merge-suggestions router.

   Seeds a workspace with a fake book + cast-merge-suggestions.json and drives
   the three suggestion endpoints:
     GET  /:bookId/cast/merge-suggestions           → list
     POST /:bookId/cast/merge-suggestions/dismiss   → drop one
     POST /:bookId/cast/merge-suggestions/accept    → merge + drop

   Mirrors cast-merge.test.ts: defer module imports until WORKSPACE_DIR is
   set so paths.ts captures the right root. */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Suggestions Author';
const SERIES = 'Standalones';
const TITLE = 'Suggestions Book';
const MANUSCRIPT_ID = 'm_suggestions_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

/* Characters: Оля and Ольга are diminutive pair; Ольга is the canonical survivor. */
const olyaChar = {
  id: 'olya',
  name: 'Оля',
  role: 'secondary',
  color: 'halloran',
  lines: 4,
  scenes: 2,
  gender: 'female',
};

const olgaChar = {
  id: 'olga',
  name: 'Ольга',
  role: 'protagonist',
  color: 'eliza',
  lines: 10,
  scenes: 3,
  gender: 'female',
};

const marloChar = {
  id: 'marlo',
  name: 'Marlo',
  role: 'sidekick',
  color: 'halloran',
  lines: 6,
  scenes: 2,
};

const sentences = [
  { id: 1, chapterId: 1, characterId: 'olya', text: 'Привет.' },
  { id: 2, chapterId: 1, characterId: 'olga', text: 'Здравствуй.' },
  { id: 3, chapterId: 2, characterId: 'marlo', text: 'Hello there.' },
];

const suggestions = [
  { sourceId: 'olya', targetId: 'olga', reason: 'diminutive of Ольга' },
  { sourceId: 'marlo', targetId: 'olga', reason: 'unrelated pair for dismiss test' },
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-suggestions-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castMergeRouter }, { castMergeSuggestionsRouter }, { makeBookId }] = await Promise.all([
    import('./cast-merge.js'),
    import('./cast-merge-suggestions.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'One', slug: '01-one' },
        { id: 2, title: 'Two', slug: '02-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [olgaChar, olyaChar, marloChar] }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast-merge-suggestions.json'),
    JSON.stringify({ suggestions }),
  );

  /* Analysis cache — needed because performCastMerge touches it. */
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({
      stage1: {
        characters: [olgaChar, olyaChar, marloChar],
        chapters: [
          { id: 1, title: 'One' },
          { id: 2, title: 'Two' },
        ],
      },
      chapters: {
        1: [sentences[0], sentences[1]],
        2: [sentences[2]],
      },
      updatedAt: new Date().toISOString(),
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', castMergeRouter);
  app.use('/api/books', castMergeSuggestionsRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (cachePath) rmSync(cachePath, { force: true });
});

function readSuggestionsFile(): { suggestions: Array<{ sourceId: string; targetId: string; reason: string }> } {
  return JSON.parse(
    readFileSync(join(bookDir, '.audiobook', 'cast-merge-suggestions.json'), 'utf8'),
  ) as { suggestions: Array<{ sourceId: string; targetId: string; reason: string }> };
}

function readCastFile(): { characters: Array<{ id: string }> } {
  return JSON.parse(
    readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
  ) as { characters: Array<{ id: string }> };
}

describe('GET /:bookId/cast/merge-suggestions', () => {
  it('returns the seeded suggestions', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cast/merge-suggestions`);
    expect(res.status).toBe(200);
    const body = res.body as { suggestions: Array<{ sourceId: string; targetId: string }> };
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0]).toMatchObject({ sourceId: 'olya', targetId: 'olga' });
  });

  it('returns empty suggestions for an unknown book (no file)', async () => {
    const res = await request(app).get('/api/books/no-such-book/cast/merge-suggestions');
    expect(res.status).toBe(200);
    const body = res.body as { suggestions: unknown[] };
    expect(body.suggestions).toHaveLength(0);
  });
});

describe('POST /:bookId/cast/merge-suggestions/dismiss', () => {
  it('removes the matching suggestion and leaves others intact', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
      .send({ sourceId: 'marlo', targetId: 'olga' });
    expect(res.status).toBe(200);

    /* The dismissed pair is gone; the olya/olga pair survives. */
    const file = readSuggestionsFile();
    expect(file.suggestions).toHaveLength(1);
    expect(file.suggestions[0]).toMatchObject({ sourceId: 'olya', targetId: 'olga' });
  });

  it('subsequent GET reflects the dismissal', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cast/merge-suggestions`);
    expect(res.status).toBe(200);
    const body = res.body as { suggestions: Array<{ sourceId: string }> };
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].sourceId).toBe('olya');
  });
});

describe('POST /:bookId/cast/merge-suggestions/accept', () => {
  it('performs the merge (sourceId folded into targetId), then drops the suggestion', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .send({ sourceId: 'olya', targetId: 'olga' });
    expect(res.status).toBe(200);

    /* cast.json: olya is gone, olga survives and has olya as an alias. */
    const cast = readCastFile();
    const ids = cast.characters.map((c) => c.id);
    expect(ids).not.toContain('olya');
    expect(ids).toContain('olga');

    const olga = cast.characters.find((c) => c.id === 'olga') as {
      id: string;
      aliases?: string[];
    };
    expect(olga.aliases).toContain('Оля');

    /* The accepted suggestion is removed. */
    const file = readSuggestionsFile();
    expect(file.suggestions).toHaveLength(0);
  });

  it('subsequent GET shows empty suggestions', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cast/merge-suggestions`);
    expect(res.status).toBe(200);
    const body = res.body as { suggestions: unknown[] };
    expect(body.suggestions).toHaveLength(0);
  });
});
