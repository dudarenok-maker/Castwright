import { describe, it, expect } from 'vitest';
import {
  CUTOFFS,
  percentile,
  cosineToCentroid,
  scoreSegment,
} from './score.js';

// ── CUTOFFS pin ────────────────────────────────────────────────────────────

describe('CUTOFFS', () => {
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
});
