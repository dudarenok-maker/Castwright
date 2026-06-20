import { describe, it, expect } from 'vitest';
import { deriveIssues, ISSUE_CONTEXT_PAD_SEC } from './chapter-issues';

const seg = (start: number, end: number, suspect?: boolean, reasons?: string[]) => ({
  start, end, characterId: 'c', sentenceId: 1, suspect, reasons,
});

describe('deriveIssues', () => {
  it('pads a single flagged segment and clamps + sets seekSec', () => {
    const r = deriveIssues({ durationSec: 20, segments: [seg(6, 10, true, ['Long sentence'])] });
    expect(r).toHaveLength(1);
    expect(r[0].seekSec).toBe(4); // 6 - 2
    expect(r[0].startFrac).toBeCloseTo(4 / 20);
    expect(r[0].endFrac).toBeCloseTo(12 / 20); // 10 + 2
    expect(r[0].reasons).toEqual(['Long sentence']);
  });

  it('merges two flagged segments within 2*PAD into one region', () => {
    const r = deriveIssues({
      durationSec: 60,
      segments: [seg(0, 3, true, ['A']), seg(4, 6, true, ['B'])],
    });
    expect(r).toHaveLength(1);
    expect(r[0].reasons).toEqual(['A', 'B']);
    expect(r[0].seekSec).toBe(0);
  });

  it('keeps two far-apart flags as separate regions', () => {
    const r = deriveIssues({
      durationSec: 60,
      segments: [seg(0, 3, true, ['A']), seg(50, 53, true, ['B'])],
    });
    expect(r).toHaveLength(2);
  });

  it('clamps a near-start issue startFrac to 0 without flagging it degenerate', () => {
    const r = deriveIssues({ durationSec: 60, segments: [seg(0, 3, true, ['A'])] });
    expect(r[0].startFrac).toBe(0);
    expect(r[0].endFrac).toBeCloseTo(5 / 60);
  });

  it('drops a region that covers the whole track (degenerate / short chapter)', () => {
    const r = deriveIssues({ durationSec: 3, segments: [seg(0, 3, true, ['A'])] });
    expect(r).toEqual([]);
  });

  it('ignores non-suspect segments', () => {
    expect(deriveIssues({ durationSec: 20, segments: [seg(0, 5)] })).toEqual([]);
    expect(ISSUE_CONTEXT_PAD_SEC).toBe(2);
  });
});
