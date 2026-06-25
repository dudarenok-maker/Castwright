import { describe, it, expect, vi } from 'vitest';
import { applyProposedReattributions } from './apply-proposed';

function deps(over = {}) {
  const dispatched: any[] = [];
  return {
    spy: dispatched,
    rosterByName: new Map(),
    createCharacter: vi.fn(async (p: any) => ({ id: p.name.toLowerCase(), name: p.name })),
    addCharacter: (c: any) => dispatched.push(['add', c.id]),
    setSentenceCharacter: (_chapterId: number, id: number, cid: string) => dispatched.push(['reassign', id, cid]),
    onBoundaryMove: () => {},
    isSameBook: () => true,
    ...over,
  };
}

describe('fs-58 Unit B — applyProposedReattributions', () => {
  it('creates then reassigns each proposed op (interleaved)', async () => {
    const d = deps();
    const r = await applyProposedReattributions(
      [{ chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } }] as any, d);
    expect(d.createCharacter).toHaveBeenCalledTimes(1);
    expect(d.spy).toEqual([['add', 'ferra'], ['reassign', 5, 'ferra']]);
    expect(r).toEqual({ created: 1, aborted: false });
  });

  it('dedupes the same proposed name to ONE create within a batch', async () => {
    const d = deps();
    await applyProposedReattributions([
      { chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } },
      { chapterId: 1, id: 7, op: 'reattribute', proposed: { name: 'ferra ' } },
    ] as any, d);
    expect(d.createCharacter).toHaveBeenCalledTimes(1);
    expect(d.spy.filter((x) => x[0] === 'reassign')).toHaveLength(2); // both lines reassigned to the one id
  });

  it('a name matching an existing roster member does NOT create', async () => {
    const d = deps({ rosterByName: new Map([['ferra', { id: 'ferra' }]]) });
    await applyProposedReattributions([{ chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } }] as any, d);
    expect(d.createCharacter).not.toHaveBeenCalled();
    expect(d.spy).toEqual([['reassign', 5, 'ferra']]);
  });

  it('aborts remaining ops when the book changed mid-await', async () => {
    let book = 'b1';
    const d = deps({ isSameBook: () => book === 'b1', createCharacter: vi.fn(async (p: any) => { book = 'b2'; return { id: p.name.toLowerCase(), name: p.name }; }) });
    const r = await applyProposedReattributions([
      { chapterId: 1, id: 5, op: 'reattribute', proposed: { name: 'Ferra' } },
      { chapterId: 1, id: 7, op: 'reattribute', proposed: { name: 'Gus' } },
    ] as any, d);
    expect(r.aborted).toBe(true);
    expect(d.createCharacter).toHaveBeenCalledTimes(1); // stopped before the second
  });
});
