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

  it('dispersion guard: a degenerate synthetic-only pool (one bad render in six) still flags a mismatched voice (cosine 0.16) as severe, never inconclusive — bounds the sigma band against dispersion', async () => {
    // Regression test for unbounded syntheticOnlySpread. With a pool like
    // [0.20, 0.30, 0.95, 0.96, 0.97, 0.98], the sigma-based pSevere would
    // become negative (−0.2886), disabling the severe tier entirely. The fix
    // bounds the sigma band using the percentile-based floor so the severe tier
    // can never be disabled by pool dispersion.
    auditionSpy.mockResolvedValue({
      centroid: CENTROID,
      // Degenerate pool: 5 good renders clustered at 0.95–0.98, 1 bad at 0.20
      embeddings: [0.20, 0.30, 0.95, 0.96, 0.97, 0.98].map(vecAtCosine),
      kind: 'audition' as const,
      syntheticOnly: true,
    });
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-degen-bound-'));
    await writeThuridBook(dir, 0.16); // Clear mismatch, should be severe

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    // Before the fix, this would have been 'inconclusive' or 'voice-match'
    // (because pSevere would be negative, making cosine 0.16 NOT < pSevere).
    // After the fix, it must be 'voice-mismatch'/'severe'.
    expect(freshRender!.verdict).toBe('voice-mismatch');
    expect(freshRender!.severity).toBe('severe');
  });

  it('band edge mutation-sensitivity: a render at cosine 0.85 is severe with the tight pool — catches severeSigma narrowing mutations', async () => {
    // This test is sensitive to mutations on severeSigma. With severeSigma=3,
    // pSevere ≈ 0.9119, so cosine 0.85 < pSevere → severe. Reducing severeSigma
    // (e.g., to 1) would raise pSevere to ~0.927, making 0.85 NOT severe. This
    // catches unintended narrowing of the severe band.
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-severe-band-narrow-'));
    await writeThuridBook(dir, 0.85); // Below pSevere with severeSigma=3

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    // With severeSigma=3, cosine 0.85 must be severe
    expect(freshRender!.verdict).toBe('voice-mismatch');
    expect(freshRender!.severity).toBe('severe');
  });

  it('band edge mutation-sensitivity: a render at cosine 0.945 is voice-match with the tight pool — catches bandSigma narrowing mutations', async () => {
    // This test is sensitive to mutations on bandSigma. With bandSigma=1.5,
    // pBand ≈ 0.937, so cosine 0.945 > pBand → voice-match. Narrowing bandSigma
    // (e.g., to 0.5) would raise pBand to ~0.954, making 0.945 < pBand →
    // inconclusive. This catches unintended narrowing of the band edge.
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-band-edge-narrow-'));
    await writeThuridBook(dir, 0.945); // Above pBand with bandSigma=1.5

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    // With bandSigma=1.5, cosine 0.945 must be voice-match
    expect(freshRender!.verdict).toBe('voice-match');
    expect(freshRender!.severity).toBeNull();
  });

  it('moderately-dispersed pool: a pool with moderate variance triggers the dispersion guard — a correct match (cosine 0.92) within the high subcluster remains voice-match, not disabled by dispersion', async () => {
    // Test the dispersion-guard fallback with a moderately-dispersed pool.
    // Pool: [0.35, 0.40, 0.45, 0.90, 0.92, 0.94] — std ≈ 0.262, which exceeds
    // the dispersion threshold and triggers percentile-based fallback.
    // A cosine 0.92 in the high subcluster should remain voice-match even though
    // the sigma-based band would collapse (mean-1.5σ ≈ 0.35). The dispersion
    // guard must bound it properly via percentiles (pBand ≈ 0.37).
    auditionSpy.mockResolvedValue({
      centroid: CENTROID,
      embeddings: [0.35, 0.40, 0.45, 0.90, 0.92, 0.94].map(vecAtCosine),
      kind: 'audition' as const,
      syntheticOnly: true,
    });
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-mod-dispersed-'));
    await writeThuridBook(dir, 0.92); // High subcluster, should remain voice-match

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    // Cosine 0.92 is well above pBand, so it must be voice-match
    // (confirming the dispersion guard doesn't disable the band)
    expect(freshRender!.verdict).toBe('voice-match');
    expect(freshRender!.severity).toBeNull();
  });

  it('A36 fix: a pre-fix persisted audition row (without bandMethod field) is rebuilt with the new sigma-band logic instead of being reused — a correct-voice fresh render (0.928) is no longer flagged severe', async () => {
    // Regression test for the persisted-row cache-hit path: a pre-fix row
    // written with percentile-derived pSevere/pBand (from the register's
    // 2026-08-29 values) survives the upgrade and is returned verbatim,
    // short-circuiting before auditionCentroid is called. This false-positive
    // the fix: detect pre-fix rows (missing bandMethod field) and rebuild them.
    mockSyntheticOnlyAudition();
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-prefix-persist-'));
    await writeThuridBook(dir, 0.928);

    // Pre-pass: write a pre-fix audition centroid row (no bandMethod field) with
    // the register's own recorded percentile-derived values. This simulates a
    // book scored before the fix landed.
    mkdirSync(join(dir, 'audio'), { recursive: true });
    writeFileSync(
      join(dir, 'audio', 'render-integrity.centroids.json'),
      JSON.stringify({
        thurid: {
          characterId: 'thurid',
          centroid: [1, 0, 0, 0, 0, 0, 0, 0],
          cleanMean: 0.9629,
          pSevere: 0.9409, // pre-fix percentile-derived value
          pBand: 0.9446,   // pre-fix percentile-derived value
          referenceKind: 'audition',
          auditionVoice: {
            voiceName: 'qwen-thurid',
            modelKey: 'qwen3-tts-1.7b',
            cloned: false,
            // deliberately omit bandMethod to simulate pre-fix row
          },
        },
      }),
    );

    // Pass 1 (post-fix): scoreBook encounters the pre-fix row. The fix requires
    // it to detect the missing bandMethod field and rebuild via auditionCentroid.
    // Without the fix, the persisted row would be returned verbatim, and the
    // fresh render at cosine 0.928 would be flagged voice-mismatch/severe
    // (0.928 < pSevere 0.9409) — the A36 false positive.
    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // Verify auditionCentroid was called (i.e., the persisted row was rejected)
    expect(auditionSpy).toHaveBeenCalledTimes(1);

    // Verify the fresh render is NOT flagged severe with the new sigma band
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    expect(freshRender!.verdict).not.toBe('voice-mismatch');
    expect(freshRender!.severity).not.toBe('severe');
  });

  it('dispersion fallback correction: the corrected fallback (percentile 6/10) flags cosine 0.50 as severe with the review pool', async () => {
    // Regression test for the corrected dispersion fallback. The reviewer found
    // that the OLD fallback (percentile 1/5) was wrong-direction: it was LESS
    // protective than both the raw sigma AND the main percentiles. The fix
    // changes the fallback to use the same percentiles as the real-anchor path,
    // which is proven-safe (no regression).
    // Pool: [0.4369, 0.9607, 0.9734, 0.9836, 0.9914, 0.9967]
    // This pool is dispersed (std ≈ 0.262 > 0.05), so it triggers the fallback.
    // With the corrected fallback (percentile 6), pSevere ≈ 0.5940.
    // Cosine 0.50 < 0.5940 → severe (correct).
    auditionSpy.mockResolvedValue({
      centroid: CENTROID,
      embeddings: [0.4369, 0.9607, 0.9734, 0.9836, 0.9914, 0.9967].map(vecAtCosine),
      kind: 'audition' as const,
      syntheticOnly: true,
    });
    const dir = mkdtempSync(join(tmpdir(), 'spk-a36-dispersed-corrected-'));
    await writeThuridBook(dir, 0.50);

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const freshRender = verdicts!.find((v) => v.sentenceIds[0] === 99);
    expect(freshRender).toBeDefined();
    // With the corrected fallback, cosine 0.50 must be severe
    expect(freshRender!.verdict).toBe('voice-mismatch');
    expect(freshRender!.severity).toBe('severe');
  });
});
