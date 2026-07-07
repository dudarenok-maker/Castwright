/* fs-51 — a manual splice re-record must write a FRESH QA/ASR verdict for the
   re-recorded segment, not spread forward the stale one from before the
   re-record. This also exercises the companion route-level change: the
   `synth` callback now passes real signal-QA/ASR gate options into its
   `synthesiseChapter` call (previously it passed none), so a manual splice
   re-record gains the same QA coverage as a normal render for that sentence.

   Real ffmpeg encode/decode; only the GPU synth + the analysis cache are
   mocked so the test runs without a sidecar. Mirrors the scaffold in the
   sibling `chapter-splice-rerecord-qa.test.ts` (fs-32a). */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Fresh Verdict Author';
const SERIES = 'Standalones';
const TITLE = 'Fresh Verdict Story';
const SLUG = 'chapter-one';
const SR = 24_000;
const MANUSCRIPT_ID = 'm_fresh_verdict';

let workspaceRoot: string;
let audioRoot: string;
let app: Express;
let bookId: string;

function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

vi.mock('../store/analysis-cache.js', () => ({
  loadAnalysisCache: vi.fn(async () => ({
    chapters: { 1: [{ id: 2, characterId: 'castor', text: 'A re-recorded line.' }] },
  })),
}));

vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: vi.fn(async () => ({
      pcm: tone(1.0, 12000),
      sampleRate: SR,
      durationSec: 1.0,
      segments: [
        {
          groupIndex: 0,
          characterId: 'castor',
          sentenceIds: [2],
          startSec: 0,
          endSec: 1.0,
          qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1.0, expectedSec: 1.0 },
          suspect: undefined,
        },
      ],
    })),
  };
});

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-fresh-verdict-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ chapterSpliceRouter }, { makeBookId }, mp3] = await Promise.all([
    import('./chapter-splice.js'),
    import('../workspace/paths.js'),
    import('../tts/mp3.js'),
  ]);
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
      manuscriptId: MANUSCRIPT_ID,
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

  /* 1s Amy + 1s Castor = a 2.0s chapter. Castor's segment carries a stale
     suspect/qa verdict that the re-record must overwrite. */
  const chapterPcm = Buffer.concat([tone(1.0, 12000), tone(1.0, 12000)]);
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
        {
          groupIndex: 1,
          characterId: 'castor',
          sentenceIds: [2],
          startSec: 1.0,
          endSec: 2.0,
          qa: { status: 'suspect', reasons: ['stale'], rms: 0, longestSilenceSec: 0, durationSec: 1.0, expectedSec: 1.0 },
          suspect: true,
        },
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

describe('POST /:bookId/chapters/:chapterId/splice (rerecord) — fs-51 fresh verdict', () => {
  it('passes the signal-QA/ASR gate options to the re-record synth call and persists its fresh verdict, not the stale one', async () => {
    const { synthesiseChapter } = await import('../tts/synthesise-chapter.js');

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'castor', modelKey: 'kokoro-v1' });

    expect(res.status).toBeLessThan(400);
    expect(vi.mocked(synthesiseChapter)).toHaveBeenCalledWith(
      expect.objectContaining({ maxSegmentRerecords: expect.any(Number) }),
    );

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8')) as {
      segments: Array<{ characterId: string; qa?: { status?: string }; suspect?: boolean }>;
    };
    const castorSegment = segFile.segments.find((s) => s.characterId === 'castor');
    expect(castorSegment?.qa?.status).toBe('ok');
    expect(castorSegment?.suspect).toBeUndefined();
  });
});
