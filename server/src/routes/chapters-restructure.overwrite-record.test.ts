/* #3711 PR #3714 review pass 5 -- a chapter restructure builds the new
   `state.chapters` from the ManuscriptRecord's hints, so the record it uses must
   be the current one for the manuscript the LOCKED state names. A portable
   bundle overwrite replaces `state.json` and the manuscript on disk; two shapes
   used to rebuild the chapter list from the replaced book's hints:

     (a) race, NEW manuscriptId -- the merge prepared (hydrating the old record)
         before an overwrite queued ahead of it on `book-op` landed; the commit
         found the new id cold and fell back to the prepared, stale record;
     (b) no race, SAME manuscriptId -- the record was warm in memory (any open,
         analysis or restructure) and the overwrite never dropped it, so the next
         merge (and the next analysis start) read the replaced text.

   Each case runs the real restructure router and `importPortableBundle`. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';

const AUTHOR = 'Overwrite Record';
const SERIES = 'S';
const TITLE = 'Record Book';
const OLD_BODY =
  '# Chapter One\n\nAlpha first.\n\n# Chapter Two\n\nBeta first.\n\n# Chapter Three\n\nGamma first.\n';
const NEW_BODY =
  '# New 1\n\nOne.\n\n# New 2\n\nTwo.\n\n# New 3\n\nThree.\n\n# New 4\n\nFour.\n\n# New 5\n\nFive.\n';

let workspaceRoot: string;
let app: Express;
let bookDir: string;
let bookId: string;
let paths: typeof import('../workspace/paths.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let portable: typeof import('../import/scan-import-folder.js');
let store: typeof import('../store/manuscripts.js');
let fileLock: typeof import('../workspace/file-lock.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-overwrite-record-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  portable = await import('../import/scan-import-folder.js');
  store = await import('../store/manuscripts.js');
  fileLock = await import('../workspace/file-lock.js');
  const { chaptersRestructureRouter } = await import('./chapters-restructure.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
  bookId = paths.makeBookId(AUTHOR, SERIES, TITLE);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  for (const id of ['m_old', 'm_new', 'm_same']) store.removeManuscript(id);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  bookOp.__bookDirIndexForTest().clear();
});

const chapters = (titles: string[]) =>
  titles.map((title, i) => ({ id: i + 1, title, slug: `${String(i + 1).padStart(2, '0')}-x` }));

function stateFor(manuscriptId: string, titles: string[]): Record<string, unknown> {
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

/** The old book: three chapters under `manuscriptId`. */
function seedOld(manuscriptId: string): void {
  bookDir = join(paths.BOOKS_ROOT, AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), OLD_BODY);
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify(stateFor(manuscriptId, ['Chapter One', 'Chapter Two', 'Chapter Three'])),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: [] }));
}

/** A portable bundle of the same book with five chapters under `manuscriptId`. */
function bundleFor(manuscriptId: string): Promise<Buffer> {
  const state = stateFor(manuscriptId, ['New 1', 'New 2', 'New 3', 'New 4', 'New 5']);
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
  (JSON.parse(readFileSync(paths.stateJsonPath(bookDir), 'utf8')) as { chapters: Array<{ title: string }> }).chapters.map(
    (c) => c.title,
  );

const merge = () =>
  request(app)
    .post(`/api/books/${bookId}/chapters/merge`)
    .send({ chapterIds: [2, 3] })
    .then((r) => r);

async function waitForWaiters(n: number, release: () => void): Promise<void> {
  const deadline = Date.now() + 8000;
  while (fileLock.__keyWaitersForTest(`book-op:${bookId}`) < n) {
    if (Date.now() > deadline) {
      release();
      throw new Error(`timed out waiting for ${n} book-op waiter(s)`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('(a) a merge prepared before a bundle overwrite with a NEW manuscriptId', () => {
  it('control: overwrite, then merge -- the bundle manuscript is merged (5 -> 4)', async () => {
    seedOld('m_old');
    await portable.importPortableBundle(await bundleFor('m_new'), { onConflict: 'overwrite' });
    const res = await merge();
    expect(res.status).toBe(200);
    expect(stateChapters()).toHaveLength(4);
  });

  it('race: the merge commits against the bundle manuscript, not the record it prepared', async () => {
    seedOld('m_old');
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const holding = new Promise<void>((r) => (entered = r));
    const holder = bookOp.withBookOp(bookId, () => {
      entered();
      return open;
    });
    let overwrite!: Promise<unknown>;
    let merged!: Promise<request.Response>;
    try {
      await holding;
      overwrite = bundleFor('m_new').then((b) => portable.importPortableBundle(b, { onConflict: 'overwrite' }));
      await waitForWaiters(1, release);
      /* The merge's prep peeks the OLD book and hydrates its record, then queues. */
      merged = merge();
      await waitForWaiters(2, release);
      expect(store.getManuscript('m_old')).toBeDefined();
    } finally {
      release();
    }
    await holder;
    await overwrite;
    const res = await merged;
    expect(res.status).toBe(200);
    expect(stateChapters()).toEqual(['New 1', 'New 2', 'New 4', 'New 5']);
    expect(store.getManuscript('m_new')?.chapterHints).toHaveLength(4);
  });
});

describe('(b) a bundle overwrite under the SAME manuscriptId with a warm record', () => {
  it('the next merge and the next hydrate read the bundle manuscript', async () => {
    seedOld('m_same');
    expect((await store.getOrHydrateManuscript('m_same'))?.chapterHints).toHaveLength(3);
    await portable.importPortableBundle(await bundleFor('m_same'), { onConflict: 'overwrite' });
    /* What an analysis start reads (`getOrHydrateManuscript`, analysis.ts). */
    const record = await store.getOrHydrateManuscript('m_same');
    expect(record?.chapterHints).toHaveLength(5);
    expect(record?.sourceText).toContain('Five.');
    const res = await merge();
    expect(res.status).toBe(200);
    expect(stateChapters()).toEqual(['New 1', 'New 2', 'New 4', 'New 5']);
  });
});
