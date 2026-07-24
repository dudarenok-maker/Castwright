/* Integration tests for the fs-26 splice router (remix / gain path). Set
   WORKSPACE_DIR to a tempdir before importing the modules (paths.ts reads it at
   load time), scaffold a book with a REAL rendered chapter (encoded via the
   actual encoder), then drive the splice through supertest and assert the
   targeted character's region got louder while the chapter stays intact.

   Real ffmpeg throughout (encode + decode + gain) — no mocks at the audio
   boundary, matching the rest of the audio suite. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

/* fs-10 (#412, review fix) — regression: the splice route resolves
   `segmentIndices` against the ON-DISK segments array (where a title-led
   chapter's title beat occupies index 0), not the published/filtered one.
   Mock the two GPU-backed calls so the ownership + isRerecordableSegment gate
   below is exercised without a live sidecar. `loadAnalysisCache` is gated on
   manuscriptId so the "fails a valid re-record gracefully when no analysis is
   cached" case above (manuscriptId 'm_test') keeps its original empty-cache
   behaviour untouched. */
const TITLE_LED_MANUSCRIPT_ID = 'm_title_led';
vi.mock('../store/analysis-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/analysis-cache.js')>();
  return {
    ...actual,
    loadAnalysisCache: vi.fn(async (manuscriptId: string) =>
      manuscriptId === TITLE_LED_MANUSCRIPT_ID
        ? { chapters: { 1: [{ id: 1, characterId: 'amy', text: 'The first body line.' }] } }
        : { chapters: {} },
    ),
  };
});
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    // Re-synth returns a short 0.3s tone regardless of input — only used by
    // the title-led index-mapping case below, which cares about WHICH segment
    // got replaced, not the audio content.
    synthesiseChapter: vi.fn(async () => ({
      pcm: tone(0.3, 9000),
      sampleRate: SR,
      segments: [],
      durationSec: 0.3,
    })),
  };
});

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

describe('POST /:bookId/chapters/:chapterId/splice (rerecord) — fs-10 title-led index mapping', () => {
  let titleLedBookId: string;
  let titleLedAudioRoot: string;

  beforeAll(async () => {
    const [{ makeBookId: makeId }, mp3] = await Promise.all([
      import('../workspace/paths.js'),
      import('../tts/mp3.js'),
    ]);
    const author = 'Title-Led Author';
    const series = 'Standalones';
    const title = 'Title-Led Story';
    titleLedBookId = makeId(author, series, title);
    const bookDir = join(workspaceRoot, 'books', author, series, title);
    titleLedAudioRoot = join(bookDir, 'audio');
    mkdirSync(titleLedAudioRoot, { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: titleLedBookId,
        manuscriptId: TITLE_LED_MANUSCRIPT_ID,
        title,
        author,
        series,
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

    /* Title-led on-disk array: index 0 is the synthetic chapter-title beat
       (amy's characterId, no sentences), index 1 is amy's first real body
       line, index 2 belongs to another character — mirrors a book where the
       narrator and a re-recordable character are the same person, so
       ownership alone can't tell the title beat apart from a real line. */
    const chapterPcm = Buffer.concat([tone(0.2, 12000), tone(1.0, 9000), tone(1.0, 3000)]);
    const mp3Bytes = await mp3.encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(titleLedAudioRoot, `${SLUG}.mp3`), mp3Bytes);
    writeFileSync(
      join(titleLedAudioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId: titleLedBookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 2.2,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [
          { groupIndex: -1, characterId: 'amy', sentenceIds: [], startSec: 0, endSec: 0.2, kind: 'title' },
          { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0.2, endSec: 1.2 },
          { groupIndex: 1, characterId: 'castor', sentenceIds: [2], startSec: 1.2, endSec: 2.2 },
        ],
      }),
    );
  });

  it('targets the first BODY line (index 1) and re-records it, leaving the title beat untouched', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(titleLedBookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'amy', modelKey: 'kokoro-v1', segmentIndices: [1] });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'splice_complete');
    expect(done, `expected splice_complete, got ${res.text}`).toBeTruthy();

    const segFile = JSON.parse(readFileSync(join(titleLedAudioRoot, `${SLUG}.segments.json`), 'utf8')) as {
      segments: Array<{ kind?: string; startSec: number; endSec: number; characterId: string }>;
    };
    // The title beat (segment 0) is untouched — same timing, still kind:'title'.
    expect(segFile.segments[0]).toMatchObject({ kind: 'title', startSec: 0, endSec: 0.2 });
    // The body segment (segment 1) is the one that changed — it now reflects
    // the mocked re-record's 0.3s length (was 1.0s), proving the request
    // targeted index 1, not the title at index 0.
    expect(segFile.segments[1].endSec - segFile.segments[1].startSec).toBeCloseTo(0.3, 5);
  });

  it('rejects targeting the title beat (index 0) directly with the title-only error', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(titleLedBookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'amy', modelKey: 'kokoro-v1', segmentIndices: [0] });

    const events = parseSse(res.text);
    const failed = events.find((e) => e.type === 'chapter_failed');
    expect(failed).toBeTruthy();
    expect(String(failed!.errorReason)).toBe(
      'No re-recordable lines for this character in this chapter (title-only).',
    );
  });
});
