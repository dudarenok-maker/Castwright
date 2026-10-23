/* #3703 part 1 -- every restructure also writes the restructured chapter bodies
 * to <book>/.audiobook/manuscript-hints.json. Harness mirrors
 * chapters-restructure.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const writeSpy = vi.hoisted(() => ({ fail: false }));
vi.mock('../workspace/manuscript-hints.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/manuscript-hints.js')>();
  return {
    ...real,
    writeManuscriptHints: vi.fn(async (...args: Parameters<typeof real.writeManuscriptHints>) => {
      if (writeSpy.fail) throw new Error('hints write boom');
      return real.writeManuscriptHints(...args);
    }),
  };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Hints Persist Test';
const SERIES = 'Standalones';
const TITLE = 'Hints Persist Test Book';
const MANUSCRIPT_ID = 'm_hints_persist_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const MANUSCRIPT_BODY =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

function seedState(): void {
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
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

function seedManuscriptEdits(): void {
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'narr', text: 'Alpha first.' },
        { id: 2, chapterId: 1, characterId: 'narr', text: 'Alpha second.' },
        { id: 1, chapterId: 2, characterId: 'narr', text: 'Beta first.' },
        { id: 2, chapterId: 2, characterId: 'sam', text: 'Beta second.' },
        { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma first.' },
        { id: 2, chapterId: 3, characterId: 'narr', text: 'Gamma second.' },
      ],
    }),
  );
}

const hintsPath = (): string => join(bookDir, '.audiobook', 'manuscript-hints.json');
const statePath = (): string => join(bookDir, '.audiobook', 'state.json');

function readHints(): {
  schema: number;
  manuscriptId: string;
  manuscriptFile: string;
  sourceSha256: string;
  chapters: Array<{ id: number; uuid: string; body: string }>;
} {
  return JSON.parse(readFileSync(hintsPath(), 'utf8'));
}

function readStateUuids(): string[] {
  const s = JSON.parse(readFileSync(statePath(), 'utf8')) as { chapters: Array<{ uuid: string }> };
  return s.chapters.map((c) => c.uuid);
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-hints-persist-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  writeSpy.fail = false;
  seedState();
  seedManuscriptEdits();
  rmSync(hintsPath(), { force: true });
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

afterEach(() => {
  writeSpy.fail = false;
});

describe('restructure persists manuscript-hints.json (#3703)', () => {
  it('merge writes the merged bodies keyed to state.json uuids', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(200);

    expect(existsSync(hintsPath())).toBe(true);
    const h = readHints();
    expect(h.schema).toBe(1);
    expect(h.manuscriptId).toBe(MANUSCRIPT_ID);
    expect(h.manuscriptFile).toBe('manuscript.md');
    expect(h.sourceSha256).toBe(createHash('sha256').update(MANUSCRIPT_BODY).digest('hex'));
    expect(h.chapters.map((c) => c.id)).toEqual([1, 2]);
    expect(h.chapters.map((c) => c.uuid)).toEqual(readStateUuids());
    expect(h.chapters[0].body).toContain('Alpha first.');
    expect(h.chapters[0].body).toContain('Beta first.');
    expect(h.chapters[1].body).toContain('Gamma first.');
  });

  it('reorder writes bodies in the new order with matching uuids', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [3, 1, 2] });
    expect(res.status).toBe(200);

    const h = readHints();
    expect(h.chapters).toHaveLength(3);
    expect(h.chapters[0].body).toContain('Gamma first.');
    expect(h.chapters[1].body).toContain('Alpha first.');
    expect(h.chapters[2].body).toContain('Beta first.');
    expect(h.chapters.map((c) => c.uuid)).toEqual(readStateUuids());
  });

  it('a failing hints write answers 500 and leaves state.json byte-identical', async () => {
    const before = readFileSync(statePath());
    writeSpy.fail = true;
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(res.status).toBe(500);
    expect(readFileSync(statePath()).equals(before)).toBe(true);
    expect(existsSync(hintsPath())).toBe(false);
  });
});
