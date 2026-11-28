/* #3518 — an audition row blended from REAL anchors must record the tier those anchors were
   rendered at (not the current voice's), and is usable (qa-repair rule AND scoreBook reuse gate)
   only when every blended anchor shares the row's own tier. A synthetic-only audition has no
   anchors to disagree; a legacy row with no record fails closed. */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// auditionCentroid is mocked at the module boundary; `synthOnly` flips its syntheticOnly flag.
const { auditionSpy, mode } = vi.hoisted(() => {
  const unit = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const mode = { synthOnly: false };
  return {
    mode,
    auditionSpy: vi.fn(async () => ({ centroid: unit, embeddings: Array.from({ length: 8 }, () => unit), kind: 'audition' as const, syntheticOnly: mode.synthOnly })),
  };
});
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';
import { readCentroids, writeCentroids, auditionCentroidUsableForCurrent, AUDITION_NO_ANCHORS } from './centroids-io.js';

const T06 = 'qwen3-tts-0.6b';
const T17 = 'qwen3-tts-1.7b';
const unit = () => Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);

/** A book whose single chapter holds `lines` 'thurid' lines rendered at T06; thurid is pinned to `pin` (if any).
 *  `stamp` is each segment's `renderedModelKey` (#4225); null = legacy, unstamped segments. */
async function bookWithLines(lines: number, pin?: string, stamp: string | null = T06) {
  const dir = mkdtempSync(join(tmpdir(), 'audition-anchor-tier-'));
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [{ id: 'thurid', name: 'Thurid', ttsEngine: 'qwen', ...(pin ? { ttsModelKey: pin } : {}), overrideTtsVoices: { qwen: { name: 'Thurid voice', libraryUuid: 'new' } } }] }),
  );
  const rows = Array.from({ length: lines }, (_, i) => ({ characterId: 'thurid', sentenceIds: [i], vec: unit() }));
  await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
  writeFileSync(
    join(dir, 'audio', 'ch1.segments.json'),
    JSON.stringify({
      chapterId: 1,
      modelKey: T06,
      segments: rows.map((r) => ({
        characterId: 'thurid', sentenceIds: r.sentenceIds, renderedFallbackEngine: null, voiceName: 'qwen-new',
        ...(stamp ? { renderedModelKey: stamp } : {}),
      })),
      characterSnapshots: { thurid: { voiceEngine: 'qwen', modelKey: T06, resolvedVoiceName: 'qwen-new' } },
    }),
  );
  return dir;
}

describe('audition rows record the tier of the real anchors blended into them (#3518)', () => {
  it('reviewer probe: 8 lines rendered at 0.6B, character pinned to 1.7B -> the audition row is NOT usable for 1.7B', async () => {
    mode.synthOnly = false;
    const dir = await bookWithLines(8, T17);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('audition');
    expect(row.auditionVoice?.modelKey).toBe(T17);
    expect(row.auditionAnchorModelKey).toBe(T06);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-new', T17)).toBe(false);
  });

  it('anchors at the same tier as the voice: the row is usable', async () => {
    mode.synthOnly = false;
    const dir = await bookWithLines(8);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const row = (await readCentroids(dir))!['thurid'];
    expect(row.auditionAnchorModelKey).toBe(T06);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-new', T06)).toBe(true);
  });

  it('an audition that blends an unknown-tier anchor (legacy unstamped segment) gets NO stamp and is unusable (P3-3)', async () => {
    mode.synthOnly = false;
    const dir = await bookWithLines(8, undefined, null);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const row = (await readCentroids(dir))!['thurid'];
    expect(row.referenceKind).toBe('audition');
    expect(row.auditionAnchorModelKey).toBeUndefined();
    expect(auditionCentroidUsableForCurrent(row, 'qwen-new', T06)).toBe(false);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-new', T17)).toBe(false);
  });

  it('a synthetic-only audition (no real anchors blended) is usable at the voice tier', async () => {
    mode.synthOnly = true;
    const dir = await bookWithLines(8, T17);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const row = (await readCentroids(dir))!['thurid'];
    expect(row.auditionAnchorModelKey).toBe(AUDITION_NO_ANCHORS);
    expect(auditionCentroidUsableForCurrent(row, 'qwen-new', T17)).toBe(true);
  });

  it('scoreBook does not reuse an off-tier persisted audition row (it rebuilds it), nor a legacy one with no record', async () => {
    mode.synthOnly = false;
    const dir = await bookWithLines(8, T17);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    const built = (await readCentroids(dir))!['thurid'];
    const callsAfterFirst = auditionSpy.mock.calls.length;

    // Same row, but stamped as if its anchors were at the voice's own tier -> reused, no new audition.
    await writeCentroids(dir, [{ ...built, auditionAnchorModelKey: T17 }]);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(auditionSpy.mock.calls.length).toBe(callsAfterFirst);

    // Off-tier stamp (what the reviewer probe leaves behind) -> rebuilt.
    await writeCentroids(dir, [{ ...built, auditionAnchorModelKey: T06 }]);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(auditionSpy.mock.calls.length).toBe(callsAfterFirst + 1);

    // Legacy row (no record at all) -> rebuilt.
    const { auditionAnchorModelKey: _drop, ...legacy } = built;
    await writeCentroids(dir, [legacy]);
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(auditionSpy.mock.calls.length).toBe(callsAfterFirst + 2);
  });
});
