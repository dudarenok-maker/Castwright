/* Regression test (#3427, review pass 2): the interim manuscript-edits.json
   roll must take its snapshot and its queue position in ONE synchronous step.
   `withVerifiedBookDir` awaits a state.json read first (which sleeps and retries
   on a transient failure), so a roll that joins the write queue from inside the
   callback while its snapshot was built before the await lands in verify-
   completion order, not snapshot order: chapter A's {A} snapshot could land
   after chapter B's {A,B}.

   Drives the production `rollManuscriptEdits` with the reviewer's probe:
   chapter A's verification is slow (the transient read), chapter B's is
   immediate. The write itself is stubbed so the FIRST write to land is slower
   than the later ones — an un-ordered (plain writeJsonAtomic) roll lands its
   earlier call last. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const landed: string[][] = [];
let writeNo = 0;
let verifyDelays: number[] = [];
let verifyNo = 0;

vi.mock('./book-dir-guard.js', () => ({
  withVerifiedBookDir: async (
    _opts: unknown,
    fn: (bookDir: string) => Promise<void>,
  ): Promise<void> => {
    const delay = verifyDelays[verifyNo++] ?? 0;
    await new Promise((r) => setTimeout(r, delay));
    await fn('/book');
  },
}));

vi.mock('./state-io.js', async () => {
  const actual = await vi.importActual<typeof import('./state-io.js')>('./state-io.js');
  return {
    ...actual,
    writeJsonAtomic: async (_path: string, data: { sentences: string[] }): Promise<void> => {
      const n = writeNo++;
      await new Promise((r) => setTimeout(r, n === 0 ? 30 : 1));
      landed.push(data.sentences);
    },
  };
});

const { rollManuscriptEdits } = await import('./edits-roll.js');

afterEach(() => {
  landed.length = 0;
  writeNo = 0;
  verifyNo = 0;
  verifyDelays = [];
});

const opts = { manuscriptId: 'm', candidateBookDir: '/book', mode: 'drop' as const };

describe('rollManuscriptEdits ordering (#3427)', () => {
  it('a slow verification on the first roll does not let its older snapshot land last', async () => {
    const done: string[] = [];
    verifyDelays = [40, 0]; // chapter A: transient state.json read; chapter B: immediate
    const rolls: Array<Promise<void>> = [];
    done.push('A');
    rolls.push(rollManuscriptEdits(opts, () => [...done]));
    await new Promise((r) => setTimeout(r, 5));
    done.push('B');
    rolls.push(rollManuscriptEdits(opts, () => [...done]));
    await Promise.all(rolls);
    expect(landed[landed.length - 1]).toEqual(['A', 'B']);
  });

  it('with no transient read the rolls land in call order', async () => {
    const done: string[] = [];
    const rolls: Array<Promise<void>> = [];
    for (const ch of ['A', 'B', 'C']) {
      done.push(ch);
      rolls.push(rollManuscriptEdits(opts, () => [...done]));
    }
    await Promise.all(rolls);
    expect(landed.map((l) => l.join(''))).toEqual(['ABC', 'ABC', 'ABC']);
  });

  it('overlapping rolls with distinct snapshots land in call order (a plain write would land the first last)', async () => {
    let k = 0;
    const rolls = [1, 2, 3].map(() => rollManuscriptEdits(opts, () => [String(++k)]));
    await Promise.all(rolls);
    expect(landed).toEqual([['1'], ['2'], ['3']]);
  });
});
