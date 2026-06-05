import { describe, it, expect } from 'vitest';
import { computeReanalyseProgress, formatElapsed } from './reanalyse-progress';

describe('computeReanalyseProgress', () => {
  it('starts at the 2% floor for phase 0 before any heartbeat', () => {
    expect(computeReanalyseProgress({ phaseId: 0, serverProgress: 0.02, phaseElapsedMs: 0 })).toBeCloseTo(0.02, 5);
  });

  it('climbs through the detect band as stage-1 time elapses (no longer frozen at 2%)', () => {
    const early = computeReanalyseProgress({ phaseId: 0, serverProgress: 0.02, phaseElapsedMs: 3_000 });
    const later = computeReanalyseProgress({ phaseId: 0, serverProgress: 0.02, phaseElapsedMs: 12_000 });
    expect(early).toBeGreaterThan(0.02);
    expect(later).toBeGreaterThan(early);
    expect(later).toBeLessThan(0.4); // never reaches the band top on time alone
  });

  it('snaps to the detect band top when the server reports the phase done', () => {
    expect(computeReanalyseProgress({ phaseId: 0, serverProgress: 0.95, phaseElapsedMs: 5_000 })).toBeCloseTo(0.4, 5);
  });

  it('attribution starts at 40% and climbs toward (but not past) 97%', () => {
    const start = computeReanalyseProgress({ phaseId: 1, serverProgress: 0.02, phaseElapsedMs: 0 });
    const mid = computeReanalyseProgress({ phaseId: 1, serverProgress: 0.02, phaseElapsedMs: 20_000 });
    expect(start).toBeCloseTo(0.4, 5);
    expect(mid).toBeGreaterThan(start);
    expect(mid).toBeLessThan(0.97);
  });

  it('snaps attribution to 97% when the server reports it done', () => {
    expect(computeReanalyseProgress({ phaseId: 1, serverProgress: 0.96, phaseElapsedMs: 1_000 })).toBeCloseTo(0.97, 5);
  });

  it('is monotonic across a realistic single-chapter run', () => {
    const ticks: Array<{ phaseId: 0 | 1; serverProgress: number; phaseElapsedMs: number }> = [
      { phaseId: 0, serverProgress: 0.02, phaseElapsedMs: 0 },
      { phaseId: 0, serverProgress: 0.02, phaseElapsedMs: 2_000 },
      { phaseId: 0, serverProgress: 0.02, phaseElapsedMs: 6_000 },
      { phaseId: 0, serverProgress: 0.95, phaseElapsedMs: 8_000 }, // phase 0 done → 0.40
      { phaseId: 1, serverProgress: 0.02, phaseElapsedMs: 0 }, //     phase 1 start → 0.40
      { phaseId: 1, serverProgress: 0.02, phaseElapsedMs: 10_000 },
      { phaseId: 1, serverProgress: 0.02, phaseElapsedMs: 40_000 },
      { phaseId: 1, serverProgress: 0.96, phaseElapsedMs: 45_000 }, // phase 1 done → 0.97
    ];
    let prev = -1;
    for (const t of ticks) {
      const v = computeReanalyseProgress(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    expect(prev).toBeCloseTo(0.97, 5);
  });

  it('always returns a value within [0, 1]', () => {
    for (const phaseId of [0, 1] as const) {
      for (const ms of [0, 1_000, 100_000]) {
        const v = computeReanalyseProgress({ phaseId, serverProgress: 0.02, phaseElapsedMs: ms });
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('formatElapsed', () => {
  it('formats ms as M:SS', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(8_000)).toBe('0:08');
    expect(formatElapsed(95_000)).toBe('1:35');
    expect(formatElapsed(-50)).toBe('0:00');
  });
});
