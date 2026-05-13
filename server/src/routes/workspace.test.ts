/* Integration test for the workspace-changelog aggregator.

   Asserts that:
     1. GET /api/workspace returns root/booksRoot metadata.
     2. GET /api/workspace/changelog fans out across every book in the
        workspace, attaches bookId/bookTitle/author to each event, sorts
        newest-first, and skips books that have no change-log.json on disk.

   Mirrors book-state.test.ts: tempdir workspace, deferred module imports so
   paths.ts captures WORKSPACE_DIR before resolving, supertest against the
   real router. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';

let workspaceRoot: string;
let app: Express;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-workspace-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ workspaceRouter }, { makeBookId }] = await Promise.all([
    import('./workspace.js'),
    import('../workspace/paths.js'),
  ]);

  /* Two books with change-log.json + one book without — confirms the
     aggregator skips empty/missing logs and merges from the rest. */
  const seedBook = (title: string, events: Array<Record<string, unknown>> | null) => {
    const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(dir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: makeBookId(AUTHOR, SERIES, title),
        manuscriptId: 'm_' + title,
        title,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
    if (events) {
      writeFileSync(
        join(dir, '.audiobook', 'change-log.json'),
        JSON.stringify({ events }),
      );
    }
  };

  seedBook('Book Alpha', [
    {
      id: 1, at: '2026-05-13T10:00:00.000Z', ts: 'earlier', date: 'today',
      type: 'regenerate', title: 'Regenerated Chapter 3', note: 'note',
      actor: 'you', chapterId: 3, revertible: true,
    },
    {
      id: 2, at: '2026-05-13T15:00:00.000Z', ts: 'Just now', date: 'today',
      type: 'voice_tune', title: "Tuned Alice's voice", note: 'tone updated',
      actor: 'you',
    },
  ]);
  seedBook('Book Beta', [
    {
      id: 3, at: '2026-05-13T12:00:00.000Z', ts: 'earlier', date: 'today',
      type: 'cast_confirm', title: 'Confirmed the cast', note: '6 characters.',
      actor: 'you',
    },
  ]);
  seedBook('Book Empty', null); // state.json only, no change-log.json — should be skipped

  app = express();
  app.use(express.json());
  app.use('/api/workspace', workspaceRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('workspace router', () => {
  it('GET / returns workspace metadata', async () => {
    const res = await request(app).get('/api/workspace');
    expect(res.status).toBe(200);
    expect(res.body.root).toBe(workspaceRoot);
    expect(res.body.booksRoot).toBe(join(workspaceRoot, 'books'));
    expect(res.body.source).toBe('env');
  });

  it('GET /changelog fans out across books and tags each event with book context', async () => {
    const res = await request(app).get('/api/workspace/changelog');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    /* 2 events from Alpha + 1 from Beta; Book Empty must not contribute. */
    expect(res.body.events).toHaveLength(3);
    const titles = res.body.events.map((e: { bookTitle: string }) => e.bookTitle);
    expect(titles).toContain('Book Alpha');
    expect(titles).toContain('Book Beta');
    expect(titles).not.toContain('Book Empty');
    for (const ev of res.body.events) {
      expect(typeof ev.bookId).toBe('string');
      expect(typeof ev.bookTitle).toBe('string');
      expect(typeof ev.author).toBe('string');
    }
  });

  it('sorts events newest-first by `at` so the workspace view reads top-down', async () => {
    const res = await request(app).get('/api/workspace/changelog');
    const ats = res.body.events.map((e: { at: string }) => e.at);
    /* Newest → oldest: 15:00 (Alpha tune), 12:00 (Beta confirm), 10:00 (Alpha regen). */
    expect(ats).toEqual([
      '2026-05-13T15:00:00.000Z',
      '2026-05-13T12:00:00.000Z',
      '2026-05-13T10:00:00.000Z',
    ]);
  });
});
