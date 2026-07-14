import { describe, it, expect } from 'vitest';
import { shouldSurfaceColdBootAnalysisPill } from './analysis-pill-gate';

describe('shouldSurfaceColdBootAnalysisPill', () => {
  it('suppresses a stale paused/halted pill on a confirmed book (voice-strip incident 2026-07-14)', () => {
    expect(shouldSurfaceColdBootAnalysisPill(true, 'paused')).toBe(false);
    expect(shouldSurfaceColdBootAnalysisPill(true, 'halted')).toBe(false);
  });

  it('still surfaces a genuinely-running analysis on a confirmed book', () => {
    expect(shouldSurfaceColdBootAnalysisPill(true, 'running')).toBe(true);
  });

  it('surfaces paused/halted snapshots on an UNconfirmed book (resume flow intact)', () => {
    expect(shouldSurfaceColdBootAnalysisPill(false, 'paused')).toBe(true);
    expect(shouldSurfaceColdBootAnalysisPill(false, 'halted')).toBe(true);
    expect(shouldSurfaceColdBootAnalysisPill(false, 'running')).toBe(true);
  });
});
