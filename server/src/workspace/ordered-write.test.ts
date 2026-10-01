/* Regression test (#3427): overlapping writes to one path through
   writeJsonAtomicOrdered must land in CALL order. This is the shape of the
   Phase-1 pool's per-chapter `manuscript-edits.json` roll (K concurrent
   chapters, each writing a snapshot built at its own moment): without the
   per-path chain a slow earlier write lands last and drops the later chapter.

   Deterministic: the real write is stubbed so the FIRST call completes after
   the later one would. */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';

const landed: string[] = [];
let callNo = 0;

vi.mock('./state-io.js', async () => {
  const actual = await vi.importActual<typeof import('./state-io.js')>('./state-io.js');
  return {
    ...actual,
    writeJsonAtomic: async (path: string, data: { sentences?: string[] }): Promise<void> => {
      const n = callNo++;
      await new Promise((r) => setTimeout(r, n === 0 ? 40 : 1));
      await actual.writeJsonAtomic(path, data);
      landed.push((data.sentences ?? []).join(','));
    },
  };
});

const { writeJsonAtomicOrdered } = await import('./ordered-write.js');

let dir: string | undefined;
afterEach(async () => {
  landed.length = 0;
  callNo = 0;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('writeJsonAtomicOrdered (#3427)', () => {
  it('two overlapping interim edits rolls end with the last-called content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ordered-write-'));
    const editsPath = join(dir, 'manuscript-edits.json');
    /* Chapter A builds its roll first (A only); chapter B builds a roll that
       holds A+B. A's write is the slow one. */
    const a = writeJsonAtomicOrdered(editsPath, { sentences: ['A'] });
    const b = writeJsonAtomicOrdered(editsPath, { sentences: ['A', 'B'] });
    await Promise.all([a, b]);
    expect(landed).toEqual(['A', 'A,B']);
    expect(JSON.parse(await readFile(editsPath, 'utf8'))).toEqual({ sentences: ['A', 'B'] });
  });

  it('serialises the payload at call time, not when the queued write runs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ordered-write-'));
    const editsPath = join(dir, 'manuscript-edits.json');
    const rolled = ['A'];
    const first = writeJsonAtomicOrdered(editsPath, { sentences: ['blocker'] }); // slow stub
    const second = writeJsonAtomicOrdered(editsPath, { sentences: rolled });
    rolled.push('late'); // in-place mutation after the call
    await Promise.all([first, second]);
    expect(landed).toEqual(['blocker', 'A']);
  });
});
