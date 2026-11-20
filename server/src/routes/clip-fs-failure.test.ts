/* #3702 / #4508 -- a node fs error caught by the share-clip route answers the curated
   fs body, never the raw message (which names an absolute path). */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const FS_ERR = Object.assign(
  new Error("EPERM: operation not permitted, rename 'C:/Users/someone/castwright-workspace/x' -> 'y'"),
  { code: 'EPERM', syscall: 'rename', path: 'C:/Users/someone/castwright-workspace/x' },
);

vi.mock('node:child_process', () => ({
  spawn: () => {
    throw FS_ERR;
  },
}));
vi.mock('../workspace/scan.js', () => ({
  findBookByBookId: async () => ({
    bookDir: 'X:/book',
    state: { chapters: [{ id: 1, slug: 'chapter-one' }] },
  }),
}));
vi.mock('../workspace/chapter-take.js', () => ({
  findChapterAudio: () => ({ path: 'X:/book/audio/chapter-one.mp3' }),
}));

let app: Express;

beforeAll(async () => {
  const { clipRouter } = await import('./clip.js');
  app = express();
  app.use('/api/books', clipRouter);
});

describe('clip route -- fs failure curation', () => {
  it('a caught fs error answers FS_FAILURE_REQUEST_ERROR, no path', async () => {
    const { FS_FAILURE_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/books/b/chapters/1/clip?start=0&duration=1');
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.message).toBe(FS_FAILURE_REQUEST_ERROR);
    expect(res.text).not.toContain('someone');
  });
});
