/**
 * srv-36 — acoustic candidate source + accept-check in chapter-qa-repair.ts
 *
 * Four cases:
 *   1. Dry-run scan picks up an acoustic (voice-mismatch/fixable) candidate
 *      from the sibling render-integrity.json when qa.speaker.autoRepair is on.
 *   2. Non-dry-run: a mocked re-render with mocked /embed returning a high-cosine
 *      (≥ cleanMean) take is accepted and `qa_repair_complete.repaired` includes
 *      the segment. Post-finalize: the embeddings + verdict rows are rewritten.
 *   3. A signal/ASR-only candidate (acoustic === undefined) is NOT rejected even
 *      when the mocked embed returns a cosine BELOW cleanMean — the acoustic gate
 *      must be conditional on candidate.acoustic, not applied universally.
 *      Also asserts embedSegment is NOT called for a signal-only candidate.
 *   4. UNION candidate (segment flagged by signal QA AND present as voice-mismatch/
 *      fixable in the verdict file) with NO centroids file is STILL re-rendered
 *      and repaired on signal grounds — the pre-filter must not drop it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { embedSegment } from '../tts/embed-client.js';

// ── Module mocks (must come before any imports of the mocked modules) ────────

// configValue: enable qa.speaker.autoRepair; return sensible defaults for qa.seg.* thresholds
// so the signal scan uses the shipped defaults rather than 0/false.
vi.mock('../config/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/resolver.js')>();
  return {
    ...real,
    configValue: vi.fn((key: string) => {
      if (key === 'qa.speaker.autoRepair') return true;
      if (key === 'qa.speaker.enabled') return true;
      // Delegate to the real configValue for everything else (segment QA thresholds, etc.)
      return real.configValue(key);
    }),
  };
});

// Mock synthesiseChapter so the re-render path works without a real engine.
// Returns a 1-second 24kHz loud tone.
const SR = 24_000;
function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...real,
    synthesiseChapter: vi.fn(async () => ({
      pcm: tone(2.0, 12000), // loud, healthy 2-second tone
      sampleRate: SR,
      embeddings: [],
    })),
  };
});

// Mock the analysis cache so the repair path finds sentences.
vi.mock('../store/analysis-cache.js', () => ({
  loadAnalysisCache: vi.fn(async () => ({
    chapters: { 1: [{ id: 10, text: 'Hello world sentence.' }] },
  })),
}));

// Mock reused-voice hydration (noop).
vi.mock('../tts/hydrate-reused-voice-workspace.js', () => ({
  hydrateCastReusedVoices: vi.fn(async (chars: unknown[]) => chars),
}));

// Mock rebuildCacheFromEdits (noop).
vi.mock('../store/analysis-cache-rebuild.js', () => ({
  rebuildCacheFromEdits: vi.fn(async () => {}),
}));

// Mock finalizeChapterAudioWrite so it doesn't need real ffmpeg/encode.
vi.mock('../audio/finalize-chapter-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/finalize-chapter-write.js')>();
  return {
    ...real,
    finalizeChapterAudioWrite: vi.fn(async () => ({
      durationSec: 2.0,
      segmentCount: 1,
      audioPath: '/fake/path.mp3',
    })),
  };
});

// Mock spliceChapterSegments so it doesn't crash (returns minimal valid result).
vi.mock('../audio/splice-chapter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/splice-chapter.js')>();
  return {
    ...real,
    spliceChapterSegments: vi.fn(() => ({
      pcm: tone(2.0, 12000),
      sampleRate: SR,
      durationSec: 2.0,
      segments: [],
    })),
  };
});

// Mock buildSynthReplacements to just call the synth callback directly.
vi.mock('../audio/build-synth-replacement.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/build-synth-replacement.js')>();
  return {
    ...real,
    buildSynthReplacements: vi.fn(async (opts: {
      segments: unknown[];
      targetIndices: number[];
      chapterSampleRate: number;
      synth: (seg: unknown) => Promise<{ pcm: Buffer; sampleRate: number }>;
    }) => {
      const results = [];
      for (const idx of opts.targetIndices) {
        const seg = opts.segments[idx];
        const result = await opts.synth(seg);
        results.push({ segmentIndex: idx, ...result });
      }
      return results;
    }),
  };
});

// Mock embedSegment — returns a high-cosine vector by default.
// We use a unit vector along [1, 0, 0, ...] which will produce cosine 1.0
// against the centroid [1, 0, 0, ...] we'll set as fixture.
let embedReturnHighCosine = true;
vi.mock('../tts/embed-client.js', () => ({
  embedSegment: vi.fn(async () => {
    // High-cosine vector: mostly along first axis (matches fixture centroid).
    if (embedReturnHighCosine) {
      const v = new Float32Array(192).fill(0);
      v[0] = 1.0;
      return v;
    } else {
      // Low-cosine vector: orthogonal to the centroid.
      const v = new Float32Array(192).fill(0);
      v[1] = 1.0;
      return v;
    }
  }),
}));

// Mock abort/register so no coordination state leaks between tests.
vi.mock('./chapter-job-coordination.js', () => ({
  registerSplice: vi.fn(() => () => {}),
}));
vi.mock('./generation.js', () => ({
  abortInFlightChapterJob: vi.fn(),
}));

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AUTHOR = 'Spk Author';
const SERIES = 'Standalones';
const TITLE = 'Spk Story';
const SLUG = 'chapter-one';

let workspaceRoot: string;
let audioRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

/** Parse SSE body into event objects. */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

/** Build a 192-float centroid unit vector along first axis. */
function unitVec(): number[] {
  const v = new Array<number>(192).fill(0);
  v[0] = 1.0;
  return v;
}

/** Write the fixture render-integrity.json with one fixable voice-mismatch row. */
function writeVerdictFixture(segIdx: number) {
  const verdictPath = join(audioRoot, `${SLUG}.render-integrity.json`);
  writeFileSync(
    verdictPath,
    JSON.stringify([
      {
        characterId: 'hero',
        sentenceIds: [10],
        verdict: 'voice-mismatch',
        cosine: 0.30,
        severity: 'severe',
        fixable: true,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'in-book',
        windowed: false,
        segmentIndex: segIdx,
      },
    ]),
  );
}

/** Write the fixture centroids.json with a high cleanMean for 'hero'. */
function writeCentroidFixture() {
  const centroidsPath = join(audioRoot, 'render-integrity.centroids.json');
  writeFileSync(
    centroidsPath,
    JSON.stringify({
      hero: {
        characterId: 'hero',
        centroid: unitVec(),
        cleanMean: 0.70,  // the accept threshold: embed must return cosine ≥ 0.70
        pSevere: 0.45,
        pBand: 0.60,
        referenceKind: 'in-book',
      },
    }),
  );
}

beforeAll(async () => {
  process.env.SEG_SPK_AUTO_REPAIR = '1';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-spk-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ chapterQaRepairRouter }, { makeBookId }, mp3] = await Promise.all([
    import('./chapter-qa-repair.js'),
    import('../workspace/paths.js'),
    import('../tts/mp3.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_spk_test',
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
    JSON.stringify({
      characters: [
        {
          id: 'hero',
          name: 'Hero',
          gender: 'male',
          attributes: [],
          ttsEngine: 'kokoro', // kokoro = not qwen → qwenUnavailable won't block
        },
      ],
    }),
  );

  // Fixture chapter: one loud 2-second tone for 'hero' (signal-clean, will only
  // be flagged by the acoustic candidate from render-integrity.json).
  const heroTone = tone(2.0, 12000);
  const mp3Bytes = await mp3.encodePcmToAudio(heroTone, SR, { format: 'mp3', quality: 2 });
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
        { groupIndex: 0, characterId: 'hero', sentenceIds: [10], startSec: 0, endSec: 2.0 },
      ],
    }),
  );

  // Acoustic verdict fixture: segment 0 is voice-mismatch/fixable.
  writeVerdictFixture(0);
  writeCentroidFixture();

  app = express();
  app.use(express.json());
  app.use('/api/books', chapterQaRepairRouter);
});

afterAll(() => {
  delete process.env.SEG_SPK_AUTO_REPAIR;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('audio-qa-repair acoustic candidate source (srv-36)', () => {
  it('dry-run: qa_scan includes the acoustic candidate from render-integrity.json', async () => {
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: true });

    const events = parseSse(res.text);
    const scan = events.find((e) => e.type === 'qa_scan');
    expect(scan, `expected qa_scan, got:\n${res.text}`).toBeTruthy();

    const flagged = scan!.flagged as Array<{
      segmentIndex: number;
      characterId: string;
      reasons: string[];
      acoustic?: boolean;
    }>;

    // The signal scan produces no flags (loud healthy tone); the acoustic
    // source must inject the candidate from render-integrity.json.
    const acousticCandidate = flagged.find((f) => f.acoustic === true);
    expect(acousticCandidate, 'expected at least one acoustic candidate').toBeTruthy();
    expect(acousticCandidate!.segmentIndex).toBe(0);
    expect(acousticCandidate!.characterId).toBe('hero');
    // The reason may be the voice-mismatch reason (pure acoustic) or a signal reason
    // when the UNION path merged the acoustic flag onto an existing signal candidate.
    expect(acousticCandidate!.reasons.length).toBeGreaterThan(0);
  });

  it('non-dry-run: high-cosine embed → take accepted, repaired[] includes segment, embeddings + verdicts rewritten', async () => {
    embedReturnHighCosine = true;  // cosine = 1.0 > cleanMean 0.70 → accept

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();
    expect(done!.dryRun).toBe(false);

    const repaired = done!.repaired as number[];
    expect(repaired).toContain(0); // segment 0 was accepted

    // Post-finalize: embeddings sibling must have been written.
    const embeddingsPath = join(audioRoot, `${SLUG}.embeddings.json`);
    expect(existsSync(embeddingsPath), 'embeddings.json should be written after repair').toBe(true);
    const embeddingsRaw = JSON.parse(readFileSync(embeddingsPath, 'utf8'));
    // The file should have at least one row for the repaired segment.
    expect(Array.isArray(embeddingsRaw.rows) && embeddingsRaw.rows.length > 0).toBe(true);

    // Post-finalize: verdict sibling must have been updated (cosine updated).
    const verdictPath = join(audioRoot, `${SLUG}.render-integrity.json`);
    const verdicts = JSON.parse(readFileSync(verdictPath, 'utf8')) as Array<{
      sentenceIds: number[];
      verdict: string;
      cosine: number;
    }>;
    const row = verdicts.find((v) => v.sentenceIds.includes(10));
    expect(row, 'expected verdict row for sentenceId 10').toBeTruthy();
    // After a high-cosine re-render, the verdict should have been updated.
    expect(row!.cosine).toBeGreaterThan(0.5);
  });

  it('conditional accept: a signal/ASR-only candidate is NOT rejected by a low acoustic cosine', async () => {
    // Remove the acoustic verdict fixture so the candidate is pure signal (silent segment).
    // We need a truly silent segment to trigger the signal scan.
    // Recreate the chapter with a silent segment instead.
    const silence = Buffer.alloc(SR * 2 * 2); // 2s of silence (zeros)
    const { encodePcmToAudio } = await import('../tts/mp3.js');
    const mp3Bytes = await encodePcmToAudio(silence, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);

    // Remove acoustic verdict file so there's no acoustic candidate.
    const verdictPath = join(audioRoot, `${SLUG}.render-integrity.json`);
    writeFileSync(verdictPath, JSON.stringify([])); // empty — no voice-mismatch rows

    // Set embed to return LOW cosine (orthogonal to centroid) — below cleanMean 0.70.
    embedReturnHighCosine = false;

    // Clear prior calls from Test 2 so we get a clean call-count baseline.
    vi.mocked(embedSegment).mockClear();

    // The signal scan will flag the silence. The re-render (mocked synthesiseChapter)
    // returns a loud healthy tone, which the signal QA accepts.
    // Even though embed returns a low cosine, the signal candidate (acoustic===undefined)
    // must be accepted — the acoustic gate must NOT apply.
    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    // The signal candidate must be accepted (loud tone passes signal QA)
    // despite the low cosine from embedSegment.
    expect(repaired).toContain(0);
    expect((done!.stillSuspect as number[]).includes(0)).toBe(false);

    // embedSegment must NOT have been called — it is only invoked for acoustic candidates.
    expect(vi.mocked(embedSegment)).not.toHaveBeenCalled();

    // Restore fixtures for any subsequent tests.
    writeVerdictFixture(0);
    const heroTone = tone(2.0, 12000);
    const mp3BytesRestored = await encodePcmToAudio(heroTone, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3BytesRestored);
    embedReturnHighCosine = true;
  });

  it('union candidate (signal+acoustic) with no centroids file is still re-rendered and repaired on signal grounds', async () => {
    // Set up: a SILENT segment (triggers signal QA flag) AND a voice-mismatch/fixable
    // verdict row for the same segment (triggers acoustic UNION). No centroids file.
    const { encodePcmToAudio } = await import('../tts/mp3.js');
    const silence = Buffer.alloc(SR * 2 * 2); // 2s of silence
    const mp3Bytes = await encodePcmToAudio(silence, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3Bytes);

    // Write a fixable voice-mismatch verdict row for segment 0 (UNION path).
    writeVerdictFixture(0);

    // Remove the centroids file so readCentroids returns null.
    const centroidsPath = join(audioRoot, 'render-integrity.centroids.json');
    writeFileSync(centroidsPath, 'null'); // invalid JSON trick: just write an empty object
    // Actually write a valid empty object so JSON.parse doesn't throw.
    writeFileSync(centroidsPath, JSON.stringify({}));

    // embedReturnHighCosine doesn't matter — embedSegment must not be called for
    // the union candidate when there is no centroid (no centroid → no acoustic embed).
    vi.mocked(embedSegment).mockClear();

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    const stillSuspect = (done!.stillSuspect as number[]) ?? [];

    // The segment must be re-rendered and accepted on signal grounds (loud re-render
    // passes signal QA), NOT pushed to stillSuspect by the pre-filter.
    expect(repaired).toContain(0);
    expect(stillSuspect.includes(0)).toBe(false);

    // Restore all fixtures for future tests.
    writeCentroidFixture();
    const heroTone = tone(2.0, 12000);
    const mp3BytesRestored = await encodePcmToAudio(heroTone, SR, { format: 'mp3', quality: 2 });
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), mp3BytesRestored);
    embedReturnHighCosine = true;
  });
});
