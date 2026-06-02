/* fs-1 — pin the upgrade busy gate aggregation. */

import { describe, it, expect } from 'vitest';
import { anyJobInFlight } from './busy-probe.js';

describe('anyJobInFlight', () => {
  it('is not busy when nothing is generating or analysing', () => {
    const r = anyJobInFlight({ generation: () => [], analysis: () => [] });
    expect(r.busy).toBe(false);
    expect(r.generationBooks).toEqual([]);
  });

  it('is busy and names the books when a generation is in flight', () => {
    const r = anyJobInFlight({ generation: () => ['book-a'], analysis: () => [] });
    expect(r.busy).toBe(true);
    expect(r.generationBooks).toEqual(['book-a']);
  });

  it('is busy when an analysis is in flight', () => {
    const r = anyJobInFlight({ generation: () => [], analysis: () => ['ms-1'] });
    expect(r.busy).toBe(true);
    expect(r.analysisManuscripts).toEqual(['ms-1']);
  });
});
