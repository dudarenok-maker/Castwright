/* #2099 gap B — mechanism test, NOT a race detector.

   Before #2099, `applyReparse`'s cast.json delete arm read:

     existsSync(castJsonPath(bookDir))
       ? withCastLock(bookDir, () => rm(castJsonPath(bookDir), { force: true }))
       : Promise.resolve();

   The `existsSync` check ran OUTSIDE the lock, in the same synchronous tick
   as the ternary — there is no seam to gate for a genuine interleaving race
   (a real concurrent writer can't land between the check and the lock
   acquisition on demand), so this is NOT a race detector and must not read
   as one. What CAN be pinned mechanically, with no racer and no
   nondeterminism, is that the delete decision is no longer sourced from that
   out-of-lock `existsSync` at all: post-#2099 the arm deletes cast.json
   unconditionally (`rm(..., { force: true })` is already a no-op on a
   missing file), so stubbing `existsSync` to lie and say "cast.json doesn't
   exist" must NOT stop the delete from happening.

   Own file, deliberately (per the #2099 brief) — not folded into
   book-state.reparse.test.ts. That file's own `beforeEach` and nearly every
   assertion call the REAL `existsSync` from `node:fs`; a hoisted
   `vi.mock('node:fs')` there would rebind their copy too. Isolating this
   test in its own module means the mock only has to coexist with the setup
   in THIS file, where it can be filtered to the one path under test. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Hoisted so the wrapped `existsSync` is bound before `book-state.ts` (and
   everything else in the module graph) imports it — same rationale as the
   `readJson` mock in book-state.reparse.test.ts. Defaults to a plain
   passthrough via `vi.fn(actual.existsSync)`, so every OTHER call through
   `node:fs`'s `existsSync` in this file (including `book-state.ts`'s own
   `existsSync(manuscriptPath)` 404/409 guard) behaves exactly as if this
   mock weren't here; only the one test below overrides `mockImplementation`
   for its own duration, then restores it. */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const AUTHOR = 'Reparse GapB Author';
const SERIES = 'Standalones';
const TITLE = 'Reparse GapB Book';
const MANUSCRIPT_ID = 'm_reparse_gapb';

const MANUSCRIPT_BODY = `# Chapter One\n\nFirst sentence.\nSecond sentence.\n\n# Chapter Two\n\nMore text here.\n`;

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-reparse-gapb-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
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

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe("reparse handler — #2099 gap B: the cast.json delete is not gated on an out-of-lock existsSync (mechanism, not a race)", () => {
  it('deletes cast.json even when existsSync lies and says it is already absent', async () => {
    const { castJsonPath } = await import('../workspace/paths.js');
    const fsModule = await import('node:fs');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

    const castPath = castJsonPath(bookDir);
    const manuscriptPath = join(bookDir, 'manuscript.md');
    writeFileSync(
      castPath,
      JSON.stringify({
        characters: [{ id: 'nova', name: 'Nova', role: 'character', color: '#abc', aliases: [] }],
      }),
    );
    expect(actual.existsSync(castPath)).toBe(true);

    const spy = vi.mocked(fsModule.existsSync);
    let sawManuscriptCheck = false;
    let res: request.Response;
    try {
      spy.mockImplementation((path: unknown) => {
        if (path === castPath) return false; // the lie under test
        if (path === manuscriptPath) sawManuscriptCheck = true;
        return actual.existsSync(path as never);
      });

      res = await request(app).post(`/api/books/${bookId}/reparse`);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.existsSync);
    }

    // Filter-scope check, explicit per the #2099 brief: the manuscript-path
    // 404/409 guard at book-state.ts (`existsSync(manuscriptPath)`) shares
    // the same `node:fs` import as the cast-path check under test. If the
    // filter above were loose enough to also lie about the manuscript path,
    // reparse would 409 before ever reaching the cast delete and this test
    // would pass for the wrong reason. Assert both that the manuscript
    // check was actually exercised, AND that reparse proceeded past it.
    expect(sawManuscriptCheck).toBe(true);
    expect(res!.status).toBe(200);

    // The mechanism under test: even though `existsSync` lied and said
    // cast.json was already gone (which, pre-#2099, took the ternary's
    // false branch and skipped the delete entirely), the file is actually
    // deleted — because the delete no longer reads that out-of-lock
    // `existsSync` result at all. Checked with the REAL existsSync (the mock
    // has been restored above), not the still-lying one.
    expect(actual.existsSync(castPath)).toBe(false);
  });
});
