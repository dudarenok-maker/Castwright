/* Regression test (#3427): overlapping saveAnalysisCache calls for one
   manuscript must land on disk in CALL order. The underlying writeJsonAtomic
   does not order same-path writes (and its EPERM retry jitters), so the
   earlier-called write could land last and clobber a newer snapshot.

   Deterministic: the real write is stubbed so the FIRST call completes after
   the later ones would — without per-manuscript serialisation the stale
   snapshot lands last. */

import { describe, it, expect, afterEach, vi } from 'vitest';

const landed: Array<{ path: string; stage1: unknown }> = [];
let callNo = 0;

vi.mock('../workspace/state-io.js', async () => {
  const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
    '../workspace/state-io.js',
  );
  return {
    ...actual,
    writeJsonAtomic: async (path: string, data: { stage1?: unknown }): Promise<void> => {
      const n = callNo++;
      /* Earlier-called writes take longer, so an unserialised implementation
         lands them last. */
      await new Promise((r) => setTimeout(r, n === 0 ? 40 : n === 1 ? 20 : 1));
      if (n === 3 && (data as { fail?: boolean }).fail) throw new Error('boom');
      landed.push({ path, stage1: data.stage1 });
    },
  };
});

const { saveAnalysisCache } = await import('./analysis-cache.js');

afterEach(() => {
  landed.length = 0;
  callNo = 0;
});

const snap = (tag: string) =>
  ({ chapters: {}, stage1: tag }) as unknown as Parameters<typeof saveAnalysisCache>[1];

describe('saveAnalysisCache call ordering (#3427)', () => {
  it('overlapping saves for one manuscript land in call order (last call wins)', async () => {
    await Promise.all([
      saveAnalysisCache('order-a', snap('first')),
      saveAnalysisCache('order-a', snap('second')),
      saveAnalysisCache('order-a', snap('third')),
    ]);
    expect(landed.map((l) => l.stage1)).toEqual(['first', 'second', 'third']);
  });

  it('a failed save does not wedge the chain for later saves', async () => {
    const p0 = saveAnalysisCache('order-b', snap('a'));
    const p1 = saveAnalysisCache('order-b', snap('b'));
    const p2 = saveAnalysisCache('order-b', snap('c'));
    const bad = saveAnalysisCache('order-b', { ...snap('d'), fail: true } as never);
    const badErr = bad.then(
      () => null,
      (e: Error) => e,
    );
    const after = saveAnalysisCache('order-b', snap('e'));
    await Promise.all([p0, p1, p2]);
    expect((await badErr)?.message).toBe('boom');
    await after;
    expect(landed.map((l) => l.stage1)).toEqual(['a', 'b', 'c', 'e']);
  });

  it('different manuscripts are not serialised against each other', async () => {
    const slow = saveAnalysisCache('order-c', snap('slow')); // 40ms stub
    const fast = saveAnalysisCache('order-d', snap('fast')); // 20ms stub
    await Promise.all([slow, fast]);
    expect(landed.map((l) => l.stage1)).toEqual(['fast', 'slow']);
  });
});
