/* #3700 — every state.json read-modify-write takes the per-book state-json lock,
   not just the render path. Two concurrent chapter-exclude toggles on one book
   are each a whole-file read-modify-write; unserialised, the second writer's
   snapshot predates the first writer's landing, so the first toggle is silently
   reverted. The interleave is FORCED, not hoped for: the first state.json write
   is held back, so a second request's read (if the lock lets it run) happens
   before that write lands. RED with `withStateJsonLock` removed from
   `updateStateJsonLocked`, GREEN with it. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const writes = { stateWrites: 0 };
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, value: unknown, opts?: Parameters<typeof actual.writeJsonAtomic>[2]) => {
      if (path.endsWith('state.json')) {
        writes.stateWrites += 1;
        if (writes.stateWrites === 1) await new Promise((r) => setTimeout(r, 400));
      }
      return actual.writeJsonAtomic(path, value, opts);
    },
  };
});

const AUTHOR = 'Concurrent Test';
const SERIES = 'Standalones';
const TITLE = 'Concurrent State Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let statePath: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-concurrent-state-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  statePath = join(bookDir, '.audiobook', 'state.json');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

/* Re-seeded per attempt: the forced delay keys off a module-level write counter,
   so a retried attempt (vitest retry) must start from the same fixture and a
   zeroed counter or it would run with no delay and pass vacuously. */
beforeEach(() => {
  writes.stateWrites = 0;
  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      chapters: [
        { id: 1, title: 'One', slug: '01-one', duration: '0:00', uuid: 'u-1' },
        { id: 2, title: 'Two', slug: '02-two', duration: '0:00', uuid: 'u-2' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /:bookId/chapters/:chapterId/exclude — concurrent toggles (#3700)', () => {
  it('both chapters stay excluded when two toggles run at once', async () => {
    const toggle = (chapterId: number) =>
      request(app).post(`/api/books/${bookId}/chapters/${chapterId}/exclude`).send({ excluded: true });
    const [a, b] = await Promise.all([toggle(1), toggle(2)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      chapters: Array<{ id: number; excluded?: boolean }>;
    };
    for (const id of [1, 2]) {
      expect(state.chapters.find((c) => c.id === id)?.excluded, `chapter ${id} exclusion lost`).toBe(true);
    }
  });
});
