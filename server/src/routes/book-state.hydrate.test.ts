/* Round-trip tests for the manuscript-edits persistence path.

   Complements book-state.reparse.test.ts (which covers reparse-side merge
   and the GET-side cache reconcile) by pinning the OTHER half: the
   `PUT /:bookId/state slice='manuscript'` handler actually writes the
   payload to manuscript-edits.json, and a subsequent GET returns it
   identically. Before this test landed, the file existed but the
   `27-book-state-persistence.md` plan recorded a KNOWN-scaffolded note
   claiming "manuscriptEdits.sentences is written by PUT but not fully
   hydrated by GET — sentence reassignments may reset on reload." Reading
   the wiring (persistence-middleware → PUT handler → atomic write → GET
   handler → frontend hydrateFromBookState) shows that's stale; this test
   is the regression baseline that nails it down and lets the doc be
   cleaned up. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '..', '..');
const CACHE_DIR = join(SERVER_ROOT, 'handoff', 'cache');

const AUTHOR = 'Hydrate Test';
const SERIES = 'Standalones';
const TITLE = 'Hydrate Round Trip Book';
const MANUSCRIPT_ID = 'm_hydrate_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const MANUSCRIPT_BODY = `# Chapter One\n\nFirst sentence.\nSecond sentence.\n`;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-hydrate-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cachePath && existsSync(cachePath)) rmSync(cachePath, { force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
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
  for (const f of ['manuscript-edits.json', 'change-log.json', 'cast.json', 'revisions.json']) {
    const p = join(bookDir, '.audiobook', f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
});

describe('PUT /:bookId/state slice=manuscript → GET round-trip', () => {
  it('PUT writes sentences to manuscript-edits.json and GET returns them identically (no analysis cache)', async () => {
    /* Simulates the live frontend flow: user reassigns two sentences in
       the manuscript view. The persistence-middleware fires PUT
       slice='manuscript' with { sentences }. On reload, layout.tsx
       fires GET and feeds res.manuscriptEdits.sentences into
       manuscriptActions.hydrateFromBookState. This test pins that the
       server side of that loop is honest. */
    const sentences = [
      { id: 1, chapterId: 1, characterId: 'eliza', text: 'First sentence.' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'Second sentence.' },
    ];

    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences } });
    expect(put.status).toBe(204);

    /* PUT actually wrote the file. */
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    expect(existsSync(editsPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(editsPath, 'utf8'));
    expect(onDisk).toEqual({ sentences });

    /* GET returns it identically (no cache, so no reconcile filter
       applies — edits flow through unchanged). */
    const get = await request(app).get(`/api/books/${bookId}/state`);
    expect(get.status).toBe(200);
    expect(get.body.manuscriptEdits.sentences).toEqual(sentences);
  });

  it('a second PUT overwrites the first (last-write-wins, no merging)', async () => {
    /* The persistence-middleware debounces and then re-PUTs the whole
       sentences array; the server is intentionally a pass-through writer
       for this slice. Two sequential PUTs must collapse to whatever the
       second one sent. */
    const first = [
      { id: 1, chapterId: 1, characterId: 'eliza', text: 'First sentence.' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'Second sentence.' },
    ];
    const second = [
      { id: 1, chapterId: 1, characterId: 'halloran', text: 'First sentence.' },
      { id: 2, chapterId: 1, characterId: 'halloran', text: 'Second sentence.' },
    ];

    let res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences: first } });
    expect(res.status).toBe(204);

    res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences: second } });
    expect(res.status).toBe(204);

    const get = await request(app).get(`/api/books/${bookId}/state`);
    expect(get.body.manuscriptEdits.sentences).toEqual(second);
  });

  it('round-trip preserves split-offspring ids above the cache max', async () => {
    /* The merge filter at book-state.ts:78-95 keeps ids > maxCacheId
       (likely split offspring whose ids were assigned beyond the
       analyzer's range — splitSentence's `maxId + 1` rule). PUT a
       payload that includes such an offspring; cache only knows the
       original ids; GET must round-trip the offspring through. */
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        chapters: {
          1: [
            { id: 1, chapterId: 1, characterId: 'narrator', text: 'First sentence.' },
            { id: 2, chapterId: 1, characterId: 'narrator', text: 'Second sentence.' },
          ],
        },
      }),
    );

    const sentences = [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'First sentence.' },
      { id: 2, chapterId: 1, characterId: 'eliza', text: 'Second part 1.' },
      { id: 999, chapterId: 1, characterId: 'halloran', text: 'Second part 2 (split offspring).' },
    ];

    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .send({ slice: 'manuscript', patch: { sentences } });
    expect(put.status).toBe(204);

    const get = await request(app).get(`/api/books/${bookId}/state`);
    expect(get.status).toBe(200);
    const ids = (get.body.manuscriptEdits.sentences as Array<{ id: number }>)
      .map((s) => s.id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([1, 2, 999]);
    /* The user's characterId reassignments survive intact. */
    const byId = new Map<number, { characterId: string }>(
      (get.body.manuscriptEdits.sentences as Array<{ id: number; characterId: string }>).map(
        (s) => [s.id, s],
      ),
    );
    expect(byId.get(1)!.characterId).toBe('narrator');
    expect(byId.get(2)!.characterId).toBe('eliza');
    expect(byId.get(999)!.characterId).toBe('halloran');
  });
});
