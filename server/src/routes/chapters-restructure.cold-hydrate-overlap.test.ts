/* #3703 -- a cold hydrate that overlaps a restructure (or an exclude toggle) must
   not overwrite the changed record. The hydrate guard in `getOrHydrateManuscript`
   compares a per-id put/remove version, which an in-place mutation of the cached
   record cannot move; both routes now replace the record through
   `putManuscript` instead.

     C1 -- a merge lands while a bare cold hydrate is parsing; the store keeps
           the merged hints (2), not the hydrate's fresh parse (3).
     C2 -- the same shape for the exclude toggle: the excluded flag survives.

   The first parse is gated so each race is deterministic. Real routes. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const gate = vi.hoisted(() => ({
  armed: false,
  entered: null as null | (() => void),
  release: null as null | Promise<void>,
}));

vi.mock('../parsers/index.js', async (orig) => {
  const real = (await orig()) as typeof import('../parsers/index.js');
  return {
    ...real,
    parseManuscript: async (args: Parameters<typeof real.parseManuscript>[0]) => {
      if (gate.armed) {
        gate.armed = false;
        gate.entered?.();
        await gate.release;
      }
      return real.parseManuscript(args);
    },
  };
});

const AUTHOR = 'Cold Overlap';
const SERIES = 'S';
const TITLE = 'Overlap Book';
const BODY =
  '# Chapter One\n\nAlpha first.\n\n# Chapter Two\n\nBeta first.\n\n# Chapter Three\n\nGamma first.\n';

let workspaceRoot: string;
let app: Express;
let bookDir: string;
let bookId: string;
let manuscriptId: string;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let store: typeof import('../store/manuscripts.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cold-overlap-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  store = await import('../store/manuscripts.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  const { bookStateRouter } = await import('./book-state.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
  app.use('/api/books', bookStateRouter);
  bookId = paths.makeBookId(AUTHOR, SERIES, TITLE);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  gate.armed = false;
  store.removeManuscript(manuscriptId);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  bookOp.__bookDirIndexForTest().clear();
});

function seed(tag: string): void {
  /* A unique id per case: the analysis cache under server/handoff persists across runs. */
  manuscriptId = `m_cold_overlap_${tag}_${Date.now()}`;
  bookDir = join(paths.BOOKS_ROOT, AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), BODY);
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      chapters: ['Chapter One', 'Chapter Two', 'Chapter Three'].map((title, i) => ({
        id: i + 1,
        title,
        slug: `${String(i + 1).padStart(2, '0')}-x`,
      })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      language: 'en',
    }),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: [] }));
}

/** Hold the next parse until `release` is called. */
function armGate(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  gate.release = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (gate.entered = r));
  gate.armed = true;
  return { entered, release };
}

describe('a cold hydrate overlapping a change keeps the changed record', () => {
  it('C1: a merge during a held cold hydrate leaves 2 hints in the store', async () => {
    seed('c1');
    const g = armGate();
    const hydrate = store.getOrHydrateManuscript(manuscriptId);
    try {
      await g.entered; // the bare hydrate has read the 3-chapter state and is parsing
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/merge`)
        .send({ chapterIds: [1, 2] });
      expect(res.status).toBe(200);
      expect(store.getManuscript(manuscriptId)?.chapterHints).toHaveLength(2);
    } finally {
      g.release();
    }
    await hydrate;
    expect(store.getManuscript(manuscriptId)?.chapterHints).toHaveLength(2);
    expect((await store.getOrHydrateManuscript(manuscriptId))?.chapterHints).toHaveLength(2);
  });

  it('C2: an exclude during a held cold hydrate keeps the excluded flag in the store', async () => {
    seed('c2');
    const g = armGate();
    const hydrate = store.getOrHydrateManuscript(manuscriptId);
    try {
      await g.entered;
      /* A second, ungated hydrate warms the store while the first is parked. */
      await store.getOrHydrateManuscript(manuscriptId);
      const res = await request(app)
        .post(`/api/books/${bookId}/chapters/1/exclude`)
        .send({ excluded: true });
      expect(res.status).toBe(200);
    } finally {
      g.release();
    }
    await hydrate;
    expect(store.getManuscript(manuscriptId)?.chapterHints[0].excluded).toBe(true);
  });
});
