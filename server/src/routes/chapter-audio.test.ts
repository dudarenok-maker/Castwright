/* Integration tests for the chapter-audio router. Set WORKSPACE_DIR to a
   tempdir before importing the modules (paths.ts reads it at load time),
   scaffold a synthetic book layout, then drive the router with supertest.

   Post-plan-39: MP3 is the only chapter audio format. The legacy `.wav`
   fallback narrative has been retired; the `audio.wav` route is no longer
   registered and a legacy `.wav` on disk is invisible to the locator. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
        { groupIndex: 0, characterId: 'marlow', sentenceIds: [101, 102], startSec: 0, endSec: 6.2 },
        { groupIndex: 1, characterId: 'oduvan', sentenceIds: [103], startSec: 6.2, endSec: 12.5 },
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

function rmIfExists(name: string) {
  try {
    rmSync(join(audioRoot, name));
  } catch {
    /* ignore */
  }
}

function resetAudio() {
  rmIfExists(`${SLUG}.mp3`);
  rmIfExists(`${SLUG}.wav`);
  rmIfExists(`${SLUG}.previous.mp3`);
  rmIfExists(`${SLUG}.previous.segments.json`);
  rmIfExists(`${SLUG}.peaks.json`);
  rmIfExists(`${SLUG}.previous.peaks.json`);
  rmIfExists(`${SLUG}.lufs.json`);
  rmIfExists(`${SLUG}.previous.lufs.json`);
}

/** Drop a plan-71 sibling `<slug>.lufs.json` next to the MP3 with a
 *  realistic two-pass payload so the meta endpoint can be pinned to
 *  read it back verbatim. */
function writeLufs(
  slug = SLUG,
  payload: {
    i: number;
    lra: number;
    tp: number;
    target: number;
    twoPass: boolean;
    measuredAt?: string;
  } = {
    i: -16.02,
    lra: 8.4,
    tp: -2.1,
    target: -16,
    twoPass: true,
  },
) {
  writeFileSync(
    join(audioRoot, `${slug}.lufs.json`),
    JSON.stringify({
      i: payload.i,
      lra: payload.lra,
      tp: payload.tp,
      target: payload.target,
      twoPass: payload.twoPass,
      measuredAt: payload.measuredAt ?? '2026-05-20T12:00:00.000Z',
    }),
  );
}

/** Drop a plan-56 sibling `<slug>.peaks.json` next to the MP3 with a
 *  deterministic ramp so assertions can pin both presence AND content
 *  flow-through. */
function writePeaks(slug = SLUG, count = 240) {
  const peaks = Array.from({ length: count }, (_, i) => i / Math.max(1, count - 1));
  writeFileSync(join(audioRoot, `${slug}.peaks.json`), JSON.stringify({ peaks }));
}

function writePreviousMp3(bytes = 4096) {
  /* Distinguishable from writeMp3 — fill with 0x42 so byte comparisons in
     the restore test can prove the previous bytes really replaced the live
     bytes (vs. just touching the file). */
  const buf = Buffer.alloc(bytes, 0x42);
  buf[0] = 0xff;
  buf[1] = 0xf3;
  buf[2] = 0x40;
  buf[3] = 0xc0;
  writeFileSync(join(audioRoot, `${SLUG}.previous.mp3`), buf);
}

function writePreviousSegments() {
  writeFileSync(
    join(audioRoot, `${SLUG}.previous.segments.json`),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      durationSec: 11.0,
      sampleRate: 24_000,
      modelKey: 'xtts_v2',
      synthesizedAt: new Date().toISOString(),
      segments: [
        { groupIndex: 0, characterId: 'marlow', sentenceIds: [101], startSec: 0, endSec: 11 },
      ],
    }),
  );
}

describe('chapter-audio router', () => {
  describe('mp3 chapter', () => {
    beforeAll(() => {
      resetAudio();
      writeMp3();
    });

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

    it('GET audio.wav returns 404 (route not registered post-purge)', async () => {
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

  describe('no audio file', () => {
    beforeAll(() => {
      resetAudio();
    });

    it('JSON metadata 404s', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
      expect(res.status).toBe(404);
    });

    it('audio.mp3 404s', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.mp3`);
      expect(res.status).toBe(404);
    });

    it('audio.wav 404s (route not registered)', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.wav`);
      expect(res.status).toBe(404);
    });
  });

  describe('legacy .wav on disk is invisible', () => {
    /* Post-plan-39: a stray `.wav` left over from before the format
       switch must NOT shadow an absent `.mp3`. The locator probes only
       `.mp3`, so the JSON endpoint should 404. */
    beforeAll(() => {
      resetAudio();
      const data = Buffer.alloc(64, 0);
      const hdr = Buffer.alloc(44);
      hdr.write('RIFF', 0, 'ascii');
      hdr.writeUInt32LE(36 + data.length, 4);
      hdr.write('WAVE', 8, 'ascii');
      writeFileSync(join(audioRoot, `${SLUG}.wav`), Buffer.concat([hdr, data]));
    });

    it('JSON metadata still 404s with only a .wav on disk', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
      expect(res.status).toBe(404);
    });

    it('audio.wav route still 404s (route not registered)', async () => {
      const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio.wav`);
      expect(res.status).toBe(404);
    });
  });

  describe('unknown ids', () => {
    beforeAll(() => {
      resetAudio();
      writeMp3();
    });

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

  describe('peaks sibling (plan 56)', () => {
    describe('when sibling .peaks.json is present', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writePeaks();
      });

      it('meta endpoint returns the peaks array from disk', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.peaks)).toBe(true);
        expect(res.body.peaks).toHaveLength(240);
        /* Verify it's the content we wrote, not the legacy `[]` fallback —
           ramp values match the writePeaks fixture above. */
        expect(res.body.peaks[0]).toBeCloseTo(0, 6);
        expect(res.body.peaks[239]).toBeCloseTo(1, 6);
      });
    });

    describe('when sibling .peaks.json is missing (legacy chapter)', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
      });

      it('meta endpoint returns peaks: [] (graceful pre-plan-56 contract)', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        expect(res.status).toBe(200);
        expect(res.body.peaks).toEqual([]);
      });
    });

    describe('when sibling .peaks.json is malformed', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writeFileSync(join(audioRoot, `${SLUG}.peaks.json`), '{ this is not json');
      });

      it('meta endpoint absorbs the parse error and returns peaks: []', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        /* Critical: the route must NOT 500 on a corrupt peaks file —
           that would take the whole Listen view down for a visualization
           aid. The fallback path matches the legacy contract. */
        expect(res.status).toBe(200);
        expect(res.body.peaks).toEqual([]);
      });
    });
  });

  describe('loudness sidecar (plan 77 consumer of plan 71 writer)', () => {
    describe('when sibling .lufs.json is present (two-pass)', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writeLufs();
      });

      it('meta endpoint surfaces the lufs payload verbatim', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        expect(res.status).toBe(200);
        expect(res.body.lufs).toEqual({
          i: -16.02,
          lra: 8.4,
          tp: -2.1,
          target: -16,
          twoPass: true,
          measuredAt: '2026-05-20T12:00:00.000Z',
        });
      });
    });

    describe('when sibling .lufs.json is present (single-pass)', () => {
      /* Single-pass values are the nominal target restated, not a real
         post-filter measurement — the wire payload still carries them
         (the gate is `twoPass === true` on the consumer side, not on
         the route). */
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writeLufs(SLUG, {
          i: -16,
          lra: 11,
          tp: -1.5,
          target: -16,
          twoPass: false,
        });
      });

      it('meta endpoint surfaces twoPass: false unchanged so the UI can degrade to neutral', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        expect(res.status).toBe(200);
        expect(res.body.lufs).toBeTruthy();
        expect(res.body.lufs.twoPass).toBe(false);
        expect(res.body.lufs.target).toBe(-16);
      });
    });

    describe('when sibling .lufs.json is missing (legacy / disabled)', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
      });

      it('meta endpoint returns lufs: null — the "no data" gate for the report card', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        expect(res.status).toBe(200);
        expect(res.body.lufs).toBeNull();
      });
    });

    describe('when sibling .lufs.json is malformed', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writeFileSync(join(audioRoot, `${SLUG}.lufs.json`), '{ this is not json');
      });

      it('meta endpoint absorbs the parse error and returns lufs: null', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        /* Critical: corrupt sidecar must NOT 500 the meta endpoint —
           it's a visualization aid, not a hard dependency. The same
           graceful-fallback contract that plan 56's peaks file
           established. */
        expect(res.status).toBe(200);
        expect(res.body.lufs).toBeNull();
      });
    });

    describe('full payload round-trip', () => {
      it('preserves every field through the read path (no field-name drift)', async () => {
        resetAudio();
        writeMp3();
        const payload = {
          i: -18.7,
          lra: 9.1,
          tp: -1.8,
          target: -18,
          twoPass: true,
          measuredAt: '2026-04-12T10:30:00.000Z',
        };
        writeLufs(SLUG, payload);
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio`);
        expect(res.status).toBe(200);
        expect(res.body.lufs).toEqual(payload);
      });
    });
  });

  describe('preserved previous audio', () => {
    describe('GET /audio/previous', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writePreviousMp3();
        writePreviousSegments();
      });

      it('JSON metadata points at audio/previous.mp3 URL', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio/previous`);
        expect(res.status).toBe(200);
        expect(res.body.url).toBe(
          `/api/books/${encodeURIComponent(bookId)}/chapters/1/audio/previous.mp3`,
        );
        expect(res.body.durationSec).toBe(11.0);
        expect(res.body.segments).toHaveLength(1);
      });

      it('GET audio/previous.mp3 serves audio/mpeg with range support', async () => {
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio/previous.mp3`);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/audio\/mpeg/);
        expect(res.headers['accept-ranges']).toBe('bytes');
      });

      it('GET audio/previous 404s when nothing preserved', async () => {
        resetAudio();
        writeMp3();
        const res = await request(app).get(`/api/books/${bookId}/chapters/1/audio/previous`);
        expect(res.status).toBe(404);
      });
    });

    describe('DELETE /audio/previous (accept)', () => {
      beforeAll(() => {
        resetAudio();
        writeMp3();
        writePreviousMp3();
        writePreviousSegments();
      });

      it('removes both .previous.* files and 204s', async () => {
        const fs = await import('node:fs');
        expect(fs.existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);

        const res = await request(app).delete(`/api/books/${bookId}/chapters/1/audio/previous`);
        expect(res.status).toBe(204);
        expect(fs.existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(false);
        expect(fs.existsSync(join(audioRoot, `${SLUG}.previous.segments.json`))).toBe(false);
        /* Live file untouched. */
        expect(fs.existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
      });

      it('404s when nothing to delete', async () => {
        const res = await request(app).delete(`/api/books/${bookId}/chapters/1/audio/previous`);
        expect(res.status).toBe(404);
      });
    });

    describe('POST /audio/previous/restore (reject)', () => {
      it('renames .previous.* over live names and 204s', async () => {
        resetAudio();
        writeMp3();
        writePreviousMp3();
        writePreviousSegments();
        const fs = await import('node:fs');
        const liveMp3 = join(audioRoot, `${SLUG}.mp3`);
        const liveSegments = join(audioRoot, `${SLUG}.segments.json`);
        /* Mark the live mp3 with a sentinel byte so we can verify the
           previous content replaced it (not just sat next to it). */
        const liveBytes = fs.readFileSync(liveMp3);
        const prevBytes = fs.readFileSync(join(audioRoot, `${SLUG}.previous.mp3`));
        expect(liveBytes.equals(prevBytes)).toBe(false);

        const res = await request(app).post(
          `/api/books/${bookId}/chapters/1/audio/previous/restore`,
        );
        expect(res.status).toBe(204);

        /* Previous pair is gone; live now holds what was previous. */
        expect(fs.existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(false);
        expect(fs.existsSync(join(audioRoot, `${SLUG}.previous.segments.json`))).toBe(false);
        expect(fs.existsSync(liveMp3)).toBe(true);
        expect(fs.readFileSync(liveMp3).equals(prevBytes)).toBe(true);
        expect(fs.existsSync(liveSegments)).toBe(true);
      });

      it('404s when nothing preserved', async () => {
        resetAudio();
        writeMp3();
        const res = await request(app).post(
          `/api/books/${bookId}/chapters/1/audio/previous/restore`,
        );
        expect(res.status).toBe(404);
      });

      it('409s when a generation is in flight for the book', async () => {
        /* Re-mock generation.js so isGenerationActive returns true for any
           bookId — we don't want to spin up a real generation here, just
           verify the route refuses the restore under that condition.

           vi.doMock affects only the FOLLOWING fresh import. We re-import
           the router into a separate express app so the mock takes effect
           without contaminating the rest of the suite. */
        vi.resetModules();
        vi.doMock('./generation.js', () => ({
          generationRouter: undefined,
          isGenerationActive: () => true,
        }));
        const { chapterAudioRouter: mockedRouter } = await import('./chapter-audio.js');
        const mockedApp = express();
        mockedApp.use('/api/books', mockedRouter);

        resetAudio();
        writePreviousMp3();
        const res = await request(mockedApp).post(
          `/api/books/${bookId}/chapters/1/audio/previous/restore`,
        );
        expect(res.status).toBe(409);
        /* .previous.mp3 must still be on disk — refused, not partially executed. */
        const fs = await import('node:fs');
        expect(fs.existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);

        vi.doUnmock('./generation.js');
        vi.resetModules();
      });
    });
  });
});
