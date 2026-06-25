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
    expect(r).toEqual({ created: 1, createdCharacters: [{ id: 'ferra', name: 'Ferra' }], aborted: false });
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

  it('returns createdCharacters with {id,name} for each minted member (dedup within batch)', async () => {
    const d = deps();
    const r = await applyProposedReattributions([
      { chapterId: 1, id: 10, op: 'reattribute', proposed: { name: 'Mara' } },
      { chapterId: 1, id: 11, op: 'reattribute', proposed: { name: 'mara ' } }, // dup name → one create
      { chapterId: 2, id: 12, op: 'reattribute', proposed: { name: 'Tom' } },
    ] as any, d);
    expect(r.created).toBe(2);
    expect(r.createdCharacters).toEqual([
      { id: 'mara', name: 'Mara' },
      { id: 'tom', name: 'Tom' },
    ]);
    expect(r.aborted).toBe(false);
  });

  it('returns empty createdCharacters when every op dedupes to an existing roster member', async () => {
    const d = deps({ rosterByName: new Map([['hart', { id: 'hart-1' }]]) });
    const r = await applyProposedReattributions(
      [{ chapterId: 1, id: 10, op: 'reattribute', proposed: { name: 'Hart' } }] as any, d);
    expect(r.createdCharacters).toEqual([]);
  });

  it('carries partial createdCharacters when the batch aborts on a book switch', async () => {
    // isSameBook is checked once right after each create: true for Mara (recorded),
    // false for Tom (abort BEFORE Tom is recorded).
    const isSameBook = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const d = deps({ isSameBook });
    const r = await applyProposedReattributions([
      { chapterId: 1, id: 10, op: 'reattribute', proposed: { name: 'Mara' } },
      { chapterId: 2, id: 12, op: 'reattribute', proposed: { name: 'Tom' } },
    ] as any, d);
    expect(r.aborted).toBe(true);
    expect(r.createdCharacters).toEqual([{ id: 'mara', name: 'Mara' }]);
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
