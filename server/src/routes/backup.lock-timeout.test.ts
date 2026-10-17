/* #3625 child 10 — a state-lock timeout out of the backup-restore route answers
   the curated 500 body, never the lock key (which embeds the absolute
   workspace path). withStateLock is mocked here, so this lives in its own
   file apart from the real-lock tests in backup.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';
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

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let backup: typeof import('../workspace/auto-backup.js');

const BOOK_ID = 'tester__myseries__demo';
const bookDir = () => join(workspaceRoot, 'books', 'tester', 'myseries', 'demo');

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'backup-lock-timeout-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.resetModules();
  paths = await import('../workspace/paths.js');
  backup = await import('../workspace/auto-backup.js');
  const { backupRouter } = await import('./backup.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', backupRouter);
  await mkdir(join(bookDir(), '.audiobook'), { recursive: true });
  await writeFile(join(bookDir(), 'manuscript.txt'), 'chapter one', 'utf8');
  await writeFile(
    paths.stateJsonPath(bookDir()),
    JSON.stringify({
      bookId: BOOK_ID,
      manuscriptId: BOOK_ID,
      title: 'Test Book',
      author: 'tester',
      series: 'myseries',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [],
      coverGradient: ['#111111', '#222222'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  await rm(workspaceRoot, { recursive: true, force: true });
});

const lockErr = () => new LockAcquisitionTimeoutError('state:/abs/secret/path', 10000);

describe('POST /api/books/:bookId/backups/restore — lock-timeout 500 body (#3625)', () => {
  it('answers a lock timeout with the curated body, not the path', async () => {
    const file = await backup.backupBook(
      { bookId: BOOK_ID, bookDir: bookDir() },
      { keep: 14, now: new Date(2026, 0, 1, 9, 0, 0) },
    );
    const { withStateLock } = await import('../workspace/state-lock.js');
    vi.mocked(withStateLock).mockRejectedValueOnce(lockErr());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/backups/restore`)
      .send({ backupFile: file })
      .then((r) => r);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(JSON.stringify(res.body)).not.toContain('/abs/secret/path');
  });

  it('answers any other unexpected error with the generic fallback', async () => {
    const file = await backup.backupBook(
      { bookId: BOOK_ID, bookDir: bookDir() },
      { keep: 14, now: new Date(2026, 0, 1, 9, 0, 0) },
    );
    const { withStateLock } = await import('../workspace/state-lock.js');
    vi.mocked(withStateLock).mockRejectedValueOnce(new Error('disk on fire'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/backups/restore`)
      .send({ backupFile: file })
      .then((r) => r);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Backup restore failed.');
  });
});
