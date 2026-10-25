/* #3625 pass-1 review — a torn state.json must stay recoverable by the per-book
   routes that now re-read INSIDE the state lock.

   Before the lock, these handlers wrote from `findBookBy`'s snapshot, which
   reads through `readStateJsonWithRecovery` (a torn main file falls back to
   `state.json.bak.N`) and so healed the file on the first edit. The in-lock
   re-read must recover the same way: a strict `readJson` throws on the torn
   main file, the route 500s, and nothing ever repairs the file.

   Each case truncates state.json to 40 bytes with a valid `.bak.1` beside it,
   calls the route, and asserts a success status plus a whole, parseable main
   file afterwards. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';

const AUTHOR = 'Torn State';
const SERIES = 'Standalones';
const TITLE = 'Torn State Book';

const MANUSCRIPT_BODY = ['# Chapter One', '', 'Alpha first.', '', '# Chapter Two', '', 'Beta first.', ''].join('\n');

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let statePath: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-torn-state-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { chaptersRestructureRouter }, { syncManifestRouter }, { makeBookId }] =
    await Promise.all([
    import('./book-state.js'),
    import('./chapters-restructure.js'),
    import('./library-sync-manifest.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  statePath = join(bookDir, '.audiobook', 'state.json');
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
  app.use('/api/books', chaptersRestructureRouter);
  app.use('/api/library', syncManifestRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* A good `.bak.1`, then the main file torn mid-string. */
function seedTorn(withUuids = true, staleTitles = false): void {
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT_BODY);
  const state = {
    bookId,
    manuscriptId: 'm_torn_state',
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.md',
    castConfirmed: true,
    chapters: [
      {
        id: 1,
        title: staleTitles ? 'Stale One' : 'Chapter One',
        slug: '01-chapter-one',
        ...(withUuids ? { uuid: 'u-1' } : {}),
      },
      { id: 2, title: 'Chapter Two', slug: '02-chapter-two', ...(withUuids ? { uuid: 'u-2' } : {}) },
    ],
    ...(staleTitles ? {} : { chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION }),
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const full = JSON.stringify(state);
  writeFileSync(`${statePath}.bak.1`, full);
  writeFileSync(statePath, full.slice(0, 40));
}

const readState = () => JSON.parse(readFileSync(statePath, 'utf8'));

beforeEach(() => {
  seedTorn();
});

describe('a torn state.json is recovered and healed by the in-lock re-read (#3625)', () => {
  it('held toggle succeeds and rewrites the main file whole', async () => {
    const res = await request(app).post(`/api/books/${bookId}/chapters/1/held`).send({ held: true });
    expect(res.status).toBe(200);
    expect(readState().chapters[0].held).toBe(true);
  });

  it('exclude toggle succeeds and rewrites the main file whole', async () => {
    const res = await request(app).post(`/api/books/${bookId}/chapters/1/exclude`).send({ excluded: true });
    expect(res.status).toBe(200);
    expect(readState().chapters[0].excluded).toBe(true);
  });

  it('PUT state slice (the autosave) succeeds and heals the file', async () => {
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { notes: 'hello' } });
    expect(res.status).toBe(200);
    expect(readState().notes).toBe('hello');
  });

  it('GET uuid migration succeeds and heals the file', async () => {
    seedTorn(false);
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(readState().chapters.every((c: { uuid?: string }) => !!c.uuid)).toBe(true);
  });

  it('the GET title refresh (refreshChapterTitles) refreshes titles and heals the file', async () => {
    seedTorn(true, true);
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(readState().chapters[0].title).not.toBe('Stale One');
    expect(readState().chapterTitleParserVersion).toBe(CHAPTER_TITLE_PARSER_VERSION);
  });

  const progressPath = () => join(bookDir, '.audiobook', 'listen-progress.json');

  it('GET listen-progress resolves the chapter uuid through a torn state.json', async () => {
    writeFileSync(
      progressPath(),
      JSON.stringify({
        chapterId: 1,
        chapterUuid: 'u-2',
        currentSec: 5,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    const res = await request(app).get(`/api/books/${bookId}/listen-progress`);
    expect(res.status).toBe(200);
    expect(res.body.chapterId).toBe(2);
  });

  it('PUT listen-progress stamps the chapter uuid through a torn state.json', async () => {
    rmSync(progressPath(), { force: true });
    const res = await request(app)
      .put(`/api/books/${bookId}/listen-progress`)
      .send({ chapterId: 2, currentSec: 7 });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(progressPath(), 'utf8')).chapterUuid).toBe('u-2');
  });

  it('reparse succeeds and heals the file', async () => {
    const res = await request(app).post(`/api/books/${bookId}/reparse`).send({});
    expect(res.status).toBe(200);
    expect(readState().chapters.length).toBeGreaterThan(0);
  });

  it('a restructure route (rename) succeeds and heals the file', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/rename`)
      .send({ title: 'Renamed' });
    expect(res.status).toBe(200);
    expect(readState().chapters[0].title).toBe('Renamed');
  });

  it('sync-manifest uuid migration heals the file', async () => {
    seedTorn(false);
    const res = await request(app).get(`/api/library/sync-manifest?bookId=${bookId}`);
    expect(res.status).toBe(200);
    expect(readState().chapters.every((c: { uuid?: string }) => !!c.uuid)).toBe(true);
  });

  it('the segments backfill heals the file', async () => {
    const [{ backfillAudioModelKeysFromSegments }, { audioDir }, { readStateJsonWithRecovery }] =
      await Promise.all([
        import('../workspace/scan.js'),
        import('../workspace/paths.js'),
        import('../workspace/state-migrate.js'),
      ]);
    const snapshot = (await readStateJsonWithRecovery(statePath))!;
    mkdirSync(audioDir(bookDir), { recursive: true });
    writeFileSync(
      join(audioDir(bookDir), '01-chapter-one.segments.json'),
      JSON.stringify({
        bookId: 'unused',
        chapterId: 1,
        chapterTitle: 'unused',
        durationSec: 61,
        sampleRate: 24_000,
        modelKey: 'xtts_v2',
        synthesizedAt: '2026-10-16T00:00:00.000Z',
        segments: [],
      }),
    );
    await backfillAudioModelKeysFromSegments(bookDir, snapshot);
    expect(readState().chapters[0].audioModelKey).toBe('xtts_v2');
  });
});
