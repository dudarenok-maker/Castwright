import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';
import type { BookJobKind } from '../workspace/book-op-lock.js';

/* #3774 — the six chapter-restructure routes (POST /:bookId/chapters/{merge,
   split,reorder,exclude,refresh-titles} and /:id/rename) and the single-chapter
   exclude toggle (POST /:bookId/chapters/:chapterId/exclude) rewrite or delete
   chapter audio while a registered long job (a render finalizing a take) may
   still be writing it. All must refuse with 409 `book_busy` while ANY long job
   is registered for the book (any `BookJobKind`) — the way reparse/replace
   (#3717) and rename/DELETE (#3711) already do. The check is the FIRST statement
   inside the `withBookOp` callback; `runBookJob` registers its token inside its
   own `withBookOp`, so a check made there cannot race a registration.

   Jobs are registered the real way — `runBookJob(bookId, kind, () => gate)` —
   never via `__addBookJobToken`. Modelled on book-state.reparse-busy.test.ts. */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Restructure Busy';
const SERIES = 'Standalones';
const TITLE = 'Busy Chapters Book';
const MANUSCRIPT_ID = 'm_restructure_exclude_busy_test';

const MANUSCRIPT_BODY =
  '# Chapter One\n\nAlpha first.\nAlpha second.\n\n# Chapter Two\n\nBeta first.\nBeta second.\n\n# Chapter Three\n\nGamma first.\nGamma second.\n';

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let app: Express;
let bookId: string;
let cachePath: string;
let bookOp: typeof import('../workspace/book-op-lock.js');
let bookJobs: typeof import('../workspace/book-jobs.js');
let fileLock: typeof import('../workspace/file-lock.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-restructure-busy-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential, not `Promise.all` — a Promise.all of dynamic imports races (#2083). */
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  bookJobs = await import('../workspace/book-jobs.js');
  fileLock = await import('../workspace/file-lock.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
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

const statePath = () => join(bookDir, '.audiobook', 'state.json');
const editsPath = () => join(bookDir, '.audiobook', 'manuscript-edits.json');
const audioFile = (slug: string) => join(audioRoot, `${slug}.mp3`);

beforeEach(async () => {
  writeFileSync(
    statePath(),
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
  writeFileSync(
    editsPath(),
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
  rmSync(audioRoot, { recursive: true, force: true });
  mkdirSync(audioRoot, { recursive: true });
  for (const slug of ['01-chapter-one', '02-chapter-two', '03-chapter-three']) {
    writeFileSync(audioFile(slug), `audio-${slug}`);
    writeFileSync(join(audioRoot, `${slug}.segments.json`), JSON.stringify({ segments: [] }));
  }
  rmSync(join(bookDir, '.audiobook', 'manuscript-hints.json'), { force: true });
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
  const { removeManuscript } = await import('../store/manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
});

/** Register a long job of `kind` that runs until `finish()` — through the real `runBookJob`. */
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

/** The #3774 race: hold `book-op`, queue `runBookJob('render')` behind it, fire `route`
 *  so it queues BEHIND the job, then release. The route's locked span therefore runs
 *  with the job already registered — only a check made INSIDE `withBookOp` sees it. */
async function raceJobAheadOfRoute(
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
  const jobP = bookJobs.runBookJob(bookId, 'render', () => jobGate);
  await waitUntil(() => bookOpWaiters() >= 1, 'the render job to queue on book-op');
  const routeP = Promise.resolve(route());
  await waitUntil(() => bookOpWaiters() >= 2, 'the route to queue on book-op behind the job');
  release();
  const res = await routeP;
  const reg = await jobP;
  if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
  return {
    res,
    finishJob: async () => {
      openJob();
      await reg.done;
    },
  };
}

/** Everything a refusal must leave byte-identical. */
function snapshot(): string {
  return JSON.stringify({
    state: readFileSync(statePath(), 'utf8'),
    edits: readFileSync(editsPath(), 'utf8'),
    audio: ['01-chapter-one', '02-chapter-two', '03-chapter-three'].map((s) => [
      existsSync(audioFile(s)) ? readFileSync(audioFile(s), 'utf8') : null,
      existsSync(join(audioRoot, `${s}.segments.json`)),
    ]),
  });
}

const RESTRUCTURE_ROUTES: Array<[string, string, unknown]> = [
  ['merge', 'chapters/merge', { chapterIds: [2, 3] }],
  ['split', 'chapters/split', { chapterId: 2, afterSentenceId: 1 }],
  ['reorder', 'chapters/reorder', { order: [3, 1, 2] }],
  ['bulk exclude', 'chapters/exclude', { chapterIds: [2], excluded: true }],
  ['rename', 'chapters/2/rename', { title: 'Renamed' }],
  ['refresh-titles', 'chapters/refresh-titles', {}],
];

const post = (path: string, body: unknown) =>
  request(app)
    .post(`/api/books/${bookId}/${path}`)
    .send(body as object);

describe('#3774 — restructure refuses with 409 book_busy while a long job is registered', () => {
  it.each(RESTRUCTURE_ROUTES)('(a) %s, render registered → 409 book_busy, nothing touched', async (_n, path, body) => {
    const before = snapshot();
    const render = await holdJob('render');
    try {
      const res = await post(path, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/rendering audio/);
      expect(res.body.error).toMatch(/change the chapters/);
      expect(res.text).not.toContain(workspaceRoot);
      expect(res.text).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
      /* (f) state.json, manuscript-edits.json and every audio file byte-identical… */
      expect(snapshot()).toBe(before);
      /* …and the refusal did not cancel or disturb the registered job. */
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await render.finish();
    }
  });

  it.each(['analysis', 'export', 'scoring', 'design', 'script-review'] as const)(
    '(b) any kind, not just render — merge refuses under a %s job',
    async (kind) => {
      const before = snapshot();
      const job = await holdJob(kind);
      try {
        const res = await post('chapters/merge', { chapterIds: [2, 3] });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('book_busy');
        expect(res.text).not.toContain(workspaceRoot);
        expect(snapshot()).toBe(before);
      } finally {
        await job.finish();
      }
    },
  );

  it('(e) the busy check wins over the transform validation that would otherwise answer 400', async () => {
    const render = await holdJob('render');
    try {
      /* Chapters 99/100 do not exist: unlocked, this is the transform's 400. */
      const res = await post('chapters/merge', { chapterIds: [99, 100] });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
    } finally {
      await render.finish();
    }
    const control = await post('chapters/merge', { chapterIds: [99, 100] });
    expect(control.status).toBe(400);
  });

  it('(f) race — merge queued BEHIND a job that registers while it waits → 409, nothing touched', async () => {
    const before = snapshot();
    const { res, finishJob } = await raceJobAheadOfRoute(() => post('chapters/merge', { chapterIds: [2, 3] }));
    try {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(snapshot()).toBe(before);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await finishJob();
    }
  });

  it('(f) race — bulk exclude queued BEHIND a job that registers while it waits → 409, nothing touched', async () => {
    const before = snapshot();
    const { res, finishJob } = await raceJobAheadOfRoute(() =>
      post('chapters/exclude', { chapterIds: [2], excluded: true }),
    );
    try {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(snapshot()).toBe(before);
    } finally {
      await finishJob();
    }
  });

  it('(g) bulk INCLUDE is refused too — its prune pass renumbers and moves audio', async () => {
    expect((await post('chapters/exclude', { chapterIds: [2], excluded: true })).status).toBe(200);
    const before = snapshot();
    const render = await holdJob('render');
    try {
      const res = await post('chapters/exclude', { chapterIds: [2], excluded: false });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(snapshot()).toBe(before);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await render.finish();
    }
  });

  it('(c) control — once the job is released, merge proceeds', async () => {
    const render = await holdJob('render');
    await render.finish();
    expect(bookOp.bookJobKinds(bookId)).toEqual([]);
    const res = await post('chapters/merge', { chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(statePath(), 'utf8')).chapters).toHaveLength(2);
  });
});

describe('#3774 — single-chapter exclude refuses with 409 book_busy while a long job is registered', () => {
  const exclude = (id: number, excluded: boolean) =>
    request(app).post(`/api/books/${bookId}/chapters/${id}/exclude`).send({ excluded });

  it('(a) render registered → 409 book_busy, audio and state untouched, job still registered', async () => {
    const before = snapshot();
    const render = await holdJob('render');
    try {
      const res = await exclude(1, true);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/rendering audio/);
      expect(res.body.error).toMatch(/exclude chapters/);
      expect(res.text).not.toContain(workspaceRoot);
      expect(res.text).not.toContain(JSON.stringify(workspaceRoot).slice(1, -1));
      expect(existsSync(audioFile('01-chapter-one'))).toBe(true);
      expect(snapshot()).toBe(before);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await render.finish();
    }
  });

  it('(b) any kind — an export job also refuses an exclude', async () => {
    const before = snapshot();
    const job = await holdJob('export');
    try {
      const res = await exclude(1, true);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(res.body.error).toMatch(/exporting/);
      expect(snapshot()).toBe(before);
    } finally {
      await job.finish();
    }
  });

  it('(g) include (un-exclude) is NOT refused — it proceeds with a render registered', async () => {
    expect((await exclude(1, true)).status).toBe(200);
    const render = await holdJob('render');
    try {
      const res = await exclude(1, false);
      expect(res.status).toBe(200);
      expect(res.body.excluded).toBeFalsy();
      const chapters = JSON.parse(readFileSync(statePath(), 'utf8')).chapters;
      expect(chapters.find((c: { id: number }) => c.id === 1).excluded).toBeUndefined();
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await render.finish();
    }
  });

  it('(g) race — an include queued BEHIND a job that registers while it waits still proceeds', async () => {
    expect((await exclude(1, true)).status).toBe(200);
    const { res, finishJob } = await raceJobAheadOfRoute(() => exclude(1, false));
    try {
      expect(res.status).toBe(200);
    } finally {
      await finishJob();
    }
  });

  it('(e) the busy check wins over the chapter-not-found 404', async () => {
    const render = await holdJob('render');
    try {
      const res = await exclude(99, true);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
    } finally {
      await render.finish();
    }
    expect((await exclude(99, true)).status).toBe(404);
  });

  it('(f) race — exclude queued BEHIND a job that registers while it waits → 409, audio survives', async () => {
    const before = snapshot();
    const { res, finishJob } = await raceJobAheadOfRoute(() => exclude(1, true));
    try {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('book_busy');
      expect(existsSync(audioFile('01-chapter-one'))).toBe(true);
      expect(snapshot()).toBe(before);
      expect(bookOp.bookJobKinds(bookId)).toEqual(['render']);
    } finally {
      await finishJob();
    }
  });

  it('(c) control — with no job registered, exclude proceeds and deletes the chapter audio', async () => {
    const res = await exclude(1, true);
    expect(res.status).toBe(200);
    expect(res.body.excluded).toBe(true);
    expect(existsSync(audioFile('01-chapter-one'))).toBe(false);
  });
});
