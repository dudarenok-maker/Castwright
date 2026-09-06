import { describe, it, expect } from 'vitest';
import {
  CUTOFFS,
  SYNTHETIC_ONLY_CUTOFFS,
  percentile,
  cosineToCentroid,
  scoreSegment,
  syntheticOnlySpread,
} from './score.js';

// ── CUTOFFS pin ────────────────────────────────────────────────────────────

describe('CUTOFFS', () => {
  // Pinned values are the srv-36 Task 16 calibration result (2026-06-22 operator
  // listen on real Qwen renders). Per-character percentile is required — drift/clean
  // boundaries differ per voice (china-sorrows clean at 0.478 vs narrator drift at
  // 0.507), so no global absolute cosine separates them. See score.ts CUTOFFS doc.
  it('exports the calibration-tuned cutoff constants', () => {
    expect(CUTOFFS.severeEdgePctl).toBe(6);
    expect(CUTOFFS.bandUpperPctl).toBe(10);
    expect(CUTOFFS.minDurationSec).toBe(3.0);
  });
});

// ── percentile ─────────────────────────────────────────────────────────────

describe('percentile', () => {
  it('returns the correct percentile for a simple sorted array', () => {
    // [0, 1, 2, ..., 9] — 100 elements
    const arr = Array.from({ length: 100 }, (_, i) => i);
    // p0 = 0, p50 ≈ 49-50 range, p100 = 99
    expect(percentile(arr, 0)).toBeCloseTo(0, 5);
    expect(percentile(arr, 100)).toBeCloseTo(99, 5);
  });

  it('returns exact value for a two-element array at p0 and p100', () => {
    const arr = [0.3, 0.9];
    expect(percentile(arr, 0)).toBeCloseTo(0.3, 5);
    expect(percentile(arr, 100)).toBeCloseTo(0.9, 5);
  });

  it('returns the single element for a one-element array at any percentile', () => {
    const arr = [0.5];
    expect(percentile(arr, 0)).toBeCloseTo(0.5, 5);
    expect(percentile(arr, 50)).toBeCloseTo(0.5, 5);
    expect(percentile(arr, 100)).toBeCloseTo(0.5, 5);
  });

  it('p50 of 4 elements returns the interpolated midpoint', () => {
    const arr = [1, 2, 3, 4];
    // Standard linear interpolation at p50: midpoint between 2 and 3 = 2.5
    expect(percentile(arr, 50)).toBeCloseTo(2.5, 5);
  });
});

// ── syntheticOnlySpread (A36) ────────────────────────────────────────────────

describe('SYNTHETIC_ONLY_CUTOFFS', () => {
  it('exports the sigma-band calibration constants', () => {
    expect(SYNTHETIC_ONLY_CUTOFFS.severeSigma).toBe(3);
    expect(SYNTHETIC_ONLY_CUTOFFS.bandSigma).toBe(1.5);
  });
});

describe('syntheticOnlySpread', () => {
  // Register row A36's own observed shape (discharged 2026-09-05): a tight, small (N=6) synthetic-only
  // pool clustered around 0.9629, spread ±0.02 — and the two real correct-voice
  // re-render cosines (0.928, 0.934) that a plain percentile-of-pool cutoff
  // false-flagged 'voice-mismatch'/'severe' against this exact cluster.
  const poolCosines = [0.9429, 0.9429, 0.9529, 0.9729, 0.9829, 0.9829]; // mean 0.9629

  it('places both real over-flagged cosines (0.928, 0.934) above the severe edge', () => {
    const { pSevere } = syntheticOnlySpread(poolCosines);
    expect(0.928).toBeGreaterThan(pSevere);
    expect(0.934).toBeGreaterThan(pSevere);
  });

  it('reproduces the calibrated severe/band edges for the pinned pool', () => {
    // mean=0.9629, population std≈0.017318 → severe = mean-3σ, band = mean-1.5σ
    const { pSevere, pBand, usedSigmaBand } = syntheticOnlySpread(poolCosines);
    expect(pSevere).toBeCloseTo(0.9629 - 3 * 0.017318, 4);
    expect(pBand).toBeCloseTo(0.9629 - 1.5 * 0.017318, 4);
    expect(usedSigmaBand).toBe(true); // tight pool uses sigma band
  });

  it('the plain percentile-of-pool cutoff (old behaviour) DOES flag the same pool\'s edge at/above 0.928 — this is the bug this band replaces', () => {
    const sorted = [...poolCosines].sort((a, b) => a - b);
    const oldPSevere = percentile(sorted, CUTOFFS.severeEdgePctl);
    expect(oldPSevere).toBeGreaterThan(0.928); // old cutoff over-flags the real render
  });

  it('degenerate pool dispersion fallback: corrected to use the same percentiles as the real-anchor path', () => {
    // Regression test for the corrected dispersion fallback. Pool with one outlier
    // at 0.4369 and the rest clustered at 0.9607-0.9967. This pool is dispersed
    // (std > 0.05) so it falls back to percentile-based band.
    const degeneratePool = [0.4369, 0.9607, 0.9734, 0.9836, 0.9914, 0.9967];
    const { pSevere, pBand, usedSigmaBand } = syntheticOnlySpread(degeneratePool);

    // This pool should trigger dispersion detection (std > 0.05)
    expect(usedSigmaBand).toBe(false); // dispersed pool uses percentile fallback

    // The fallback should use CUTOFFS percentiles (6, 10), not tighter ones
    const sorted = [...degeneratePool].sort((a, b) => a - b);
    const expectedPSevere = percentile(sorted, CUTOFFS.severeEdgePctl);
    const expectedPBand = percentile(sorted, CUTOFFS.bandUpperPctl);
    expect(pSevere).toBeCloseTo(expectedPSevere, 5);
    expect(pBand).toBeCloseTo(expectedPBand, 5);

    // Verify: cosine 0.50 should be severe (the reviewer's test case)
    expect(0.50).toBeLessThan(pSevere);
  });
});

// ── cosineToCentroid ───────────────────────────────────────────────────────

describe('cosineToCentroid', () => {
  it('self-cosine = 1 for a unit vector', () => {
    const v = [1, 0, 0];
    expect(cosineToCentroid(v, v)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors yield 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineToCentroid(a, b)).toBeCloseTo(0.0, 5);
  });

  it('zero vector returns 0 (degenerate)', () => {
    const zero = [0, 0, 0];
    const v = [1, 0, 0];
    expect(cosineToCentroid(zero, v)).toBe(0);
    expect(cosineToCentroid(v, zero)).toBe(0);
  });

  it('antiparallel vectors yield -1', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineToCentroid(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('non-unit vectors are normalised internally', () => {
    const a = [3, 0, 0]; // norm 3
    const b = [5, 0, 0]; // norm 5 — same direction
    expect(cosineToCentroid(a, b)).toBeCloseTo(1.0, 5);
  });
});

// ── scoreSegment — 3-tier + sub-floor override ────────────────────────────

describe('scoreSegment', () => {
  // Synthetic spread: E (pSevere) = 0.47, U (pBand) = 0.60
  const spread = { pSevere: 0.47, pBand: 0.60 };
  const okDur = 5.0; // above MIN_DURATION_SEC (3.0)

  it('cosine 0.40 (< E=0.47) → voice-mismatch / severe', () => {
    const r = scoreSegment(0.40, spread, okDur);
    expect(r.verdict).toBe('voice-mismatch');
    expect(r.severity).toBe('severe');
  });

  it('cosine 0.55 (E≤cos<U) → inconclusive / inconclusive', () => {
    const r = scoreSegment(0.55, spread, okDur);
    expect(r.verdict).toBe('inconclusive');
    expect(r.severity).toBe('inconclusive');
  });

  it('cosine 0.70 (≥ U=0.60) → voice-match / null', () => {
    const r = scoreSegment(0.70, spread, okDur);
    expect(r.verdict).toBe('voice-match');
    expect(r.severity).toBeNull();
  });

  it('cosine 0.70 with duration 1s (< minDurationSec) → inconclusive override', () => {
    const r = scoreSegment(0.70, spread, 1.0);
    expect(r.verdict).toBe('inconclusive');
    expect(r.severity).toBe('inconclusive');
  });

  it('cosine exactly at E boundary (0.47) is NOT severe — falls into inconclusive band', () => {
    // boundary: cos < E is severe; cos >= E is band (inconclusive)
    const r = scoreSegment(0.47, spread, okDur);
    expect(r.verdict).toBe('inconclusive');
    expect(r.severity).toBe('inconclusive');
  });

  it('cosine exactly at U boundary (0.60) is voice-match', () => {
    // boundary: cos < U is band; cos >= U is match
    const r = scoreSegment(0.60, spread, okDur);
    expect(r.verdict).toBe('voice-match');
    expect(r.severity).toBeNull();
  });

  it('duration exactly at minDurationSec (3.0) is NOT overridden (cos check applies)', () => {
    // durationSec < CUTOFFS.minDurationSec is the guard; equal is safe
    const r = scoreSegment(0.70, spread, 3.0);
    expect(r.verdict).toBe('voice-match');
    expect(r.severity).toBeNull();
  });

  it('severe mismatch with sub-floor duration still → inconclusive (floor wins)', () => {
    const r = scoreSegment(0.10, spread, 0.5);
    expect(r.verdict).toBe('inconclusive');
    expect(r.severity).toBe('inconclusive');
  });

  // A36 regression: reproduces the exact 2026-08-29 false-positive shape — a
  // correctly-cast voice re-rendered on fresh text, scored against a small
  // (N=6) synthetic-only Phase B pool clustered at 0.9629±0.02. With the old
  // percentile-of-pool spread this cosine was flagged 'voice-mismatch'/'severe';
  // with the new synthetic-only sigma band it must not be.
  it('a correct-voice cosine (0.928) against a tight synthetic-only pool is no longer flagged severe', () => {
    const poolCosines = [0.9429, 0.9429, 0.9529, 0.9729, 0.9829, 0.9829]; // mean 0.9629
    const synthSpread = syntheticOnlySpread(poolCosines);
    const r = scoreSegment(0.928, synthSpread, okDur);
    expect(r.verdict).not.toBe('voice-mismatch');
    expect(r.severity).not.toBe('severe');
  });

  it('a correct-voice cosine (0.934) against the same pool is also no longer flagged severe under the synthetic-only band', () => {
    const poolCosines = [0.9429, 0.9429, 0.9529, 0.9729, 0.9829, 0.9829];
    const synthSpread = syntheticOnlySpread(poolCosines);
    const r = scoreSegment(0.934, synthSpread, okDur);
    expect(r.verdict).not.toBe('voice-mismatch');
    expect(r.severity).not.toBe('severe');
  });

  it('the SAME cosine (0.928) against the normal (real-anchor) percentile spread is unaffected by the new band', () => {
    // Sanity check that the normal path's own spread values are untouched —
    // this test's `spread` constant (0.47/0.60) is a stand-in for a real
    // in-book spread and is never routed through syntheticOnlySpread.
    const r = scoreSegment(0.928, spread, okDur);
    expect(r.verdict).toBe('voice-match');
    expect(r.severity).toBeNull();
  });
});
