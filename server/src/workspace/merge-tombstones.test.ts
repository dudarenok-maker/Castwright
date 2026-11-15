/* applyMergeTombstones — fold tombstoned sentences into their merge survivor (#4155). */

import { describe, it, expect } from 'vitest';
import { applyMergeTombstones } from './merge-tombstones.js';

interface S {
  chapterId: number;
  id: number;
  text: string;
  characterId: string;
  emotion?: string;
  instruct?: string;
  vocalization?: string;
}

const s = (chapterId: number, id: number, text: string, extra: Partial<S> = {}): S => ({
  chapterId,
  id,
  text,
  characterId: `c${chapterId}-${id}`,
  ...extra,
});
const brief = (xs: S[]) => xs.map((x) => [x.chapterId, x.id, x.text]);

describe('applyMergeTombstones', () => {
  const abc = () => [s(1, 1, 'A.'), s(1, 2, 'B.'), s(1, 3, 'C.')];

  it('T1 folds a tombstoned sentence into its predecessor', () => {
    expect(brief(applyMergeTombstones(abc(), ['1:2']))).toEqual([
      [1, 1, 'A. B.'],
      [1, 3, 'C.'],
    ]);
  });

  it('T2 folds a three-way merge', () => {
    expect(brief(applyMergeTombstones(abc(), ['1:2', '1:3']))).toEqual([[1, 1, 'A. B. C.']]);
  });

  it('T3 drops a promoted first sentence with no earlier kept sentence', () => {
    expect(brief(applyMergeTombstones(abc(), ['1:1']))).toEqual([
      [1, 2, 'B.'],
      [1, 3, 'C.'],
    ]);
  });

  it('T4 promote then merge', () => {
    const xs = [s(1, 1, 'T.'), s(1, 2, 'B.'), s(1, 3, 'C.')];
    expect(brief(applyMergeTombstones(xs, ['1:1', '1:3']))).toEqual([[1, 2, 'B. C.']]);
  });

  it('T5 is chapter-scoped and never crosses a chapter', () => {
    const xs = [s(1, 1, 'A.'), s(1, 2, 'B.'), s(2, 1, 'C.'), s(2, 2, 'D.')];
    expect(brief(applyMergeTombstones(xs, ['2:1']))).toEqual([
      [1, 1, 'A.'],
      [1, 2, 'B.'],
      [2, 2, 'D.'],
    ]);
    expect(brief(applyMergeTombstones(xs, ['2:2']))).toEqual([
      [1, 1, 'A.'],
      [1, 2, 'B.'],
      [2, 1, 'C. D.'],
    ]);
  });

  it('T6 survivor keeps its fields minus instruct/vocalization; removed fields vanish', () => {
    const xs = [
      s(1, 1, 'A.', { emotion: 'calm', instruct: 'slow', vocalization: 'sigh' }),
      s(1, 2, 'B.', { emotion: 'angry', instruct: 'fast' }),
    ];
    const [out] = applyMergeTombstones(xs, ['1:2']);
    expect(out.characterId).toBe('c1-1');
    expect(out.emotion).toBe('calm');
    expect(out).not.toHaveProperty('instruct');
    expect(out).not.toHaveProperty('vocalization');
    expect(JSON.stringify(out)).not.toContain('c1-2');
  });

  it('T7 is pure', () => {
    const xs = [s(1, 1, 'A.', { instruct: 'x' }), s(1, 2, 'B.'), s(1, 3, 'C.')];
    const before = structuredClone(xs);
    const out = applyMergeTombstones(xs, ['1:2']);
    expect(xs).toEqual(before);
    expect(out[0]).not.toBe(xs[0]);
    const copy = applyMergeTombstones(xs, []);
    expect(copy).toEqual(xs);
    expect(copy).not.toBe(xs);
  });

  it('T8 malformed keys change nothing', () => {
    const xs = abc();
    expect(applyMergeTombstones(xs, ['x', '1:', ':2'])).toEqual(xs);
  });
});
