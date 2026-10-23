import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';
import type { BookJobKind } from '../workspace/book-op-lock.js';

/* #3717 — POST /api/books/:bookId/reparse and POST /api/books/:bookId/
   replace-manuscript delete `cast.json` and the `audio/` directory and reset
   revisions while a registered long job may still be writing them. Both
   routes must refuse with 409 `book_busy` while ANY long job is registered
   for the book (any `BookJobKind`, not only `render`) — exactly the way a
   folder rename and a DELETE already refuse (PR #3714 / #3711). The check is
   the FIRST statement inside the `withBookOp` callback, before
   `assertRevisionsResettable`, before the fingerprint check, before any
   write; because `runBookJob` registers its token inside its own `withBookOp`,
   a check made inside a `withBookOp` callback cannot race a registration.

   Jobs are registered the real way — `runBookJob(bookId, kind, () => gate)`,
   the `holdRender` pattern from book-op.read-errors.test.ts — never via
   `__addBookJobToken`. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Reparse Busy';
const SERIES = 'Standalones';
const TITLE = 'Busy Book';
const MANUSCRIPT_ID = 'm_reparse_busy_test';

const ORIGINAL_BODY = `# Chapter One\n\nOne.\nTwo.\n`;
const REPLACEMENT_BODY = `## Fresh Chapter A\n\nAlpha.\n\n## Fresh Chapter B\n\nBeta.\nGamma.\n`;

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;
let bookOp: typeof import('../workspace/book-op-lock.js');
let bookJobs: typeof import('../workspace/book-jobs.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reparse-busy-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential, not `Promise.all` — a Promise.all of dynamic imports races
     (#2083); modelled on book-state.replace-manuscript.test.ts. */
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  bookJobs = await import('../workspace/book-jobs.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  writeFileSync(join(bookDir, 'manuscript.md'), ORIGINAL_BODY);
  if (existsSync(join(bookDir, 'manuscript.epub'))) rmSync(join(bookDir, 'manuscript.epub'), { force: true });
  if (existsSync(join(bookDir, 'manuscript.txt'))) rmSync(join(bookDir, 'manuscript.txt'), { force: true });
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
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'wren',
          name: 'Wren',
          voiceState: 'tuned',
          overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
        },
      ],
    }),
  );
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), 'LIVE');
  for (const f of ['change-log.json', 'cast-reuse-carryover.json', 'revisions.json']) {
    const p = join(bookDir, '.audiobook', f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
});

/** Register a long job of `kind` for `bookId` that runs until `finish()` is
 *  called — the `holdRender` pattern (book-op.read-errors.test.ts), through
 *  the real `runBookJob`; never `__addBookJobToken`. */
async function holdJob(kind: BookJobKind): Promise<{ finish: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reg = await bookJobs.runBookJob(bookId, kind, () => gate);
  if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
  return {
    finish: async () => {
      open();
      await reg.done;
    },
  };
}

describe('#3717 — reparse and replace-manuscript refuse with 409 book_busy while a long job is registered', () => {
  it('(a) reparse, render registered → 409 book_busy, nothing touched, job still registered', async () => {
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const castPath = join(bookDir, '.audiobook', 'cast.json');
    const manuscriptPath = join(bookDir, 'manuscript.md');
    const audioSentinel = join(bookDir, 'audio', '01-chapter-one.mp3');
    const stateBefore = readFileSync(statePath, 'utf8');
    const castBefore = readFileSync(castPath, 'utf8');
    const manuscriptBefore = readFileSync(manuscriptPath, 'utf8');
    const render = await holdJob('render');
    try {
      const res = await request(app).post(`/api/books/${bookId}/reparse`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/rendering audio/);
      expect(res.body.error).toMatch(/re-parse/);
      expect(res.text).not.toContain(workspaceRoot);
      /* Nothing was written: all three files byte-identical and the audio sentinel survives… */
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
      expect(readFileSync(castPath, 'utf8')).toBe(castBefore);
      expect(readFileSync(manuscriptPath, 'utf8')).toBe(manuscriptBefore);
      expect(existsSync(audioSentinel)).toBe(true);
      /* …and the refusal did not cancel or disturb the registered job. */
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await render.finish();
    }
  });

  it('(b) replace-manuscript, render registered → 409 book_busy, nothing written', async () => {
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const castPath = join(bookDir, '.audiobook', 'cast.json');
    const manuscriptPath = join(bookDir, 'manuscript.md');
    const audioSentinel = join(bookDir, 'audio', '01-chapter-one.mp3');
    const stateBefore = readFileSync(statePath, 'utf8');
    const castBefore = readFileSync(castPath, 'utf8');
    const manuscriptBefore = readFileSync(manuscriptPath, 'utf8');
    const render = await holdJob('render');
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/rendering audio/);
      expect(res.text).not.toContain(workspaceRoot);
      /* Nothing was written: all three files byte-identical, the audio sentinel survives… */
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
      expect(readFileSync(castPath, 'utf8')).toBe(castBefore);
      expect(readFileSync(manuscriptPath, 'utf8')).toBe(manuscriptBefore);
      expect(existsSync(audioSentinel)).toBe(true);
      /* …and no temp/backup upload file was ever left in the book dir. */
      expect(readdirSync(bookDir).filter((f) => f.startsWith('.manuscript-'))).toEqual([]);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await render.finish();
    }
  });

  it('(c) any kind, not just render — reparse refuses under an analysis job', async () => {
    const analysis = await holdJob('analysis');
    try {
      const res = await request(app).post(`/api/books/${bookId}/reparse`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/analysing/);
      expect(res.text).not.toContain(workspaceRoot);
    } finally {
      await analysis.finish();
    }
  });

  it('(c) any kind, not just render — replace-manuscript refuses under an export job', async () => {
    const exportJob = await holdJob('export');
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/exporting/);
      expect(res.text).not.toContain(workspaceRoot);
    } finally {
      await exportJob.finish();
    }
  });

  it('(d) the busy check runs BEFORE the newer-schema revisions refusal', async () => {
    const revisionsPath = join(bookDir, '.audiobook', 'revisions.json');
    writeFileSync(revisionsPath, JSON.stringify({ schema: 2, pending: [] }));
    const render = await holdJob('render');
    try {
      const res = await request(app).post(`/api/books/${bookId}/reparse`);
      /* 409 book_busy — NOT the 500 schema=2 refusal that assertRevisionsResettable raises. */
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/rendering audio/);
      expect(res.text).not.toContain('schema=2');
      expect(res.text).not.toContain(workspaceRoot);
    } finally {
      await render.finish();
      /* Drain the cast queue before deleting the fixture, the way
         book-state.reparse.test.ts does (a queued cast arm can outlive the
         response under a mutated route). */
      const { withCastLock } = await import('../workspace/cast-lock.js');
      await withCastLock(bookDir, async () => undefined);
      rmSync(join(bookDir, 'audio'), { recursive: true, force: true });
      rmSync(revisionsPath, { force: true });
    }
  });

  it('(e) control — once the job is released, reparse and replace-manuscript proceed', async () => {
    const castPath = join(bookDir, '.audiobook', 'cast.json');
    const audioSentinel = join(bookDir, 'audio', '01-chapter-one.mp3');
    const render = await holdJob('render');
    await render.finish();
    expect(bookOp.bookJobKinds(bookId)).toEqual([]);

    const reparseRes = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(reparseRes.status).toBe(200);
    expect(existsSync(castPath)).toBe(false);
    expect(existsSync(audioSentinel)).toBe(false);

    /* Re-seed what the reparse deleted, then replace the manuscript. */
    writeFileSync(castPath, JSON.stringify({ characters: [] }));
    const replaceRes = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(REPLACEMENT_BODY), 'revised.md');
    expect(replaceRes.status).toBe(200);
    expect(readFileSync(join(bookDir, 'manuscript.md'), 'utf8')).toBe(REPLACEMENT_BODY);
  });
});


