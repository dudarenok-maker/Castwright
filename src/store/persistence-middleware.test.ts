// Pairs with docs/features/archive/27-book-state-persistence.md

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({ api: { putBookState } }));

import { persistenceMiddleware } from './persistence-middleware';

function makeStore(state: Record<string, unknown>) {
  return {
    getState: () => state,
    dispatch: vi.fn(),
  } as unknown as Parameters<typeof persistenceMiddleware>[0];
}

const baseState = (overrides: Record<string, unknown> = {}) => ({
  ui: { stage: { bookId: 'book-1' } },
  cast: { characters: [{ id: 'halloran' }] },
  manuscript: { sentences: [] },
  revisions: { pending: [], drift: [] },
  changeLog: { events: [] },
  bookMeta: { draft: null, saved: {} },
  ...overrides,
});

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  putBookState.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('persistenceMiddleware — gating', () => {
  it('skips persistence when stage has no bookId', async () => {
    const state = baseState({ ui: { stage: {} } });
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/setCharacters' });
    await advance(1000);
    expect(putBookState).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through unrelated action types without firing a PUT', async () => {
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(baseState()))(next)({ type: 'something/unrelated' });
    await advance(1000);
    expect(putBookState).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignores actions without a type property', async () => {
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(baseState()))(next)({} as { type?: string });
    await advance(1000);
    expect(putBookState).not.toHaveBeenCalled();
  });
});

describe('persistenceMiddleware — debounce', () => {
  it('PUTs once after 500ms for a curated action', async () => {
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(baseState()))(next);

    mw({ type: 'cast/setCharacters' });
    await advance(499);
    expect(putBookState).not.toHaveBeenCalled();

    await advance(1);
    expect(putBookState).toHaveBeenCalledOnce();
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'halloran' }] },
    });
  });

  it('honors a user-tuned autosave debounce from the settings slice (fe-2)', async () => {
    const next = vi.fn((x) => x);
    /* settings.autosaveDebounceMs = 2000 → the write must wait 2s, not 500ms. */
    const state = baseState({ settings: { autosaveDebounceMs: 2000 } });
    const mw = persistenceMiddleware(makeStore(state))(next);

    mw({ type: 'cast/setCharacters' });
    await advance(500);
    expect(putBookState).not.toHaveBeenCalled(); // would have fired at the old default

    await advance(1500);
    expect(putBookState).toHaveBeenCalledOnce();
  });

  it('coalesces multiple rapid actions within the debounce window into one PUT', async () => {
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(baseState()))(next);

    mw({ type: 'cast/setCharacters' });
    await advance(200);
    mw({ type: 'cast/updateCharacter' });
    await advance(200);
    mw({ type: 'cast/lockVoice' });
    await advance(500);

    expect(putBookState).toHaveBeenCalledOnce();
    expect(putBookState).toHaveBeenCalledWith('book-1', expect.objectContaining({ slice: 'cast' }));
  });

  it('debounces independently per slice', async () => {
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(baseState()))(next);

    mw({ type: 'cast/setCharacters' });
    mw({ type: 'manuscript/splitSentence' });
    mw({ type: 'revisions/acceptAllPending' });
    mw({ type: 'changeLog/appendLogEvent' });
    mw({ type: 'ui/confirmCast' });

    await advance(500);

    const slices = putBookState.mock.calls
      .map(([, body]) => (body as { slice: string }).slice)
      .sort();
    expect(slices).toEqual(['cast', 'changeLog', 'manuscript', 'revisions', 'state']);
  });
});

describe('persistenceMiddleware — payload shape', () => {
  it('sends the cast.characters patch for cast actions', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({ cast: { characters: [{ id: 'x' }, { id: 'y' }] } });
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/applyVoiceMatches' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'x' }, { id: 'y' }] },
    });
  });

  it('persists a manual continuity link (applyManualMatch) the same as auto-reuse', async () => {
    /* link-prior stamps matchedFrom/voiceId on the source character; without
       this persist the matchedFrom lived only in redux and reverted on
       reload, so the Reused badge + merge-picker suppression silently broke. */
    const next = vi.fn((x) => x);
    const state = baseState({ cast: { characters: [{ id: 'wren', matchedFrom: { bookId: 'b0' } }] } });
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/applyManualMatch' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'wren', matchedFrom: { bookId: 'b0' } }] },
    });
  });

  it('persists the full cast on applyAddAlias so the alias is the authoritative last write', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({ cast: { characters: [{ id: 'castor', aliases: ['Castor'] }] } });
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/applyAddAlias' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'castor', aliases: ['Castor'] }] },
    });
  });

  it('sends both pending + drift for revisions actions', async () => {
    const next = vi.fn((x) => x);
    /* Each drift event carries its own bookId so the persist filter can
       send only THIS book's drift to revisions.json (cross-book entries
       belong on their own books' files). */
    const state = baseState({
      revisions: { pending: [{ id: 'r1' }], drift: [{ id: 'd1', bookId: 'book-1' }] },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/dismissDrift' });
    await advance(500);
    /* Plan 55 — `timeline` rides along with every revisions persist so a
       reload reflects the per-chapter history. The test state omits it
       (undefined); Vitest's deepEqual treats undefined own-props as absent,
       so this assertion still pins the dismissed-drift case shape. */
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: { pending: [{ id: 'r1' }], drift: [{ id: 'd1', bookId: 'book-1' }] },
    });
  });

  it('drops other books\' drift events from the per-book persist patch', async () => {
    /* Cross-book invariant: the flat drift list spans concurrently-active
       books, but each book's revisions.json must only carry its own
       events. Otherwise re-hydration on Book A would replay Book B's
       drift into Book A's slot. */
    const next = vi.fn((x) => x);
    const state = baseState({
      revisions: {
        pending: [],
        drift: [
          { id: 'd-mine', bookId: 'book-1' },
          { id: 'd-other', bookId: 'book-2' },
        ],
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/dismissDrift' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: { pending: [], drift: [{ id: 'd-mine', bookId: 'book-1' }] },
    });
  });

  it('sends `timeline` alongside the revisions patch on every revisions action (plan 55)', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      revisions: {
        pending: [{ id: 'r1' }],
        drift: [],
        dismissed: [],
        acceptedSelections: {},
        timeline: { 3: [{ id: 'r0', chapterId: 3, eventKind: 'accepted' }] },
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/acceptRevision' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: {
        pending: [{ id: 'r1' }],
        drift: [],
        dismissed: [],
        acceptedSelections: {},
        timeline: { 3: [{ id: 'r0', chapterId: 3, eventKind: 'accepted' }] },
      },
    });
  });

  it('sends acceptedSelections alongside pending+drift+dismissed for revisions/acceptRevision', async () => {
    /* Per-item accept is the only path that records selection on the slice;
       its patch must carry acceptedSelections so the user's choices survive
       a reload. Reject's patch does NOT need acceptedSelections (no
       selection captured) — covered by the next test. */
    const next = vi.fn((x) => x);
    const state = baseState({
      revisions: {
        pending: [{ id: 'r1' }],
        drift: [{ id: 'd1', bookId: 'book-1' }],
        dismissed: ['d2'],
        acceptedSelections: { 'r-prev': { 4: 'B' } },
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/acceptRevision' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: {
        pending: [{ id: 'r1' }],
        drift: [{ id: 'd1', bookId: 'book-1' }],
        dismissed: ['d2'],
        acceptedSelections: { 'r-prev': { 4: 'B' } },
      },
    });
  });

  it('sends pending+drift+dismissed for revisions/enqueuePending (middleware-driven regen stub)', async () => {
    /* enqueuePending is fired by the generation-stream middleware when a
       regen kicks off. The patch must include `pending` so a mid-regen
       reload rehydrates the in-flight stub. */
    const next = vi.fn((x) => x);
    const state = baseState({
      revisions: {
        pending: [{ id: 'revision:1:halloran:42' }],
        drift: [],
        dismissed: [],
        acceptedSelections: {},
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/enqueuePending' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: {
        pending: [{ id: 'revision:1:halloran:42' }],
        drift: [],
        dismissed: [],
      },
    });
  });

  it('sends pending+drift+dismissed for revisions/markRevisionPlayable', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      revisions: {
        pending: [{ id: 'r1', playable: true }],
        drift: [],
        dismissed: [],
        acceptedSelections: {},
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/markRevisionPlayable' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: {
        pending: [{ id: 'r1', playable: true }],
        drift: [],
        dismissed: [],
      },
    });
  });

  it('sends pending+drift+dismissed (NO acceptedSelections) for revisions/rejectRevision', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      revisions: {
        pending: [{ id: 'r1' }],
        drift: [{ id: 'd1', bookId: 'book-1' }],
        dismissed: ['d2'],
        acceptedSelections: { 'r-prev': { 4: 'B' } },
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'revisions/rejectRevision' });
    await advance(500);
    /* Patch shape is the same shape the existing bulk reject sends — reject
       intentionally drops the selection, even though one might exist on the
       slice from a prior accept. */
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'revisions',
      patch: {
        pending: [{ id: 'r1' }],
        drift: [{ id: 'd1', bookId: 'book-1' }],
        dismissed: ['d2'],
      },
    });
  });

  it('fs-58 batch ordering: mergedAwayKeys survives a subsequent setSentenceText in the same debounce window', async () => {
    /* Regression guard for the Task-2b correctness gap: when an Apply batch
       dispatches mergeSentences then setSentenceText, the later action was the
       last writer of pending['manuscript'], so the flush sent only { sentences }
       and the tombstone was silently dropped — causing a re-analysis to
       resurrect the merged-away id on reload.
       Both actions must land the same tombstone in the final PUT patch. */
    const next = vi.fn((x) => x);
    const state = baseState({
      manuscript: {
        sentences: [{ id: 1, chapterId: 1, text: 'Corrected text.' }],
        mergedAwayKeys: ['1:2'],
      },
    });
    const mw = persistenceMiddleware(makeStore(state))(next);

    mw({ type: 'manuscript/mergeSentences' });
    mw({ type: 'manuscript/setSentenceText' });
    await advance(500);

    expect(putBookState).toHaveBeenCalledOnce();
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'manuscript',
      patch: expect.objectContaining({ mergedAwayKeys: ['1:2'] }),
    });
  });

  it('sends castConfirmed=true for ui/confirmCast (slice="state")', async () => {
    const next = vi.fn((x) => x);
    persistenceMiddleware(makeStore(baseState()))(next)({ type: 'ui/confirmCast' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'state',
      patch: { castConfirmed: true },
    });
  });

  it('sends the full editable metadata for bookMeta/commitDraft (slice="state")', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      bookMeta: {
        draft: null,
        saved: {
          'book-1': {
            title: 'Renamed',
            author: 'Marin Vale',
            series: 'NCT · Book 2',
            narratorCredit: 'Anders Vale',
            genre: 'Literary fiction',
            publicationDate: '2026-05-09',
          },
        },
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'bookMeta/commitDraft' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'state',
      patch: {
        title: 'Renamed',
        author: 'Marin Vale',
        series: 'NCT · Book 2',
        narratorCredit: 'Anders Vale',
        genre: 'Literary fiction',
        publicationDate: '2026-05-09',
      },
    });
  });

  it('fs-57 — sends { liveInstruct: true } for bookMeta/setLiveInstruct (slice="state")', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      bookMeta: { draft: null, saved: {}, liveInstruct: true },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'bookMeta/setLiveInstruct' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'state',
      patch: { liveInstruct: true },
    });
  });

  it('fs-57 — sends { liveInstruct: false } for bookMeta/setLiveInstruct when toggled off', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      bookMeta: { draft: null, saved: {}, liveInstruct: false },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'bookMeta/setLiveInstruct' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'state',
      patch: { liveInstruct: false },
    });
  });
});

describe('persistenceMiddleware — error handling', () => {
  it('logs but does not rethrow when api.putBookState rejects', async () => {
    putBookState.mockRejectedValueOnce(new Error('boom'));
    const next = vi.fn((x) => x);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    persistenceMiddleware(makeStore(baseState()))(next)({ type: 'cast/setCharacters' });
    await advance(500);
    // Let the rejected promise settle.
    await vi.runAllTimersAsync();

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
