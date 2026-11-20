/* #3702 / #4508 -- the dev worktrees route curates a caught fs error out of its 500 body. */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const FS_ERR = Object.assign(
  new Error("EPERM: operation not permitted, rename 'C:/Users/someone/castwright-workspace/x' -> 'y'"),
  { code: 'EPERM', syscall: 'rename', path: 'C:/Users/someone/castwright-workspace/x' },
);

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: (...a: unknown[]) => spawnSyncMock(...a) }));

let app: Express;

beforeAll(async () => {
  const { worktreesRouter } = await import('./worktrees.js');
  app = express();
  app.use('/api', worktreesRouter);
});

beforeEach(() => {
  spawnSyncMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('worktrees route -- fs failure curation', () => {
  it('a thrown fs error answers FS_FAILURE_REQUEST_ERROR, no path', async () => {
    const { FS_FAILURE_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    spawnSyncMock.mockImplementation(() => {
      throw FS_ERR;
    });
    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(FS_FAILURE_REQUEST_ERROR);
    expect(res.text).not.toContain('someone');
  });

  it('a non-zero git exit carrying an fs error answers the curated body', async () => {
    const { FS_FAILURE_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    spawnSyncMock.mockReturnValue({ status: 1, stderr: 'fatal: C:/Users/someone/x', stdout: '', error: FS_ERR });
    const res = await request(app).get('/api/worktrees');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(FS_FAILURE_REQUEST_ERROR);
    expect(res.text).not.toContain('someone');
  });
});
