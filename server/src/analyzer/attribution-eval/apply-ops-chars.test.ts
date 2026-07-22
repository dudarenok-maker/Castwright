/* Task 4: applies accepted script-review ops (reattribute / split /
   extract_dialogue) to a final char-position speaker array to produce the
   "reviewed" char array — the other half of the final→reviewed char-array
   diff. `resolveAnchorOffset` (review-apply-core.ts) returns the END offset
   of a unique anchor match, sentence-local; every offset here is derived
   from that contract. See task-4-brief.md for the exact op rules. */
import { describe, it, expect } from 'vitest';
import { applyOpsToCharArray } from './apply-ops-chars.js';
import type { ScriptReviewOp } from '../../handoff/schemas.js';

interface FinalSentence {
  id: number;
  text: string;
  characterId: string;
}
interface FinalSpan {
  id: number;
  start: number;
  end: number;
}

function makeOp(partial: Partial<ScriptReviewOp> & Pick<ScriptReviewOp, 'id' | 'op'>): ScriptReviewOp {
  return { rationale: 'test', ...partial } as ScriptReviewOp;
}

describe('applyOpsToCharArray', () => {
  it('reattribute recolors the whole span', () => {
    // 30-char chapter; sentence 1 occupies [0,10) as 'alice'; rest is 'zed' filler.
    const finalByChar: Array<string | null> = [
      ...Array(10).fill('alice'),
      ...Array(20).fill('zed'),
    ];
    const finalSentences: FinalSentence[] = [{ id: 1, text: 'irrelevant', characterId: 'alice' }];
    const finalSpans: FinalSpan[] = [{ id: 1, start: 0, end: 10 }];
    const ops: ScriptReviewOp[] = [makeOp({ id: 1, op: 'reattribute', characterId: 'bob' })];

    const reviewed = applyOpsToCharArray(finalByChar, finalSentences, finalSpans, ops);

    expect(reviewed.slice(0, 10)).toEqual(Array(10).fill('bob'));
    expect(reviewed.slice(10, 30)).toEqual(Array(20).fill('zed'));
  });

  it('split recolors only the second piece (anchor end offset = split point)', () => {
    // Sentence 2 occupies chapter chars [10,20), text 'abcdefghij' (10 chars).
    // anchor 'abcde' -> unique match, end offset 5 -> split at chapter char 15.
    // pieceCharacterIds[0] === original speaker 'alice' (piece0 recolors to itself,
    // so only the second piece visibly changes), pieceCharacterIds[1] = 'carol'.
    const finalByChar: Array<string | null> = [
      ...Array(10).fill('zed'), // [0,10)
      ...Array(10).fill('alice'), // [10,20) — sentence 2
      ...Array(10).fill('zed'), // [20,30)
    ];
    const finalSentences: FinalSentence[] = [{ id: 2, text: 'abcdefghij', characterId: 'alice' }];
    const finalSpans: FinalSpan[] = [{ id: 2, start: 10, end: 20 }];
    const ops: ScriptReviewOp[] = [
      makeOp({ id: 2, op: 'split', anchor: 'abcde', pieceCharacterIds: ['alice', 'carol'] }),
    ];

    const reviewed = applyOpsToCharArray(finalByChar, finalSentences, finalSpans, ops);

    expect(reviewed.slice(0, 10)).toEqual(Array(10).fill('zed')); // untouched
    expect(reviewed.slice(10, 15)).toEqual(Array(5).fill('alice')); // piece0 [10,15)
    expect(reviewed.slice(15, 20)).toEqual(Array(5).fill('carol')); // piece1 [15,20)
    expect(reviewed.slice(20, 30)).toEqual(Array(10).fill('zed')); // untouched
  });

  it('extract_dialogue recolors only the middle sub-span', () => {
    // Sentence 3 occupies chapter chars [20,30), text '0123456789' (10 chars).
    // anchor '012' -> end offset 3; anchorEnd '0123456' -> end offset 7.
    // Middle sentence-local [3,7) -> chapter [23,27) recolors to pieceCharacterIds[1];
    // flanks [20,23) and [27,30) keep the sentence's original speaker 'alice'.
    const finalByChar: Array<string | null> = [
      ...Array(20).fill('zed'), // [0,20)
      ...Array(10).fill('alice'), // [20,30) — sentence 3
    ];
    const finalSentences: FinalSentence[] = [{ id: 3, text: '0123456789', characterId: 'alice' }];
    const finalSpans: FinalSpan[] = [{ id: 3, start: 20, end: 30 }];
    const ops: ScriptReviewOp[] = [
      makeOp({
        id: 3,
        op: 'extract_dialogue',
        anchor: '012',
        anchorEnd: '0123456',
        pieceCharacterIds: ['alice', 'dave'],
      }),
    ];

    const reviewed = applyOpsToCharArray(finalByChar, finalSentences, finalSpans, ops);

    expect(reviewed.slice(0, 20)).toEqual(Array(20).fill('zed')); // untouched
    expect(reviewed.slice(20, 23)).toEqual(Array(3).fill('alice')); // left flank
    expect(reviewed.slice(23, 27)).toEqual(Array(4).fill('dave')); // extracted middle
    expect(reviewed.slice(27, 30)).toEqual(Array(3).fill('alice')); // right flank
  });

  it('same-speaker split (no pieceCharacterIds) is a no-op', () => {
    const finalByChar: Array<string | null> = [...Array(10).fill('alice'), ...Array(10).fill('zed')];
    const finalSentences: FinalSentence[] = [{ id: 4, text: 'abcdefghij', characterId: 'alice' }];
    const finalSpans: FinalSpan[] = [{ id: 4, start: 0, end: 10 }];
    const ops: ScriptReviewOp[] = [makeOp({ id: 4, op: 'split', anchor: 'abcde' })]; // no pieceCharacterIds

    const reviewed = applyOpsToCharArray(finalByChar, finalSentences, finalSpans, ops);

    expect(reviewed).toEqual(finalByChar);
  });

  it('an op whose anchor does not resolve is a no-op', () => {
    const finalByChar: Array<string | null> = [...Array(10).fill('alice'), ...Array(10).fill('zed')];
    const finalSentences: FinalSentence[] = [{ id: 5, text: 'abcdefghij', characterId: 'alice' }];
    const finalSpans: FinalSpan[] = [{ id: 5, start: 0, end: 10 }];
    // 'xyz' is absent from the sentence text -> resolveAnchorOffset returns null.
    const ops: ScriptReviewOp[] = [
      makeOp({ id: 5, op: 'split', anchor: 'xyz', pieceCharacterIds: ['alice', 'carol'] }),
    ];

    const reviewed = applyOpsToCharArray(finalByChar, finalSentences, finalSpans, ops);

    expect(reviewed).toEqual(finalByChar);
  });

  it('returns a distinct copy — the input finalByChar is never mutated', () => {
    const finalByChar: Array<string | null> = [...Array(10).fill('alice'), ...Array(20).fill('zed')];
    const original = finalByChar.slice();
    const finalSentences: FinalSentence[] = [{ id: 1, text: 'irrelevant', characterId: 'alice' }];
    const finalSpans: FinalSpan[] = [{ id: 1, start: 0, end: 10 }];
    const ops: ScriptReviewOp[] = [makeOp({ id: 1, op: 'reattribute', characterId: 'bob' })];

    const reviewed = applyOpsToCharArray(finalByChar, finalSentences, finalSpans, ops);

    expect(reviewed).not.toBe(finalByChar);
    expect(finalByChar).toEqual(original); // input untouched
    expect(reviewed[0]).toBe('bob'); // the copy DID change
  });
});
