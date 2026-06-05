/* ASR content-QA in the audio-QA repair route (srv-31). The signal scan can't
   flag a fluent, full-length, full-loudness segment that says the WRONG words;
   the ASR scan can. This drives the dry-run scan over a fixture whose only
   segment is signal-CLEAN (a loud tone) and asserts that, with SEG_ASR_ENABLED,
   a drifting transcript flags it for re-record.

   transcribe-client + analysis-cache are mocked (no sidecar, no real cache). */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Asr Author';
const SERIES = 'Standalones';
const TITLE = 'Asr Story';
const SLUG = 'chapter-one';
const SR = 24_000;
const TEXT = 'The quick brown fox jumped over the lazy dog in the moonlit yard.';

/* Drift transcript — completely different words, clean signals → classify=drift. */
vi.mock('../tts/transcribe-client.js', () => ({
  transcribeSegment: vi.fn(async () => ({
    text: 'absolutely none of these spoken words match the manuscript line at all',
    language: 'en',
    avgLogprob: -0.2,
    noSpeechProb: 0.02,
    compressionRatio: 1.3,
  })),
}));

/* Provide sentence text so segText (and thus the ASR check) has a reference. */
vi.mock('../store/analysis-cache.js', () => ({
  loadAnalysisCache: vi.fn(async () => ({ chapters: { 1: [{ id: 1, text: TEXT }] } })),
}));

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

beforeAll(async () => {
  process.env.SEG_ASR_ENABLED = '1';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-asr-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ chapterQaRepairRouter }, { makeBookId }, mp3] = await Promise.all([
    import('./chapter-qa-repair.js'),
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
      manuscriptId: 'm_asr_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:04' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [{ id: 'amy', name: 'Amy', gender: 'female', attributes: [] }] }),
  );

  /* One signal-CLEAN segment: ~4s of loud tone (matches TEXT's predicted length
     so the duration check passes too). The ONLY way to flag it is content/ASR. */
  const amy = tone(4.0, 12000);
  const mp3Bytes = await mp3.encodePcmToAudio(amy, SR, { format: 'mp3', quality: 2 });
  writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);
  writeFileSync(
    join(audioRoot, `${SLUG}.segments.json`),
    JSON.stringify({
      bookId,
      chapterId: 1,
      chapterTitle: 'Chapter 1',
      durationSec: 4.0,
      sampleRate: SR,
      modelKey: 'kokoro-v1',
      synthesizedAt: new Date().toISOString(),
      segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 4.0 }],
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

describe('audio-qa-repair ASR content scan (srv-31)', () => {
  it('flags a signal-clean but wrong-words segment via the ASR check', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: true });
    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got ${res.text}`).toBeTruthy();
    const flagged = done!.flagged as Array<{ segmentIndex: number; reasons: string[] }>;
    expect(flagged).toHaveLength(1);
    expect(flagged[0].segmentIndex).toBe(0);
    // The reason is the content-drift one, not a signal reason.
    expect(flagged[0].reasons.join(' ')).toMatch(/drift|word-error/i);
  });
});
