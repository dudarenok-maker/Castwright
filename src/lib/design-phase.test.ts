import { describe, it, expect } from 'vitest';
import { DESIGN_PHASE_ORDER, phaseRank, DESIGN_PHASE_LABELS, DESIGN_PHASE_BUDGETS_MS } from './design-phase';

describe('design-phase', () => {
  it('ranks phases by their canonical order', () => {
    expect(phaseRank('loading-model')).toBeLessThan(phaseRank('designing'));
    expect(phaseRank('rendering')).toBe(DESIGN_PHASE_ORDER.length - 1);
  });
  it('has a label and a positive budget for every phase', () => {
    for (const p of DESIGN_PHASE_ORDER) {
      expect(DESIGN_PHASE_LABELS[p]).toBeTruthy();
      expect(DESIGN_PHASE_BUDGETS_MS[p]).toBeGreaterThan(0);
    }
  });
});
