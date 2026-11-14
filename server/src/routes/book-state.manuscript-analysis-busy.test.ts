/* #4098 — PUT /:bookId/state refuses the `manuscript` slice with 409 `book_busy`
   while an analysis job is registered for the book, exactly as the `cast` slice
   already is (#4031). Both analysis jobs rewrite manuscript-edits.json wholesale
   at their terminal persist, so a manuscript write accepted mid-run would be
   reverted.

   Its own fast-tier file for the same reasons as
   book-state.rename-analysis-busy.test.ts: book-state.test.ts is pinned to the
   single-fork slow tier, and this file owns its own WORKSPACE_DIR and registers
   jobs the real way through `runBookJob`. */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Busy Manuscript Author';
const SERIES = 'Standalones';
const TITLE = 'Busy Manuscript Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;
let clearAnalysisBusy: (d: string) => void;
let runBookJob: typeof import('../workspace/book-jobs.js').runBookJob;
let BOOK_GONE: typeof import('../workspace/book-op-lock.js').BOOK_GONE;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-busy-manuscript-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { bookStateRouter } = await import('./book-state.js');
  const paths = await import('../workspace/paths.js');
  clearAnalysisBusy = (await import('../tts/design-lock.js')).clearAnalysisBusy;
  runBookJob = (await import('../workspace/book-jobs.js')).runBookJob;
  BOOK_GONE = (await import('../workspace/book-op-lock.js')).BOOK_GONE;

  bookId = paths.makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const editsPath = () => join(bookDir, '.audiobook', 'manuscript-edits.json');
const statePath = () => join(bookDir, '.audiobook', 'state.json');

function sentences(text2: string) {
  return [
    { id: 1, chapterId: 1, characterId: 'narrator', text: 'First sentence.' },
    { id: 2, chapterId: 1, characterId: 'narrator', text: text2 },
  ];
}

function seedBook(): void {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder body');
  writeFileSync(
    statePath(),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_busy_manuscript',
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
  writeFileSync(editsPath(), JSON.stringify({ sentences: sentences('Second sentence.') }));
}

const releases: Array<() => Promise<void>> = [];
async function holdJob(kind: 'analysis' | 'render'): Promise<() => Promise<void>> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const registered = await runBookJob(bookId, kind, async () => {
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
  for (const release of releases.splice(0)) await release();
  for (let i = 0; i < 4; i++) clearAnalysisBusy(bookDir);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

function putManuscript(patch: unknown) {
  return request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'manuscript', patch });
}

describe('#4098 — PUT /:bookId/state manuscript slice is read-only during an analysis', () => {
  it('S1: refuses with 409 book_busy and touches nothing', async () => {
    seedBook();
    const editsBefore = readFileSync(editsPath());
    const stateBefore = readFileSync(statePath());
    await holdJob('analysis');

    const res = await putManuscript({ sentences: sentences('EDITED sentence.') });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_busy');
    expect(res.body.error).toMatch(/manuscript is read-only/);
    expect(res.text).not.toContain(workspaceRoot);
    expect(readFileSync(editsPath()).equals(editsBefore)).toBe(true);
    expect(readFileSync(statePath()).equals(stateBefore)).toBe(true);
  });

  it('S2: refuses before parsing — a malformed patch is 409, not 400', async () => {
    seedBook();
    await holdJob('analysis');

    const res = await putManuscript({ sentences: 'nope' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_busy');
  });

  it('S3: a non-analysis job does not refuse the manuscript save', async () => {
    seedBook();
    await holdJob('render');

    const res = await putManuscript({ sentences: sentences('EDITED sentence.') });

    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(editsPath(), 'utf8'));
    expect(onDisk.sentences[1].text).toBe('EDITED sentence.');
  });

  it('S4: accepted again once the analysis has finished', async () => {
    seedBook();
    const release = await holdJob('analysis');
    await release();

    const res = await putManuscript({ sentences: sentences('EDITED sentence.') });

    expect(res.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(editsPath(), 'utf8'));
    expect(onDisk.sentences[1].text).toBe('EDITED sentence.');
  });
});
