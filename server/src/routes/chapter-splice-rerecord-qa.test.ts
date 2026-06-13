/* fs-32a regression — a legitimate re-record that changes the replaced
   segment's length must NOT false-flag the chapter QA as "suspect".

   Before the fix the splice passed `expectedSec = priorChapterDuration` to the
   QA gate, so a re-record that materially lengthened (or shortened) the line
   read as a 2.75× duration drift → spurious "suspect" badge. The fix passes the
   ANALYTIC post-splice expected duration (prior − replaced + new), so a normal
   re-record reads ratio ≈ 1.0 → `ok`, while a gross runaway in the re-recorded
   region still trips the band.

   Real ffmpeg encode/decode; only the GPU synth + the analysis cache are mocked
   so the test runs without a sidecar. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { evaluateChapterQa } from '../tts/audio-qa.js';

const AUTHOR = 'Rerecord QA Author';
const SERIES = 'Standalones';
const TITLE = 'Rerecord QA Story';
const SLUG = 'chapter-one';
const SR = 24_000;
const MANUSCRIPT_ID = 'm_rerecord_qa';

/* Re-record Castor's 1s line as a much longer 4.5s line. Prior chapter = 2.0s,
   so the OLD expectedSec (2.0s) vs the new ~5.5s chapter is ratio 2.75 → SUSPECT
   under the pre-fix code; the fix's expected (2.0 − 1.0 + 4.5 = 5.5s) → ok. */
const RERECORD_SEC = 4.5;

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
    // Re-synth returns a long 4.5s tone regardless of input, so the spliced
    // chapter is materially longer than the original.
    synthesiseChapter: vi.fn(async () => ({
      pcm: tone(RERECORD_SEC, 12000),
      sampleRate: SR,
      segments: [],
      durationSec: RERECORD_SEC,
    })),
  };
});

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-rerecord-qa-test-'));
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

  /* 1s Amy + 1s Castor = a 2.0s chapter. */
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

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('POST /:bookId/chapters/:chapterId/splice (rerecord) — fs-32a QA', () => {
  it('reads OK when a length-changing re-record would false-flag under the prior chapter duration', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'castor', modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'splice_complete');
    expect(done, `expected splice_complete, got ${res.text}`).toBeTruthy();

    // The re-record materially lengthened the chapter (~5.5s vs prior 2.0s).
    expect(Number(done!.durationSec)).toBeGreaterThan(4);

    // Persisted QA reads OK — the analytic post-splice expectedSec makes the
    // measured duration land at ratio ≈ 1.0.
    const segFile = JSON.parse(
      readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'),
    ) as { qa?: { status?: string }; durationSec: number };
    expect(segFile.qa?.status).toBe('ok');

    // Regression guard: the SAME measured duration WOULD have been flagged
    // "suspect" under the pre-fix expectedSec (the prior whole-chapter length).
    const underOldExpected = evaluateChapterQa({
      durationSec: segFile.durationSec,
      expectedSec: 2.0,
      lufs: null,
      truePeakDb: null,
    });
    expect(underOldExpected.status).toBe('suspect');
  });
});
