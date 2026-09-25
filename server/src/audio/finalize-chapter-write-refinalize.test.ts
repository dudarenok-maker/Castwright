/* #3362 review pass 5, 🟠E — a re-finalize (chapter-splice.ts / chapter-
   qa-repair.ts, both via `spliceChapterSegments`) reads segments back from
   disk and calls `finalizeChapterAudioWrite` again. Before this fix, that
   second write re-resolved EVERY segment's identity through the CURRENT
   (mutable) cast + cast-id-history — including segments this write never
   touched — silently repainting an untouched line's `resolvedCharacterId`
   and folding its voice into a DIFFERENT character's `resolvedVoiceName`
   ("last wins"). owner design (i): identity is FROZEN for a segment this
   write did not itself re-synthesize; only `resynthesizedIndices` (or its
   default — every index, the shape of a full render) get resolved fresh.

   Each test below follows the reviewer's own repro shape: call the REAL
   `finalizeChapterAudioWrite` twice (an initial render, then a re-finalize
   with the segments read back from disk, mirroring exactly what
   chapter-splice.ts / chapter-qa-repair.ts pass — `...segments[i]`
   verbatim for an untouched segment), then run the real `scoreBook` and
   assert on the written verdicts/centroids. `auditionCentroid`'s
   synth/embed calls are stubbed (never a live sidecar) via scoreBook's own
   `__testSynthFn`/`__testEmbedFn` injection seam. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChapterSegmentsFile } from './finalize-chapter-write.js';
import type { EmbeddingRow } from './render-integrity/embeddings-io.js';

const AUTHOR = 'Refinalize Author';
const SERIES = 'Standalones';
const TITLE = 'Refinalize Story';
const SLUG = 'chapter-one';
const SR = 8_000;

function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

/** A 2-d unit vector at angle θ, padded to length 8 — matches
    render-integrity/aggregate.test.ts's own convention. */
const vec = (theta: number) => Float32Array.from([Math.cos(theta), Math.sin(theta), 0, 0, 0, 0, 0, 0]);

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let bookId: string;
let segPath: string;

let finalizeChapterAudioWrite: typeof import('./finalize-chapter-write.js').finalizeChapterAudioWrite;
let scoreBook: typeof import('./render-integrity/aggregate.js').scoreBook;
let readVerdicts: typeof import('./render-integrity/verdicts-io.js').readVerdicts;
let readCentroids: typeof import('./render-integrity/centroids-io.js').readCentroids;
let writeEmbeddings: typeof import('./render-integrity/embeddings-io.js').writeEmbeddings;
let EMBEDDINGS_VERSION: typeof import('./render-integrity/embeddings-io.js').EMBEDDINGS_VERSION;
let castJsonPath: typeof import('../workspace/paths.js').castJsonPath;
let castIdHistoryPath: typeof import('../store/cast-id-history.js').castIdHistoryPath;

beforeEach(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-refinalize-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [
    { finalizeChapterAudioWrite: finalizeFn },
    { scoreBook: scoreBookFn },
    { readVerdicts: readVerdictsFn },
    { readCentroids: readCentroidsFn },
    { writeEmbeddings: writeEmbeddingsFn, EMBEDDINGS_VERSION: embVersion },
    { makeBookId, castJsonPath: castJsonPathFn },
    { castIdHistoryPath: castIdHistoryPathFn },
  ] = await Promise.all([
    import('./finalize-chapter-write.js'),
    import('./render-integrity/aggregate.js'),
    import('./render-integrity/verdicts-io.js'),
    import('./render-integrity/centroids-io.js'),
    import('./render-integrity/embeddings-io.js'),
    import('../workspace/paths.js'),
    import('../store/cast-id-history.js'),
  ]);
  finalizeChapterAudioWrite = finalizeFn;
  scoreBook = scoreBookFn;
  readVerdicts = readVerdictsFn;
  readCentroids = readCentroidsFn;
  writeEmbeddings = writeEmbeddingsFn;
  EMBEDDINGS_VERSION = embVersion;
  castJsonPath = castJsonPathFn;
  castIdHistoryPath = castIdHistoryPathFn;

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  segPath = join(audioRoot, `${SLUG}.segments.json`);
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
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:00' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function readSegFile(): ChapterSegmentsFile {
  return JSON.parse(readFileSync(segPath, 'utf8'));
}

function writeCast(characters: Array<{ id: string; name: string }>): void {
  writeFileSync(
    castJsonPath(bookDir),
    JSON.stringify({
      characters: characters.map((c) => ({ ...c, gender: 'female', attributes: [] })),
    }),
  );
}

function writeHistory(history: unknown): void {
  writeFileSync(castIdHistoryPath(bookDir), JSON.stringify(history));
}

/** Auditions are stubbed: the last requested `voiceName` decides the angle
    the "rendered" audition embeds at, so a test can distinguish "the
    audition ran under the WRONG (narrator's) voice" from "no audition ran
    at all" without a live sidecar. */
function makeAuditionStub() {
  let lastVoiceName = '';
  return {
    __testSynthFn: async (input: { voiceName: string }) => {
      lastVoiceName = input.voiceName;
      return { pcm: Buffer.alloc(Math.ceil(3.5 * SR) * 2), sampleRate: SR, mimeType: 'audio/pcm' };
    },
    __testEmbedFn: async () => vec(lastVoiceName === 'v-narrator' ? Math.PI / 2 : 0),
  };
}

describe('finalizeChapterAudioWrite re-finalize freezes untouched-segment identity (#3362 pass-5, 🟠E)', () => {
  it('resynthesized segments DO get fresh identity — a segment unresolved at its prior render resolves once this write actually re-synthesizes it', async () => {
    // Render 1: 'mayrin' has no cast/history entry at all — unresolved, no stamp.
    writeCast([]);
    writeHistory({ schema: 1, supersededBy: {} });
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(1.0, 12000),
      sampleRate: SR,
      durationSec: 1.0,
      segments: [{ groupIndex: 0, characterId: 'mayrin', sentenceIds: [1], startSec: 0, endSec: 1.0, voiceName: 'v-mairin' }],
      cast: [],
      castIdHistory: { schema: 1, supersededBy: {} },
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
      audioFormat: 'mp3',
    });
    const rendered = readSegFile();
    expect(rendered.segments[0].resolvedCharacterId).toBeUndefined();
    expect(rendered.characterSnapshots?.mairin).toBeUndefined();

    // AFTER render: a link is recorded — 'mayrin' resolves to 'mairin' now.
    writeCast([{ id: 'mairin', name: 'Mairin' }]);
    writeHistory({ schema: 1, supersededBy: { mayrin: 'mairin' } });

    // Re-finalize: THIS write re-synthesizes the one (and only) segment —
    // index 0 is in resynthesizedIndices.
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(1.0, 12000),
      sampleRate: SR,
      durationSec: 1.0,
      segments: rendered.segments,
      cast: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: { mayrin: 'mairin' } },
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
      audioFormat: 'mp3',
      resynthesizedIndices: [0],
    });

    const reFinalized = readSegFile();
    expect(reFinalized.segments[0].resolvedCharacterId).toBe('mairin');
    expect(reFinalized.characterSnapshots?.mairin).toBeDefined();
  });

  it('R1: a stamp surviving a reject carries its prior snapshot entry forward rather than dangling — never a stamp without a matching key', async () => {
    // Render 1: 'mayrin' resolves to 'mairin' via history; the segment is
    // stamped and gets a real snapshot entry.
    writeCast([{ id: 'mairin', name: 'Mairin' }]);
    writeHistory({ schema: 1, supersededBy: { mayrin: 'mairin' } });
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(1.0, 12000),
      sampleRate: SR,
      durationSec: 1.0,
      segments: [{ groupIndex: 0, characterId: 'mayrin', sentenceIds: [1], startSec: 0, endSec: 1.0, voiceName: 'v-mairin' }],
      cast: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: { mayrin: 'mairin' } },
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
      audioFormat: 'mp3',
    });
    const rendered = readSegFile();
    expect(rendered.segments[0].resolvedCharacterId).toBe('mairin');
    expect(rendered.characterSnapshots?.mairin).toBeDefined();

    // AFTER render: 'mairin' is rejected out of the cast entirely.
    writeCast([]);
    writeHistory({ schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] });

    // Re-finalize (e.g. an unrelated gain remix elsewhere in the chapter) —
    // this segment is untouched: resynthesizedIndices is empty.
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(1.0, 12000),
      sampleRate: SR,
      durationSec: 1.0,
      segments: rendered.segments,
      cast: [],
      castIdHistory: { schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }] },
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
      audioFormat: 'mp3',
      resynthesizedIndices: [],
    });

    const reFinalized = readSegFile();
    // The stamp is carried forward, together with a matching snapshot entry
    // — never a dangling stamp pointing at an absent key.
    expect(reFinalized.segments[0].resolvedCharacterId).toBe('mairin');
    expect(reFinalized.characterSnapshots?.mairin).toBeDefined();
    expect(reFinalized.characterSnapshots?.mairin).toEqual(rendered.characterSnapshots?.mairin);
  });

  it('R2 (S8 via splice): an orphan linked to a real character AFTER render never pools into that character once a splice re-finalizes the chapter', async () => {
    const mairinSegs = Array.from({ length: 12 }, (_, i) => ({
      groupIndex: i,
      characterId: 'mairin',
      sentenceIds: [i],
      startSec: i,
      endSec: i + 1,
      voiceName: 'v-mairin',
    }));
    // Narrator-rendered orphan lines — no cast/history entry for 'mayrin' at
    // render time, so they render in the narrator's voice and stay unresolved.
    const orphanSegs = Array.from({ length: 6 }, (_, i) => ({
      groupIndex: 12 + i,
      characterId: 'mayrin',
      sentenceIds: [100 + i],
      startSec: 12 + i,
      endSec: 13 + i,
      voiceName: 'v-narrator',
    }));
    const embeddings: EmbeddingRow[] = [
      ...mairinSegs.map((s) => ({ characterId: 'mairin', sentenceIds: s.sentenceIds, vec: vec(0.02 * s.groupIndex) })),
      ...orphanSegs.map((s) => ({ characterId: 'mayrin', sentenceIds: s.sentenceIds, vec: vec(Math.PI / 2 + 0.02 * s.groupIndex) })),
    ];

    writeCast([{ id: 'mairin', name: 'Mairin' }]);
    writeHistory({ schema: 1, supersededBy: {} });
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(18.0, 12000),
      sampleRate: SR,
      durationSec: 18.0,
      segments: [...mairinSegs, ...orphanSegs],
      cast: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: {} },
      defaultEngine: 'qwen',
      modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3',
      embeddings,
    });
    const rendered = readSegFile();
    expect(rendered.characterSnapshots?.mairin?.resolvedVoiceName).toBe('v-mairin');
    expect(rendered.characterSnapshots?.mayrin).toBeUndefined();

    // AFTER render: the orphan is linked to 'mairin'.
    writeCast([{ id: 'mairin', name: 'Mairin' }]);
    writeHistory({ schema: 1, supersededBy: { mayrin: 'mairin' } });

    // A splice re-finalizes the chapter, touching nothing (resynthesizedIndices: []).
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(18.0, 12000),
      sampleRate: SR,
      durationSec: 18.0,
      segments: rendered.segments,
      cast: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: { mayrin: 'mairin' } },
      defaultEngine: 'qwen',
      modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3',
      resynthesizedIndices: [],
    });

    const reFinalized = readSegFile();
    // Untouched: identity and voice stay exactly what they were at render —
    // never folded to the orphan's narrator voice ("last wins").
    expect(reFinalized.characterSnapshots?.mairin?.resolvedVoiceName).toBe('v-mairin');
    expect(reFinalized.characterSnapshots?.mayrin).toBeUndefined();
    expect(reFinalized.segments.filter((s) => s.resolvedCharacterId === 'mairin').length).toBe(12);

    await scoreBook(bookDir, [{ id: 1, slug: SLUG }], undefined, makeAuditionStub());
    const verdicts = await readVerdicts(join(audioRoot, `${SLUG}.render-integrity.json`));
    expect(verdicts).not.toBeNull();
    expect(verdicts!.length).toBe(12); // not 18 — the orphan's rows never joined
    expect(verdicts!.every((v) => v.characterId === 'mairin')).toBe(true);
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);

    const centroids = await readCentroids(bookDir);
    expect(centroids!['mairin'].referenceKind).toBe('in-book'); // no audition
  });

  it('R3: a rename recorded AFTER scoring, followed by a re-finalize that resynthesizes nothing, never splits the chapter into a stale/fresh duplicate pair', async () => {
    const segs = Array.from({ length: 12 }, (_, i) => ({
      groupIndex: i,
      characterId: 'mairin',
      sentenceIds: [i],
      startSec: i,
      endSec: i + 1,
      voiceName: 'v-mairin',
    }));
    const embeddings: EmbeddingRow[] = segs.map((s) => ({
      characterId: 'mairin',
      sentenceIds: s.sentenceIds,
      vec: vec(0.02 * s.groupIndex),
    }));

    writeCast([{ id: 'mairin', name: 'Mairin' }]);
    writeHistory({ schema: 1, supersededBy: {} });
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(12.0, 12000),
      sampleRate: SR,
      durationSec: 12.0,
      segments: segs,
      cast: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: {} },
      defaultEngine: 'qwen',
      modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3',
      embeddings,
    });
    const rendered = readSegFile();

    await scoreBook(bookDir, [{ id: 1, slug: SLUG }], undefined, makeAuditionStub());
    const firstPass = await readVerdicts(join(audioRoot, `${SLUG}.render-integrity.json`));
    expect(firstPass!.length).toBe(12);

    // AFTER scoring: 'mairin' is renamed to 'mairin-oakes'.
    writeCast([{ id: 'mairin-oakes', name: 'Mairin Oakes' }]);
    writeHistory({ schema: 1, supersededBy: { mairin: 'mairin-oakes' } });

    // A splice re-finalizes the chapter, resynthesizing nothing.
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(12.0, 12000),
      sampleRate: SR,
      durationSec: 12.0,
      segments: rendered.segments,
      cast: [{ id: 'mairin-oakes', name: 'Mairin Oakes', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: { mairin: 'mairin-oakes' } },
      defaultEngine: 'qwen',
      modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3',
      resynthesizedIndices: [],
    });

    await scoreBook(bookDir, [{ id: 1, slug: SLUG }], undefined, makeAuditionStub());
    const secondPass = await readVerdicts(join(audioRoot, `${SLUG}.render-integrity.json`));
    expect(secondPass).not.toBeNull();
    // 12 rows, still under the FROZEN 'mairin' key — never 24 (12 stale +
    // 12 under the renamed key), and never moved to 'mairin-oakes'.
    expect(secondPass!.length).toBe(12);
    expect(secondPass!.every((v) => v.characterId === 'mairin')).toBe(true);

    const centroids = await readCentroids(bookDir);
    expect(centroids!['mairin']).toBeDefined();
    expect(centroids!['mairin-oakes']).toBeUndefined();
  });

  it('R4 (A22 legacy shape): a re-finalize of a legacy chapter with drift-spelled narrator-rendered lines never repaints them in place — no history change needed at all', async () => {
    // Hand-written legacy fixture: a chapter rendered BEFORE the normalised-id
    // resolver existed. 12 real 'the_torment' rows plus 6 'the-torment' rows
    // narrator-rendered (unresolved at render time — no per-segment stamp,
    // no snapshot entry for the drift spelling). This is exactly register
    // row A22's real shape.
    writeCast([{ id: 'the_torment', name: 'The Torment' }]);
    writeHistory({ schema: 1, supersededBy: {} });

    const realSegs = Array.from({ length: 12 }, (_, i) => ({
      groupIndex: i,
      characterId: 'the_torment',
      sentenceIds: [i],
      startSec: i,
      endSec: i + 1,
    }));
    const narratorSegs = Array.from({ length: 6 }, (_, i) => ({
      groupIndex: 12 + i,
      characterId: 'the-torment',
      sentenceIds: [100 + i],
      startSec: 12 + i,
      endSec: 13 + i,
    }));
    const embeddings: EmbeddingRow[] = [
      ...realSegs.map((s, i) => ({ characterId: 'the_torment', sentenceIds: s.sentenceIds, vec: vec(0.02 * i) })),
      ...narratorSegs.map((s, i) => ({ characterId: 'the-torment', sentenceIds: s.sentenceIds, vec: vec(Math.PI / 2 + 0.02 * i) })),
    ];
    await writeEmbeddings(join(audioRoot, `${SLUG}.embeddings.json`), embeddings, EMBEDDINGS_VERSION);
    writeFileSync(
      segPath,
      JSON.stringify({
        bookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 18,
        sampleRate: SR,
        modelKey: 'qwen3-tts-0.6b',
        synthesizedAt: new Date().toISOString(),
        segments: [...realSegs, ...narratorSegs],
        characterSnapshots: {
          the_torment: { voiceEngine: 'qwen', resolvedVoiceName: 'v-torment', modelKey: 'qwen3-tts-0.6b' },
        },
      } satisfies ChapterSegmentsFile),
    );
    const legacy = readSegFile();

    // Re-finalize (a one-sentence splice, or any other operation): nothing
    // is resynthesized, and there is NO history change at all — the ONLY
    // variable is that finalize runs again on this legacy chapter.
    await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(18.0, 12000),
      sampleRate: SR,
      durationSec: 18.0,
      segments: legacy.segments,
      cast: [{ id: 'the_torment', name: 'The Torment', gender: 'female', attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: {} },
      defaultEngine: 'qwen',
      modelKey: 'qwen3-tts-0.6b',
      audioFormat: 'mp3',
      resynthesizedIndices: [],
    });

    const reFinalized = readSegFile();
    // Untouched, legacy, never stamped in the first place (pre-pass-4): no
    // NEW stamp is minted either — the segments still carry no
    // `resolvedCharacterId` at all, exactly as before this write, and their
    // identity is still the raw exact-match ('the_torment') the chapter's
    // own carried-forward snapshot key supports. The drift-spelled
    // narrator lines ('the-torment') stay un-snapshotted — the fix does
    // not repair a legacy chapter in place on a re-finalize that never
    // re-synthesizes them.
    expect(reFinalized.characterSnapshots?.the_torment?.resolvedVoiceName).toBe('v-torment');
    expect(reFinalized.segments.every((s) => s.resolvedCharacterId === undefined)).toBe(true);
    expect(reFinalized.segments.filter((s) => s.characterId === 'the_torment').length).toBe(12);
    expect(reFinalized.characterSnapshots?.['the-torment']).toBeUndefined();

    await scoreBook(bookDir, [{ id: 1, slug: SLUG }], undefined, makeAuditionStub());
    const verdicts = await readVerdicts(join(audioRoot, `${SLUG}.render-integrity.json`));
    expect(verdicts).not.toBeNull();
    // 12 rows, in-book, never 18 and never an audition in the narrator's voice.
    expect(verdicts!.length).toBe(12);
    expect(verdicts!.every((v) => v.characterId === 'the_torment')).toBe(true);
    expect(verdicts!.every((v) => v.referenceKind === 'in-book')).toBe(true);

    const centroids = await readCentroids(bookDir);
    expect(centroids!['the_torment'].referenceKind).toBe('in-book');
  });
});
