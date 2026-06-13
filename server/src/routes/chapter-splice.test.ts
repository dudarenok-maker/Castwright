/* Integration tests for the fs-26 splice router (remix / gain path). Set
   WORKSPACE_DIR to a tempdir before importing the modules (paths.ts reads it at
   load time), scaffold a book with a REAL rendered chapter (encoded via the
   actual encoder), then drive the splice through supertest and assert the
   targeted character's region got louder while the chapter stays intact.

   Real ffmpeg throughout (encode + decode + gain) — no mocks at the audio
   boundary, matching the rest of the audio suite. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Splice Author';
const SERIES = 'Standalones';
const TITLE = 'Splice Story';
const SLUG = 'chapter-one';
const SR = 24_000;

let workspaceRoot: string;
let audioRoot: string;
let app: Express;
let bookId: string;
let decodeAudioToPcm: (b: Buffer, sr: number) => Promise<Buffer>;

/** Constant-amplitude int16 mono PCM. */
function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    // a low-freq sine so loudnorm has real signal to measure
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

/** Mean absolute amplitude over a [startSec, endSec) slice of mono PCM. */
function avgAbsRange(pcm: Buffer, startSec: number, endSec: number): number {
  const a = Math.round(startSec * SR);
  const b = Math.min(Math.round(endSec * SR), pcm.length / 2);
  let sum = 0;
  let count = 0;
  for (let i = a; i < b; i += 1) {
    sum += Math.abs(pcm.readInt16LE(i * 2));
    count += 1;
  }
  return count ? sum / count : 0;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-splice-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ chapterSpliceRouter }, { makeBookId }, mp3] = await Promise.all([
    import('./chapter-splice.js'),
    import('../workspace/paths.js'),
    import('../tts/mp3.js'),
  ]);
  decodeAudioToPcm = mp3.decodeAudioToPcm;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

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
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:02' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'amy', name: 'Amy', gender: 'female', attributes: [] },
        { id: 'castor', name: 'Castor', gender: 'female', attributes: [] },
      ],
    }),
  );

  /* Real chapter: 1s loud Amy + 1s quiet Castor, encoded via the actual MP3
     encoder so the route's decode→gain→re-encode pipeline runs for real. */
  const amy = tone(1.0, 12000);
  const castor = tone(1.0, 3000);
  const chapterPcm = Buffer.concat([amy, castor]);
  const mp3Bytes = await mp3.encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
  writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);
  writeFileSync(
    join(audioRoot, `${SLUG}.segments.json`),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      durationSec: 2.0,
      sampleRate: SR,
      modelKey: 'kokoro-v1',
      synthesizedAt: new Date().toISOString(),
      segments: [
        { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 },
        { groupIndex: 1, characterId: 'castor', sentenceIds: [2], startSec: 1.0, endSec: 2.0 },
      ],
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', chapterSpliceRouter);
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Pull the `data:` JSON frames out of an SSE response body. */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('POST /:bookId/chapters/:chapterId/splice (remix)', () => {
  it('boosts the target character region and preserves the chapter', async () => {
    const before = await decodeAudioToPcm(readFileSync(join(audioRoot, `${SLUG}.mp3`)), SR);
    const castorBefore = avgAbsRange(before, 1.05, 1.95);
    const amyBefore = avgAbsRange(before, 0.05, 0.95);

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'remix', characterId: 'castor', gainDb: 10 });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'splice_complete');
    expect(done, `expected splice_complete, got ${res.text}`).toBeTruthy();
    expect(done!.hasPreviousAudio).toBe(true);

    // Prior take preserved for A/B + rollback.
    expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(true);
    expect(existsSync(join(audioRoot, `${SLUG}.previous.segments.json`))).toBe(true);

    const after = await decodeAudioToPcm(readFileSync(join(audioRoot, `${SLUG}.mp3`)), SR);
    const castorAfter = avgAbsRange(after, 1.05, 1.95);
    const amyAfter = avgAbsRange(after, 0.05, 0.95);

    // Castor got materially louder; her gain RELATIVE to Amy increased.
    expect(castorAfter).toBeGreaterThan(castorBefore * 1.5);
    expect(castorAfter / amyAfter).toBeGreaterThan(castorBefore / amyBefore);

    // Duration unchanged by a pure gain (within a frame of MP3 slack).
    expect(Math.abs(after.length - before.length) / (SR * 2)).toBeLessThan(0.1);
  });

  it('rejects a remix for a character with no segments', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'remix', characterId: 'nobody', gainDb: 6 });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });

  it('rejects an out-of-range gain', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'remix', characterId: 'castor', gainDb: 99 });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });

  it('rejects a re-record with an invalid modelKey', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'castor', modelKey: 'not-a-model' });
    const events = parseSse(res.text);
    const failed = events.find((e) => e.type === 'chapter_failed');
    expect(failed).toBeTruthy();
    expect(String(failed!.errorReason)).toMatch(/modelKey/i);
  });

  it('fails a valid re-record gracefully when no analysis is cached', async () => {
    // No analysis cache exists for this fixture book, so the re-record can't
    // find the sentences to re-synthesise → clean chapter_failed (not a crash).
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'castor', modelKey: 'kokoro-v1' });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'splice_start')).toBe(true);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });
});
