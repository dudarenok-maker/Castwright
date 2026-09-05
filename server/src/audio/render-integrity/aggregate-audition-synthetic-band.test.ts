/* A36 (parent #2934, register row A36, #1969/#2402/#2700) regression.

   2026-08-29 real on-box finding: a correctly-cast voice, re-rendered against
   fresh text, was false-flagged 'voice-mismatch'/'severe' because its
   reference was a small (N=6), synthetic-only Option-B ("Phase B") pool —
   same engine, same voice, same controlled acoustic conditions — which
   clusters far tighter (observed 0.9629±0.02) than the natural variance of a
   real render (observed correct-voice cosines 0.928/0.934). The normal
   percentile cutoffs (CUTOFFS.severeEdgePctl/bandUpperPctl in score.ts) are
   calibrated for real-anchor variance and, applied to that tight synthetic
   cluster, sit ABOVE the real render's cosine.

   This file exercises the fix end to end through scoreBook: auditionCentroid
   is mocked (never touches a sidecar) to return the register's own pinned
   pool shape with `syntheticOnly: true`, and asserts the ACTUAL verdict rows
   scoreBook writes for both the correct-voice fresh render and — in a
   separate test — a real in-book (non-synthetic) character, to prove the
   normal path is completely unaffected. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { auditionSpy } = vi.hoisted(() => ({
  auditionSpy: vi.fn(async (_character: unknown, _opts?: unknown) => null as unknown),
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { readVerdicts } from './verdicts-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// A 2-d unit vector at angle θ, padded to length 8 (matches aggregate.test.ts).
// cosineToCentroid(vec(θ), vec(0)) = cos(θ) exactly (both unit-norm).
const vec = (theta: number) => Float32Array.from([Math.cos(theta), Math.sin(theta), 0, 0, 0, 0, 0, 0]);
const vecAtCosine = (cosine: number) => vec(Math.acos(cosine));
const CENTROID = vec(0); // [1, 0, 0, 0, 0, 0, 0, 0]

// The register's own observed synthetic-only pool: N=6, cosines-to-centroid
// clustered at mean 0.9629, spread ±0.02 (matches score.test.ts's pinned pool).
const SYNTHETIC_POOL_COSINES = [0.9429, 0.9429, 0.9529, 0.9729, 0.9829, 0.9829];

function mockSyntheticOnlyAudition() {
  auditionSpy.mockResolvedValue({
    centroid: CENTROID,
    embeddings: SYNTHETIC_POOL_COSINES.map(vecAtCosine),
    kind: 'audition' as const,
    syntheticOnly: true,
  });
}

function writeThuridBook(dir: string, freshRenderCosine: number) {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const anchorRows = Array.from({ length: 3 }, (_, i) => ({
    characterId: 'thurid',
    sentenceIds: [i],
    vec: vec(0), // count (< CENTROID_MIN_N=10) is what matters — triggers Option-B
  }));
  const freshRenderRow = { characterId: 'thurid', sentenceIds: [99], vec: vecAtCosine(freshRenderCosine) };
  const rows = [...anchorRows, freshRenderRow];

  writeFileSync(
    join(dir, 'audio', 'ch1.segments.json'),
    JSON.stringify({
      chapterId: 1,
      modelKey: 'qwen3-tts-1.7b',
      segments: rows.map((r) => ({ characterId: 'thurid', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
    }),
  );
  return writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
}

describe('scoreBook — A36 synthetic-only-pool severity band (register row A36)', () => {
  beforeEach(() => auditionSpy.mockClear());

  it('reproduces the exact 2026-08-29 shape and confirms the fix: correct-voice fresh render (cosine 0.928) is no longer voice-mismatch/severe', async () => {
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-synth-band-'));
    await writeThuridBook(dir, 0.928);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    expect(freshRender!.verdict).not.toBe('voice-mismatch');
    expect(freshRender!.severity).not.toBe('severe');
  });

  it('a correct-voice fresh render (cosine 0.934) is also not flagged severe under the synthetic-only band', async () => {
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-synth-band-match-'));
    await writeThuridBook(dir, 0.934);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender!.verdict).not.toBe('voice-mismatch');
    expect(freshRender!.severity).not.toBe('severe');
  });

  it('a clearly matching render (cosine 0.995) scores voice-match under the synthetic-only band — the band is wider, not disabled', async () => {
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-synth-band-clearmatch-'));
    await writeThuridBook(dir, 0.995);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender!.verdict).toBe('voice-match');
    expect(freshRender!.severity).toBeNull();
  });

  it('a genuinely mismatched render (cosine 0.10) is still flagged severe under the synthetic-only band — the band widens, it does not disable detection', async () => {
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-synth-band-truepos-'));
    await writeThuridBook(dir, 0.10);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender!.verdict).toBe('voice-mismatch');
    expect(freshRender!.severity).toBe('severe');
  });

  it('the normal (real-anchor, in-book) path is completely unaffected — a clearly-drifted segment is still flagged severe, and the audition/synthetic-only path is never even reached', async () => {
    // No mock needed — this exercises the in-book path only (>= CENTROID_MIN_N
    // anchors), which never calls auditionCentroid and never reaches
    // syntheticOnlySpread; mirrors aggregate.test.ts's own proven in-book
    // fixture shape (12 clustered near θ≈0, one segment far away at θ≈1.2).
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-inbook-unaffected-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const anchorRows = Array.from({ length: 12 }, (_, i) => ({ characterId: 'thurid', sentenceIds: [i], vec: vec(0.02 * i) }));
    const freshRenderRow = { characterId: 'thurid', sentenceIds: [99], vec: vec(1.2) }; // far from the cluster
    const rows = [...anchorRows, freshRenderRow];

    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({ characterId: 'thurid', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).not.toHaveBeenCalled(); // in-book path never touches Option-B
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender!.verdict).toBe('voice-mismatch');
    expect(freshRender!.severity).toBe('severe');
  });
});
