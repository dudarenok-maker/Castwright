/* Plan 289 Task 1 (#3784) — GET /:bookId/state returns `sliceRevisions`
   computed from the RAW reads, and the wiping writers (re-parse, replace)
   rotate `state.json.editEpoch` so every token of the book moves.

   Real temp workspace + the real router (supertest), the pattern of
   book-state.reparse.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';
import { sliceRevision, STATE_REVISION_FIELDS } from '../workspace/slice-revision.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(resolve(__dirname, '..', '..'), 'handoff', 'cache');

const AUTHOR = 'Slice Rev Test';
const SERIES = 'Standalones';
const TITLE = 'Slice Revision Book';
const MANUSCRIPT_ID = 'm_slice_rev_test';
const BODY = `# Chapter One\n\nFirst sentence.\nSecond sentence.\n`;

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let cachePath: string;

const ab = (f: string) => join(bookDir, '.audiobook', f);
const readState = () => JSON.parse(readFileSync(ab('state.json'), 'utf8'));
const readRaw = (f: string): Record<string, unknown> | null =>
  existsSync(ab(f)) ? (JSON.parse(readFileSync(ab(f), 'utf8')) as Record<string, unknown>) : null;

async function getRevisions(): Promise<Record<string, Record<string, string>>> {
  const res = await request(app).get(`/api/books/${bookId}/state`);
  expect(res.status).toBe(200);
  return res.body.sliceRevisions;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-slice-rev-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  cachePath = join(CACHE_DIR, `${MANUSCRIPT_ID}.json`);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
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
  writeFileSync(join(bookDir, 'manuscript.md'), BODY);
  writeFileSync(
    ab('state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: false,
      editEpoch: 'ep_before',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  for (const f of ['cast.json', 'manuscript-edits.json', 'change-log.json', 'revisions.json']) {
    if (existsSync(ab(f))) rmSync(ab(f), { force: true });
  }
  if (existsSync(cachePath)) rmSync(cachePath, { force: true });
});

describe('GET /:bookId/state — sliceRevisions (D5)', () => {
  it('equals slice-revision.ts over the RAW files, not the decorated response', async () => {
    writeFileSync(
      ab('cast.json'),
      JSON.stringify({ characters: [{ id: 'wren', name: 'Wren' }] }),
    );
    writeFileSync(
      ab('manuscript-edits.json'),
      JSON.stringify({
        sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'First sentence.' }],
        mergedAwayKeys: ['k1'],
      }),
    );
    writeFileSync(ab('change-log.json'), JSON.stringify({ events: [{ type: 'x' }] }));

    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    /* The response cast IS decorated (lines / clonedElsewhereInSeries), which
       is exactly why the tokens must come from the raw read. */
    expect(res.body.cast.characters[0]).toHaveProperty('clonedElsewhereInSeries');

    const salt = { manuscriptId: MANUSCRIPT_ID, editEpoch: 'ep_before' };
    expect(res.body.sliceRevisions).toEqual({
      state: sliceRevision('state', readState(), salt),
      cast: sliceRevision('cast', readRaw('cast.json'), salt),
      manuscript: sliceRevision('manuscript', readRaw('manuscript-edits.json'), salt),
      changeLog: sliceRevision('changeLog', readRaw('change-log.json'), salt),
    });
  });

  it('answers tokens for absent files and gives them distinct tokens from present-but-empty', async () => {
    const absent = await getRevisions();
    expect(Object.keys(absent.state).sort()).toEqual([...STATE_REVISION_FIELDS].sort());
    writeFileSync(ab('cast.json'), JSON.stringify({}));
    const present = await getRevisions();
    expect(present.cast.characters).not.toBe(absent.cast.characters);
  });

  it('uses the raw state, not the narratorCredit-defaulted view', async () => {
    const revs = await getRevisions();
    const salt = { manuscriptId: MANUSCRIPT_ID, editEpoch: 'ep_before' };
    expect(revs.state.narratorCredit).toBe(sliceRevision('state', readState(), salt).narratorCredit);
  });

  it('a legacy book with no editEpoch salts as the empty string', async () => {
    const s = readState();
    delete s.editEpoch;
    writeFileSync(ab('state.json'), JSON.stringify(s));
    const revs = await getRevisions();
    expect(revs.state.title).toBe(
      sliceRevision('state', s, { manuscriptId: MANUSCRIPT_ID }).title,
    );
  });
});

describe('wiping writers rotate editEpoch (D3)', () => {
  it('re-parse rotates the epoch, so a base castConfirmed:false token no longer matches', async () => {
    const before = await getRevisions();
    const res = await request(app).post(`/api/books/${bookId}/reparse`);
    expect(res.status).toBe(200);

    const epoch = readState().editEpoch;
    expect(epoch).toMatch(/^ep_/);
    expect(epoch).not.toBe('ep_before');
    /* castConfirmed is still false (the re-parse wrote false), yet its token
       moved: this is what refuses a kept `castConfirmed: true`. */
    expect(readState().castConfirmed).toBe(false);
    const after = await getRevisions();
    for (const f of STATE_REVISION_FIELDS) expect(after.state[f], f).not.toBe(before.state[f]);
    expect(after.cast.characters).not.toBe(before.cast.characters);
    expect(after.manuscript.sentences).not.toBe(before.manuscript.sentences);
    expect(after.changeLog.events).not.toBe(before.changeLog.events);
  });

  it('replace-manuscript rotates the epoch', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/replace-manuscript`)
      .attach('file', Buffer.from(`## Fresh A\n\nAlpha.\n`), 'revised.md');
    expect(res.status).toBe(200);
    const epoch = readState().editEpoch;
    expect(epoch).toMatch(/^ep_/);
    expect(epoch).not.toBe('ep_before');
  });
});
