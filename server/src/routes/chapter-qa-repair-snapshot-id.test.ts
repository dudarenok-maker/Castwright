/**
 * #3362 review pass 2, finding 🟠B — chapter-qa-repair.ts's acoustic
 * accept-check looked up `centroids?.[seg.characterId]` / verdict rows using
 * the RAW segment characterId (segments.json), while centroids.json and
 * render-integrity.json are keyed by the RENDER-TIME `characterSnapshots`
 * key (see aggregate.ts's `buildSnapshotIdResolver`). A character whose raw
 * segment id differs from its snapshot key by spelling (hyphen/underscore
 * drift, #2040) silently missed the centroid entirely: `centroids?.[rawId]`
 * came back `undefined`, `embedSegment` was never called, and the take was
 * accepted on signal-QA alone — a wrong-voice take shipped with no acoustic
 * check, and the stale verdict row was never updated so the next scoring
 * pass would re-flag the same segment forever.
 *
 * Two cases:
 *   1. Low-cosine embed (wrong voice): the drift-spelled character must be
 *      REJECTED (stillSuspect) with embedSegment actually called — exactly
 *      like the control ('hero', exact id match) — not silently accepted.
 *   2. High-cosine embed (correct voice): the drift-spelled character's
 *      repair is accepted AND the sibling render-integrity.json row (keyed
 *      by the snapshot id, not the raw segment id) is updated in place.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { embedSegment } from '../tts/embed-client.js';

// ── Module mocks (must come before any imports of the mocked modules) ────────

vi.mock('../config/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/resolver.js')>();
  return {
    ...real,
    configValue: vi.fn((key: string) => {
      if (key === 'qa.speaker.autoRepair') return true;
      if (key === 'qa.speaker.enabled') return true;
      return real.configValue(key);
    }),
  };
});

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
      pcm: tone(2.0, 12000), // loud, signal-QA-clean tone every time
      sampleRate: SR,
      embeddings: [],
    })),
  };
});

// Two sentences: id 10 → 'hero' (control), id 20 → 'the-torment' (raw,
// drift-spelled — matches the segment's own raw characterId below).
vi.mock('../store/analysis-cache.js', () => ({
  loadAnalysisCache: vi.fn(async () => ({
    chapters: {
      1: [
        { id: 10, characterId: 'hero', text: 'Hero sentence.' },
        { id: 20, characterId: 'the-torment', text: 'Torment sentence.' },
      ],
    },
  })),
}));

vi.mock('../tts/hydrate-reused-voice-workspace.js', () => ({
  hydrateCastReusedVoices: vi.fn(async (chars: unknown[]) => chars),
}));

vi.mock('../store/analysis-cache-rebuild.js', () => ({
  rebuildCacheFromEdits: vi.fn(async () => {}),
}));

vi.mock('../audio/finalize-chapter-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/finalize-chapter-write.js')>();
  return {
    ...real,
    finalizeChapterAudioWrite: vi.fn(async () => ({
      durationSec: 2.0,
      segmentCount: 2,
      audioPath: '/fake/path.mp3',
    })),
  };
});

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

// embedSegment — cosine controlled per-test via `embedCosine`. [1,0,...] gives
// cosine 1.0 against the fixture centroid ([1,0,...]); [0,1,...] gives 0.0.
let embedCosine: 'high' | 'low' = 'low';
vi.mock('../tts/embed-client.js', () => ({
  embedSegment: vi.fn(async () => {
    const v = new Float32Array(192).fill(0);
    v[embedCosine === 'high' ? 0 : 1] = 1.0;
    return v;
  }),
}));

vi.mock('./chapter-job-coordination.js', () => ({
  registerSplice: vi.fn(() => () => {}),
}));
vi.mock('./generation.js', () => ({
  abortInFlightChapterJob: vi.fn(),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AUTHOR = 'Snap Author';
const SERIES = 'Standalones';
const TITLE = 'Snap Story';
const SLUG = 'chapter-one';

let workspaceRoot: string;
let audioRoot: string;
let bookId: string;
let app: Express;

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

function unitVec(): number[] {
  const v = new Array<number>(192).fill(0);
  v[0] = 1.0;
  return v;
}

/** Two fixable voice-mismatch rows, keyed by the RENDER-TIME snapshot id
 *  ('hero' exact, 'the_torment' — the canonical snapshot key, NOT the raw
 *  segment id 'the-torment' the segments.json below uses for segment 1). */
function writeVerdictFixture() {
  writeFileSync(
    join(audioRoot, `${SLUG}.render-integrity.json`),
    JSON.stringify([
      {
        characterId: 'hero',
        sentenceIds: [10],
        verdict: 'voice-mismatch',
        cosine: 0.3,
        severity: 'severe',
        fixable: true,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'in-book',
        windowed: false,
        segmentIndex: 0,
      },
      {
        characterId: 'the_torment',
        sentenceIds: [20],
        verdict: 'voice-mismatch',
        cosine: 0.3,
        severity: 'severe',
        fixable: true,
        expectedEngine: 'qwen',
        renderedEngine: 'qwen',
        referenceKind: 'in-book',
        windowed: false,
        segmentIndex: 1,
      },
    ]),
  );
}

function writeCentroidFixture() {
  writeFileSync(
    join(audioRoot, 'render-integrity.centroids.json'),
    JSON.stringify({
      hero: {
        characterId: 'hero',
        centroid: unitVec(),
        cleanMean: 0.7,
        pSevere: 0.45,
        pBand: 0.6,
        referenceKind: 'in-book',
      },
      the_torment: {
        characterId: 'the_torment',
        centroid: unitVec(),
        cleanMean: 0.7,
        pSevere: 0.45,
        pBand: 0.6,
        referenceKind: 'in-book',
      },
    }),
  );
}

async function writeSegmentsFixture() {
  const { encodePcmToAudio } = await import('../tts/mp3.js');
  const heroTone = tone(2.0, 12000);
  const mp3Bytes = await encodePcmToAudio(heroTone, SR, { format: 'mp3', quality: 2 });
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
      // segment 1's characterId ('the-torment') is the RAW render-time id;
      // characterSnapshots below canonicalises it to 'the_torment'.
      segments: [
        { groupIndex: 0, characterId: 'hero', sentenceIds: [10], startSec: 0, endSec: 2.0 },
        { groupIndex: 1, characterId: 'the-torment', sentenceIds: [20], startSec: 2.0, endSec: 4.0 },
      ],
      characterSnapshots: {
        hero: { voiceEngine: 'kokoro' },
        the_torment: { voiceEngine: 'kokoro' },
      },
    }),
  );
}

beforeAll(async () => {
  process.env.SEG_SPK_AUTO_REPAIR = '1';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qa-snapshot-id-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const { chapterQaRepairRouter } = await import('./chapter-qa-repair.js');
  const { makeBookId } = await import('../workspace/paths.js');
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
      manuscriptId: 'm_snapshot_id_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      language: 'en',
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
        { id: 'hero', name: 'Hero', gender: 'male', attributes: [], ttsEngine: 'kokoro' },
        { id: 'the-torment', name: 'The Torment', gender: 'male', attributes: [], ttsEngine: 'kokoro' },
      ],
    }),
  );

  await writeSegmentsFixture();
  writeVerdictFixture();
  writeCentroidFixture();

  app = express();
  app.use(express.json());
  app.use('/api/books', chapterQaRepairRouter);
});

afterAll(() => {
  delete process.env.SEG_SPK_AUTO_REPAIR;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('audio-qa-repair joins centroids/verdicts by render-time snapshot key (#3362 🟠B)', () => {
  it('wrong-voice take: drift-spelled segment is acoustically checked and rejected, same as the exact-id control', async () => {
    embedCosine = 'low'; // cosine 0.0 << cleanMean 0.7 for both characters
    vi.mocked(embedSegment).mockClear();

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    const stillSuspect = done!.stillSuspect as number[];

    // Control ('hero', exact id match): rejected on the acoustic check.
    expect(stillSuspect).toContain(0);
    expect(repaired).not.toContain(0);

    // Drift-spelled ('the-torment' segment vs 'the_torment' centroid key):
    // must be rejected too, NOT silently accepted because the centroid
    // lookup missed.
    expect(stillSuspect).toContain(1);
    expect(repaired).not.toContain(1);

    // The acoustic check must actually have run for the drift-spelled
    // character too, not just the control — asserted as a count STRICTLY
    // ABOVE what the control alone would produce, not merely `> 0` (#3362
    // review pass 3, 🟡: `> 0` is satisfied by the control's own calls
    // alone, so it cannot fail even when the drift-spelled character's
    // centroid join is silently skipped). With SEG_QA_MAX_RERECORDS
    // defaulting to 2 attempts per segment and `isAcceptable` never
    // returning true in this low-cosine test (so the loop always runs the
    // full 2 attempts), a control-only run produces exactly 2 embedSegment
    // calls (1 segment x 2 attempts) — asserting a count above that proves
    // the drift-spelled segment's own acoustic gate fired too.
    expect(vi.mocked(embedSegment).mock.calls.length).toBeGreaterThan(2);
  });

  it('correct-voice take: drift-spelled segment is accepted and its verdict row (keyed by snapshot id) is updated', async () => {
    // Reset fixtures: both centroid+verdict rows fresh, segments unflagged by signal QA.
    writeVerdictFixture();
    writeCentroidFixture();
    await writeSegmentsFixture();
    embedCosine = 'high'; // cosine 1.0 > cleanMean 0.7 — correct voice

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    expect(repaired).toContain(0);
    expect(repaired).toContain(1);

    const verdicts = JSON.parse(
      readFileSync(join(audioRoot, `${SLUG}.render-integrity.json`), 'utf8'),
    ) as Array<{ characterId: string; sentenceIds: number[]; cosine: number }>;

    // Exactly one row for sentenceId 20, still keyed by the snapshot id
    // ('the_torment') the verdict file already used — no duplicate row
    // minted under the raw segment id ('the-torment'), and its cosine was
    // actually refreshed by this repair (not left at the stale 0.3).
    const tormentRows = verdicts.filter((v) => v.sentenceIds.includes(20));
    expect(tormentRows).toHaveLength(1);
    expect(tormentRows[0]!.characterId).toBe('the_torment');
    expect(tormentRows[0]!.cosine).toBeGreaterThan(0.5);
  });
});

// ── Transitional-book scenario (#3362 review pass 3, 🟠B continued) ─────────
//
// A chapter rendered BEFORE finalize-chapter-write started keying
// characterSnapshots canonically has NO snapshot entry at all for a
// character — neither the raw segment spelling nor a canonical one. Review
// pass 2's fix made aggregate.ts's row-join resolver BOOK-WIDE: a chapter
// like this one could resolve its raw row onto a canonical key a LATER,
// UNRELATED chapter's own snapshot introduced (borrowing), producing a
// silent disagreement with chapter-qa-repair.ts's own (already per-chapter)
// resolver — the acoustic gate looked up the centroid under a key aggregate
// never actually used for this chapter's rows.
//
// Fix (pass 3): aggregate.ts's resolver is now per-chapter too, scoped to
// THIS chapter's own snapshot keys + castIdHistory (never another chapter's
// keys) — the exact same construction chapter-qa-repair.ts already used.
// With no snapshot entry at all, both consumers now agree: the raw id
// passes through UNRESOLVED, matching `main`'s own pre-#3362 behaviour
// (scoreBook used the raw characterId directly, with no resolver).
//
// This segments fixture drops the drift-spelled character's snapshot entry
// entirely (matching the pre-PR shape) and pre-seeds verdict/centroid rows
// keyed by the RAW id — what a per-chapter-consistent aggregate.ts would
// have written for this chapter — plus a DECOY entry under the CANONICAL
// key ('the_torment') that a later, unrelated chapter might use, with a
// deliberately permissive cleanMean (0) that would wrongly ACCEPT any
// cosine if qa-repair ever borrowed it instead of this chapter's own key.
describe('audio-qa-repair never borrows another chapter\'s snapshot key for a chapter with no snapshot entry of its own (#3362 🟠B continued)', () => {
  function writeTransitionalSegmentsFixture() {
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
        segments: [
          { groupIndex: 0, characterId: 'hero', sentenceIds: [10], startSec: 0, endSec: 2.0 },
          { groupIndex: 1, characterId: 'the-torment', sentenceIds: [20], startSec: 2.0, endSec: 4.0 },
        ],
        // No entry at all for 'the-torment'/'the_torment' — this chapter
        // predates canonical snapshot keying (the transitional/pre-PR shape).
        characterSnapshots: {
          hero: { voiceEngine: 'kokoro' },
        },
      }),
    );
  }

  function writeTransitionalVerdictFixture() {
    writeFileSync(
      join(audioRoot, `${SLUG}.render-integrity.json`),
      JSON.stringify([
        {
          characterId: 'hero',
          sentenceIds: [10],
          verdict: 'voice-mismatch',
          cosine: 0.3,
          severity: 'severe',
          fixable: true,
          expectedEngine: 'qwen',
          renderedEngine: 'qwen',
          referenceKind: 'in-book',
          windowed: false,
          segmentIndex: 0,
        },
        {
          // Keyed by the RAW id — this chapter's own resolver has an empty
          // candidate cast for this character (no snapshot entry at all),
          // so its row passes through unresolved, exactly what a
          // per-chapter-consistent aggregate.ts writes for this chapter.
          characterId: 'the-torment',
          sentenceIds: [20],
          verdict: 'voice-mismatch',
          cosine: 0.3,
          severity: 'severe',
          fixable: true,
          expectedEngine: 'qwen',
          renderedEngine: 'qwen',
          referenceKind: 'in-book',
          windowed: false,
          segmentIndex: 1,
        },
      ]),
    );
  }

  function writeTransitionalCentroidFixture() {
    writeFileSync(
      join(audioRoot, 'render-integrity.centroids.json'),
      JSON.stringify({
        hero: {
          characterId: 'hero',
          centroid: unitVec(),
          cleanMean: 0.7,
          pSevere: 0.45,
          pBand: 0.6,
          referenceKind: 'in-book',
        },
        // This chapter's OWN centroid, under the RAW key — the one the
        // acoustic gate must actually use.
        'the-torment': {
          characterId: 'the-torment',
          centroid: unitVec(),
          cleanMean: 0.7,
          pSevere: 0.45,
          pBand: 0.6,
          referenceKind: 'in-book',
        },
        // Decoy: a LATER, UNRELATED chapter's canonical key, with a
        // deliberately permissive cleanMean of 0 — any cosine >= 0 always
        // passes. If qa-repair ever borrowed this entry instead of this
        // chapter's own 'the-torment' key, segment 1 would be wrongly
        // ACCEPTED even at a low (wrong-voice) cosine, flipping this test's
        // outcome and exposing the borrow.
        the_torment: {
          characterId: 'the_torment',
          centroid: unitVec(),
          cleanMean: 0,
          pSevere: 0.45,
          pBand: 0.6,
          referenceKind: 'in-book',
        },
      }),
    );
  }

  it('wrong-voice take: the no-snapshot-entry segment is acoustically checked against its OWN raw-keyed centroid, not the decoy canonical key, and rejected', async () => {
    writeTransitionalSegmentsFixture();
    writeTransitionalVerdictFixture();
    writeTransitionalCentroidFixture();
    embedCosine = 'low'; // cosine 0.0 << cleanMean 0.7 (own key) but >= cleanMean 0 (decoy)
    vi.mocked(embedSegment).mockClear();

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    const stillSuspect = done!.stillSuspect as number[];

    // Control ('hero'): rejected on the acoustic check, as always.
    expect(stillSuspect).toContain(0);
    expect(repaired).not.toContain(0);

    // The no-snapshot-entry segment must be rejected against its OWN
    // 'the-torment' centroid (cleanMean 0.7) — if it had instead resolved
    // onto the decoy 'the_torment' canonical key (cleanMean 0), it would be
    // wrongly accepted here.
    expect(stillSuspect).toContain(1);
    expect(repaired).not.toContain(1);
    expect(vi.mocked(embedSegment).mock.calls.length).toBeGreaterThan(2);
  });

  it('correct-voice take: the no-snapshot-entry segment is accepted and its verdict row stays keyed by the RAW id, never re-keyed onto the decoy canonical key', async () => {
    writeTransitionalSegmentsFixture();
    writeTransitionalVerdictFixture();
    writeTransitionalCentroidFixture();
    embedCosine = 'high'; // cosine 1.0 > cleanMean 0.7 (own key) — correct voice

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    expect(repaired).toContain(0);
    expect(repaired).toContain(1);

    const verdicts = JSON.parse(
      readFileSync(join(audioRoot, `${SLUG}.render-integrity.json`), 'utf8'),
    ) as Array<{ characterId: string; sentenceIds: number[]; cosine: number }>;

    // Exactly one row for sentenceId 20, still keyed by the RAW id
    // ('the-torment') the verdict file already used — never re-keyed onto
    // the decoy canonical key ('the_torment'), and its cosine was actually
    // refreshed by this repair.
    const tormentRows = verdicts.filter((v) => v.sentenceIds.includes(20));
    expect(tormentRows).toHaveLength(1);
    expect(tormentRows[0]!.characterId).toBe('the-torment');
    expect(tormentRows[0]!.cosine).toBeGreaterThan(0.5);
  });
});
