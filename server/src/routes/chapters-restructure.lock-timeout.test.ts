/* #3625 child 10 — a state-lock timeout out of a restructure route answers the
   curated 500 body, never the lock key (which embeds the absolute workspace
   path). withStateLock is mocked here, so this lives in its own file apart
   from the real-lock tests in chapters-restructure.test.ts. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
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

const AUTHOR = 'Restructure Timeout';
const SERIES = 'Standalones';
const TITLE = 'Restructure Timeout Book';
const MANUSCRIPT_ID = 'm_restructure_timeout';

let workspaceRoot: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-restructure-timeout-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ chaptersRestructureRouter }, { makeBookId }] = await Promise.all([
    import('./chapters-restructure.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, 'manuscript.md'),
    '# Chapter One\n\nAlpha first.\n\n# Chapter Two\n\nBeta first.\n',
  );
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
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', chaptersRestructureRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const lockErr = () => new LockAcquisitionTimeoutError('state:/abs/secret/path', 10000);

async function rejectNextLock(err: unknown): Promise<void> {
  const { withStateLock } = await import('../workspace/state-lock.js');
  vi.mocked(withStateLock).mockRejectedValueOnce(err);
}

describe('chapters-restructure routes — lock-timeout 500 bodies are curated (#3625)', () => {
  it('merge answers a lock timeout with the curated body, not the path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await rejectNextLock(lockErr());
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/merge`)
      .send({ chapterIds: [1, 2] })
      .then((r) => r);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(JSON.stringify(res.body)).not.toContain('/abs/secret/path');
  });

  it('rename answers a lock timeout with the curated body, not the path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await rejectNextLock(lockErr());
    const res = await request(app)
      .post(`/api/books/${bookId}/chapters/1/rename`)
      .send({ title: 'New Title' })
      .then((r) => r);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(JSON.stringify(res.body)).not.toContain('/abs/secret/path');
  });
});
