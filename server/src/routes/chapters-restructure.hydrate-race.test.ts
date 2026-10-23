/* #3711 PR #3714 review pass 6 -- `getOrHydrateManuscript` reads and parses the
   manuscript with no lock held. A hydrate whose READ precedes a locked change
   to the manuscript (a bundle overwrite's eviction, replace-manuscript's
   `putManuscript`) and whose cache WRITE follows it used to reinstate the
   superseded record; the restructure commit then built `state.chapters` from
   it, and every later analysis start read it until a restart.

     R1 -- a merge's prep hydrates the OLD text; a same-id bundle overwrite
           lands during the parse; the merge must use the bundle's chapters.
     R2 -- a bare cold hydrate (GET /state, an analysis start) is in flight
           during a same-id overwrite; the store must hold the new text after.
     R4 -- replace-manuscript lands during the merge prep's parse.

   The parse of the OLD buffer is gated so each race is deterministic. Each
   case runs the real routes and `importPortableBundle`. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';

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
      if (gate.armed && args.buffer?.toString('utf8').includes('Alpha first')) {
        gate.armed = false;
        gate.entered?.();
        await gate.release;
      }
      return real.parseManuscript(args);
    },
  };
});

const AUTHOR = 'Hydrate Race';
const SERIES = 'S';
const TITLE = 'Race Book';
const OLD_BODY =
  '# Chapter One\n\nAlpha first.\n\n# Chapter Two\n\nBeta first.\n\n# Chapter Three\n\nGamma first.\n';
const NEW_BODY =
  '# New 1\n\nOne.\n\n# New 2\n\nTwo.\n\n# New 3\n\nThree.\n\n# New 4\n\nFour.\n\n# New 5\n\nFive.\n';

let workspaceRoot: string;
let app: Express;
let bookDir: string;
let bookId: string;
let manuscriptId: string;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let portable: typeof import('../import/scan-import-folder.js');
let store: typeof import('../store/manuscripts.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-hydrate-race-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  portable = await import('../import/scan-import-folder.js');
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

const chapters = (titles: string[]) =>
  titles.map((title, i) => ({ id: i + 1, title, slug: `${String(i + 1).padStart(2, '0')}-x` }));

function stateFor(titles: string[]): Record<string, unknown> {
  return {
    bookId,
    manuscriptId,
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.md',
    castConfirmed: false,
    chapters: chapters(titles),
    coverGradient: ['#000', '#fff'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    language: 'en',
  };
}

/* A unique id per case: the analysis cache under server/handoff persists across runs. */
function seedOld(tag: string): void {
  manuscriptId = `m_hydrate_race_${tag}_${Date.now()}`;
  bookDir = join(paths.BOOKS_ROOT, AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), OLD_BODY);
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify(stateFor(['Chapter One', 'Chapter Two', 'Chapter Three'])),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: [] }));
}

function bundle(): Promise<Buffer> {
  const state = stateFor(['New 1', 'New 2', 'New 3', 'New 4', 'New 5']);
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1 })), 'MANIFEST.json');
    zip.addBuffer(Buffer.from(JSON.stringify(state)), 'state.json');
    zip.addBuffer(Buffer.from(NEW_BODY), 'manuscript.md');
    zip.end();
  });
}

const stateChapters = (): string[] =>
  (
    JSON.parse(readFileSync(paths.stateJsonPath(bookDir), 'utf8')) as {
      chapters: Array<{ title: string }>;
    }
  ).chapters.map((c) => c.title);

/** Hold the next parse of the OLD manuscript until `release` is called. */
function armGate(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  gate.release = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (gate.entered = r));
  gate.armed = true;
  return { entered, release };
}

describe('a hydrate that straddles a manuscript change does not reinstate the old record', () => {
  it('control: overwrite, then merge, builds the chapter list from the bundle', async () => {
    seedOld('ctrl');
    await portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' });
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] });
    expect(res.status).toBe(200);
    expect(stateChapters()).toEqual(['New 1', 'New 2', 'New 4', 'New 5']);
  });

  it('R1: a same-id bundle overwrite during the merge prep parse -- the merge uses the bundle', async () => {
    seedOld('r1');
    const g = armGate();
    const merged = request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] })
      .then((r) => r);
    try {
      await g.entered; // the prep's hydrate has read the OLD manuscript and is parsing
      await portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' });
    } finally {
      g.release();
    }
    const res = await merged;
    expect(res.status).toBe(200);
    expect(stateChapters()).toEqual(['New 1', 'New 2', 'New 4', 'New 5']);
    expect(store.getManuscript(manuscriptId)?.sourceText ?? '').not.toContain('Alpha first');
  });

  it('R2: a cold hydrate in flight during a same-id overwrite leaves the new text in the store', async () => {
    seedOld('r2');
    const g = armGate();
    const hydrate = store.getOrHydrateManuscript(manuscriptId);
    try {
      await g.entered;
      await portable.importPortableBundle(await bundle(), { onConflict: 'overwrite' });
    } finally {
      g.release();
    }
    const first = await hydrate;
    expect(first?.sourceText).not.toContain('Alpha first');
    const next = await store.getOrHydrateManuscript(manuscriptId); // what the next analysis start reads
    expect(next?.sourceText).toContain('Five.');
    expect(next?.chapterHints).toHaveLength(5);
  });

  it('R4: replace-manuscript during the merge prep parse -- the merge uses the new manuscript', async () => {
    seedOld('r4');
    const g = armGate();
    const merged = request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [2, 3] })
      .then((r) => r);
    try {
      await g.entered;
      const rep = await request(app)
        .post(`/api/books/${bookId}/replace-manuscript`)
        .attach('file', Buffer.from(NEW_BODY), 'new.md');
      expect(rep.status).toBe(200);
    } finally {
      g.release();
    }
    const res = await merged;
    expect(res.status).toBe(200);
    expect(stateChapters()).toHaveLength(4);
    expect(store.getManuscript(manuscriptId)?.sourceText ?? '').not.toContain('Alpha first');
  });
});
