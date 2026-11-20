/* chapterQwenTierNeeds, cases H1-H11 of plan 293 §5.1 (#1393). The rows live in
   `qwen-tier-needs.fixtures.ts`; the parity test against the real
   `synthesiseChapter` (`qwen-tier-needs.parity.test.ts`) reuses them. */
import { describe, it, expect } from 'vitest';
import { chapterQwenTierNeeds } from './qwen-tier-needs.js';
import { computeQwenKokoroFallbackSet } from './qwen-fallback-set.js';
import { ROWS, row } from './qwen-tier-needs.fixtures.js';

describe('chapterQwenTierNeeds', () => {
  for (const r of ROWS) {
    it(`${r.id}: ${JSON.stringify(r.expected)}`, () => {
      expect(chapterQwenTierNeeds(r.input)).toEqual(r.expected);
    });
  }

  it('H10/H11: the variant-only narrator is in the Kokoro fallback set', () => {
    for (const id of ['H10', 'H11']) {
      const { cast, defaultEngine } = row(id).input;
      expect(computeQwenKokoroFallbackSet(cast, defaultEngine).map((c) => c.id)).toEqual(['narrator']);
    }
  });
});
