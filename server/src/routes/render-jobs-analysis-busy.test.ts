import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { BookJobKind } from '../workspace/book-op-lock.js';

/* #3436 (owner decision 2026-11-21) -- generation, chapter splice and chapter QA repair each
   rebuild the analysis cache mid-run, so each is refused with a 409 `book_busy` while an ANALYSIS
   job is registered for the book. The refusal is made atomically with the render's own
   registration (`runBookJob`'s `refuseIfLive`, inside book-op) and BEFORE any SSE header is
   flushed, so the client gets a plain JSON 409. A render of another book, and any non-analysis
   job kind, is unaffected. Jobs are registered the real way (`runBookJob(bookId, kind, gate)`). */

const AUTHOR = 'Render Busy';
const SERIES = 'Standalones';
const TITLE = 'Render Busy Book';
const OTHER_TITLE = 'Render Busy Other Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let otherBookId: string;
let bookJobs: typeof import('../workspace/book-jobs.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-render-busy-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential, not `Promise.all` -- a Promise.all of dynamic imports races (#2083). */
  const { generationRouter } = await import('./generation.js');
  const { chapterSpliceRouter } = await import('./chapter-splice.js');
  const { chapterQaRepairRouter } = await import('./chapter-qa-repair.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookJobs = await import('../workspace/book-jobs.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  otherBookId = makeBookId(AUTHOR, SERIES, OTHER_TITLE);
  for (const [id, title] of [
    [bookId, TITLE],
    [otherBookId, OTHER_TITLE],
  ]) {
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: id,
        manuscriptId: `m_render_busy_${title}`,
        title,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: true,
        language: 'en',
        chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
  }
  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
  app.use('/api/books', chapterSpliceRouter);
  app.use('/api/books', chapterQaRepairRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/** Register a held job of `kind` for `forBookId`; resolves to a release function. */
async function holdJob(forBookId: string, kind: BookJobKind): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const registered = await bookJobs.runBookJob(forBookId, kind, () => gate);
  if (typeof registered === 'symbol') throw new Error('book not found');
  return () => {
    release();
  };
}

const ROUTES: { name: string; send: (id: string) => request.Test }[] = [
  {
    name: 'generation',
    send: (id) =>
      request(app).post(`/api/books/${id}/generation`).send({ modelKey: 'coqui-xtts-v2', chapterIds: [1] }),
  },
  {
    name: 'splice',
    send: (id) =>
      request(app)
        .post(`/api/books/${id}/chapters/1/splice`)
        .send({ mode: 'rerecord', characterId: 'narr', modelKey: 'coqui-xtts-v2' }),
  },
  {
    name: 'qa-repair',
    send: (id) =>
      request(app).post(`/api/books/${id}/chapters/1/audio-qa-repair`).send({ dryRun: false }),
  },
];

/* Owner decision 2026-11-21 (#3436): only the modes that REBUILD the analysis cache are refused.
   A splice `remix` (loudness fix) and a QA-repair `dryRun` scan never rebuild it, so they stay
   allowed during an analysis. */
const ALLOWED_ROUTES: typeof ROUTES = [
  {
    name: 'splice remix (loudness fix)',
    send: (id) =>
      request(app)
        .post(`/api/books/${id}/chapters/1/splice`)
        .send({ mode: 'remix', characterId: 'narr', gainDb: 3 }),
  },
  {
    name: 'qa-repair dryRun scan',
    send: (id) => request(app).post(`/api/books/${id}/chapters/1/audio-qa-repair`).send({}),
  },
];

describe('#3436 render jobs are refused while an analysis job is live', () => {
  let releases: Array<() => void> = [];
  beforeEach(() => {
    for (const r of releases) r();
    releases = [];
  });

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('409 book_busy (JSON, not SSE) while an analysis job is registered for the book', async () => {
        releases.push(await holdJob(bookId, 'analysis'));
        const res = await route.send(bookId);
        expect(res.status).toBe(409);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.body.code).toBe('book_busy');
        expect(res.body.error).toMatch(/analysing/);
        expect(res.body.error).toMatch(/not started/);
      });

      it('control: another book\'s analysis does not refuse it', async () => {
        releases.push(await holdJob(otherBookId, 'analysis'));
        const res = await route.send(bookId);
        expect(res.body?.code).not.toBe('book_busy');
        expect(res.status).toBe(200);
      });

      it('control: a non-analysis job (render) on the same book does not refuse it', async () => {
        releases.push(await holdJob(bookId, 'render'));
        const res = await route.send(bookId);
        expect(res.body?.code).not.toBe('book_busy');
        expect(res.status).toBe(200);
      });
    });
  }

  for (const route of ALLOWED_ROUTES) {
    it(`${route.name} is ALLOWED while an analysis job is registered (it never rebuilds the cache)`, async () => {
      releases.push(await holdJob(bookId, 'analysis'));
      const res = await route.send(bookId);
      expect(res.body?.code).not.toBe('book_busy');
      expect(res.status).toBe(200);
    });
  }
});
