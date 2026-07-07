/* fs-51 follow-up regression: `asrRetries` on the audio-QA repair route must
   count only attempts the ASR check itself flagged (`verdict === 'drift'`),
   NOT every attempt in this route's combined signal-QA/ASR loop — unlike
   `retryCount`/`qaRetries`, which do count every attempt regardless of which
   gate rejected it. Before this fix, `asrRetries` was stamped as the SAME
   `retryCount` whenever ASR was enabled, so a segment that needed several
   attempts purely on signal-QA (ASR verdict `ok` throughout) was mis-reported
   as having that many ASR-driven retries.

   Scaffolds a segment that starts dead-silent (flagged by the signal scan,
   so the repair loop runs), fails signal-QA on attempt 1, and recovers on
   attempt 2 — purely a signal-QA story. The mocked ASR transcript always
   matches the reference text exactly (WER 0 → verdict 'ok' on every attempt),
   so the ASR gate never rejects a take. Asserts `qaRetries` reflects the two
   attempts while `asrRetries` stays undefined. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Asr Retries Author';
const SERIES = 'Standalones';
const TITLE = 'Asr Retries Story';
const SLUG = 'chapter-one';
const SR = 24_000;
// Short text (low duration-drift `expectedSec`, same trick as
// chapter-qa-repair.test.ts's VERDICT_SENTENCES) so the 0.5s re-record
// fixtures below land inside segment-qa's duration-ratio window regardless
// of which attempt is being evaluated — only the RMS/silence check should
// decide acceptance here, not an incidental duration flag.
const TEXT = 'Yes.';

/* Transcript ALWAYS matches TEXT exactly (WER 0) regardless of the PCM it's
   "given" — the ASR gate must stay 'ok' on every attempt so this test isolates
   signal-QA-only retries. */
vi.mock('../tts/transcribe-client.js', () => ({
  transcribeSegment: vi.fn(async () => ({
    text: TEXT,
    language: 'en',
    avgLogprob: -0.2,
    noSpeechProb: 0.02,
    compressionRatio: 1.3,
  })),
}));

vi.mock('../store/analysis-cache.js', () => ({
  loadAnalysisCache: vi.fn(async () => ({ chapters: { 1: [{ id: 1, text: TEXT }] } })),
}));

/* The repair path's re-record synth call — mocked so attempt 1 renders dead
   silence (rejected by signal-QA) and attempt 2 renders a healthy tone
   (accepted). */
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return { ...real, synthesiseChapter: vi.fn() };
});

let workspaceRoot: string;
let audioRoot: string;
let app: Express;
let bookId: string;
let synthesiseChapterMock: any;

function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

beforeAll(async () => {
  process.env.SEG_ASR_ENABLED = '1';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-asr-retries-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const synth = await import('../tts/synthesise-chapter.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const mp3 = await import('../tts/mp3.js');
  const { chapterQaRepairRouter } = await import('./chapter-qa-repair.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  synthesiseChapterMock = vi.mocked(synth.synthesiseChapter);

  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_asr_retries_test',
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
    JSON.stringify({ characters: [{ id: 'amy', name: 'Amy', gender: 'female', attributes: [] }] }),
  );

  /* Dead-silent rendered segment — flagged by the initial signal scan so the
     repair loop runs at all (this route only repairs what the scan flags). */
  const silentPcm = Buffer.alloc(SR * 2); // 2s of dead silence
  const mp3Bytes = await mp3.encodePcmToAudio(silentPcm, SR, { format: 'mp3', quality: 2 });
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
      segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 2.0 }],
    }),
  );

  app = express();
  app.use(express.json());
  app.use('/api/books', chapterQaRepairRouter);
});

afterAll(() => {
  delete process.env.SEG_ASR_ENABLED;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

function readSegmentsJson(): {
  segments: Array<{ qaRetries?: number; asrRetries?: number }>;
} {
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  const segPath = join(bookDir, 'audio', `${SLUG}.segments.json`);
  return JSON.parse(readFileSync(segPath, 'utf8'));
}

describe('audio-qa-repair asrRetries vs qaRetries (fs-51 follow-up)', () => {
  it('does NOT count a signal-QA-only retry as an ASR retry', async () => {
    synthesiseChapterMock.mockReset();
    let call = 0;
    synthesiseChapterMock.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? { pcm: Buffer.alloc(Math.round(0.5 * SR) * 2), sampleRate: SR } // attempt 1: dead silence — signal-QA rejects
        : { pcm: tone(0.5, 12000), sampleRate: SR }; // attempt 2: healthy tone — accepted
    });

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
    expect((done!.repaired as number[]).includes(0)).toBe(true);
    expect(call).toBe(2); // 1 initial + 1 signal-QA-driven retry

    const segFile = readSegmentsJson();
    // Total attempts: qaRetries counts every attempt in the combined loop.
    expect(segFile.segments[0].qaRetries).toBe(2);
    // ASR never flagged a 'drift' verdict (transcript always matches), so the
    // ASR-specific counter must stay undefined — NOT mirror qaRetries.
    expect(segFile.segments[0].asrRetries).toBeUndefined();
  });
});
