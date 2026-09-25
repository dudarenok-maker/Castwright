/**
 * #3362 review pass 2, finding 🟠B — chapter-qa-repair.ts's acoustic
 * accept-check looked up `centroids?.[seg.characterId]` / verdict rows using
 * the RAW segment characterId (segments.json), while centroids.json and
 * render-integrity.json are keyed by whatever id `scoreBook` actually wrote
 * a chapter's rows under (see aggregate.ts's `resolveRowCharId`). A
 * character whose raw segment id differs from its verdict-row key by
 * spelling (hyphen/underscore drift, #2040) silently missed the centroid
 * entirely: `centroids?.[rawId]` came back `undefined`, `embedSegment` was
 * never called, and the take was accepted on signal-QA alone — a
 * wrong-voice take shipped with no acoustic check, and the stale verdict
 * row was never updated so the next scoring pass would re-flag the same
 * segment forever.
 *
 * Two cases:
 *   1. Low-cosine embed (wrong voice): the drift-spelled character must be
 *      REJECTED (stillSuspect) with embedSegment actually called — exactly
 *      like the control ('hero', exact id match) — not silently accepted.
 *   2. High-cosine embed (correct voice): the drift-spelled character's
 *      repair is accepted AND the sibling render-integrity.json row (keyed
 *      by the snapshot id, not the raw segment id) is updated in place.
 *
 * The second describe block below (Q1/Q2/Q3) pins the pass-4 fix (owner
 * design (a)+(b), 🟠D): the acoustic gate must key off the VERDICT ROW's
 * own `characterId`, not a resolution re-derived from the CURRENT (mutable)
 * cast + cast-id-history, so a rename/reject recorded AFTER scoring can't
 * make the gate miss it.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { embedSegment } from '../tts/embed-client.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';

// ── Module mocks (must come before any imports of the mocked modules) ────────

/* #3362 review pass 5, 🟡 — pinned so the Q1–Q3 `embedSegment` call-count
   assertions below (which assume 2 re-record attempts per segment) don't
   pass vacuously if the shipped default ever moves. `chapter-qa-repair.ts`'s
   `resolveMaxRerecords` reads `process.env.SEG_QA_MAX_RERECORDS` directly
   (not `configValue`) — see `beforeAll` below, which sets that env var to
   this SAME constant so the actual attempt count and the assertions' bound
   stay a single source of truth. The `configValue('qa.seg.maxRerecords')`
   mock entry is added for symmetry with the registry key this env var backs
   (`server/src/config/registry.ts`), even though this route doesn't read it
   through `configValue`. */
const PINNED_MAX_RERECORDS = 2;

vi.mock('../config/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/resolver.js')>();
  return {
    ...real,
    configValue: vi.fn((key: string) => {
      if (key === 'qa.speaker.autoRepair') return true;
      if (key === 'qa.speaker.enabled') return true;
      if (key === 'qa.seg.maxRerecords') return PINNED_MAX_RERECORDS;
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
  // #3362 review pass 5, 🟡 — drives resolveMaxRerecords's actual attempt
  // count; see PINNED_MAX_RERECORDS's own doc comment above.
  process.env.SEG_QA_MAX_RERECORDS = String(PINNED_MAX_RERECORDS);
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
  delete process.env.SEG_QA_MAX_RERECORDS;
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

// ── Q1/Q2/Q3: the acoustic gate survives a history write BETWEEN scoring and
// repair (#3362 pass-4, 🟠D's qa-repair symptom) ─────────────────────────
//
// The two tests this block replaces (review pass 3, 🟠B continued) seeded a
// render-integrity.json row keyed by a RAW id ('the-torment') for a chapter
// whose segments.json carried NO snapshot entry for that character at all.
// Pass-4 review found that state UNREACHABLE: neither the old nor the new
// aggregate.ts ever writes a verdict row for a character absent from its
// own chapter's `characterSnapshots` — a no-snapshot chapter gets no
// verdict file for that character at all (matching `main`). The fixture
// pinned a state `scoreBook` can't produce, not the qa-repair half of the
// commit.
//
// This block seeds an actually-reachable state instead: a chapter rendered
// while `cast-id-history.json` bridged `mayrin` -> `mairin` (segment 1's
// raw characterId is `mayrin`; finalize-chapter-write.ts stamps
// `resolvedCharacterId: 'mairin'` on it, since `mairin` is a real key in
// this chapter's own `characterSnapshots`) — exactly what `scoreBook` would
// write centroid/verdict rows under (see aggregate.test.ts's own
// 'resolved through cast-id-history AT RENDER TIME' test for the sibling
// scoring-side pin). Q1 is the control (history unchanged between scoring
// and repair); Q2 renames `mairin` and Q3 rejects the `mayrin`/`mairin`
// pair, both AFTER scoring — the design (b) fix keys every centroid lookup
// off the VERDICT ROW's own `characterId` ('mairin'), so neither mutation
// can make the acoustic gate miss it.
describe('audio-qa-repair acoustic gate survives a cast-id-history write between scoring and repair (#3362 pass-4, Q1/Q2/Q3)', () => {
  beforeAll(() => {
    // The shared analysis-cache mock's sentence 20 carries 'the-torment' for
    // the describe block above; this block's segment 1 is raw 'mayrin', so
    // its sentence must match or `findDivergentSentences` (build-synth-
    // replacement.ts) excludes it from repair before the acoustic gate ever
    // runs, independent of this fix.
    vi.mocked(loadAnalysisCache).mockResolvedValue({
      chapters: {
        1: [
          { id: 10, chapterId: 1, characterId: 'hero', text: 'Hero sentence.' },
          { id: 20, chapterId: 1, characterId: 'mayrin', text: 'Mairin sentence.' },
        ],
      },
    } as Awaited<ReturnType<typeof loadAnalysisCache>>);
  });

  function writeMairinCastFixture() {
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'hero', name: 'Hero', gender: 'male', attributes: [], ttsEngine: 'kokoro' },
          { id: 'mairin', name: 'Mairin', gender: 'female', attributes: [], ttsEngine: 'kokoro' },
        ],
      }),
    );
  }

  function writeHistoryBridgedSegmentsFixture() {
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
          // Raw render-time id 'mayrin', stamped by finalize-chapter-write.ts
          // with the canonical id it resolved to at RENDER time ('mairin') —
          // the same shape a real render produces (see
          // ChapterSegment.resolvedCharacterId's doc comment).
          { groupIndex: 1, characterId: 'mayrin', resolvedCharacterId: 'mairin', sentenceIds: [20], startSec: 2.0, endSec: 4.0 },
        ],
        characterSnapshots: {
          hero: { voiceEngine: 'kokoro' },
          mairin: { voiceEngine: 'kokoro' },
        },
      }),
    );
  }

  // What `scoreBook` writes for this render: verdict/centroid rows keyed by
  // the STAMP ('mairin'), never by the raw synth-time id ('mayrin') — see
  // aggregate.ts's `resolveRowCharId`.
  function writeMairinVerdictFixture() {
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
          characterId: 'mairin',
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

  function writeMairinCentroidFixture() {
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
        mairin: {
          characterId: 'mairin',
          centroid: unitVec(),
          cleanMean: 0.7,
          pSevere: 0.45,
          pBand: 0.6,
          referenceKind: 'in-book',
        },
      }),
    );
  }

  function writeHistoryAtScoring() {
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin' } }),
    );
  }

  it('Q1 (control, history unchanged): wrong-voice take is rejected, acoustic gate actually ran', async () => {
    writeMairinCastFixture();
    writeHistoryBridgedSegmentsFixture();
    writeMairinVerdictFixture();
    writeMairinCentroidFixture();
    writeHistoryAtScoring();
    embedCosine = 'low'; // cosine 0.0 << cleanMean 0.7
    vi.mocked(embedSegment).mockClear();

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const repaired = done!.repaired as number[];
    const stillSuspect = done!.stillSuspect as number[];

    expect(stillSuspect).toContain(0);
    expect(repaired).not.toContain(0);
    // The 'mayrin'-rendered segment's take is correctly rejected against its
    // 'mairin'-keyed centroid — the acoustic gate found it.
    expect(stillSuspect).toContain(1);
    expect(repaired).not.toContain(1);
    expect(vi.mocked(embedSegment).mock.calls.length).toBeGreaterThan(PINNED_MAX_RERECORDS);
  });

  it('Q2 (mairin renamed AFTER scoring): wrong-voice take is STILL rejected — the gate keys off the verdict row, not the current cast-id-history', async () => {
    writeHistoryBridgedSegmentsFixture();
    writeMairinVerdictFixture();
    writeMairinCentroidFixture();
    writeHistoryAtScoring();
    // AFTER scoring, 'mairin' is renamed to 'mairin-oakes' — cast.json and
    // cast-id-history.json both move. The verdict/centroid files (already
    // on disk, written at scoring time) are untouched — exactly the state a
    // real rename leaves behind.
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'hero', name: 'Hero', gender: 'male', attributes: [], ttsEngine: 'kokoro' },
          { id: 'mairin-oakes', name: 'Mairin Oakes', gender: 'female', attributes: [], ttsEngine: 'kokoro' },
        ],
      }),
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin-oakes', mairin: 'mairin-oakes' } }),
    );
    embedCosine = 'low';
    vi.mocked(embedSegment).mockClear();

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const stillSuspect = done!.stillSuspect as number[];
    const repaired = done!.repaired as number[];

    // Pre-fix: the resolver re-derived through the CURRENT (renamed) cast +
    // history, missed the 'mairin'-keyed centroid/verdict row entirely, and
    // the wrong-voice take was silently ACCEPTED with no acoustic check.
    expect(stillSuspect).toContain(1);
    expect(repaired).not.toContain(1);
    expect(vi.mocked(embedSegment).mock.calls.length).toBeGreaterThan(PINNED_MAX_RERECORDS);
  });

  it('Q3 (mayrin/mairin pair rejected AFTER scoring): wrong-voice take is STILL rejected', async () => {
    writeMairinCastFixture();
    writeHistoryBridgedSegmentsFixture();
    writeMairinVerdictFixture();
    writeMairinCentroidFixture();
    writeHistoryAtScoring();
    // AFTER scoring, a user rejects "mayrin is not Mairin" — the bridge is
    // torn down via rejectedPairs, with no replacement bridge at all.
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] }),
    );
    embedCosine = 'low';
    vi.mocked(embedSegment).mockClear();

    const res = await request(app)
      .post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`)
      .send({ dryRun: false, modelKey: 'kokoro-v1' });

    const events = parseSse(res.text);
    const done = events.find((e) => e.type === 'qa_repair_complete');
    expect(done, `expected qa_repair_complete, got:\n${res.text}`).toBeTruthy();

    const stillSuspect = done!.stillSuspect as number[];
    const repaired = done!.repaired as number[];

    expect(stillSuspect).toContain(1);
    expect(repaired).not.toContain(1);
    expect(vi.mocked(embedSegment).mock.calls.length).toBeGreaterThan(PINNED_MAX_RERECORDS);
  });

  it('correct-voice take is accepted and the verdict row (still keyed "mairin") is updated, even after a post-scoring rename', async () => {
    writeMairinCastFixture();
    writeHistoryBridgedSegmentsFixture();
    writeMairinVerdictFixture();
    writeMairinCentroidFixture();
    writeHistoryAtScoring();
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'hero', name: 'Hero', gender: 'male', attributes: [], ttsEngine: 'kokoro' },
          { id: 'mairin-oakes', name: 'Mairin Oakes', gender: 'female', attributes: [], ttsEngine: 'kokoro' },
        ],
      }),
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin-oakes', mairin: 'mairin-oakes' } }),
    );
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

    const mairinRows = verdicts.filter((v) => v.sentenceIds.includes(20));
    expect(mairinRows).toHaveLength(1);
    expect(mairinRows[0]!.characterId).toBe('mairin');
    expect(mairinRows[0]!.cosine).toBeGreaterThan(0.5);
  });
});
