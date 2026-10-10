import { describe, it, expect } from 'vitest';
import { revisionsSlice, revisionsActions as a, compareFileIds, selectActivePending, type RevisionsState } from './revisions-slice';

type Act = Parameters<typeof revisionsSlice.reducer>[1];
const reduce = (s: RevisionsState, ...acts: Act[]) => acts.reduce(revisionsSlice.reducer, s);
const init = () => revisionsSlice.reducer(undefined, { type: '@@init' });
const st = (o: Partial<{ bookId: string; fileId: string | null; rev: number; ids: string[] }>) => ({
  bookId: o.bookId ?? 'A', fileId: o.fileId ?? null, rev: o.rev ?? 0,
  pending: (o.ids ?? []).map((id) => ({ id, chapterId: 1, characterId: 'c', segments: [] })),
  dismissed: [] as string[], acceptedSelections: {}, timeline: {},
});
const F1 = '000000000000001-aa', F2 = '000000000000002-aa', F2b = '000000000000002-bb';

describe('compareFileIds', () => {
  it('null is older than any id; ids order by epoch; a same-ms tie breaks on the suffix', () => {
    expect(compareFileIds(null, F1)).toBeLessThan(0);
    expect(compareFileIds(F1, null)).toBeGreaterThan(0);
    expect(compareFileIds(F1, F2)).toBeLessThan(0);
    expect(compareFileIds(F2, F2b)).toBeLessThan(0);
    expect(compareFileIds(F2b, F2)).toBeGreaterThan(0);
    expect(compareFileIds(null, null)).toBe(0);
  });
});

describe('applyServerState — ordered adopt', () => {
  it('adopts a different book', () => {
    const s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F2, rev: 5, ids: ['a'] })), a.applyServerState(st({ bookId: 'B', fileId: F1, rev: 1, ids: ['b'] })));
    expect(s.bookId).toBe('B'); expect(s.pending.map((p) => p.id)).toEqual(['b']);
  });
  it('ignores a lower rev within one fileId; adopts an equal or higher rev', () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['x'] })));
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 2, ids: [] })));
    expect(s.pending.map((p) => p.id)).toEqual(['x']);
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 3, ids: ['y'] })));
    expect(s.pending.map((p) => p.id)).toEqual(['y']);
  });
  it("null → id adopts (a legacy book's first op), and a newer fileId adopts even at a lower rev", () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: null, rev: 0, ids: ['legacy'] })));
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1, ids: [] })));
    expect(s.fileId).toBe(F1);
    s = reduce(s, a.applyServerState(st({ fileId: F2, rev: 0, ids: ['reset'] })));
    expect(s.fileId).toBe(F2); expect(s.rev).toBe(0); expect(s.pending.map((p) => p.id)).toEqual(['reset']);
  });
  it('ignores an older fileId (a late pre-reset response) and a null fileId over a non-null cache', () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: F2, rev: 0, ids: [] })));
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 9, ids: ['stale'] })));
    s = reduce(s, a.applyServerState(st({ fileId: null, rev: 9, ids: ['legacy'] })));
    expect(s.fileId).toBe(F2); expect(s.pending).toEqual([]);
  });
  it('a changing adoption increments adoptSeq; an ignored or equal-version payload does not', () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 1 })));
    expect(s.adoptSeq).toBe(1);
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 0 })));
    expect(s.adoptSeq).toBe(1);
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1 })));
    expect(s.adoptSeq).toBe(1);
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 2 })));
    expect(s.adoptSeq).toBe(2);
  });
});

describe('hydrate', () => {
  it('adopts a different fileId even when it is null (delete + re-import under the same id)', () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: F2, rev: 4, ids: ['old'] })));
    s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0 }), requestSeq: s.adoptSeq }));
    expect(s.fileId).toBeNull(); expect(s.pending).toEqual([]);
  });
  it('with the same fileId, a stale hydrate does not drop a newer entry', () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['new'] })));
    s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: F1, rev: 2 }), requestSeq: s.adoptSeq }));
    expect(s.pending.map((p) => p.id)).toEqual(['new']);
  });
  it('a null state for a new book adopts an empty cache and flips loaded', () => {
    const s = reduce(init(), a.hydrate({ bookId: 'A', state: null }));
    expect(s).toMatchObject({ bookId: 'A', fileId: null, rev: 0, pending: [], loaded: true });
  });
  it('sequence guard — a legacy-book read that started before the first op is dropped when it lands after it', () => {
    // book open: legacy file, nothing written yet
    let s = reduce(init(), a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0 }), requestSeq: 0 }));
    // a reopen read starts now…
    const requestSeq = s.adoptSeq;
    // …the user's first op lands: the server minted F1 and recorded an entry
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 1, ids: ['recorded'] })));
    // …then the stale null-fileId snapshot from before the op arrives
    s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0 }), requestSeq }));
    expect(s.fileId).toBe(F1);
    expect(s.pending.map((p) => p.id)).toEqual(['recorded']);
  });
  it('sequence guard — an equal-rev poll landing while a hydrate is in flight does not drop that hydrate', () => {
    // cache at F1 rev 3; a reopen read starts…
    let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['old'] })));
    const requestSeq = s.adoptSeq;
    // …a routine poll at the same version lands first (a no-op adoption)…
    s = reduce(s, a.applyServerState(st({ fileId: F1, rev: 3, ids: ['old'] })));
    // …then the hydrate lands carrying a re-imported file (fileId:null): it must still adopt
    s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0, ids: [] }), requestSeq }));
    expect(s.fileId).toBeNull();
    expect(s.pending).toEqual([]);
  });
  it('sequence guard — the other order: a hydrate that lands first, then an equal-rev poll, leaves the hydrated state and adoptSeq alone', () => {
    let s = reduce(init(), a.applyServerState(st({ fileId: F1, rev: 3, ids: ['old'] })));
    s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: F2, rev: 0, ids: ['fresh'] }), requestSeq: s.adoptSeq }));
    const seqAfterHydrate = s.adoptSeq;
    s = reduce(s, a.applyServerState(st({ fileId: F2, rev: 0, ids: ['fresh'] })));
    expect(s.adoptSeq).toBe(seqAfterHydrate);
    expect(s).toMatchObject({ fileId: F2, rev: 0 });
    expect(s.pending.map((p) => p.id)).toEqual(['fresh']);
    // …so a second hydrate whose read started right after the first landed is not dropped either
    s = reduce(s, a.hydrate({ bookId: 'A', state: st({ fileId: null, rev: 0, ids: [] }), requestSeq: seqAfterHydrate }));
    expect(s.fileId).toBeNull();
  });
  it('sequence guard does not apply across books', () => {
    let s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 1, ids: ['a'] })));
    s = reduce(s, a.hydrate({ bookId: 'B', state: st({ bookId: 'B', fileId: null, rev: 0, ids: ['b'] }), requestSeq: 0 }));
    expect(s.bookId).toBe('B'); expect(s.pending.map((p) => p.id)).toEqual(['b']);
  });
});

describe('applyDismiss', () => {
  it('removes the event; a foreign book (no state) leaves rev and dismissed alone', () => {
    let s = reduce(init(), a.applyServerState({ ...st({ fileId: F1, rev: 2 }), dismissed: ['k'] }));
    s = { ...s, drift: [{ id: 'd-foreign', bookId: 'B' } as never, { id: 'd-own', bookId: 'A' } as never] };
    s = reduce(s, a.applyDismiss({ driftId: 'd-foreign' }));
    expect(s.drift.map((d) => d.id)).toEqual(['d-own']);
    expect(s.rev).toBe(2); expect(s.dismissed).toEqual(['k']);
    s = reduce(s, a.applyDismiss({ driftId: 'd-own', state: { ...st({ fileId: F1, rev: 3 }), dismissed: ['k', 'd-own'] } }));
    expect(s.drift).toEqual([]); expect(s.dismissed).toEqual(['k', 'd-own']); expect(s.rev).toBe(3);
  });
});

describe('applyPoll — drift follows the ordered rule (#3400)', () => {
  const ev = { id: 'd1', bookId: 'A' } as never;
  const poll = (rev: number, drift: unknown[]) => a.applyPoll({ ...st({ fileId: F1, rev }), drift } as never);
  it('a stale poll does not resurrect a dismissed drift event; a newer poll adopts drift', () => {
    let s = reduce(init(), poll(5, [ev]));
    expect(s.drift.map((d) => d.id)).toEqual(['d1']);
    s = reduce(s, a.applyDismiss({ driftId: 'd1', state: { ...st({ fileId: F1, rev: 6 }), dismissed: ['d1'] } }));
    expect(s.drift).toEqual([]);
    s = reduce(s, poll(5, [ev]));
    expect(s.drift).toEqual([]);
    s = reduce(s, poll(7, [ev]));
    expect(s.drift.map((d) => d.id)).toEqual(['d1']);
  });
});

describe('forgetBook', () => {
  it('resets only when it holds that book', () => {
    let s = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 2, ids: ['x'] })));
    s = reduce(s, a.forgetBook('B'));
    expect(s.bookId).toBe('A');
    s = reduce(s, a.forgetBook('A'));
    expect(s).toMatchObject({ bookId: null, fileId: null, rev: 0, pending: [] });
  });
});

describe('selectors', () => {
  it('return empty for a non-active book or no active book', () => {
    const revisions = reduce(init(), a.applyServerState(st({ bookId: 'A', fileId: F1, rev: 1, ids: ['x'] })));
    expect(selectActivePending({ revisions, ui: { stage: { kind: 'ready', bookId: 'A' } } })).toHaveLength(1);
    expect(selectActivePending({ revisions, ui: { stage: { kind: 'ready', bookId: 'B' } } })).toEqual([]);
    expect(selectActivePending({ revisions, ui: { stage: { kind: 'books' } } })).toEqual([]);
  });
});

