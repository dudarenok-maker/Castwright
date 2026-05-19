/* Integration tests for the share-clip route (plan 69).

   Mirrors the chapter-audio.test.ts harness — tempdir workspace, deferred
   module load so paths.ts picks up WORKSPACE_DIR, supertest against an
   express app that mounts only the route under test.

   The happy-path test requires ffmpeg on PATH (the same prereq as the
   M4B / MP3-zip export tests). It writes a tiny real MP3 by synthesising
   silence via ffmpeg, then asks the route to slice 0.5 s of it. When
   ffmpeg isn't installed the happy-path test skips with a clear banner;
   validation + 404 cases are independent of ffmpeg and always run. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Bonus Story';
const SLUG = 'chapter-one';

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let app: Express;
let bookId: string;

function ffmpegAvailable(): boolean {
  try {
    const out = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return out.status === 0;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = ffmpegAvailable();

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-clip-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ clipRouter }, { makeBookId }] = await Promise.all([
    import('./clip.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });

  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  app = express();
  app.use('/api/books', clipRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/** Synthesize a 2 s silent MP3 with ffmpeg so the route has a real
    file to slice. Returns false when ffmpeg isn't on PATH so the caller
    can skip. */
function writeRealMp3(): boolean {
  if (!HAS_FFMPEG) return false;
  const out = join(audioRoot, `${SLUG}.mp3`);
  const r = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=24000',
      '-t',
      '2',
      '-acodec',
      'libmp3lame',
      '-b:a',
      '64k',
      out,
    ],
    { stdio: 'ignore' },
  );
  return r.status === 0 && existsSync(out);
}

describe('share-clip route', () => {
  describe('validation', () => {
    it('rejects duration > 60 with 400', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/1/clip?start=0&duration=61`,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/duration.*<=\s*60/i);
    });

    it('rejects negative start with 400', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/1/clip?start=-1&duration=5`,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/start/i);
    });

    it('rejects zero / non-positive duration with 400', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/1/clip?start=0&duration=0`,
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/duration/i);
    });

    it('rejects non-numeric query with 400', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/1/clip?start=nope&duration=5`,
      );
      expect(res.status).toBe(400);
    });

    it('rejects missing duration with 400', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/clip?start=0`);
      expect(res.status).toBe(400);
    });
  });

  describe('not-found cases', () => {
    it('unknown bookId → 404', async () => {
      const res = await request(app).get(
        '/api/books/does-not-exist__x__y/chapters/1/clip?start=0&duration=5',
      );
      expect(res.status).toBe(404);
    });

    it('non-integer chapterId → 404', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/not-a-number/clip?start=0&duration=5`,
      );
      expect(res.status).toBe(404);
    });

    it('unknown chapterId → 404', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/999/clip?start=0&duration=5`,
      );
      expect(res.status).toBe(404);
    });

    it('chapter exists but no MP3 on disk → 404', async () => {
      const res = await request(app).get(
        `/api/books/${bookId}/chapters/1/clip?start=0&duration=5`,
      );
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/audio/i);
    });
  });

  /* The happy-path slice exercises a real ffmpeg invocation. Skip
     cleanly when ffmpeg isn't installed — same convention as plan 66
     uses for Calibre, so a fresh-clone dev box still passes `npm run
     test:server`. */
  (HAS_FFMPEG ? describe : describe.skip)('happy path (ffmpeg required)', () => {
    beforeAll(() => {
      const ok = writeRealMp3();
      if (!ok) throw new Error('Failed to synthesise test MP3 with ffmpeg');
    });

    it('returns audio/mpeg with Content-Disposition: attachment', async () => {
      const res = await request(app)
        .get(`/api/books/${bookId}/chapters/1/clip?start=0&duration=0.5`)
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="/);
      expect(res.headers['content-disposition']).toMatch(/chapter-one-clip-0s\.mp3/);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('clip filename reflects start second', async () => {
      const res = await request(app)
        .get(`/api/books/${bookId}/chapters/1/clip?start=1.4&duration=0.3`)
        .buffer(true);
      expect(res.status).toBe(200);
      /* Math.floor(1.4) === 1 → start label is 1s */
      expect(res.headers['content-disposition']).toMatch(/chapter-one-clip-1s\.mp3/);
    });
  });
});
