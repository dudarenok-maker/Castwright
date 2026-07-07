/* fs-51 review follow-up — CRITICAL regression test for a genuine false-pass
   bug found in code review of PR #1433.

   Scenario: a segment carries a genuine prior `suspect: true` / `qa.status:
   'suspect'` verdict from an earlier full-book render (gates on at the time).
   A user later does an unrelated manual "regenerate this line" via the splice
   route, but the signal-QA gate is now configured OFF (`qa.seg.maxRerecords`
   = 0) and ASR is off. `synthesiseChapter` never evaluates the gate for this
   call (its own `maxSegmentRerecords > 0` guard), so it genuinely doesn't
   know whether the new take is good or bad — it returns `qa: undefined,
   suspect: undefined`, correctly reflecting "not checked."

   Before the fix, `buildSynthReplacements` wrapped this into a `freshVerdict`
   object that STILL carried the `qa`/`suspect` keys (just with `undefined`
   values), and `spliceChapterSegments`'s `{...segment, ...freshVerdict}`
   spread copies a key's presence regardless of its value — so the segment's
   real prior `suspect: true` was silently wiped to `undefined`. The segment
   then read as clean everywhere downstream (Listen-view issues list,
   qa-report.ts's `acoustic.chaptersFlagged`) even though nobody re-validated
   the new take.

   After the fix, `signalQaRan`/`asrRan` tell buildSynthReplacements whether
   each gate actually ran, and it omits the corresponding key group entirely
   when it didn't — so this segment's PRIOR suspect/qa fields must survive
   the splice unchanged.

   Real ffmpeg encode/decode; only the GPU synth + the analysis cache are
   mocked so the test runs without a sidecar. Mirrors the sibling
   `chapter-splice-fresh-verdict.test.ts` (the gate-ON counterpart). */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Gate Off Author';
const SERIES = 'Standalones';
const TITLE = 'Gate Off Story';
const SLUG = 'chapter-one';
const SR = 24_000;
const MANUSCRIPT_ID = 'm_gate_off';

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

/* The gate is OFF for this call (maxSegmentRerecords: 0, no `asr` options), so
   the REAL synthesiseChapter never evaluates segment-qa for the returned
   segment — it genuinely returns `qa: undefined, suspect: undefined`. This
   mock mirrors that real behavior rather than re-deriving synthesiseChapter's
   internal gate logic. */
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
          qa: undefined,
          suspect: undefined,
        },
      ],
    })),
  };
});

beforeAll(async () => {
  // Gate off: signal-QA disabled, ASR left at its default-off.
  process.env.SEG_QA_MAX_RERECORDS = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-gate-off-test-'));
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

  /* 1s Amy + 1s Castor = a 2.0s chapter. Castor's segment carries a GENUINE
     prior suspect/qa verdict from an earlier render with the gate on — the
     re-record below (gate off) must not touch it. */
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
          qa: { status: 'suspect', reasons: ['stale-but-real'], rms: 0, longestSilenceSec: 0, durationSec: 1.0, expectedSec: 1.0 },
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
  delete process.env.SEG_QA_MAX_RERECORDS;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('POST /:bookId/chapters/:chapterId/splice (rerecord) — fs-51 gate-off must not wipe a genuine prior verdict', () => {
  it('leaves the segment suspect:true / qa.status:suspect UNCHANGED when the re-record ran with the signal-QA gate off and ASR off', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/splice`)
      .send({ mode: 'rerecord', characterId: 'castor', modelKey: 'kokoro-v1' });

    expect(res.status).toBeLessThan(400);

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8')) as {
      segments: Array<{ characterId: string; qa?: { status?: string; reasons?: string[] }; suspect?: boolean }>;
    };
    const castorSegment = segFile.segments.find((s) => s.characterId === 'castor');
    // THE CRITICAL ASSERTION: the stale-but-real verdict survives untouched —
    // the gate never ran for this call, so it must not be allowed to clear it.
    expect(castorSegment?.suspect).toBe(true);
    expect(castorSegment?.qa?.status).toBe('suspect');
    expect(castorSegment?.qa?.reasons).toEqual(['stale-but-real']);
  });
});
