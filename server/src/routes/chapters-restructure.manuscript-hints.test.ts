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
const stateWriteSpy = vi.hoisted(() => ({ fail: false }));
vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  return {
    ...real,
    writeStateJsonAtomic: vi.fn(async (...args: Parameters<typeof real.writeStateJsonAtomic>) => {
      if (stateWriteSpy.fail) throw new Error('state write boom');
      return real.writeStateJsonAtomic(...args);
    }),
  };
});
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
  /* The newest entry (entries[0]) is the one just written. */
  const file = JSON.parse(readFileSync(hintsPath(), 'utf8')) as {
    schema: number;
    entries: Array<{
      manuscriptId: string;
      manuscriptFile: string;
      sourceSha256: string;
      chapters: Array<{ id: number; uuid: string; body: string }>;
    }>;
  };
  return { schema: file.schema, ...file.entries[0]! };
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
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  writeSpy.fail = false;
  stateWriteSpy.fail = false;
  seedState();
  seedManuscriptEdits();
  rmSync(hintsPath(), { force: true });
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

afterEach(() => {
  writeSpy.fail = false;
  stateWriteSpy.fail = false;
  // A stale-body test edits the manuscript on disk; vitest's retry and every
  // later test must see the original again.
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
});

const EDITED_BODY = MANUSCRIPT_BODY.replace('Alpha first.', 'Edited opener.');

/* Edit the manuscript on disk after the record was cached from it: the record's
   bodies are now from a file that no longer exists, which is the only way a
   restructure sees a stale body. */
function editManuscriptOnDisk(): void {
  writeFileSync(join(bookDir, 'manuscript.md'), EDITED_BODY);
}

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

  it('a failed state.json write after a SECOND restructure still hydrates the structure that landed', async () => {
    const merge = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(merge.status).toBe(200);

    // The reorder overwrites the hints file, then its state.json write fails.
    stateWriteSpy.fail = true;
    const reorder = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(500);
    stateWriteSpy.fail = false;

    // state.json is still the merged structure (2 chapters, Gamma last).
    expect(readStateUuids()).toHaveLength(2);

    // A restart: drop the in-memory record and hydrate from disk.
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
    const record = await getOrHydrateManuscript(MANUSCRIPT_ID);
    expect(record?.chapterHints).toHaveLength(2);
    expect(record!.chapterHints[0]!.body).toContain('Alpha first.');
    expect(record!.chapterHints[0]!.body).toContain('Beta first.');
    expect(record!.chapterHints[1]!.body).toContain('Gamma first.');
  });

  it('a stale-body restructure whose state.json write fails leaves state.json untouched and a restart re-parses the edited manuscript', async () => {
    const merge = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(merge.status).toBe(200);

    // The record was cached from the original manuscript; now the file changes.
    editManuscriptOnDisk();
    const stateBefore = readFileSync(statePath());

    stateWriteSpy.fail = true;
    const reorder = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(500);
    stateWriteSpy.fail = false;
    expect(readFileSync(statePath()).equals(stateBefore)).toBe(true);

    // A restart: no kept entry validates against the edited file's sha, so the
    // hydrate fresh-parses the EDITED manuscript. Old bodies never come back.
    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
    const record = await getOrHydrateManuscript(MANUSCRIPT_ID);
    const bodies = record!.chapterHints.map((c) => c.body).join('\n');
    expect(bodies).toContain('Edited opener.');
    expect(bodies).not.toContain('Alpha first.');
  });

  it('a stale-body restructure whose state.json write fails keeps the hints file, so reverting the edit before a restart still hydrates the landed structure', async () => {
    const merge = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(merge.status).toBe(200);

    editManuscriptOnDisk();
    const stateBefore = readFileSync(statePath());

    stateWriteSpy.fail = true;
    const reorder = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(500);
    stateWriteSpy.fail = false;
    expect(readFileSync(statePath()).equals(stateBefore)).toBe(true);

    // The edit is reverted before the restart: the kept entry validates again,
    // so removing it before the failed state write would lose the merged structure.
    writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

    const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
    removeManuscript(MANUSCRIPT_ID);
    const record = await getOrHydrateManuscript(MANUSCRIPT_ID);
    expect(record?.chapterHints).toHaveLength(readStateUuids().length);
    expect(record!.chapterHints[0]!.body).toContain('Alpha first.');
    expect(record!.chapterHints[0]!.body).toContain('Beta first.');
    expect(record!.chapterHints[1]!.body).toContain('Gamma first.');
  });

  it('a stale-body restructure whose state.json write lands removes the stale hints file', async () => {
    const merge = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] });
    expect(merge.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(true);

    editManuscriptOnDisk();

    const reorder = await request(app)
      .post(`/api/books/${bookId}/chapters/reorder`)
      .send({ order: [2, 1] });
    expect(reorder.status).toBe(200);
    expect(existsSync(hintsPath())).toBe(false);
  });
});
