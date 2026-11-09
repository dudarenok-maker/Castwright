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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const landed: string[][] = [];
let writeNo = 0;
let verifyDelays: number[] = [];
let verifyNo = 0;
let verifiedDir = '/book';

vi.mock('./book-dir-guard.js', () => ({
  withVerifiedBookDir: async (
    _opts: unknown,
    fn: (bookDir: string) => Promise<void>,
  ): Promise<void> => {
    const delay = verifyDelays[verifyNo++] ?? 0;
    await new Promise((r) => setTimeout(r, delay));
    await fn(verifiedDir);
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
  verifiedDir = '/book';
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

  it('with no transient read every roll writes the latest snapshot (identical snapshots; order is pinned by the next test)', async () => {
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

describe('rollManuscriptEdits book lock (#3784)', () => {
  it('waits for the held book lock, so a slice PUT cannot land between its check and its write', async () => {
    const { withBookLock } = await import('./book-lock.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const holder = withBookLock('book-3784', async () => {
      held();
      await gate;
    });
    await holding;

    const roll = rollManuscriptEdits(opts, () => ['A'], 'book-3784');
    try {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
      expect(landed).toEqual([]);
    } finally {
      release();
      await holder;
      await roll;
    }
    expect(landed).toEqual([['A']]);
  });
});

describe('rollManuscriptEdits re-reads under the book lock (#4031)', () => {
  type S = { chapterId: number; characterId: string };
  const seedEdits = (sentences: S[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'edits-roll-'));
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(join(dir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
    return dir;
  };
  const s = (chapterId: number, characterId: string): S => ({ chapterId, characterId });
  const toOlga = (ss: S[]): S[] => ss.map((x) => (x.characterId === 'the-jogger' ? { ...x, characterId: 'olga' } : x));

  it('a roll keeps chapters it did not produce', async () => {
    /* A merge remapped chapter 1 on disk after the job last produced it. */
    verifiedDir = seedEdits([s(1, 'olga'), s(2, 'olga')]);
    await rollManuscriptEdits(opts, () => [s(3, 'the-jogger')], 'book-4031-a', toOlga);
    expect(landed).toEqual([[s(1, 'olga'), s(2, 'olga'), s(3, 'olga')]]);
  });

  it('a roll replaces a chapter it produced, in place', async () => {
    verifiedDir = seedEdits([s(1, 'olga'), s(2, 'old'), s(3, 'olga')]);
    await rollManuscriptEdits(opts, () => [s(2, 'the-jogger')], 'book-4031-b', toOlga);
    expect(landed).toEqual([[s(1, 'olga'), s(2, 'olga'), s(3, 'olga')]]);
  });

  it('with no file yet a roll writes just its own chapters', async () => {
    verifiedDir = mkdtempSync(join(tmpdir(), 'edits-roll-'));
    await rollManuscriptEdits(opts, () => [s(1, 'the-jogger')], 'book-4031-c', toOlga);
    expect(landed).toEqual([[s(1, 'olga')]]);
  });

  it('an unreadable file fails the roll instead of being written over as empty', async () => {
    verifiedDir = mkdtempSync(join(tmpdir(), 'edits-roll-'));
    mkdirSync(join(verifiedDir, '.audiobook'), { recursive: true });
    writeFileSync(join(verifiedDir, '.audiobook', 'manuscript-edits.json'), '{ not json');
    await expect(
      rollManuscriptEdits(opts, () => [s(1, 'the-jogger')], 'book-4031-d', toOlga),
    ).rejects.toThrow();
    expect(landed).toEqual([]);
  });

  it('a fallback chapter is written only where the file has none', async () => {
    verifiedDir = seedEdits([s(1, 'olga')]);
    await rollManuscriptEdits(opts, () => [s(3, 'x')], 'book-4031-f', toOlga, () => [s(1, 'the-jogger'), s(2, 'the-jogger')]);
    expect(landed).toEqual([[s(1, 'olga'), s(2, 'olga'), s(3, 'x')]]);
  });

  it('without resolveIds a roll still writes its snapshot wholesale (the subset job)', async () => {
    verifiedDir = seedEdits([s(1, 'olga'), s(9, 'olga')]);
    await rollManuscriptEdits(opts, () => [s(1, 'x'), s(2, 'x')], 'book-4031-e');
    expect(landed).toEqual([[s(1, 'x'), s(2, 'x')]]);
  });
});
