import { describe, it, expect, vi } from 'vitest';
import { applyProposedReattributions, consolidateProposedByName } from './apply-proposed';
import type { ReviewOpWithChapter } from '../store/script-review-slice';

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
    onOpApplied: () => {},
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

describe('consolidateProposedByName', () => {
  const rop = (chapterId: number, id: number, name: string): ReviewOpWithChapter =>
    ({ chapterId, id, op: 'reattribute', rationale: 'x', proposed: { name } }) as ReviewOpWithChapter;

  it('groups off-roster proposals by normalized name and keeps every line', () => {
    const { newGroups, rosterMatchedOps } = consolidateProposedByName(
      [rop(3, 1, 'Guard'), rop(3, 2, ' guard '), rop(12, 8, 'Guard'), rop(4, 5, 'Cook')],
      new Set(), // empty roster → all new
    );
    expect(rosterMatchedOps).toEqual([]);
    expect(newGroups.map((g) => g.name.toLowerCase()).sort()).toEqual(['cook', 'guard']);
    const guard = newGroups.find((g) => g.name.trim().toLowerCase() === 'guard')!;
    expect(guard.ops).toHaveLength(3); // both spellings + ch12, one group
    expect(guard.proposed.name).toBe('Guard'); // first-seen display form
  });

  it('routes names already in the roster to rosterMatchedOps (no form)', () => {
    const { newGroups, rosterMatchedOps } = consolidateProposedByName(
      [rop(3, 1, 'Guard'), rop(4, 5, 'Cook')],
      new Set(['guard']), // Guard already exists
    );
    expect(rosterMatchedOps.map((o) => o.id)).toEqual([1]);
    expect(newGroups.map((g) => g.name)).toEqual(['Cook']);
  });
});

describe('onOpApplied', () => {
  it('fires for a newly-created character', async () => {
    const onOpApplied = vi.fn();
    const op = { id: 1, chapterId: 3, op: 'reattribute', proposed: { name: 'Nova' }, rationale: 'r' } as never;
    await applyProposedReattributions([op], {
      rosterByName: new Map(),
      createCharacter: async (p) => ({ id: 'c-new', name: p.name }),
      addCharacter: vi.fn(),
      setSentenceCharacter: vi.fn(),
      onBoundaryMove: vi.fn(),
      isSameBook: () => true,
      onOpApplied,
    });
    expect(onOpApplied).toHaveBeenCalledWith(op);
  });

  it('fires for a deduped op that reuses an existing roster id and never calls createCharacter', async () => {
    const onOpApplied = vi.fn();
    const createCharacter = vi.fn();
    const op = { id: 2, chapterId: 3, op: 'reattribute', proposed: { name: 'Existing' }, rationale: 'r' } as never;
    await applyProposedReattributions([op], {
      rosterByName: new Map([['existing', { id: 'c-existing' }]]),
      createCharacter,
      addCharacter: vi.fn(),
      setSentenceCharacter: vi.fn(),
      onBoundaryMove: vi.fn(),
      isSameBook: () => true,
      onOpApplied,
    });
    expect(createCharacter).not.toHaveBeenCalled();
    expect(onOpApplied).toHaveBeenCalledWith(op);
  });

  it('does not fire for ops after a create failure aborts the batch', async () => {
    const onOpApplied = vi.fn();
    const ops = [
      { id: 1, chapterId: 3, op: 'reattribute', proposed: { name: 'Nova' }, rationale: 'r' },
      { id: 2, chapterId: 3, op: 'reattribute', proposed: { name: 'Sol' }, rationale: 'r' },
    ] as never[];
    await expect(
      applyProposedReattributions(ops, {
        rosterByName: new Map(),
        createCharacter: vi.fn().mockRejectedValue(new Error('network')),
        addCharacter: vi.fn(),
        setSentenceCharacter: vi.fn(),
        onBoundaryMove: vi.fn(),
        isSameBook: () => true,
        onOpApplied,
      }),
    ).rejects.toThrow('network');
    expect(onOpApplied).not.toHaveBeenCalled();
  });
});
