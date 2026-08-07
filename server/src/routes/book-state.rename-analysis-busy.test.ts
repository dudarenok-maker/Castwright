/* #2165 — the PRIMARY guard: PUT /:bookId/state refuses with 409 when the
   patch would move the book's folder while an analysis is registered for it.

   Its own file rather than a new case in book-state.test.ts, for two reasons:
   book-state.test.ts is pinned into the single-fork slow tier
   (server/vitest.config.slow.ts) and so is skipped by `npm run test:server` —
   the primary fix's coverage belongs in the fast, pre-push tier; and the
   design-lock busy registry is module-global state this file can own and
   clear without risking a leak into that file's other suites. Same precedent
   as book-state-preserve-voices.test.ts.

   Only the guard is under test here — no analyzer runs. `markAnalysisBusy`
   is exactly what a real run calls at job creation (analysis.ts:2764), so
   driving the registry directly tests the guard at its real seam. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Module-scoped mkdir swap, so the TOCTOU case can act inside the window
   book-state.ts opens between its first guard and renameWithRetry. Same
   pattern as cast-merge-base.test.ts's readFile swap: a hoisted vi.mock (so
   book-state.ts's own binding, taken at ITS module-load time, is the mocked
   one) that delegates to the real impl unless a test installs a spy. */
type MkdirFn = (path: string, opts?: unknown) => Promise<string | undefined>;
let mkdirSpy: MkdirFn | null = null;
let realMkdir: MkdirFn;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: (path: string, opts?: unknown) =>
      (mkdirSpy ?? (actual.mkdir as unknown as MkdirFn))(path, opts),
  };
});

/* After vi.mock, so `mkdtemp` here is the (pass-through) mocked module. */
const { mkdtemp } = await import('node:fs/promises');

const AUTHOR = 'Busy Rename Author';
const SERIES = 'Standalones';
const TITLE = 'Busy Rename Book';
const NEW_TITLE = 'Busy Rename Book Renamed';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;
let newDir: string;
let markAnalysisBusy: (d: string) => void;
let clearAnalysisBusy: (d: string) => void;

beforeAll(async () => {
  const actualFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  realMkdir = actualFsp.mkdir as unknown as MkdirFn;
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-busy-rename-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* Dynamic, after WORKSPACE_DIR — the workspace path module caches its root
     at first import (see book-state.test.ts's own note). */
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  /* Same module instance book-state.ts holds: ESM caches by specifier and
     nothing here calls vi.resetModules(). */
  const designLock = await import('../tts/design-lock.js');
  markAnalysisBusy = designLock.markAnalysisBusy;
  clearAnalysisBusy = designLock.clearAnalysisBusy;

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
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

afterEach(() => {
  mkdirSpy = null;
  /* Belt and braces — a leaked busy entry would make every later case 409.
     clearAnalysisBusy is a decrement, so call it until the map is clean. */
  for (let i = 0; i < 4; i++) clearAnalysisBusy(bookDir);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

describe('#2165 — PUT /:bookId/state refuses a rename while an analysis is registered', () => {
  it('409s a title change and leaves the folder exactly where it was', async () => {
    seedBook();
    markAnalysisBusy(bookDir);

    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: NEW_TITLE } });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/analysis is running/i);
    expect(existsSync(bookDir)).toBe(true);
    expect(existsSync(newDir)).toBe(false);
    /* Nothing was written: state.json still carries the old title. */
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe(TITLE);
  });

  it('still accepts a state patch that moves no folder while the analysis runs', async () => {
    seedBook();
    markAnalysisBusy(bookDir);

    /* The negative control that matters most: the persistence middleware
       autosaves patches like this throughout an analysis. If the guard is
       hoisted above the `newDir !== bookDir` branch, this is the case that
       catches it. */
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { castConfirmed: false, notes: 'still editable' } });

    expect(res.status).toBe(204);
    expect(existsSync(bookDir)).toBe(true);
  });

  it('accepts the same rename once the analysis has cleared', async () => {
    seedBook();
    markAnalysisBusy(bookDir);
    clearAnalysisBusy(bookDir);

    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: NEW_TITLE } });

    expect(res.status).toBe(204);
    expect(existsSync(newDir)).toBe(true);
    expect(existsSync(bookDir)).toBe(false);
  });

  it('refuses when the analysis registers AFTER the first check but before the rename', async () => {
    seedBook();
    /* The TOCTOU window: book-state.ts awaits mkdir between its first guard
       and renameWithRetry. Stub that mkdir to mark the book busy on the way
       through — i.e. simulate a POST /analysis whose markAnalysisBusy lands
       in exactly that window — and the SECOND check must catch it.

       Without this case a mutation that deletes only the second check passes
       every other test in this file. */
    let marked = false;
    mkdirSpy = async (target: string, opts?: unknown) => {
      if (!marked) {
        marked = true;
        markAnalysisBusy(bookDir);
      }
      return realMkdir(target, opts as never);
    };

    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: NEW_TITLE } });

    expect(marked).toBe(true); // the window was actually entered
    expect(res.status).toBe(409);
    expect(existsSync(newDir)).toBe(false);
    expect(existsSync(bookDir)).toBe(true);
  });

  it('keeps the guard ref-counted — a sibling subset job still holds it', async () => {
    seedBook();
    markAnalysisBusy(bookDir); // main
    markAnalysisBusy(bookDir); // subset
    clearAnalysisBusy(bookDir); // main finishes first

    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { title: NEW_TITLE } });

    expect(res.status).toBe(409);
    expect(existsSync(newDir)).toBe(false);
  });
});
