/* Integration tests for the audio-QA repair router. Mirrors the fs-26 splice
   harness: WORKSPACE_DIR → tempdir before import, scaffold a book with a REAL
   rendered chapter (one healthy segment + one dead/silent segment, encoded via
   the actual encoder), then drive the repair through supertest.

   The dry-run SCAN is the new logic under test and needs no sidecar — it reads
   the rendered PCM back and flags the silent segment. The non-dry-run re-record
   path's synth+splice mechanics are covered by the segment-qa gate +
   build-synth-replacement + splice-chapter unit tests; here we only assert it
   degrades gracefully when there's nothing to re-synthesise from. */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Repair Author';
const SERIES = 'Standalones';
const TITLE = 'Repair Story';
const SLUG = 'chapter-one';
const SR = 24_000;

/* fs-51 — the re-record path re-synthesises with a mocked engine so the
   "accepted verdict lands on the segment" / "failed repair still marks
   suspect" tests below don't need a live sidecar. Only the manuscript id
   used by those fixtures gets a canned analysis cache below; every other
   manuscriptId (this file's original fixture) still falls through to the
   real, disk-backed loadAnalysisCache — preserving the existing "no cached
   analysis" test's behavior unchanged. */
const VERDICT_MANUSCRIPT_ID = 'm_verdict_test';
// Short text (low duration-drift `expectedSec`) so the 0.5s re-record fixtures
// below land inside segment-qa's duration-ratio window regardless of it being
// the accepted (healthy) or failed (silent) take — only the RMS/silence check
// should decide acceptance in these tests, not an incidental duration flag.
const VERDICT_SENTENCES = [{ id: 2, text: 'Yes.' }];

vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return { ...real, synthesiseChapter: vi.fn() };
});

/* Only exercised by the "acoustic-only rejection" describe block below (which
   turns on qa.speaker.autoRepair via SEG_SPK_AUTO_REPAIR for its own tests) —
   returns a vector orthogonal to that block's centroid fixture, so its
   cosine check reliably lands below cleanMean regardless of the take. */
vi.mock('../tts/embed-client.js', () => ({
  embedSegment: vi.fn(async () => {
    const v = new Float32Array(192).fill(0);
    v[1] = 1.0;
    return v;
  }),
}));

vi.mock('../store/analysis-cache.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../store/analysis-cache.js')>();
  return {
    ...real,
    loadAnalysisCache: vi.fn(async (manuscriptId: string) => {
      if (manuscriptId === VERDICT_MANUSCRIPT_ID) {
        return { chapters: { 1: VERDICT_SENTENCES } };
      }
      return real.loadAnalysisCache(manuscriptId);
    }),
  };
});

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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-repair-test-'));
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
      manuscriptId: 'm_repair_test',
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

  /* Real chapter: 1s loud Amy (healthy) + 1s of DEAD SILENCE for Castor (a
     dropped generation). Encoded via the real MP3 encoder so the route's
     decode→scan pipeline runs against true bytes. */
  const amy = tone(1.0, 12000);
  const castorSilent = Buffer.alloc(SR * 2); // 1s of zeros
  const chapterPcm = Buffer.concat([amy, castorSilent]);
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
  app.use('/api/books', chapterQaRepairRouter);
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

describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (dry-run scan)', () => {
  it('flags the dead/silent segment and leaves the audio untouched', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: true });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got ${res.text}`).toBeTruthy();
    expect(done!.dryRun).toBe(true);

    const flagged = done!.flagged as Array<{ segmentIndex: number; reasons: string[] }>;
    expect(flagged).toHaveLength(1);
    expect(flagged[0].segmentIndex).toBe(1); // Castor's silent segment
    expect(flagged[0].reasons.some((r) => /silent/i.test(r))).toBe(true);
    expect(done!.repaired).toEqual([]);

    // Dry run writes nothing — no rollback snapshot created.
    expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(false);
  });
});

describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (repair)', () => {
  it('fails gracefully when flagged segments have no cached analysis to re-synthesise', async () => {
    // No analysis cache for this fixture, so the re-record can't find sentences
    // → clean chapter_failed (not a crash). The scan still runs first.
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'qa_scan' || e.type === 'splice_start')).toBe(true);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });

  it('rejects an unknown book', async () => {
    const res = await request(app)
      .post('/api/books/nope/chapters/1/audio-qa-repair')
      .send({ dryRun: true });
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'chapter_failed')).toBe(true);
  });
});

describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (fs-51 verdict persistence)', () => {
  /* `workspace/paths.js` resolves WORKSPACE_ROOT from process.env.WORKSPACE_DIR
     at MODULE LOAD time — the outer beforeAll above already imported it (after
     setting the env var) once, so this second dynamic import just returns the
     same cached, correctly-rooted module. A static top-level import would run
     before the env var is set and lock in the wrong root. */
  let makeBookId: (author: string, series: string, title: string) => string;
  let audioDirFn: (bookDir: string) => string;
  let encodePcmToAudio: (pcm: Buffer, sr: number, opts: { format: 'mp3'; quality: number }) => Promise<Buffer>;
  // Test-only mock reference — the real synthesiseChapter's opts/result types
  // aren't worth reproducing here just to type a vi.mocked() handle.
  let synthesiseChapterMock: any;

  beforeAll(async () => {
    const paths = await import('../workspace/paths.js');
    const mp3 = await import('../tts/mp3.js');
    const synth = await import('../tts/synthesise-chapter.js');
    makeBookId = paths.makeBookId;
    audioDirFn = paths.audioDir;
    encodePcmToAudio = mp3.encodePcmToAudio;
    synthesiseChapterMock = vi.mocked(synth.synthesiseChapter);
  });

  /** Scaffold a fresh book (own directory, so parallel it()s never share
      audio/segments files) with segment 0 healthy ('amy') and segment 1
      dead-silent ('castor') — the silent one is what the signal scan flags
      and the repair loop re-records. */
  async function scaffoldVerdictBook(bookTitle: string): Promise<{ bookId: string; chapterSlug: string }> {
    const author = 'Verdict Author';
    const series = 'Standalones';
    const slug = 'chapter-one';
    const id = makeBookId(author, series, bookTitle);

    const bookDir = join(workspaceRoot, 'books', author, series, bookTitle);
    const thisAudioRoot = audioDirFn(bookDir);
    mkdirSync(thisAudioRoot, { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: id,
        manuscriptId: VERDICT_MANUSCRIPT_ID,
        title: bookTitle,
        author,
        series,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter 1', slug, duration: '0:02' }],
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

    const amy = tone(1.0, 12000);
    const castorSilent = Buffer.alloc(SR * 2); // 1s of dead silence — flagged by the signal scan
    const chapterPcm = Buffer.concat([amy, castorSilent]);
    const mp3Bytes = await encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(thisAudioRoot, `${slug}.mp3`), mp3Bytes);
    writeFileSync(
      join(thisAudioRoot, `${slug}.segments.json`),
      JSON.stringify({
        bookId: id,
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

    return { bookId: id, chapterSlug: slug };
  }

  function readSegmentsJson(bookTitle: string, chapterSlug: string): {
    segments: Array<{
      qa?: { status: string; reasons: string[] };
      suspect?: boolean;
      qaRetries?: number;
    }>;
  } {
    const bookDir = join(workspaceRoot, 'books', 'Verdict Author', 'Standalones', bookTitle);
    const segPath = join(audioDirFn(bookDir), `${chapterSlug}.segments.json`);
    return JSON.parse(readFileSync(segPath, 'utf8'));
  }

  it('writes the accepted take verdict onto the repaired segment, not the stale pre-repair one', async () => {
    synthesiseChapterMock.mockReset();
    synthesiseChapterMock.mockImplementation(async () => ({
      pcm: tone(0.5, 12000), // loud, healthy re-record — accepted on attempt 1
      sampleRate: SR,
    }));

    const { bookId: id, chapterSlug } = await scaffoldVerdictBook('Accepted Story');

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(id)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
    expect((done!.repaired as number[]).includes(1)).toBe(true);

    const segFile = readSegmentsJson('Accepted Story', chapterSlug);
    expect(segFile.segments[1].suspect).toBeUndefined();
    expect(segFile.segments[1].qa?.status).toBe('ok');
    expect(segFile.segments[1].qaRetries).toBeGreaterThan(0);
  });

  it('a failed repair (never becomes acceptable) still marks the segment suspect:true, not undefined', async () => {
    synthesiseChapterMock.mockReset();
    synthesiseChapterMock.mockImplementation(async () => ({
      pcm: Buffer.alloc(Math.round(0.5 * SR) * 2), // dead silence on EVERY attempt — never acceptable
      sampleRate: SR,
    }));

    const { bookId: id, chapterSlug } = await scaffoldVerdictBook('Failed Story');

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(id)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
    expect((done!.stillSuspect as number[]).includes(1)).toBe(true);
    expect((done!.repaired as number[]).includes(1)).toBe(false);

    // The regression this closes: a still-bad repair must persist suspect:true,
    // not leave the field cleared to undefined by buildSynthReplacements's
    // unconditional freshVerdict construction (fs-51 Task 3 review finding).
    const segFile = readSegmentsJson('Failed Story', chapterSlug);
    expect(segFile.segments[1].suspect).toBe(true);
    expect(segFile.segments[1].qa?.status).toBe('suspect');
    expect(segFile.segments[1].qaRetries).toBeGreaterThan(0);
  });
});

describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (acoustic-only rejection does not mislabel suspect)', () => {
  /* Same dynamic-import rationale as the "fs-51 verdict persistence" describe
     above (WORKSPACE_ROOT is resolved at module-load time). */
  let makeBookId: (author: string, series: string, title: string) => string;
  let audioDirFn: (bookDir: string) => string;
  let encodePcmToAudio: (pcm: Buffer, sr: number, opts: { format: 'mp3'; quality: number }) => Promise<Buffer>;
  let synthesiseChapterMock: any;

  const AUTHOR2 = 'Acoustic Author';
  const SERIES2 = 'Standalones';

  beforeAll(async () => {
    // qa.speaker.autoRepair defaults OFF; scope it on only for this describe
    // block's tests so the merge-in-acoustic-candidates branch runs.
    process.env.SEG_SPK_AUTO_REPAIR = '1';
    const paths = await import('../workspace/paths.js');
    const mp3 = await import('../tts/mp3.js');
    const synth = await import('../tts/synthesise-chapter.js');
    makeBookId = paths.makeBookId;
    audioDirFn = paths.audioDir;
    encodePcmToAudio = mp3.encodePcmToAudio;
    synthesiseChapterMock = vi.mocked(synth.synthesiseChapter);
  });

  afterAll(() => {
    delete process.env.SEG_SPK_AUTO_REPAIR;
  });

  function unitVec(axis: number): number[] {
    const v = new Array<number>(192).fill(0);
    v[axis] = 1.0;
    return v;
  }

  /** Both segments are HEALTHY/loud — the initial per-segment signal/ASR scan
      flags neither. Only the sibling render-integrity.json marks castor's
      segment as a fixable voice-mismatch, so it enters the repair loop as a
      pure acoustic-only candidate (acousticOnly: true, no signal/ASR backing).
      The mocked embedSegment (axis 1) is orthogonal to the centroid fixture
      (axis 0), so its cosine is ~0 — always below cleanMean — meaning the
      re-record is rejected on the acoustic gate on every attempt even though
      its own signal-QA is clean. */
  async function scaffoldAcousticOnlyBook(
    bookTitle: string,
  ): Promise<{ bookId: string; chapterSlug: string }> {
    const id = makeBookId(AUTHOR2, SERIES2, bookTitle);
    const bookDir = join(workspaceRoot, 'books', AUTHOR2, SERIES2, bookTitle);
    const thisAudioRoot = audioDirFn(bookDir);
    mkdirSync(thisAudioRoot, { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: id,
        manuscriptId: VERDICT_MANUSCRIPT_ID,
        title: bookTitle,
        author: AUTHOR2,
        series: SERIES2,
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

    const amy = tone(1.0, 12000);
    const castorHealthy = tone(1.0, 12000); // healthy, NOT silent — signal scan won't flag it
    const chapterPcm = Buffer.concat([amy, castorHealthy]);
    const mp3Bytes = await encodePcmToAudio(chapterPcm, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(thisAudioRoot, `${SLUG}.mp3`), mp3Bytes);
    writeFileSync(
      join(thisAudioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId: id,
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
    writeFileSync(
      join(thisAudioRoot, `${SLUG}.render-integrity.json`),
      JSON.stringify([
        {
          characterId: 'castor',
          sentenceIds: [2],
          verdict: 'voice-mismatch',
          cosine: 0.3,
          severity: 'severe',
          fixable: true,
          expectedEngine: 'kokoro',
          renderedEngine: 'kokoro',
          referenceKind: 'in-book',
          windowed: false,
          segmentIndex: 1,
        },
      ]),
    );
    writeFileSync(
      join(thisAudioRoot, 'render-integrity.centroids.json'),
      JSON.stringify({
        castor: {
          characterId: 'castor',
          centroid: unitVec(0),
          cleanMean: 0.9,
          pSevere: 0.45,
          pBand: 0.6,
          referenceKind: 'in-book',
        },
      }),
    );

    return { bookId: id, chapterSlug: SLUG };
  }

  function readSegmentsJson(bookTitle: string, chapterSlug: string): {
    segments: Array<{
      qa?: { status: string; reasons: string[] };
      suspect?: boolean;
      asr?: { verdict: string };
      asrSuspect?: boolean;
    }>;
  } {
    const bookDir = join(workspaceRoot, 'books', AUTHOR2, SERIES2, bookTitle);
    const segPath = join(audioDirFn(bookDir), `${chapterSlug}.segments.json`);
    return JSON.parse(readFileSync(segPath, 'utf8'));
  }

  it('does NOT mark the segment suspect:true when signal-QA/ASR are clean and only the acoustic gate rejects it', async () => {
    synthesiseChapterMock.mockReset();
    synthesiseChapterMock.mockImplementation(async () => ({
      pcm: tone(0.5, 12000), // loud, healthy re-record — signal-QA clean on every attempt
      sampleRate: SR,
    }));

    const { bookId: id, chapterSlug } = await scaffoldAcousticOnlyBook('Acoustic Only Story');

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(id)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
    // The acoustic gate never accepts it (cosine ~0 < cleanMean 0.9 on every
    // attempt) — the repair genuinely doesn't land — but that's a voice-drift
    // rejection, not a signal-QA/ASR one.
    expect((done!.stillSuspect as number[]).includes(1)).toBe(true);
    expect((done!.repaired as number[]).includes(1)).toBe(false);

    const segFile = readSegmentsJson('Acoustic Only Story', chapterSlug);
    // The take's own signal-QA is genuinely clean — must NOT be mislabeled as
    // a generic audio-QA suspect. Mislabeling here would inflate qa-report.ts's
    // acoustic.chaptersFlagged and feed finalize-chapter-write.ts's suspect
    // reason-string fallback with a misleading "audio QA" label for what is
    // actually a voice-drift mismatch (the dedicated "Voice match" row, driven
    // by render-integrity.json, already represents that signal).
    expect(segFile.segments[1].suspect).toBeUndefined();
    expect(segFile.segments[1].qa?.status).toBe('ok');
  });
});

/* fs-38 Wave 3c (fix wave, Task 6) — mirrors generation.ts/chapter-splice.ts's
   fs-2 force-to-Qwen loop test: a cloned character riding the book default on
   a non-English book must RETARGET to the eligible clone-capable engine
   carrying the clone, not get blindly forced onto 'qwen'. Uses
   VERDICT_MANUSCRIPT_ID so the module-level loadAnalysisCache mock returns
   real sentence data (id 2, "Yes.") for castor's dead-silent segment, which
   the signal scan flags and the repair loop then re-records. */
describe('POST /:bookId/chapters/:chapterId/audio-qa-repair (fs-38 Wave 3c cloned-character retarget)', () => {
  let makeBookId: (author: string, series: string, title: string) => string;
  let audioDirFn: (bookDir: string) => string;
  let encodePcmToAudio: (pcm: Buffer, sr: number, opts: { format: 'mp3'; quality: number }) => Promise<Buffer>;
  let synthesiseChapterMock: any;

  const AUTHOR3 = 'Clone Retarget Author';
  const SERIES3 = 'Standalones';

  beforeAll(async () => {
    const paths = await import('../workspace/paths.js');
    const mp3 = await import('../tts/mp3.js');
    const synth = await import('../tts/synthesise-chapter.js');
    makeBookId = paths.makeBookId;
    audioDirFn = paths.audioDir;
    encodePcmToAudio = mp3.encodePcmToAudio;
    synthesiseChapterMock = vi.mocked(synth.synthesiseChapter);
  });

  /** A single character ('castor') with a dead-silent segment (flagged by the
      signal scan and re-recorded by the repair loop) on an 'es' book,
      carrying `overrideTtsVoicesInit` for the caller to vary per test. */
  async function scaffoldCloneRetargetBook(
    bookTitle: string,
    overrideTtsVoices: Record<string, { name: string; libraryUuid: string; provenance: 'cloned' }>,
  ): Promise<{ bookId: string; chapterSlug: string }> {
    const id = makeBookId(AUTHOR3, SERIES3, bookTitle);
    const bookDir = join(workspaceRoot, 'books', AUTHOR3, SERIES3, bookTitle);
    const thisAudioRoot = audioDirFn(bookDir);
    mkdirSync(thisAudioRoot, { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: id,
        manuscriptId: VERDICT_MANUSCRIPT_ID,
        title: bookTitle,
        author: AUTHOR3,
        series: SERIES3,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        language: 'es',
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
          { id: 'castor', name: 'Castor', gender: 'female', attributes: [], overrideTtsVoices },
        ],
      }),
    );

    const castorSilent = Buffer.alloc(SR * 2); // 1s of dead silence — flagged by the signal scan
    const mp3Bytes = await encodePcmToAudio(castorSilent, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(thisAudioRoot, `${SLUG}.mp3`), mp3Bytes);
    writeFileSync(
      join(thisAudioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId: id,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 1.0,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [{ groupIndex: 0, characterId: 'castor', sentenceIds: [2], startSec: 0, endSec: 1.0 }],
      }),
    );

    return { bookId: id, chapterSlug: SLUG };
  }

  it('retargets a coqui-cloned character to coqui on an es book, instead of forcing qwen', async () => {
    synthesiseChapterMock.mockReset();
    synthesiseChapterMock.mockImplementation(async () => ({
      pcm: tone(0.5, 12000), // loud, healthy re-record — accepted on attempt 1
      sampleRate: SR,
    }));

    const { bookId: id } = await scaffoldCloneRetargetBook('Coqui Clone Story', {
      coqui: { name: 'Cloned Voice', libraryUuid: 'uuid-coqui', provenance: 'cloned' },
    });

    // modelKey 'kokoro-v1' → request default engine 'kokoro' (not clone-capable,
    // not eligible for 'es' either) — proves the retarget comes from the
    // character's own cloned slot, not the request default.
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(id)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    expect(synthesiseChapterMock).toHaveBeenCalled();
    const lastArgs = synthesiseChapterMock.mock.calls[synthesiseChapterMock.mock.calls.length - 1][0] as {
      cast: Array<{ id: string; ttsEngine?: string }>;
    };
    const castor = lastArgs.cast.find((c) => c.id === 'castor');
    /* The regression this fix closes: pre-fix this was 'qwen' (forced), or
       (with the naive "just skip it" fix) left unset entirely — both wrong. */
    expect(castor?.ttsEngine).toBeDefined();
    expect(castor?.ttsEngine).not.toBe('qwen');
    expect(castor?.ttsEngine).toBe('coqui');
  });

  it('keeps a doubly-cloned character on the request default (qwen) when both engines qualify', async () => {
    synthesiseChapterMock.mockReset();
    synthesiseChapterMock.mockImplementation(async () => ({
      pcm: tone(0.5, 12000),
      sampleRate: SR,
    }));

    const { bookId: id } = await scaffoldCloneRetargetBook('Dual Clone Story', {
      qwen: { name: 'Qwen Clone', libraryUuid: 'uuid-qwen', provenance: 'cloned' },
      coqui: { name: 'Coqui Clone', libraryUuid: 'uuid-coqui', provenance: 'cloned' },
    });

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(id)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'qwen3-tts-0.6b' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    expect(synthesiseChapterMock).toHaveBeenCalled();
    const lastArgs = synthesiseChapterMock.mock.calls[synthesiseChapterMock.mock.calls.length - 1][0] as {
      cast: Array<{ id: string; ttsEngine?: string }>;
    };
    const castor = lastArgs.cast.find((c) => c.id === 'castor');
    expect(castor?.ttsEngine).toBe('qwen');
  });
});
