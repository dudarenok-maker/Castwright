/* #2165 / #3711 — PUT /:bookId/state refuses with 409 when the patch would move
   the book's folder while an analysis is registered for it.

   Since #3711 the registration is the per-book busy registry (`runBookJob`,
   `workspace/book-jobs.ts`), taken under the `book-op` lock that the rename also
   holds -- so registration and move exclude each other, and the old
   "registers between the first check and the rename" window is closed.

   Its own file rather than a new case in book-state.test.ts, for two reasons:
   book-state.test.ts is pinned into the single-fork slow tier
   (server/vitest.config.slow.ts) and so is skipped by `npm run test:server` —
   the primary fix's coverage belongs in the fast, pre-push tier; and the
   registries are module-global state this file can own and clear without
   risking a leak into that file's other suites. Same precedent as
   book-state-preserve-voices.test.ts. */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Busy Rename Author';
const SERIES = 'Standalones';
const TITLE = 'Busy Rename Book';
const NEW_TITLE = 'Busy Rename Book Renamed';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;
let newDir: string;
let clearAnalysisBusy: (d: string) => void;
let runBookJob: typeof import('../workspace/book-jobs.js').runBookJob;
let BOOK_GONE: typeof import('../workspace/book-op-lock.js').BOOK_GONE;
let bookJobKinds: typeof import('../workspace/book-op-lock.js').bookJobKinds;
let keyWaiters: (key: string) => number;
let stateJsonLock: typeof import('../workspace/file-lock.js').withStateJsonLock;
let stateJsonPath: (dir: string) => string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-busy-rename-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* Dynamic, after WORKSPACE_DIR — the workspace path module caches its root
     at first import (see book-state.test.ts's own note). */
  const { bookStateRouter } = await import('./book-state.js');
  const paths = await import('../workspace/paths.js');
  stateJsonPath = paths.stateJsonPath;
  /* Same module instances book-state.ts holds: ESM caches by specifier and
     nothing here calls vi.resetModules(). */
  const designLock = await import('../tts/design-lock.js');
  clearAnalysisBusy = designLock.clearAnalysisBusy;
  runBookJob = (await import('../workspace/book-jobs.js')).runBookJob;
  const opLock = await import('../workspace/book-op-lock.js');
  BOOK_GONE = opLock.BOOK_GONE;
  bookJobKinds = opLock.bookJobKinds;
  const fileLock = await import('../workspace/file-lock.js');
  keyWaiters = fileLock.__keyWaitersForTest;
  stateJsonLock = fileLock.withStateJsonLock;

  bookId = paths.makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function seedBook(): void {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder body');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_busy_rename',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

/* Registers an `analysis` job for the book exactly as analysis.ts will (task 4),
   and keeps it registered until the returned release() is called. */
const releases: Array<() => Promise<void>> = [];
async function registerAnalysis(): Promise<() => Promise<void>> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const registered = await runBookJob(bookId, 'analysis', async () => {
    await gate;
  });
  if (registered === BOOK_GONE) throw new Error('book vanished before registration');
  const release = async () => {
    open();
    await registered.done;
  };
  releases.push(release);
  return release;
}

afterEach(async () => {
  /* Belt and braces — a leaked registration would make every later case 409. */
  for (const release of releases.splice(0)) await release();
  for (let i = 0; i < 4; i++) clearAnalysisBusy(bookDir);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

function renameRequest() {
  return request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch: { title: NEW_TITLE } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('#2165 — PUT /:bookId/state refuses a rename while an analysis is registered', () => {
  it('409s a title change and leaves the folder exactly where it was', async () => {
    seedBook();
    await registerAnalysis();

    const res = await renameRequest();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/analysis is running/i);
    expect(res.body.code).toBe('book_busy');
    expect(existsSync(bookDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
    /* Nothing was written: state.json still carries the old title. */
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe(TITLE);
  });

  it('still accepts a state patch that moves no folder while the analysis runs', async () => {
    seedBook();
    await registerAnalysis();

    /* The negative control that matters most: the persistence middleware
       autosaves patches like this throughout an analysis. If the guard is
       hoisted above the `newDir !== bookDir` branch, this is the case that
       catches it. */
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { castConfirmed: false, notes: 'still editable' } });

    expect(res.status).toBe(200);
    expect(existsSync(bookDir)).toBe(true);
  });

  it('accepts the same rename once the analysis has cleared', async () => {
    seedBook();
    const release = await registerAnalysis();
    await release();
    expect(bookJobKinds(bookId)).toEqual([]);

    const res = await renameRequest();

    expect(res.status).toBe(200);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('an analysis registration queued behind a rename starts on the NEW folder', async () => {
    seedBook();
    /* Park the rename inside book-op by holding the book's state-json lock, then
       queue an analysis registration on book-op behind it. Registration and move
       now exclude each other: the registration resolves AFTER the move, so its
       lease names the renamed folder -- the #2165 residual (a job pinned to the
       pre-rename path) is closed. */
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let acquired!: () => void;
    const held = new Promise<void>((r) => (acquired = r));
    void stateJsonLock(stateJsonPath(bookDir), async () => {
      acquired();
      await gate;
    });
    await held;
    const renameP = Promise.resolve(renameRequest() as unknown as PromiseLike<request.Response>);
    while (keyWaiters(`state-json:${stateJsonPath(bookDir)}`) < 1) await sleep(5);
    let leaseDir = '';
    const registeredP = runBookJob(bookId, 'analysis', async (lease) => {
      leaseDir = lease.bookDir;
    });
    while (keyWaiters(`book-op:${bookId}`) < 1) await sleep(5);
    open();
    const [renameRes, registered] = await Promise.all([renameP, registeredP]);
    expect(renameRes.status).toBe(200);
    if (registered === BOOK_GONE) throw new Error('book vanished');
    await registered.done;

    expect(leaseDir).toBe(newDir);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('keeps the guard ref-counted — a sibling subset job still holds it', async () => {
    seedBook();
    const releaseMain = await registerAnalysis();
    await registerAnalysis(); // subset
    await releaseMain(); // main finishes first

    const res = await renameRequest();

    expect(res.status).toBe(409);
    expect(existsSync(newDir)).toBe(false);
  });

  it('reports analysis-busy 409 when both analysis is running AND destination path exists', async () => {
    seedBook();
    /* Set up both preconditions: register the analysis AND create the destination
       folder so the path is taken. The guard order test: when both conditions
       hold simultaneously, the busy refusal comes FIRST, so the caller receives
       the analysis-busy 409, not the path-collision 409. */
    await registerAnalysis();
    mkdirSync(newDir, { recursive: true });

    const res = await renameRequest();

    expect(res.status).toBe(409);
    /* Assert the analysis-busy message specifically, not just any 409 — this
       pins the guard precedence. Both branches return 409; without the message
       check this test passes under either guard order and proves nothing. */
    expect(res.body.error).toMatch(/analysis is running/i);
    expect(res.body.code).toBe('book_busy');
    expect(existsSync(bookDir)).toBe(true);
    expect(existsSync(newDir)).toBe(true); // destination remains untouched
    /* Nothing was written: state.json still carries the old title. */
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe(TITLE);
  });

  it('a non-analysis job names what is running and keeps the folder in place', async () => {
    seedBook();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const registered = await runBookJob(bookId, 'render', async () => {
      await gate;
    });
    if (registered === BOOK_GONE) throw new Error('book vanished');
    releases.push(async () => {
      open();
      await registered.done;
    });

    const res = await renameRequest();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_busy');
    expect(res.body.error).toMatch(/rendering audio/i);
    expect(existsSync(bookDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
  });
});

describe('#3625 — PUT /:bookId/state rename waits on the old dir state lock', () => {
  it('does not move the folder while the lock is held, then renames', async () => {
    seedBook();
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const { stateJsonPath: stateJsonPathForLock } = await import('../workspace/paths.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = withStateJsonLock(stateJsonPathForLock(bookDir), async () => {
      acquired();
      await gate;
    });
    await got;
    try {
      const p = request(app)
        .put(`/api/books/${bookId}/state`)
        .set('Content-Type', 'application/json')
        .send({ slice: 'state', patch: { title: NEW_TITLE } })
        .then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      expect(existsSync(bookDir)).toBe(true);
      expect(existsSync(newDir)).toBe(false);
      release();
      const [res] = await Promise.all([p, held]);
      expect(res.status).toBe(200);
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(bookDir)).toBe(false);
    } finally {
      release();
      await held;
    }
  });
});
