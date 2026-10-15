/* #3524 — regression: the audition voice-check reference must be built (or
   kept) from a render in the character's CURRENT cast.json voice, not from the
   first chapter in book order.

   Repro (the review's): ch1 and ch2 both rendered on qwen-OLD, then the cast
   moves the character to qwen-NEW and ONLY ch2 is re-rendered. Before the fix
   `voiceInfoByChar` still came from ch1's (OLD) snapshot, so the persisted OLD
   audition matched and was reused verbatim, and every NEW-voice line in the
   re-rendered ch2 scored `voice-mismatch`.

   `auditionCentroid` is mocked at the module boundary (as in
   aggregate-audition-voice-reassign.test.ts); the assertion surface is its call
   count, the persisted `auditionVoice` identity, and ch2's verdict rows. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The axis the mocked audition "sounds like" — flipped between passes so the
// centroid it returns tracks the voice it was asked to render.
const { auditionSpy, audition } = vi.hoisted(() => {
  const state = { axis: 0 };
  const unit = (axis: number) => Float32Array.from(Array.from({ length: 8 }, (_, i) => (i === axis ? 1 : 0)));
  // A spread of jittered takes around the axis, so the audition's clean-band
  // thresholds are non-degenerate (one lone embedding gives a zero-width band).
  const take = (axis: number, k: number) => {
    const v = Array.from(unit(state.axis), (x) => x);
    v[(axis + 2) % 8] = k * 0.005;
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return Float32Array.from(v.map((x) => x / n));
  };
  return {
    audition: state,
    auditionSpy: vi.fn(async () => ({
      centroid: unit(state.axis),
      embeddings: Array.from({ length: 12 }, (_, k) => take(state.axis, k)),
      kind: 'audition' as const,
    })),
  };
});
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';
import { readCentroids } from './centroids-io.js';
import { readVerdicts } from './verdicts-io.js';

const CHAPTERS = [
  { id: 1, slug: 'ch1' },
  { id: 2, slug: 'ch2' },
];

// Unit vector on one axis with a tiny deterministic jitter (dim 8).
const vec = (axis: number, i: number) => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  v[(axis + 2) % 8] = i * 0.005;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return Float32Array.from(v.map((x) => x / n));
};

/** Write one chapter with 3 'thurid' anchors (below CENTROID_MIN_N=10 → the
 *  audition path) whose embeddings sit on `axis` and whose snapshot records
 *  `resolvedVoiceName`. */
async function writeChapter(dir: string, slug: string, chapterId: number, axis: number, voice: string) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: 3 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(axis, i),
  }));
  await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', `${slug}.segments.json`),
    JSON.stringify({
      chapterId,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
      })),
      characterSnapshots: {
        thurid: { voiceEngine: 'qwen', modelKey: 'qwen3-tts-1.7b', resolvedVoiceName: voice },
      },
    }),
  );
}

/** cast.json gives thurid a designed Qwen voice: a `libraryUuid` slot resolves
 *  to `qwen-<libraryUuid>` via pickVoiceForEngine. */
function writeCast(dir: string, libraryUuid: string) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        {
          id: 'thurid',
          name: 'Thurid',
          overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid } },
        },
      ],
    }),
  );
}

describe('scoreBook — the audition reference follows the current cast voice (#3524)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });

  it('rebuilds the audition from the NEW voice after a partial re-render, so the re-rendered chapter is not voice-mismatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-cur-voice-'));
    writeCast(dir, 'old');
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');

    // Pass 1 — both chapters on OLD.
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-old');

    // The cast moves to NEW; only ch2 is re-rendered under it (far-off vectors).
    writeCast(dir, 'new');
    await writeChapter(dir, 'ch2', 2, 1, 'qwen-new');
    audition.axis = 1;

    // Pass 2 — partial re-render of ch2.
    await scoreBook(dir, CHAPTERS, ['ch2']);
    expect(auditionSpy).toHaveBeenCalledTimes(2);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-new');

    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2).not.toBeNull();
    expect(ch2!.length).toBeGreaterThan(0);
    expect(ch2!.filter((r) => r.verdict === 'voice-mismatch')).toEqual([]);
  });

  it('keeps first-chapter-wins for a character with no cast.json row (no current voice known)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-cur-voice-nocast-'));
    await writeChapter(dir, 'ch1', 1, 0, 'qwen-old');
    await writeChapter(dir, 'ch2', 2, 0, 'qwen-old');

    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    // ch2 re-rendered on a different voice, but with no cast row there is no
    // "current voice" to prefer: ch1's snapshot still wins, the OLD audition is reused.
    await writeChapter(dir, 'ch2', 2, 1, 'qwen-new');
    audition.axis = 1;
    await scoreBook(dir, CHAPTERS, ['ch2']);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.voiceName).toBe('qwen-old');
  });
});

/* #3524 child 2 — the IN-BOOK anchor pool follows the current cast voice.
   12 lines per chapter (≥ CENTROID_MIN_N = 10) so each chapter alone is enough
   for the in-book path; `stamp` is the per-segment voice stamp (`voiceName`),
   or null for a legacy unstamped segment that falls back to the chapter's
   snapshot `resolvedVoiceName`. */
async function writeBulkChapter(
  dir: string,
  slug: string,
  chapterId: number,
  axis: number | Float32Array,
  snapshotVoice: string,
  stamp: string | null,
) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: 12 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    // Identical vectors per chapter ("one angle"): any jitter would put the
    // lowest-cosine NEW line under the in-book severe-edge percentile by design.
    vec: typeof axis === 'number' ? vec(axis, 0) : axis,
  }));
  await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', `${slug}.segments.json`),
    JSON.stringify({
      chapterId,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
        ...(stamp != null ? { voiceName: stamp } : {}),
      })),
      characterSnapshots: {
        thurid: { voiceEngine: 'qwen', modelKey: 'qwen3-tts-1.7b', resolvedVoiceName: snapshotVoice },
      },
    }),
  );
}

const cos = (a: number[], b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe('scoreBook — in-book anchors pool only from the current cast voice (#3524)', () => {
  beforeEach(() => {
    auditionSpy.mockClear();
    audition.axis = 0;
  });

  it('builds the in-book centroid from the NEW-voice lines only and records inBookVoiceName', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-inbook-cur-'));
    writeCast(dir, 'new');
    await writeBulkChapter(dir, 'ch1', 1, 0, 'qwen-old', 'qwen-old');
    await writeBulkChapter(dir, 'ch2', 2, 1, 'qwen-new', 'qwen-new');

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('qwen-new');
    expect(cos(row.centroid, vec(1, 3))).toBeGreaterThan(0.99);
    const ch2 = await readVerdicts(join(dir, 'audio', 'ch2.render-integrity.json'));
    expect(ch2!.length).toBeGreaterThan(0);
    expect(ch2!.filter((r) => r.verdict === 'voice-mismatch')).toEqual([]);
  });

  it('resolves an unstamped legacy line through its chapter snapshot voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-inbook-legacy-'));
    writeCast(dir, 'new');
    await writeBulkChapter(dir, 'ch1', 1, 0, 'qwen-old', null); // legacy, snapshot OLD → not an anchor
    await writeBulkChapter(dir, 'ch2', 2, 1, 'qwen-new', null); // legacy, snapshot NEW → anchor

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBe('qwen-new');
    expect(cos(row.centroid, vec(1, 3))).toBeGreaterThan(0.99);
  });

  it('pools every line and records no inBookVoiceName for a character with no cast.json row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-inbook-nocast-'));
    // OLD at 0°, NEW at 20° in the axis-0/1 plane: close enough to stay one
    // unimodal pool, far enough that pooling both (centroid at 10°) is
    // distinguishable from NEW alone (cosine 1).
    const rad = (20 * Math.PI) / 180;
    const newVec = Float32Array.from([Math.cos(rad), Math.sin(rad), 0, 0, 0, 0, 0, 0]);
    await writeBulkChapter(dir, 'ch1', 1, 0, 'qwen-old', 'qwen-old');
    await writeBulkChapter(dir, 'ch2', 2, newVec, 'qwen-new', 'qwen-new');

    await scoreBook(dir, CHAPTERS);

    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('in-book');
    expect(row.inBookVoiceName).toBeUndefined();
    expect(cos(row.centroid, newVec)).toBeGreaterThan(0.97);
    expect(cos(row.centroid, newVec)).toBeLessThan(0.995);
  });
});
