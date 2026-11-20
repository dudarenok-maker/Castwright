import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

/* Pass-through spy on the registration entry point: records the kind each route registers under, so
   the symmetric refusal (owner decision 2) is pinned at the one place it is decided. */
const registeredKinds: Array<{ bookId: string; kind: string }> = [];
vi.mock('../workspace/book-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-jobs.js')>();
  return {
    ...actual,
    runBookJob: ((bookId: string, kind: string, ...rest: unknown[]) => {
      registeredKinds.push({ bookId, kind });
      return (actual.runBookJob as (...a: unknown[]) => unknown)(bookId, kind, ...rest);
    }) as typeof actual.runBookJob,
  };
});

const AUTHOR = 'Render Busy';
const SERIES = 'Standalones';
const TITLE = 'Render Busy Book';
const OTHER_TITLE = 'Render Busy Other Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let otherBookId: string;
let bookJobs: typeof import('../workspace/book-jobs.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let fileLock: typeof import('../workspace/file-lock.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-render-busy-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential, not `Promise.all` -- a Promise.all of dynamic imports races (#2083). */
  const { generationRouter } = await import('./generation.js');
  const { chapterSpliceRouter } = await import('./chapter-splice.js');
  const { chapterQaRepairRouter } = await import('./chapter-qa-repair.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookJobs = await import('../workspace/book-jobs.js');
  bookOp = await import('../workspace/book-op-lock.js');
  fileLock = await import('../workspace/file-lock.js');
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

/** Hang guard, not a synchroniser: fails with a NAMED error rather than a bare testTimeout. */
async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function bookOpWaiters(): number {
  return (fileLock as unknown as { __keyWaitersForTest: (k: string) => number }).__keyWaitersForTest(
    `book-op:${bookId}`,
  );
}

/** The race (modelled on `raceJobAheadOfRoute`, chapters-restructure-exclude.busy.test.ts): hold
 *  `book-op`, queue `runBookJob('analysis')` behind it, fire `route` so it queues BEHIND the
 *  analysis, then release. The route's registration span therefore runs with the analysis already
 *  registered -- only a refusal checked INSIDE `withBookOp` sees it. */
async function raceAnalysisAheadOfRoute(
  route: () => PromiseLike<request.Response>,
): Promise<{ res: request.Response; finishJob: () => Promise<void> }> {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const held = new Promise<void>((r) => (acquired = r));
  void bookOp.withBookOp(bookId, async () => {
    acquired();
    await open;
  });
  await held;
  let openJob!: () => void;
  const jobGate = new Promise<void>((r) => (openJob = r));
  const jobP = bookJobs.runBookJob(bookId, 'analysis', () => jobGate);
  await waitUntil(() => bookOpWaiters() >= 1, 'the analysis job to queue on book-op');
  const routeP = Promise.resolve(route());
  await waitUntil(() => bookOpWaiters() >= 2, 'the route to queue on book-op behind the analysis');
  release();
  const res = await routeP;
  const reg = await jobP;
  if (typeof reg === 'symbol') throw new Error('test setup: book not found');
  return {
    res,
    finishJob: async () => {
      openJob();
      await reg.done;
    },
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

      it('race: an analysis that registers while the request waits on book-op still refuses it (check is INSIDE the registration span)', async () => {
        const { res, finishJob } = await raceAnalysisAheadOfRoute(() => route.send(bookId));
        try {
          expect(res.status).toBe(409);
          expect(res.body.code).toBe('book_busy');
          expect(bookOp.bookJobKinds(bookId)).toEqual(['analysis']);
        } finally {
          await finishJob();
        }
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

/* Owner decision 2026-11-21 (#3436), symmetric: an ANALYSIS start is refused only by renders that
   rebuild the cache (generation, splice re-record, non-dry-run QA repair), which register as
   `render`. A splice remix and a dry-run scan register under a kind the analysis refusal does not
   match (`audio-fix`), so an analysis start during them is allowed. They still count as a registered
   job for every folder move / delete refusal. */
describe('#3436 the kind each render route registers under (what an analysis start is refused by)', () => {
  const kindOf = async (send: (id: string) => request.Test): Promise<string | undefined> => {
    registeredKinds.length = 0;
    await send(bookId);
    return registeredKinds.find((r) => r.bookId === bookId)?.kind;
  };
  const send = (name: string) => [...ROUTES, ...ALLOWED_ROUTES].find((r) => r.name === name)!.send;

  it.each([
    ['generation', 'render'],
    ['splice', 'render'],
    ['qa-repair', 'render'],
    ['splice remix (loudness fix)', 'audio-fix'],
    ['qa-repair dryRun scan', 'audio-fix'],
  ])('%s registers as %s', async (name, kind) => {
    expect(await kindOf(send(name))).toBe(kind);
  });
});
