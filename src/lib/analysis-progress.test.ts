/* Unit cases for the shared analysis-progress helper. Pairs with
   src/lib/analysis-progress.ts and locks the regression where the pill
   and the "Overall" bar diverged (55% vs 40% on the same stream state). */

import { describe, it, expect } from 'vitest';
import { computeOverallProgress, PHASE_WEIGHTS } from './analysis-progress';

describe('PHASE_WEIGHTS', () => {
  it('sums to 1.0', () => {
    const sum = PHASE_WEIGHTS.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('computeOverallProgress', () => {
  it('returns 0 at the start of phase 0 (clean cold-boot)', () => {
    expect(computeOverallProgress(0, 0)).toBe(0);
  });

  it('returns the phase-0 weight at end of phase 0', () => {
    /* Phase 0 weight = 0.45. */
    expect(computeOverallProgress(0, 1)).toBeCloseTo(0.45, 6);
  });

  it('returns 0.55 at 20% through phase 1 — the screenshot case', () => {
    /* phaseBase = 0.45 (phase 0 weight), phaseShare = 0.5, progress = 0.2.
       → 0.45 + 0.2 * 0.5 = 0.55. The header pill showed 55%; the bug
       was the "Overall" bar showed 40% because of a naive average. */
    expect(computeOverallProgress(1, 0.2)).toBeCloseTo(0.55, 6);
  });

  it('returns 0.65 at 40% through phase 1', () => {
    /* 0.45 + 0.4 * 0.5 = 0.65. */
    expect(computeOverallProgress(1, 0.4)).toBeCloseTo(0.65, 6);
  });

  it('returns 1.0 at the end of phase 2 (run complete)', () => {
    /* 0.45 + 0.5 + 0.05 = 1.0. */
    expect(computeOverallProgress(2, 1)).toBeCloseTo(1, 6);
  });

  it('clamps a negative phase id to 0', () => {
    expect(computeOverallProgress(-1, 0.5)).toBe(computeOverallProgress(0, 0.5));
  });

  it('clamps an out-of-range phase id to the last index', () => {
    expect(computeOverallProgress(99, 0.5)).toBe(
      computeOverallProgress(PHASE_WEIGHTS.length - 1, 0.5),
    );
  });

  it('clamps phaseProgress > 1 to 1', () => {
    expect(computeOverallProgress(1, 1.5)).toBe(computeOverallProgress(1, 1));
  });

  it('clamps negative phaseProgress to 0', () => {
    expect(computeOverallProgress(1, -0.3)).toBe(computeOverallProgress(1, 0));
  });

  it('floors a fractional phase id', () => {
    /* phaseId=1.7 → floor to 1; same result as phaseId=1. */
    expect(computeOverallProgress(1.7, 0.2)).toBe(computeOverallProgress(1, 0.2));
  });
});
