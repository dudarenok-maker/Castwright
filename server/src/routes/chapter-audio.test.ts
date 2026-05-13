/* Integration tests for the chapter-audio router. Set WORKSPACE_DIR to a
   tempdir before importing the modules (paths.ts reads it at load time),
   scaffold a synthetic book layout, then drive the router with supertest.

   Cases cover the format-fallback contract: new chapters live as .mp3,
   legacy chapters as .wav, and every callsite must work for both without
   the client knowing or caring. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-chapter-audio-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  // Defer module load so paths.ts picks up WORKSPACE_DIR. Importing the
  // router after env is set guarantees the workspace root resolves into
  // our tempdir rather than the repo's default.
  const [{ chapterAudioRouter }, { makeBookId }] = await Promise.all([
    import('./chapter-audio.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });

  /* Minimal .audiobook/state.json so findBookByBookId resolves. The scan
     code derives the bookId from the slugged Author/Series/Title triple,
     so we don't even need to set it explicitly — but writing it keeps the
     fixture self-documenting. */
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
  // The manuscript file existence flips status away from 'orphaned' in
  // scan.ts; we don't gate on status here, but write one for completeness.
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  /* Segments JSON powers the JSON endpoint's metadata response. */
  writeFileSync(
    join(audioRoot, `${SLUG}.segments.json`),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      durationSec: 12.5,
      sampleRate: 24_000,
      modelKey: 'xtts_v2',
      synthesizedAt: new Date().toISOString(),
      segments: [
        { groupIndex: 0, characterId: 'Marlow', sentenceIds: [101, 102], startSec: 0, endSec: 6.2 },
        { groupIndex: 1, characterId: 'Oduvan', sentenceIds: [103],      startSec: 6.2, endSec: 12.5 },
      ],
    }),
  );

  app = express();
  app.use('/api/books', chapterAudioRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function writeMp3(bytes = 4096) {
  /* A valid-looking MPEG-2 Layer III mono frame header (0xFFF3 ... mono).
     We don't need it to *play* — sendFile only cares about bytes on disk
     and the Content-Type — but using something MP3-shaped catches drift. */
  const buf = Buffer.alloc(bytes, 0);
  buf[0] = 0xff;
  buf[1] = 0xf3;
  buf[2] = 0x40;
  buf[3] = 0xc0;
  writeFileSync(join(audioRoot, `${SLUG}.mp3`), buf);
}

function writeWav(bytes = 4096) {
  /* Minimal RIFF/WAVE header so sniffers don't get confused. */
  const data = Buffer.alloc(bytes - 44, 0);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0, 'ascii');
  hdr.writeUInt32LE(36 + data.length, 4);
  hdr.write('WAVE', 8, 'ascii');
  hdr.write('fmt ', 12, 'ascii');
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(24_000, 24);
  hdr.writeUInt32LE(24_000 * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36, 'ascii');
  hdr.writeUInt32LE(data.length, 40);
  writeFileSync(join(audioRoot, `${SLUG}.wav`), Buffer.concat([hdr, data]));
}

function rmIfExists(name: string) {
  try { rmSync(join(audioRoot, name)); } catch { /* ignore */ }
}

function resetAudio() {
  rmIfExists(`${SLUG}.mp3`);
  rmIfExists(`${SLUG}.wav`);
}

describe('chapter-audio router', () => {
  describe('mp3-only chapter (new generation)', () => {
    beforeAll(() => { resetAudio(); writeMp3(); });

    it('JSON metadata points at .mp3 URL', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
      expect(res.status).toBe(200);
      expect(res.body.url).toBe(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio.mp3`);
      expect(res.body.durationSec).toBe(12.5);
      expect(res.body.sampleRate).toBe(24_000);
      expect(res.body.segments).toHaveLength(2);
    });

    it('GET audio.mp3 returns 200 with audio/mpeg', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.mp3`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
      expect(res.headers['accept-ranges']).toBe('bytes');
    });

    it('GET audio.wav returns 404 (no legacy file)', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.wav`);
      expect(res.status).toBe(404);
    });

    it('Range request on audio.mp3 returns 206 partial content', async () => {
      const res = await request(app)
        .get(`/api/books/${bookId}/chapters/1/audio.mp3`)
        .set('Range', 'bytes=0-1023');
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toMatch(/^bytes 0-1023\//);
    });
  });

  describe('wav-only chapter (legacy backwards-compat)', () => {
    beforeAll(() => { resetAudio(); writeWav(); });

    it('JSON metadata points at .wav URL', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
      expect(res.status).toBe(200);
      expect(res.body.url).toBe(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio.wav`);
    });

    it('GET audio.wav returns 200 with audio/wav', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.wav`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/wav/);
    });

    it('GET audio.mp3 returns 404 (no new file yet)', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.mp3`);
      expect(res.status).toBe(404);
    });
  });

  describe('both files exist (stale wav from before regenerate)', () => {
    beforeAll(() => { resetAudio(); writeMp3(); writeWav(); });

    it('JSON metadata prefers the .mp3 URL', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
      expect(res.status).toBe(200);
      expect(res.body.url).toMatch(/audio\.mp3$/);
    });

    it('both file endpoints serve their respective MIMEs', async () => {
      const mp3 = await request(app).get(`/api/books/${bookId}/chapters/1/audio.mp3`);
      expect(mp3.status).toBe(200);
      expect(mp3.headers['content-type']).toMatch(/audio\/mpeg/);

      const wav = await request(app).get(`/api/books/${bookId}/chapters/1/audio.wav`);
      expect(wav.status).toBe(200);
      expect(wav.headers['content-type']).toMatch(/audio\/wav/);
    });
  });

  describe('no audio file', () => {
    beforeAll(() => { resetAudio(); });

    it('JSON metadata 404s', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
      expect(res.status).toBe(404);
    });

    it('audio.mp3 404s', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.mp3`);
      expect(res.status).toBe(404);
    });

    it('audio.wav 404s', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.wav`);
      expect(res.status).toBe(404);
    });
  });

  describe('unknown ids', () => {
    beforeAll(() => { resetAudio(); writeMp3(); });

    it('unknown bookId → 404', async () => {
      const res = await request(app).get('/api/books/does-not-exist__x__y/chapters/1/audio');
      expect(res.status).toBe(404);
    });

    it('non-integer chapterId → 404', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/not-a-number/audio`);
      expect(res.status).toBe(404);
    });

    it('unknown chapterId → 404', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/999/audio`);
      expect(res.status).toBe(404);
    });
  });
});
