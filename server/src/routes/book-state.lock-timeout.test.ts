/* #3625 child 8 — a state-lock timeout out of the exclude / held toggles and
   the GET migration answers the curated 500 body, never the lock key (which
   embeds the absolute workspace path). withStateLock is mocked here, so this
   lives in its own file apart from the real-lock tests. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { CHAPTER_TITLE_PARSER_VERSION } from '../parsers/version.js';
import {
  LOCK_CONTENTION_REQUEST_ERROR,
  LockAcquisitionTimeoutError,
} from '../workspace/file-lock.js';

vi.mock('../workspace/state-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-lock.js')>();
  return {
    ...actual,
    withStateLock: vi.fn(actual.withStateLock),
  };
});

const AUTHOR = 'Lock Timeout';
const SERIES = 'Standalones';
const TITLE = 'Lock Timeout Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-lock-timeout-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_lock_timeout',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      /* Current parser version: the title refresh (which swallows a lock
         timeout by design) is skipped, so the first lock the GET takes is the
         uuid migration's. */
      chapterTitleParserVersion: CHAPTER_TITLE_PARSER_VERSION,
      /* No uuid: the GET lazy migration has something to write. */
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
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

async function rejectNextLock(err: unknown): Promise<void> {
  const { withStateLock } = await import('../workspace/state-lock.js');
  vi.mocked(withStateLock).mockRejectedValueOnce(err);
}

const lockErr = () => new LockAcquisitionTimeoutError('state:/abs/secret/path', 10000);

describe('book-state routes — lock-timeout 500 bodies are curated (#3625)', () => {
  const cases: Array<{ name: string; send: () => Promise<request.Response> }> = [
    {
      name: 'GET /state',
      send: () => request(app).get(`/api/books/${bookId}/state`).then((r) => r),
    },
    {
      name: 'POST exclude',
      send: () =>
        request(app)
          .post(`/api/books/${bookId}/chapters/1/exclude`)
          .send({ excluded: true })
          .then((r) => r),
    },
    {
      name: 'POST held',
      send: () =>
        request(app)
          .post(`/api/books/${bookId}/chapters/1/held`)
          .send({ held: true })
          .then((r) => r),
    },
  ];

  for (const c of cases) {
    it(`${c.name} answers a lock timeout with the curated body, not the path`, async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await rejectNextLock(lockErr());
      const res = await c.send();
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
      expect(JSON.stringify(res.body)).not.toContain('/abs/secret/path');
    });

    it(`${c.name} still surfaces an ordinary error's own message`, async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await rejectNextLock(new Error('boom'));
      const res = await c.send();
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('boom');
    });
  }
});
