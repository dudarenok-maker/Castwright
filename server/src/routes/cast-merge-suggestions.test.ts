/* Integration tests for the cast-merge-suggestions router.

   Seeds a workspace with a fake book + cast-merge-suggestions.json and drives
   the three suggestion endpoints:
     GET  /:bookId/cast/merge-suggestions           → list
     POST /:bookId/cast/merge-suggestions/dismiss   → drop one
     POST /:bookId/cast/merge-suggestions/accept    → merge + drop

   Mirrors cast-merge.test.ts: defer module imports until WORKSPACE_DIR is
   set so paths.ts captures the right root. */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

/* A seam for the cast-lock ACQUISITION expiring (the real budget is 10s and
   vitest's testTimeout is 15s). Null = pass through. `fn` is never called when
   it throws, exactly like `withKeyLock` on expiry. */
const castLockFault = vi.hoisted(() => ({ toThrow: null as unknown }));

vi.mock('../workspace/cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/cast-lock.js')>();
  return {
    ...actual,
    withCastLock: async <T>(bookDir: string, fn: () => Promise<T>): Promise<T> => {
      if (castLockFault.toThrow) throw castLockFault.toThrow;
      return actual.withCastLock(bookDir, fn);
    },
  };
});

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

/* #4031 — put the book back to its seeded shape for the describes below, which
   (unlike the sequential ones above them) each need a clean slate. */
function reseed(over: { suggestions?: unknown[]; historyRaw?: string } = {}): void {
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [olgaChar, olyaChar, marloChar] }),
  );
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  writeFileSync(
    join(bookDir, '.audiobook', 'cast-merge-suggestions.json'),
    JSON.stringify({ suggestions: over.suggestions ?? suggestions }),
  );
  const historyPath = join(bookDir, '.audiobook', 'cast-id-history.json');
  rmSync(historyPath, { force: true });
  if (over.historyRaw !== undefined) writeFileSync(historyPath, over.historyRaw);
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
      chapters: { 1: [sentences[0], sentences[1]], 2: [sentences[2]] },
      updatedAt: new Date().toISOString(),
    }),
  );
}

function readHistory(): {
  notSamePerson?: Array<{ a: string; b: string }>;
} | null {
  const p = join(bookDir, '.audiobook', 'cast-id-history.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function readCastRows(): Array<{ id: string; notLinkedTo?: Array<{ bookId: string; characterId: string }> }> {
  return (JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8')) as {
    characters: Array<{ id: string; notLinkedTo?: Array<{ bookId: string; characterId: string }> }>;
  }).characters;
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

/* #4031 Task 3 — durable suggestions and dismissals. */
describe('GET keeps the MergeSuggestion shape', () => {
  it('GET keeps the MergeSuggestion shape', async () => {
    reseed({
      suggestions: [
        {
          sourceId: 'olya',
          targetId: 'olga',
          a: 'olga',
          b: 'olya',
          reason: 'diminutive of Ольга',
          origin: 'plan',
          newRow: 'olya',
          candidate: 'olga',
        },
        { sourceId: 'marlo', targetId: 'olga', reason: 'legacy entry' },
      ],
    });
    const res = await request(app).get(`/api/books/${bookId}/cast/merge-suggestions`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      suggestions: [
        { sourceId: 'olya', targetId: 'olga', reason: 'diminutive of Ольга' },
        { sourceId: 'marlo', targetId: 'olga', reason: 'legacy entry' },
      ],
    });
  });
});

describe('POST merge-suggestions/dismiss — durable (#4031)', () => {
  it('dismiss writes the record and both edges', async () => {
    reseed();
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
      .send({ sourceId: 'olya', targetId: 'olga' });
    expect(res.status).toBe(200);

    expect(readHistory()?.notSamePerson).toEqual([
      expect.objectContaining({ a: 'olga', b: 'olya' }),
    ]);
    const rows = readCastRows();
    expect(rows.find((r) => r.id === 'olya')?.notLinkedTo).toEqual([
      { bookId, characterId: 'olga' },
    ]);
    expect(rows.find((r) => r.id === 'olga')?.notLinkedTo).toEqual([
      { bookId, characterId: 'olya' },
    ]);
    // the pair is gone, the other suggestion stays
    expect(readSuggestionsFile().suggestions.map((s) => s.sourceId)).toEqual(['marlo']);
  });

  it('F14: dismiss under degraded history writes the edges, removes the pair, skips the record and logs', async () => {
    const garbage = '{ this is not json';
    reseed({ historyRaw: garbage });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
        .send({ sourceId: 'olya', targetId: 'olga' });
      expect(res.status).toBe(200);

      // the degraded file is left exactly as found: no record was written over it
      expect(readFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), 'utf8')).toBe(garbage);
      const rows = readCastRows();
      expect(rows.find((r) => r.id === 'olya')?.notLinkedTo).toEqual([{ bookId, characterId: 'olga' }]);
      expect(rows.find((r) => r.id === 'olga')?.notLinkedTo).toEqual([{ bookId, characterId: 'olya' }]);
      expect(readSuggestionsFile().suggestions.map((s) => s.sourceId)).toEqual(['marlo']);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('[cast-merge-suggestions]') && /not-same-person|dismissal record/.test(String(c[0]))),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('dismiss answers a curated 500 on a lock timeout', async () => {
    reseed();
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import(
      '../workspace/file-lock.js'
    );
    castLockFault.toThrow = new LockAcquisitionTimeoutError(`cast:${bookDir}`, 10_000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/merge-suggestions/dismiss`)
        .send({ sourceId: 'olya', targetId: 'olga' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: LOCK_CONTENTION_REQUEST_ERROR });
      expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
      // nothing was written
      expect(readHistory()).toBeNull();
      expect(readSuggestionsFile().suggestions).toHaveLength(2);
    } finally {
      castLockFault.toThrow = null;
      error.mockRestore();
    }
  });
});

describe('POST merge-suggestions/accept — durable (#4031)', () => {
  it('accept folds sourceId into targetId, removes the pair and records no dismissal', async () => {
    reseed();
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .send({ sourceId: 'olya', targetId: 'olga' });
    expect(res.status).toBe(200);

    const ids = readCastRows().map((r) => r.id);
    expect(ids).not.toContain('olya');
    expect(ids).toContain('olga');
    expect(readSuggestionsFile().suggestions.map((s) => s.sourceId)).toEqual(['marlo']);
    // an accept is a merge, never a "not the same person" record
    expect(readHistory()?.notSamePerson ?? []).toEqual([]);
  });
});
