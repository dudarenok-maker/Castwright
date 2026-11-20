/* #3702 / #4508 -- the share-clip route's 500 bodies, driven with REAL ffmpeg-stand-in
   children. A spawn failure arrives on 'error' as `ENOENT` with `syscall: 'spawn <bin>'`,
   which the fs seam deliberately exempts (it names a binary, not a file), so the seam
   wraps at the spawn sites are inert by construction: the message must pass through
   unchanged. A non-zero exit goes through `ffmpegFailure`, whose message is path-free. */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ childArgs: null as null | { cmd: string; args: string[] } }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], opts: object) =>
      actual.spawn(h.childArgs!.cmd, h.childArgs!.args, opts as never),
  };
});
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

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const GET = '/api/books/b/chapters/1/clip?start=0&duration=1';

describe('clip route -- 500 bodies from real children', () => {
  it('a real spawn failure (ENOENT, syscall spawn) passes through unchanged -- the seam is inert here', async () => {
    h.childArgs = { cmd: 'castwright-no-such-binary', args: [] };
    const res = await request(app).get(GET);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('ffmpeg spawn failed: spawn castwright-no-such-binary ENOENT');
  });

  it('a real non-zero exit whose stderr names an absolute path answers a path-free message', async () => {
    h.childArgs = {
      cmd: process.execPath,
      args: ['-e', "console.error('Error opening output C:/Users/someone/clip.mp3'); process.exit(1)"],
    };
    const res = await request(app).get(GET);
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/^ffmpeg exited with code 1/);
    expect(res.text).not.toContain('someone');
    expect(res.body.message).not.toMatch(/[A-Za-z]:[/\\]/);
  });
});
