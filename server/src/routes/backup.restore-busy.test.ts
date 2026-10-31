/* PR #3966 review pass 2 -- a backup restore refuses with 409 `book_busy` while
   ANY long job is registered for the book, exactly as the bundle overwrite does
   (scan-import-folder.ts) and as re-parse / replace-manuscript / restructure do
   (#3717 / #3774). A restore rewrites state.json, can stamp the stale-evidence
   marker, clears the analysis cache and drops the warm ManuscriptRecord; a
   running main analysis re-saves its in-memory cache after each chapter,
   rebuilds the chapters from that record and deletes the marker -- so under it
   a later Start replayed one chapter's sentence under another's id.

   The job is registered the real way -- `runBookJob(bookId, 'analysis', () =>
   gate)`, the `holdJob` pattern from book-state.reparse-busy.test.ts. The
   snapshot reorders the chapters and the edits hold a sentence, so an admitted
   restore would stamp the marker and clear the cache: the refusal must leave
   state.json, the cache file and the warm record exactly as they were. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { ManuscriptRecord } from '../store/manuscripts.js';

const AUTHOR = 'Restore Busy Author';
const SERIES = 'Standalones';
const TITLE = 'Restore Busy Book';
const MID = `m_restore_busy_${Date.now()}`;
const SNAPSHOT = '20260101-090000.json';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookDir: string;
let cacheFile: string;

const chapters = (titles: string[]) =>
  titles.map((t, i) => ({ id: i + 1, title: t, slug: `0${i + 1}-${t.toLowerCase()}`, uuid: `uu-${t}` }));
const state = (titles: string[]) => ({
  bookId, manuscriptId: MID, title: TITLE, author: AUTHOR, series: SERIES, seriesPosition: null, isStandalone: true,
  manuscriptFile: 'manuscript.md', castConfirmed: false, language: 'en', schema: 1, chapters: chapters(titles),
  coverGradient: ['#000', '#fff'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'restore-busy-ws-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { makeBookId, bookBackupsDir } = await import('../workspace/paths.js');
  const { cachePath } = await import('../store/analysis-cache.js');
  const { backupRouter } = await import('./backup.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), '# Book\n\n# Beta\n\nB.\n\n# Alpha\n\nA.\n');
  writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(state(['Beta', 'Alpha'])));
  writeFileSync(
    join(bookDir, '.audiobook', 'manuscript-edits.json'),
    JSON.stringify({ sentences: [{ id: 101, chapterId: 1, characterId: 'nova', text: 'B.' }] }),
  );
  mkdirSync(bookBackupsDir(bookId), { recursive: true });
  writeFileSync(join(bookBackupsDir(bookId), SNAPSHOT), JSON.stringify(state(['Alpha', 'Beta'])));
  cacheFile = cachePath(MID);
  mkdirSync(join(cacheFile, '..'), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ manuscriptId: MID, chapters: {} }));
  app = express();
  app.use(express.json());
  app.use('/api/books', backupRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (cacheFile && existsSync(cacheFile)) rmSync(cacheFile, { force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('a backup restore refuses while a book job is registered', () => {
  it('analysis registered -> 409 book_busy, state.json + cache + warm record untouched; released -> 200', async () => {
    const { runBookJob } = await import('../workspace/book-jobs.js');
    const { BOOK_GONE } = await import('../workspace/book-op-lock.js');
    const { putManuscript, getManuscript, removeManuscript } = await import('../store/manuscripts.js');
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const record = { manuscriptId: MID, bookDir } as unknown as ManuscriptRecord;
    putManuscript(record);
    const stateBefore = readFileSync(statePath, 'utf8');
    const cacheBefore = readFileSync(cacheFile, 'utf8');

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const reg = await runBookJob(bookId, 'analysis', () => gate);
    if (reg === BOOK_GONE) throw new Error('test setup: book not found');
    try {
      const busy = await request(app).post(`/api/books/${bookId}/backups/restore`).send({ backupFile: SNAPSHOT });
      expect(busy.status, JSON.stringify(busy.body)).toBe(409);
      expect(busy.body.code).toBe('book_busy');
      expect(typeof busy.body.error).toBe('string');
      expect(busy.body.error).not.toContain(workspaceRoot);
      expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
      expect(readFileSync(cacheFile, 'utf8')).toBe(cacheBefore);
      expect(getManuscript(MID)).toBe(record);
    } finally {
      open();
      await reg.done;
    }

    const ok = await request(app).post(`/api/books/${bookId}/backups/restore`).send({ backupFile: SNAPSHOT });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(after.chapters.map((c: { title: string }) => c.title)).toEqual(['Alpha', 'Beta']);
    expect(after.sentencesPredateChapters).toBe(true);
    expect(existsSync(cacheFile)).toBe(false);
    expect(getManuscript(MID)).toBeUndefined();
    removeManuscript(MID);
  });
});
