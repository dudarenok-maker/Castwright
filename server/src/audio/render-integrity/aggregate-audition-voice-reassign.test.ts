/* #1969 — regression: a persisted Option-B audition centroid must be reused ONLY
   while the character's CURRENT render identity (voiceName, modelKey, language,
   cloned) still matches the voice it was built from. Before Task 2 of this fix,
   resolveCharacterReference reused ANY persisted 'audition' row verbatim — the
   row recorded no voice identity — so a voice reassignment left the character
   scored against a speaker it no longer is (false voice-mismatch/severe on
   correct audio, re-rendering every pass).

   The gate under test (`voiceInfo != null && matchesCurrentVoice(...)` in
   aggregate.ts) covers every rebuild trigger:
   - voice mutation (Test 1)            — the issue's core case
   - a legacy row with no auditionVoice (Test 2) — recorded identity is unknown
   - no voice info at all (Test 3)      — the deliberate behavior change: a
     persisted audition row is NOT trusted, degrades to too-short, and that
     state is ABSORBING across passes (no later attempt re-renders)
   - a book language change (Test 4)    — same voice, different render context
   - a language recorded after none (Test 5) — strict `language` match: a row
     that stored no language is a mismatch once the book records one

   `auditionCentroid` is mocked at the module boundary (the real sidecar synth /
   embed path is never invoked), so the assertion surface is the mock's call
   count (did we RENDER a new audition, or reuse the persisted row?) plus the
   persisted `auditionVoice` identity that Task 1 records. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mocking seam: never touch the real auditionCentroid (sidecar synth/embed).
const { auditionSpy } = vi.hoisted(() => ({
  auditionSpy: vi.fn(async () => ({
    centroid: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]),
    embeddings: [Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])],
    kind: 'audition' as const,
  })),
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';
import { readCentroids } from './centroids-io.js';

const CHAPTERS = [{ id: 1, slug: 'ch1' }];

// A 2-d unit vector at angle θ, padded to length 8 (matches aggregate.test.ts).
const vec = (theta: number) => Float32Array.from([Math.cos(theta), Math.sin(theta), 0, 0, 0, 0, 0, 0]);

/** Write (or rewrite, in-place) a one-chapter, one-character 'thurid' book whose
 *  3 anchors are below CENTROID_MIN_N=10 → too-thin → the Option-B audition path.
 *  `language` is written to .audiobook/state.json only when supplied, so the
 *  "no book language" case (Tests 1–3) is reachable. Re-invoking on the SAME dir
 *  with a different voice/language rewrites the book while LEFT BEHIND the
 *  persisted centroids.json — exercising the reuse/rebuild gate across passes. */
async function writeThuridBook(
  dir: string,
  opts: { resolvedVoiceName?: string; language?: string } = {},
): Promise<void> {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const rows = Array.from({ length: 3 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(0.02 * i),
  }));
  await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);

  // voiceEngine is always present; resolvedVoiceName only when supplied — its
  // absence is the Test-3 case (a current voice info we cannot build).
  const snapshot: Record<string, unknown> = {
    voiceEngine: 'qwen',
    modelKey: 'qwen3-tts-1.7b',
  };
  if (opts.resolvedVoiceName !== undefined) snapshot.resolvedVoiceName = opts.resolvedVoiceName;

  writeFileSync(
    join(dir, 'audio', 'ch1.segments.json'),
    JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({
        characterId: 'thurid',
        sentenceIds: r.sentenceIds,
        renderedFallbackEngine: null,
      })),
      characterSnapshots: { thurid: snapshot },
    }),
  );

  if (opts.language !== undefined) {
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(join(dir, '.audiobook', 'state.json'), JSON.stringify({ language: opts.language }));
  }
}
/** Hand-write a persisted 'audition' centroid row — the BEFORE state of the fix:
 *  a legacy (pre-#1969) row that records NO `auditionVoice` identity, or a row
 *  whose recorded voice we cannot trust. `scoreBook`'s own writeCentroids reads
 *  `audio/render-integrity.centroids.json` as a `{ [characterId]: row }` map. */
function writeLegacyAuditionCentroid(dir: string): void {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  writeFileSync(
    join(dir, 'audio', 'render-integrity.centroids.json'),
    JSON.stringify({
      thurid: {
        characterId: 'thurid',
        centroid: [1, 0, 0, 0, 0, 0, 0, 0],
        cleanMean: 0.95,
        pSevere: 0.9,
        pBand: 0.93,
        referenceKind: 'audition',
        // deliberate omission: no auditionVoice field
      },
    }),
  );
}

describe("scoreBook — audition centroid reuse is gated on the character's current voice (#1969)", () => {
  beforeEach(() => auditionSpy.mockClear());

  it('reuses the persisted audition centroid while the voice matches, and rebuilds it after a voice reassignment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-aud-reassign-'));
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-thurid' });

    // Pass 1 — no persisted centroid: build the audition, record its voice.
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    let c = (await readCentroids(dir))!['thurid'];
    expect(c.referenceKind).toBe('audition');
    expect(c.auditionVoice).toEqual({
      voiceName: 'qwen-thurid',
      modelKey: 'qwen3-tts-1.7b',
      cloned: false,
    });

    // Pass 2 — identical voice: reuse the persisted centroid, no new render.
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    // Pass 3 — voice reassigned: the stale reference is discarded and rebuilt.
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-other' });
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(2);

    c = (await readCentroids(dir))!['thurid'];
    expect(c.auditionVoice?.voiceName).toBe('qwen-other');
  });

  it('rebuilds — and repersists with the current voice — a legacy audition row that records no voice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-aud-legacy-'));
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-thurid' });
    writeLegacyAuditionCentroid(dir); // pre-#1969 row, no auditionVoice field

    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    const c = (await readCentroids(dir))!['thurid'];
    expect(c.auditionVoice).toEqual({
      voiceName: 'qwen-thurid',
      modelKey: 'qwen3-tts-1.7b',
      cloned: false,
    });
  });

  it('does NOT reuse a persisted audition row when there is no voice info — degrades to too-short', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-aud-novoice-'));
    // Snapshot carries voiceEngine 'qwen' but NO resolvedVoiceName → no current
    // voice info can be built → no audition may be attempted, and the persisted
    // row must not be trusted (a deliberate behavior change from unconditional
    // reuse): the character resolves too-short instead.
    await writeThuridBook(dir, {});
    writeLegacyAuditionCentroid(dir);

    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).not.toHaveBeenCalled();

    const c = (await readCentroids(dir))!['thurid'];
    expect(c.referenceKind).toBe('too-short');

    // Second pass with the SAME fixture: the too-short state is ABSORBING — still
    // too-short, and still no audition attempted (nothing may be re-rendered for a
    // character whose current voice info we cannot build).
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).not.toHaveBeenCalled();
    expect((await readCentroids(dir))!['thurid'].referenceKind).toBe('too-short');
  });

  it('rebuilds the audition centroid when the book language changes, even though the voice is unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-aud-langchange-'));
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-thurid', language: 'de' });

    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);
    let c = (await readCentroids(dir))!['thurid'];
    expect(c.auditionVoice?.language).toBe('de');

    // Same voice + modelKey, but the book's language changed → the recorded 'de'
    // no longer matches the 'fr' the chapters now render under → rebuild.
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-thurid', language: 'fr' });
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(2);

    c = (await readCentroids(dir))!['thurid'];
    expect(c.auditionVoice?.language).toBe('fr');
  });

  it('rebuilds when a language is first recorded: a row that stored none is a strict mismatch against a now-languageful book', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-aud-langfirst-'));

    // Pass 1: no state.json → book language unknown → the built auditionVoice
    // records NO language.
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-thurid' });
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(1);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.language).toBeUndefined();

    // Pass 2: same voice + modelKey, but the book now declares 'de'. Under the
    // STRICT language rule the recorded (absent) language no longer matches 'de',
    // so the reference must be rebuilt once — then it records 'de' and stabilises.
    await writeThuridBook(dir, { resolvedVoiceName: 'qwen-thurid', language: 'de' });
    await scoreBook(dir, CHAPTERS);
    expect(auditionSpy).toHaveBeenCalledTimes(2);
    expect((await readCentroids(dir))!['thurid'].auditionVoice?.language).toBe('de');
  });
});

