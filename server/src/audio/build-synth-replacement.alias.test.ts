/* #2040 — `findDivergentSentences` is the site that matters most in this
   wave: without it, a book that moves the sentence store into a different
   id space (while the frozen segments.json stays put) reads EVERY drifted
   segment as a genuine reattribution — `chapter-qa-repair.ts` would drop
   every one into `stillSuspect` and `chapter-splice.ts` would refuse the
   whole splice outright (spec §4.3), even though the two sides actually
   agree once resolved through the cast + the book's retired-id history.

   `findDivergentSentences` now takes the book's cast and its
   `castIdHistory` (from `loadCastIdHistory(bookDir).supersededBy`,
   defaulting to `{}`) and compares RESOLVED identities via
   `buildCastResolver` (Task 3) instead of comparing the two raw
   characterId strings with `!==`.

   Guessing here can destroy correct audio (#1972's lesson) — so the
   fallback is deliberately asymmetric: two ids are only the same person
   when BOTH resolve AND resolve to the same cast id. Two ids that merely
   look alike, or that both fail to resolve, are still a divergence. */
import { describe, it, expect } from 'vitest';
import { findDivergentSentences } from './build-synth-replacement.js';
import type { ChapterSegment } from '../tts/synthesise-chapter.js';

function seg(i: number, characterId: string, sentenceIds: number[]): ChapterSegment {
  return { groupIndex: i, characterId, sentenceIds, startSec: i, endSec: i + 1 };
}

describe('#2040 findDivergentSentences tolerates alias-only differences', () => {
  const cast = [{ id: 'mairin', name: 'Мэйрин' }];
  const history = { supersededBy: { mayrin: 'mairin' } };

  it('does NOT report divergence when the two ids are the same character', () => {
    // segFile segment: characterId 'mayrin' (the retired id); current
    // sentence: characterId 'mairin' (the canonical id) — same person,
    // resolvable only through `history`, not through normalised-id
    // matching (`mayrin`/`mairin` differ by a letter, per
    // character-id.ts's own docstring).
    const segments = [seg(0, 'mayrin', [1])];
    const current = [{ id: 1, characterId: 'mairin', text: 'Line.' }];
    expect(findDivergentSentences(segments, [0], current, cast, history)).toEqual([]);
  });

  it('STILL reports divergence on a genuine reattribution', () => {
    // segFile segment: characterId 'mairin' (a live cast id); current
    // sentence: characterId 'ren' — a different, unrelated character, not
    // an alias of 'mairin' at all. Must still surface as a real drift.
    const segments = [seg(0, 'mairin', [1])];
    const current = [{ id: 1, characterId: 'ren', text: 'Line.' }];
    expect(findDivergentSentences(segments, [0], current, cast, history)).toEqual([
      { segmentIndex: 0, sentenceId: 1, newOwner: 'ren' },
    ]);
  });

  it('reports divergence when NEITHER id resolves — two orphans are not the same person just because a naive fallback might treat them alike', () => {
    // Neither 'ghost-a' nor 'ghost-b' is in the cast or the history map.
    // #1972's lesson: guessing here can destroy correct audio, so an
    // unresolvable pair must never be waved through as "the same".
    const segments = [seg(0, 'ghost-a', [1])];
    const current = [{ id: 1, characterId: 'ghost-b', text: 'Line.' }];
    expect(findDivergentSentences(segments, [0], current, cast, history)).toEqual([
      { segmentIndex: 0, sentenceId: 1, newOwner: 'ghost-b' },
    ]);
  });

  it('does NOT report divergence when the two raw ids are byte-identical, even if unresolvable (exact-match short circuit)', () => {
    // Neither id is in the cast — but they're the SAME string, so this is
    // by definition not a divergence regardless of resolution.
    const segments = [seg(0, 'ghost-a', [1])];
    const current = [{ id: 1, characterId: 'ghost-a', text: 'Line.' }];
    expect(findDivergentSentences(segments, [0], current, cast, history)).toEqual([]);
  });

  it('#2040 Task 17 fix round 1 — a rejected alias no longer counts as "the same person", so the pair reports as diverged', () => {
    // Same fixture as the first test ('mayrin' -> 'mairin' via history), but
    // the user has rejected that exact reconciliation. Before fix round 1,
    // `castIdHistory` reaching this call site was `.supersededBy` alone —
    // `rejected` never got here, so this test would have stayed green
    // (still resolving 'mayrin' -> 'mairin') even after a reject, silently
    // protecting the wrong id from ever being flagged as diverged/re-recorded.
    const rejectingHistory = { supersededBy: { mayrin: 'mairin' }, rejected: ['mayrin'] };
    const segments = [seg(0, 'mayrin', [1])];
    const current = [{ id: 1, characterId: 'mairin', text: 'Line.' }];
    expect(findDivergentSentences(segments, [0], current, cast, rejectingHistory)).toEqual([
      { segmentIndex: 0, sentenceId: 1, newOwner: 'mairin' },
    ]);
  });
});
