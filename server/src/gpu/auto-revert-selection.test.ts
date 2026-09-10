import { describe, it, expect } from 'vitest';
import { selectRevertTarget } from './auto-revert-selection.js';

describe('selectRevertTarget', () => {
  it('picks the OTHER candidate with the most free VRAM, never the tripped card', () => {
    const target = selectRevertTarget({
      trippedCardIdx: 0,
      candidates: [
        { idx: 0, freeMb: 20000 }, // tripped — must never be chosen, even though it looks roomiest
        { idx: 1, freeMb: 4000 },
        { idx: 2, freeMb: 9000 },
      ],
      requiredMb: 3000,
    });
    expect(target).toBe('cuda:2');
  });

  it('falls back to cpu when no other candidate has enough free VRAM', () => {
    const target = selectRevertTarget({
      trippedCardIdx: 0,
      candidates: [
        { idx: 0, freeMb: 20000 },
        { idx: 1, freeMb: 1000 },
      ],
      requiredMb: 6500,
    });
    expect(target).toBe('cpu');
  });

  it('falls back to cpu on a single-GPU box (no other candidate at all)', () => {
    const target = selectRevertTarget({
      trippedCardIdx: 0,
      candidates: [{ idx: 0, freeMb: 8000 }],
      requiredMb: 3000,
    });
    expect(target).toBe('cpu');
  });

  it('falls back to cpu with an empty candidate list', () => {
    const target = selectRevertTarget({ trippedCardIdx: 0, candidates: [], requiredMb: 3000 });
    expect(target).toBe('cpu');
  });
});
