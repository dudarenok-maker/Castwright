// Pairs with docs/features/archive/27-book-state-persistence.md

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({ api: { putBookState } }));

import {
  persistenceMiddleware,
  flushBookPersistence,
  dropRetainedSaves,
  beginFullRead,
  learnSliceRevisions,
  type BookFlushOutcome,
} from './persistence-middleware';
import { castSlice, castActions } from './cast-slice';
import { changeLogSlice } from './change-log-slice';
import { createBookStateDisk } from '../test/book-state-disk';
import type { Character, SliceRevision } from '../lib/types';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { notificationsSlice } from './notifications-slice';
import { bookMetaSlice, bookMetaActions, selectEffectiveMeta } from './book-meta-slice';

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
  changeLog: { events: [] },
  bookMeta: { draft: null, saved: {} },
  ...overrides,
});

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  /* mockReset (not mockClear): the #3421 retry tests install persistent
     rejections that must not leak into the next test. */
  putBookState.mockReset();
  putBookState.mockResolvedValue(undefined);
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
    mw({ type: 'changeLog/appendLogEvent' });
    mw({ type: 'ui/confirmCast' });

    await advance(500);

    const slices = putBookState.mock.calls
      .map(([, body]) => (body as { slice: string }).slice)
      .sort();
    expect(slices).toEqual(['cast', 'changeLog', 'manuscript', 'state']);
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

  it('persists the full cast on applyRepointAlias so the moved alias is the authoritative last write', async () => {
    const next = vi.fn((x) => x);
    const state = baseState({
      cast: { characters: [{ id: 'egor', aliases: [] }, { id: 'anton', aliases: ['Я'] }] },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'cast/applyRepointAlias' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'egor', aliases: [] }, { id: 'anton', aliases: ['Я'] }] },
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

  it('fs-58 Unit B — dispatching setSentenceExcluded triggers a manuscript PUT', async () => {
    /* B1 correctness guard: the exclude flag must survive reload.
       Without a PERSIST_RULES entry the flag would be silently lost on
       the next page refresh and the excluded sentence would get synthesised. */
    const next = vi.fn((x) => x);
    const state = baseState({
      manuscript: {
        sentences: [{ id: 1, chapterId: 1, text: 'p. 42', excludeFromSynthesis: true }],
        mergedAwayKeys: [],
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'manuscript/setSentenceExcluded' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'manuscript',
      patch: {
        sentences: [{ id: 1, chapterId: 1, text: 'p. 42', excludeFromSynthesis: true }],
        mergedAwayKeys: [],
      },
    });
  });

  it('2026-07-01 — dispatching promoteSentenceToTitle triggers a manuscript PUT with the tombstone', async () => {
    /* Without a PERSIST_RULES entry the promoted-away sentence would
       resurface on the next page load even though the chapter title
       already changed via the (separately-persisted) rename endpoint. */
    const next = vi.fn((x) => x);
    const state = baseState({
      manuscript: {
        sentences: [{ id: 2, chapterId: 3, text: 'You brought home a puppy.' }],
        mergedAwayKeys: ['3:1'],
      },
    });
    persistenceMiddleware(makeStore(state))(next)({ type: 'manuscript/promoteSentenceToTitle' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'manuscript',
      patch: {
        sentences: [{ id: 2, chapterId: 3, text: 'You brought home a puppy.' }],
        mergedAwayKeys: ['3:1'],
      },
    });
  });
});

describe('persistenceMiddleware — per-book debounce isolation (#3395 pass 4, S4)', () => {
  /* Repro 2 (cast): rename a character on book A → open book B within the
     debounce window (every full hydrate re-sends cast.json via
     cast/setCharacters) → before the fix, only B's cast PUT fired and A's
     rename was never saved. */
  it('does not drop book A\'s queued cast write when opening book B re-sends cast/setCharacters within the debounce window', async () => {
    const state: Record<string, unknown> = baseState({ cast: { characters: [{ id: 'bob', name: 'Bob (renamed)' }] } });
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(state))(next);

    // Book A: rename schedules A's debounced cast write.
    mw({ type: 'cast/renameCharacter' });

    // Within the debounce window, the user opens book B; the full hydrate
    // re-sends cast.json for B via cast/setCharacters.
    await advance(200);
    state.ui = { stage: { bookId: 'book-2' } };
    state.cast = { characters: [{ id: 'alice' }] };
    mw({ type: 'cast/setCharacters' });

    await advance(500);

    expect(putBookState).toHaveBeenCalledWith('book-1', {
      slice: 'cast',
      patch: { characters: [{ id: 'bob', name: 'Bob (renamed)' }] },
    });
    expect(putBookState).toHaveBeenCalledWith('book-2', {
      slice: 'cast',
      patch: { characters: [{ id: 'alice' }] },
    });
    // No cross-contamination: book-2's PUT must never carry book-1's rename.
    expect(putBookState).not.toHaveBeenCalledWith(
      'book-2',
      expect.objectContaining({ patch: expect.objectContaining({ characters: [{ id: 'bob', name: 'Bob (renamed)' }] }) }),
    );
  });
});

describe('persistenceMiddleware — leaving a book flushes, and a re-read can await, its writes (#3395 pass 4, S3)', () => {
  it('flushes the left book\'s queued write the moment scope moves away, not at the end of the debounce', async () => {
    const state: Record<string, unknown> = baseState();
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(state))(next);

    mw({ type: 'cast/setCharacters' });
    await advance(50);
    expect(putBookState).not.toHaveBeenCalled();

    /* goHome: the stage no longer names a book. */
    state.ui = { stage: {} };
    mw({ type: 'ui/goHome' });
    await advance(0);
    expect(putBookState).toHaveBeenCalledTimes(1);
    expect(putBookState).toHaveBeenCalledWith('book-1', expect.objectContaining({ slice: 'cast' }));

    /* The timer it replaced must not fire a second PUT later. */
    await advance(1000);
    expect(putBookState).toHaveBeenCalledTimes(1);
  });

  it('flushBookPersistence resolves only after that book\'s in-flight PUT settles, and returns null when nothing is pending', async () => {
    let resolvePut: () => void = () => {};
    putBookState.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePut = resolve;
        }),
    );
    const state: Record<string, unknown> = baseState();
    const next = vi.fn((x) => x);
    const mw = persistenceMiddleware(makeStore(state))(next);

    expect(mw(flushBookPersistence('book-1'))).toBeNull();

    mw({ type: 'cast/setCharacters' });
    /* A queued (not yet sent) write is sent now, and awaited. */
    const waited = mw(flushBookPersistence('book-1')) as unknown as Promise<void>;
    expect(putBookState).toHaveBeenCalledTimes(1);
    let settled = false;
    void waited.then(() => {
      settled = true;
    });
    await advance(10);
    expect(settled).toBe(false);

    resolvePut();
    await advance(0);
    expect(settled).toBe(true);
    expect(mw(flushBookPersistence('book-1'))).toBeNull();
  });

  it('flushBookPersistence never rejects when the PUT keeps failing: it resolves with the failed slice (#3421)', async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const state: Record<string, unknown> = baseState();
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    (store.dispatch as ReturnType<typeof vi.fn>).mockImplementation((a: { type: string }) => {
      if (a.type === 'notifications/pushToast') order.push('toast');
    });

    mw({ type: 'cast/setCharacters' });
    const waited = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    void waited.then(() => order.push('resolved'));
    expect(putBookState).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(putBookState).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(putBookState).toHaveBeenCalledTimes(3);
    await advance(4000);
    expect(putBookState).toHaveBeenCalledTimes(4);
    await advance(20000);
    expect(putBookState).toHaveBeenCalledTimes(4);

    await expect(waited).resolves.toEqual({ failedSlices: ['cast'] });
    const toast = (store.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((a) => a.type === 'notifications/pushToast');
    expect(toast.payload).toEqual(
      expect.objectContaining({ kind: 'error', dedupeKey: 'book-persist-failed:book-1' }),
    );
    expect(order).toEqual(['toast', 'resolved']);
    err.mockRestore();
  });

  it('re-sends a transient failure with the captured patch, and the flush waits for it (#3421)', async () => {
    putBookState.mockRejectedValueOnce(new Error('Book state PUT failed (503): down'));
    const state: Record<string, unknown> = baseState();
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    /* Leaving the book sends the write at once; then the roster changes. */
    state.ui = { stage: {} };
    mw({ type: 'ui/goHome' });
    state.cast = { characters: [{ id: 'someone-else' }] };
    await advance(0);
    expect(putBookState).toHaveBeenCalledTimes(1);

    const waited = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    let settled = false;
    void waited.then(() => {
      settled = true;
    });
    await advance(999);
    expect(settled).toBe(false);
    expect(putBookState).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(putBookState).toHaveBeenCalledTimes(2);
    expect(putBookState.mock.calls[1]).toEqual(putBookState.mock.calls[0]);
    expect(putBookState.mock.calls[1][1].patch).toEqual({ characters: [{ id: 'halloran' }] });
    await expect(waited).resolves.toEqual({ failedSlices: [] });
    expect(
      (store.dispatch as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[0]?.type === 'notifications/pushToast',
      ),
    ).toBe(false);
    err.mockRestore();
  });

  it('does not re-send a 4xx refusal (#3421)', async () => {
    putBookState.mockRejectedValueOnce(new Error('Book state PUT failed (409): refused'));
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const waited = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(0);
    await expect(waited).resolves.toEqual({ failedSlices: ['cast'] });
    await advance(20000);
    expect(putBookState).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('the given-up toast names the book by title even though another book is open by then (#3421 F3)', async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const state: Record<string, unknown> = baseState({
      bookMeta: { draft: null, saved: { 'book-1': { title: 'The Northern Star' } } },
    });
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    /* Leaving the book sends the write; the user opens another before it gives up. */
    state.ui = { stage: { bookId: 'book-2' } };
    mw({ type: 'ui/openBook' });
    await advance(20000);

    const toast = (store.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((a) => a.payload?.dedupeKey === 'book-persist-failed:book-1');
    expect(toast.payload.message).toContain('"The Northern Star"');
    err.mockRestore();
  });

  it('a 4xx refusal on a slice with no failure handler raises no generic save toast (#3421 F3)', async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (409): refused'));
    const state: Record<string, unknown> = baseState();
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const waited = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(20000);
    await expect(waited).resolves.toEqual({ failedSlices: ['cast'] });
    expect(
      (store.dispatch as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[0]?.payload?.dedupeKey === 'book-persist-failed:book-1',
      ),
    ).toBe(false);
    err.mockRestore();
  });

  it('a newer write made during a backoff rides the scheduled retry (#3421, OD-C1)', async () => {
    putBookState.mockRejectedValueOnce(new Error('Book state PUT failed (503): down'));
    const state: Record<string, unknown> = baseState();
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const waited = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(0);
    expect(putBookState).toHaveBeenCalledTimes(1);

    /* During the backoff, the user edits again. */
    state.cast = { characters: [{ id: 'newer' }] };
    mw({ type: 'cast/setCharacters' });
    await vi.runAllTimersAsync();
    await waited;

    const patches = putBookState.mock.calls.map((c) => c[1].patch);
    expect(patches).toEqual([{ characters: [{ id: 'halloran' }] }, { characters: [{ id: 'newer' }] }]);
    expect(
      (store.dispatch as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => c[0]?.payload?.dedupeKey === 'book-persist-failed:book-1',
      ),
    ).toBe(false);
    err.mockRestore();
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

/* #1676(c) — the two tests above use the lightweight fake-store harness
   (getState/dispatch mocks) that this file already defines; it can't be
   reused for the toast assertions below because pushToast needs to run
   through a REAL notifications reducer to land in state.notifications.toasts.
   makeReduxStore wires the actual manuscript/ui/notifications reducers plus
   the middleware under test, with a preloaded 'ready' ui.stage so
   bookIdFromState resolves a bookId (otherwise the middleware early-returns
   and every assertion below would pass vacuously). */
function makeReduxStore() {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
      cast: (s: unknown = { characters: [] }) => s,
      revisions: (s: unknown = {}) => s,
      changeLog: (s: unknown = { events: [] }) => s,
      bookMeta: (s: unknown = { saved: {} }) => s,
    } as never,
    preloadedState: {
      ui: { stage: { kind: 'ready', bookId: 'b1', view: 'cast', currentChapterId: 3, openProfileId: null } },
    } as never,
    middleware: (gDM) => gDM().concat(persistenceMiddleware),
  });
}

describe('detected-instruct persistence (#3435)', () => {
  it('the prosody second pass (applyDetectedInstruct) PUTs the instruction with no later edit', async () => {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        ui: uiSlice.reducer,
        notifications: notificationsSlice.reducer,
        cast: (s: unknown = { characters: [] }) => s,
        revisions: (s: unknown = {}) => s,
        changeLog: (s: unknown = { events: [] }) => s,
        bookMeta: (s: unknown = { saved: {} }) => s,
      } as never,
      preloadedState: {
        ui: { stage: { kind: 'ready', bookId: 'b1', view: 'cast', currentChapterId: 3, openProfileId: null } },
        manuscript: {
          sentences: [{ id: 1, chapterId: 3, text: 'Hello.', characterId: 'narrator' }],
          mergedAwayKeys: [],
        },
      } as never,
      middleware: (gDM) => gDM().concat(persistenceMiddleware),
    });
    store.dispatch(
      manuscriptActions.applyDetectedInstruct({
        chapterId: 3,
        annotations: [{ sentenceId: 1, instruct: 'whispering, urgent' }],
      }),
    );
    await vi.runAllTimersAsync();
    expect(putBookState).toHaveBeenCalledTimes(1);
    const [bookId, body] = putBookState.mock.calls[0] as [
      string,
      { slice: string; patch: { sentences: Array<{ instruct?: string }> } },
    ];
    expect(bookId).toBe('b1');
    expect(body.slice).toBe('manuscript');
    expect(body.patch.sentences[0].instruct).toBe('whispering, urgent');
  });
});

describe('bulk-reassign persistence', () => {
  it('flushes the full {sentences, mergedAwayKeys} patch for setSentencesCharacterBulk', async () => {
    const store = makeReduxStore();
    store.dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 1 }],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    await vi.runAllTimersAsync();
    expect(putBookState).toHaveBeenCalledWith(
      'b1',
      expect.objectContaining({
        slice: 'manuscript',
        patch: expect.objectContaining({ sentences: expect.any(Array), mergedAwayKeys: expect.any(Array) }),
      }),
    );
  });

  it('surfaces an error toast when a bulk apply PUT fails', async () => {
    putBookState.mockRejectedValue(new Error('net'));
    const store = makeReduxStore();
    store.dispatch(
      manuscriptActions.setSentencesCharacterBulk({
        keys: [{ chapterId: 1, sentenceId: 1 }],
        characterId: 'narrator',
        targetLabel: 'Narrator',
      }),
    );
    await vi.runAllTimersAsync();
    const toasts = (store.getState() as { notifications: { toasts: { kind: string }[] } }).notifications.toasts;
    expect(toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('surfaces an error toast when an undo PUT fails', async () => {
    putBookState.mockRejectedValue(new Error('net'));
    const store = makeReduxStore();
    store.dispatch(manuscriptActions.undoBulkReassign());
    await vi.runAllTimersAsync();
    const toasts = (store.getState() as { notifications: { toasts: { kind: string }[] } }).notifications.toasts;
    expect(toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('a non-bulk manuscript edit PUT failure raises the generic save toast, not the bulk one (scope)', async () => {
    putBookState.mockRejectedValue(new Error('net'));
    const store = makeReduxStore();
    store.dispatch(
      manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'x' }),
    );
    await vi.runAllTimersAsync();
    const toasts = (store.getState() as { notifications: { toasts: { kind: string; dedupeKey?: string }[] } })
      .notifications.toasts;
    expect(toasts.some((t) => t.dedupeKey === 'bulk-reassign-persist-failed')).toBe(false);
    expect(toasts.some((t) => t.dedupeKey === 'book-persist-failed:b1')).toBe(true);
  });
});
/* #2230 — a refused rename (409) from the Listen-view book-meta editor must
   surface the server's sentence AND roll back the optimistic saved update so
   the header stops showing a title the server rejected. Unlike makeReduxStore
   above (whose bookMeta is a no-op stub), this builder wires the REAL bookMeta
   reducer so setDraftField → commitDraft → rollbackCommitDraft actually mutate
   state. */
function makeBookMetaStore() {
  const meta = {
    title: 'The Northern Star',
    author: 'Marin Vale',
    series: '',
    narratorCredit: 'Anders Vale',
    genre: 'Literary fiction',
    publicationDate: '2026-05-09',
    description: null,
    notes: null,
  };
  return configureStore({
    reducer: {
      bookMeta: bookMetaSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
    } as never,
    preloadedState: {
      ui: { stage: { kind: 'ready', bookId: 'b1', view: 'cast', currentChapterId: 3, openProfileId: null } },
      bookMeta: { draft: null, saved: { b1: meta }, prosodyEnabled: {} },
    } as never,
    middleware: (gDM) => gDM().concat(persistenceMiddleware),
  });
}

describe('bookMeta/commitDraft persist failure (#2230)', () => {
  /* Both refusal modes — analysis-busy and folder path collision — must
     surface the server's OWN sentence (not the bulk-reassign copy) and revert
     the optimistic `saved` while KEEPING the user's typed draft for retry. */
  it.each([
    {
      serverError:
        'Analysis is running for this book. Wait for it to finish before renaming it.',
      probe: 'Analysis is running for this book',
    },
    {
      serverError: 'A book already exists at that Author/Series/Title path.',
      probe: 'already exists at that Author/Series/Title path',
    },
  ])('surfaces the server refusal sentence and reverts title but keeps the draft ($probe)', async ({ serverError, probe }) => {
    putBookState.mockRejectedValueOnce(new Error(`Book state PUT failed (409): ${serverError}`));
    const store = makeBookMetaStore();
    /* Stage + commit a rename exactly as the Listen editor does. */
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Renamed Book' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.runAllTimersAsync();

    const state = store.getState() as {
      notifications: { toasts: { kind: string; message: string; dedupeKey?: string }[] };
      bookMeta: { saved: Record<string, { title: string }>; draft: { title?: string } | null };
    };

    /* Specific server message, book-meta dedupe key — NOT the bulk copy. */
    const toast = state.notifications.toasts.find((t) => t.dedupeKey === 'book-meta-persist-failed');
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain(probe);
    expect(toast?.message).not.toContain('Line reassignment');
    /* The api.ts envelope is stripped — only the server's sentence remains. */
    expect(toast?.message).not.toContain('Book state PUT failed');

    /* Persisted `saved` reverts to the last accepted value… */
    expect(state.bookMeta.saved.b1.title).toBe('The Northern Star');
    /* …and the user's typed text survives in the editor for retry. */
    expect(state.bookMeta.draft?.title).toBe('Renamed Book');
  });

  it('rolls the draft back after a transient failure exhausts its retries while the book is still open (#3421)', async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Typed for A' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(20000);

    const state = store.getState() as { bookMeta: { saved: Record<string, { title: string }>; draft: { title?: string } | null } };
    expect(state.bookMeta.saved.b1.title).toBe('The Northern Star');
    expect(state.bookMeta.draft?.title).toBe('Typed for A');
    err.mockRestore();
  });

  it("does NOT restore book A's draft over book B when the user switched books during the retry window (#3421 F4)", async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Typed for A' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(1500);
    store.dispatch(uiSlice.actions.goHome());
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(
      bookMetaActions.hydrateFromBookState({
        bookId: 'b2',
        state: { title: 'Book B', author: 'B', series: '', prosodyEnabled: false } as never,
      }),
    );
    await vi.advanceTimersByTimeAsync(20000);

    const s = store.getState() as never;
    expect(selectEffectiveMeta(s, 'b2')?.title).toBe('Book B');
    err.mockRestore();
  });

  it("keeps book A's book-meta save that gave up un-rolled-back after the user left A, and re-sends it on A's next flush (#3421)", async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Typed for A' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(1500);
    store.dispatch(uiSlice.actions.goHome());
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    store.dispatch(
      bookMetaActions.hydrateFromBookState({
        bookId: 'b2',
        state: { title: 'Book B', author: 'B', series: '', prosodyEnabled: false } as never,
      }),
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect(selectEffectiveMeta(store.getState() as never, 'b2')?.title).toBe('Book B');

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    store.dispatch(flushBookPersistence('b1'));
    await vi.advanceTimersByTimeAsync(20000);
    const resent = putBookState.mock.calls.filter(
      ([id, body]) => id === 'b1' && JSON.stringify(body).includes('Typed for A'),
    );
    expect(resent.length).toBeGreaterThan(0);
    err.mockRestore();
  });

  it('clears the rollback snapshot when a kept book-meta save lands, so a later 409 does not restore the pre-save title/author (#3421 N2)', async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'T1' }));
    store.dispatch(bookMetaActions.setDraftField({ field: 'author', value: 'New Author' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(1500);
    store.dispatch(uiSlice.actions.goHome());
    await vi.advanceTimersByTimeAsync(20000);

    /* The kept save is re-sent on its own by the book's next flush, no hydrate. */
    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'complete' }));
    store.dispatch(flushBookPersistence('b1'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(putBookState).toHaveBeenCalled();

    /* A colliding rename is then refused: the rollback must land on T1, not T0. */
    putBookState.mockReset();
    putBookState.mockRejectedValue(new Error('Book state PUT failed (409): A book already exists at that Author/Series/Title path.'));
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Collides' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(20000);

    const saved = (store.getState() as { bookMeta: { saved: Record<string, { title: string; author: string }> } }).bookMeta.saved.b1;
    expect(saved.title).toBe('T1');
    expect(saved.author).toBe('New Author');
    err.mockRestore();
  });

  it('does NOT keep a rolled-back book-meta save for re-send on the next flush (#3421)', async () => {
    putBookState.mockRejectedValue(new Error('Book state PUT failed (503): down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Typed for A' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(20000);

    /* Retries exhausted with b1 still open: the draft is restored, so the user
       re-saves it themselves — the give-up must not also keep the patch. */
    const state = store.getState() as { bookMeta: { draft: { title?: string } | null } };
    expect(state.bookMeta.draft?.title).toBe('Typed for A');
    const sent = putBookState.mock.calls.length;
    expect(sent).toBeGreaterThan(1);

    putBookState.mockResolvedValue(undefined);
    store.dispatch(flushBookPersistence('b1'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(putBookState).toHaveBeenCalledTimes(sent);
    err.mockRestore();
  });

  it('does NOT toast, roll back, or keep a snapshot on a SUCCESSFUL save', async () => {
    putBookState.mockResolvedValue(undefined);
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Persisted Fine' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.runAllTimersAsync();

    const state = store.getState() as {
      notifications: { toasts: unknown[] };
      bookMeta: {
        saved: Record<string, { title: string }>;
        draft: unknown;
        lastCommitted?: Record<string, unknown>;
      };
    };
    /* The optimistic value is now confirmed on disk — no rollback. */
    expect(state.bookMeta.saved.b1.title).toBe('Persisted Fine');
    expect(state.bookMeta.draft).toBeNull();
    expect(state.notifications.toasts).toHaveLength(0);
    /* Success prunes the snapshot so the next save snaps a fresh baseline. */
    expect(state.bookMeta.lastCommitted?.['b1']).toBeUndefined();
  });

  it('a ui/confirmCast in the same window combines with the book-meta commits; a refusal rolls back every committed field and re-sends castConfirmed', async () => {
    /* #3784 (owner decision) — ui/confirmCast and bookMeta/commitDraft share
       the `state` slice and combine in one send, newest value per field, so the
       book-meta handler still owns the send's failure. The rollback baseline
       covers both commits: a refusal restores title AND author, and gives the
       user both typed values back. (Replaces #2230's "confirmCast replaces the
       pending write" test.) Pass 7 (R2) — the castConfirmed that rode along has
       no rollback, so it is not lost with the commit: it goes in a follow-up. */
    putBookState.mockRejectedValueOnce(new Error('Book state PUT failed (409): cast refused'));
    const store = makeBookMetaStore();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Renamed Book' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch(bookMetaActions.setDraftField({ field: 'author', value: 'New Author' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch({ type: 'ui/confirmCast' } as never);
    await vi.runAllTimersAsync();

    expect(putBookState).toHaveBeenCalledTimes(2);
    expect(putBookState.mock.calls[0][1]).toMatchObject({
      slice: 'state',
      patch: { title: 'Renamed Book', author: 'New Author', castConfirmed: true },
    });
    expect(putBookState.mock.calls[1][1]).toEqual({ slice: 'state', patch: { castConfirmed: true } });

    const state = store.getState() as {
      notifications: { toasts: { dedupeKey?: string }[] };
      bookMeta: {
        saved: Record<string, { title: string; author: string }>;
        draft: { title?: string; author?: string } | null;
      };
    };
    expect(state.notifications.toasts.some((t) => t.dedupeKey === 'book-meta-persist-failed')).toBe(true);
    expect(state.bookMeta.saved.b1).toMatchObject({ title: 'The Northern Star', author: 'Marin Vale' });
    expect(state.bookMeta.draft).toEqual({ title: 'Renamed Book', author: 'New Author' });
  });

  it('does NOT let an older in-flight save prune/roll back over a newer one (#2230 race)', async () => {
    /* Two saves whose debounced PUTs OVERLAP in flight: the older PUT resolving
       after a newer one is scheduled must NOT prune the shared rollback
       snapshot, and the newer PUT's failure must still recover the newest edit.
       A landed save prunes the snapshot only when no entry of its handler is
       still queued; otherwise the older onSuccess would wipe the snapshot the
       newer save's rollback needs → the newer edit was lost. */
    const deferred: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    putBookState.mockImplementation(
      () =>
        new Promise<unknown>((resolve, reject) => {
          deferred.push({ resolve, reject });
        }),
    );
    const store = makeBookMetaStore();

    /* Save A → the first debounced flush fires and its PUT stays in-flight. */
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Edit A' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(deferred).toHaveLength(1);

    /* Save B before PUT_A resolves → its debounce fires, but it waits behind
       PUT_A: one PUT per (book, slice) in transit (plan 289 pass 7, C2). */
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Edit B' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(deferred).toHaveLength(1);

    /* The OLDER flush (A) succeeds first — it must NOT prune the snapshot that
       the queued newer save (B, sent next) depends on. */
    deferred[0].resolve(undefined);
    await vi.runAllTimersAsync();
    expect(deferred).toHaveLength(2);
    expect((store.getState() as { bookMeta: { lastCommitted?: Record<string, unknown> } }).bookMeta.lastCommitted?.['b1']).toBeDefined();

    /* The NEWER flush (B) now fails — its rollback must still run, restoring the
       accepted title and preserving the newest edit for retry. */
    deferred[1].reject(new Error('Book state PUT failed (409): analysis is running'));
    await vi.runAllTimersAsync();
    const after = store.getState() as {
      bookMeta: { saved: Record<string, { title: string }>; draft: { title?: string } | null };
    };
    expect(after.bookMeta.saved.b1.title).toBe('The Northern Star');
    expect(after.bookMeta.draft?.title).toBe('Edit B');
  });
});

describe('a given-up save is kept and re-sent on the next flush (#3421)', () => {
  const down = () => new Error('Book state PUT failed (503): down');

  it('(i) re-sends the kept save with no new edit, then has nothing left', async () => {
    putBookState.mockRejectedValue(down());
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await expect(first).resolves.toEqual({ failedSlices: ['cast'] });
    expect(putBookState).toHaveBeenCalledTimes(4);

    putBookState.mockResolvedValue(undefined);
    const again = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    expect(putBookState).toHaveBeenCalledTimes(5);
    expect(putBookState.mock.calls[4]).toEqual(putBookState.mock.calls[0]);
    await expect(again).resolves.toEqual({ failedSlices: [] });
    expect(mw(flushBookPersistence('book-1'))).toBeNull();
    err.mockRestore();
  });

  it('(i-b) a debounced save of the book sends the kept save before its own', async () => {
    putBookState.mockRejectedValue(down());
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await first;

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    mw({ type: 'manuscript/setSentenceCharacter' });
    await advance(500);
    expect(putBookState.mock.calls.map((c) => c[1].slice)).toEqual(['cast', 'manuscript']);
    err.mockRestore();
  });

  it('(i-c) two kept slices of one book are each re-sent exactly once', async () => {
    putBookState.mockRejectedValue(down());
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'manuscript/setSentenceCharacter' });
    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await first;

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    const again = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await expect(again).resolves.toEqual({ failedSlices: [] });
    expect(putBookState.mock.calls.map((c) => c[1].slice)).toEqual(['cast', 'manuscript']);
    err.mockRestore();
  });

  it('(iii-a) a newer edit to the same fields replaces the kept ones', async () => {
    putBookState.mockRejectedValue(down());
    const state: Record<string, unknown> = baseState({ cast: { characters: [{ id: 'old' }] } });
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await first;

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    state.cast = { characters: [{ id: 'new' }] };
    mw({ type: 'cast/setCharacters' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledTimes(1);
    expect(putBookState.mock.calls[0][1].patch).toEqual({ characters: [{ id: 'new' }] });
    err.mockRestore();
  });

  it('(iii-b) a newer edit to other fields of the shared state slice rides with the kept ones', async () => {
    putBookState.mockRejectedValue(down());
    const meta = {
      title: 'Renamed',
      author: 'Marin Vale',
      series: 'NCT · Book 2',
      narratorCredit: 'Anders Vale',
      genre: 'Literary fiction',
      publicationDate: '2026-05-09',
    };
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'ui/confirmCast' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await expect(first).resolves.toEqual({ failedSlices: ['state'] });

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    state.bookMeta = { draft: null, saved: { 'book-1': meta } };
    mw({ type: 'bookMeta/commitDraft' });
    await advance(500);
    expect(putBookState).toHaveBeenCalledTimes(1);
    expect(putBookState.mock.calls[0][1].patch).toEqual(
      expect.objectContaining({ castConfirmed: true, ...meta }),
    );
    err.mockRestore();
  });

  it('(v) dropping the book’s kept saves (a full re-read, a delete): the next flush does not re-send the old roster', async () => {
    putBookState.mockRejectedValue(down());
    const state: Record<string, unknown> = baseState({ cast: { characters: [{ id: 'pre-reparse' }] } });
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await expect(first).resolves.toEqual({ failedSlices: ['cast'] });

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    mw(dropRetainedSaves('book-1'));
    expect(mw(flushBookPersistence('book-1'))).toBeNull();
    mw({ type: 'manuscript/setSentenceCharacter' });
    await advance(500);
    expect(putBookState.mock.calls.map((c) => c[1].slice)).toEqual(['manuscript']);
    err.mockRestore();
  });

  it("(v-b) dropping one book's kept saves leaves another book's alone", async () => {
    putBookState.mockRejectedValue(down());
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(7000);
    await first;

    putBookState.mockReset();
    putBookState.mockResolvedValue(undefined);
    mw(dropRetainedSaves('book-2'));
    const again = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await expect(again).resolves.toEqual({ failedSlices: [] });
    expect(putBookState).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('(iv) a 4xx refusal is not kept', async () => {
    putBookState.mockRejectedValueOnce(new Error('Book state PUT failed (409): refused'));
    const state: Record<string, unknown> = baseState();
    const mw = persistenceMiddleware(makeStore(state))(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    mw({ type: 'cast/setCharacters' });
    const first = mw(flushBookPersistence('book-1')) as unknown as Promise<BookFlushOutcome>;
    await advance(0);
    await expect(first).resolves.toEqual({ failedSlices: ['cast'] });
    expect(mw(flushBookPersistence('book-1'))).toBeNull();
    await advance(20000);
    expect(putBookState).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe("a handler's given-up save toast names the book (#3421 N4)", () => {
  const down = () => new Error('Book state PUT failed (503): down');
  /* Edit a book, leave it for another before the retries run out, and return
     the toast raised under `dedupeKey`. */
  const givenUpToast = async (actionType: string, dedupeKey: string, error: Error) => {
    putBookState.mockRejectedValue(error);
    const state: Record<string, unknown> = baseState({
      bookMeta: { draft: null, saved: { 'book-1': { title: 'The Northern Star' } } },
    });
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mw({ type: actionType });
    state.ui = { stage: { bookId: 'book-2' } };
    mw({ type: 'ui/openBook' });
    await advance(20000);
    err.mockRestore();
    return (store.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((a) => a.payload?.dedupeKey === dedupeKey);
  };

  it.each(['manuscript/setSentencesCharacterBulk', 'manuscript/undoBulkReassign'])(
    'the %s line-reassignment toast names the book after a 5xx exhausts its retries',
    async (actionType) => {
      const toast = await givenUpToast(actionType, 'bulk-reassign-persist-failed', down());
      expect(toast.payload.message).toContain('"The Northern Star"');
      expect(toast.payload.message).toContain('Line reassignment');
    },
  );

  it('the book-details toast names the book after a 5xx exhausts its retries', async () => {
    const toast = await givenUpToast('bookMeta/commitDraft', 'book-meta-persist-failed', down());
    expect(toast.payload.message).toContain('"The Northern Star"');
  });

  it('a 4xx book-details refusal keeps its exact existing message', async () => {
    const sentence = 'A book already exists at that Author/Series/Title path.';
    const toast = await givenUpToast(
      'bookMeta/commitDraft',
      'book-meta-persist-failed',
      new Error(`Book state PUT failed (409): ${sentence}`),
    );
    expect(toast.payload.message).toBe(`Book details couldn't be saved: ${sentence}`);
  });
});

describe('a given-up save toast names the last-saved title (#3421 S2)', () => {
  const down = () => new Error('Book state PUT failed (503): down');
  /* Edit a book, leave it for another before the retries run out, and return
     the generic given-up toast for `book-1`. */
  const givenUpToast = async (state: Record<string, unknown>) => {
    putBookState.mockRejectedValue(down());
    const store = makeStore(state);
    const mw = persistenceMiddleware(store)(vi.fn((x) => x));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mw({ type: 'cast/setCharacters' });
    state.ui = { stage: { bookId: 'book-2' } };
    mw({ type: 'ui/openBook' });
    await advance(20000);
    err.mockRestore();
    return (store.dispatch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((a) => a.payload?.dedupeKey === 'book-persist-failed:book-1');
  };

  it('names the title on disk, not the renamed title that never saved', async () => {
    const toast = await givenUpToast(
      baseState({
        bookMeta: {
          draft: null,
          saved: { 'book-1': { title: 'The Southern Cross' } },
          lastCommitted: {
            'book-1': { saved: { title: 'The Northern Star' }, draft: { title: 'The Southern Cross' } },
          },
        },
      }),
    );
    expect(toast.payload.message).toContain('"The Northern Star"');
    expect(toast.payload.message).not.toContain('Southern Cross');
  });

  it('falls back to the library title when bookMeta holds nothing for the book', async () => {
    const toast = await givenUpToast(
      baseState({
        library: { books: [{ bookId: 'book-1', title: 'The Library Title' }] },
      }),
    );
    expect(toast.payload.message).toContain('"The Library Title"');
  });
});

/* Plan 289 — a re-sent save carries the revision it was built against, and a
   save the book has moved past is refused (D2, D6). Driven against the shared
   disk model, which applies the server's precondition and edit epoch. */
describe('re-sent saves carry their base revision (plan 289)', () => {
  const eliza = (name: string) => ({ id: 'c1', name, role: '', color: 'narrator' }) as Character;
  const isCast = (_id: string, req: { slice: string }) => req.slice === 'cast';
  const isState = (_id: string, req: { slice: string }) => req.slice === 'state';
  type Req = { slice: string; patch: Record<string, unknown>; baseRevision?: SliceRevision };
  const reqs = () => putBookState.mock.calls.map((c) => c[1] as Req);

  function setup(manuscript?: Record<string, unknown>) {
    const disk = createBookStateDisk();
    disk.seed('b1', {
      state: { title: 'The Northern Star', author: 'Marin Vale', castConfirmed: false },
      cast: { characters: [eliza('Eliza')] },
    });
    putBookState.mockImplementation((id: string, req: never) => disk.serve(id, req));
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
        notifications: notificationsSlice.reducer,
      } as never,
      preloadedState: {
        ui: { stage: { kind: 'ready', bookId: 'b1', view: 'cast', currentChapterId: 3, openProfileId: null } },
        ...(manuscript ? { manuscript: { ...manuscriptSlice.getInitialState(), ...manuscript } } : {}),
        bookMeta: {
          draft: null,
          saved: {
            b1: {
              title: 'The Northern Star',
              author: 'Marin Vale',
              series: '',
              narratorCredit: 'Castwright',
              genre: null,
              publicationDate: null,
              description: null,
              notes: null,
            },
          },
          prosodyEnabled: {},
        },
      } as never,
      middleware: (gDM) => gDM().concat(persistenceMiddleware),
    });
    /* The full read Layout makes on open. */
    learn(store, disk.revisions('b1'), store.dispatch(beginFullRead('b1')) as unknown as number);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { disk, store, restore: () => err.mockRestore() };
  }
  type S = ReturnType<typeof setup>['store'];
  type Disk = ReturnType<typeof setup>['disk'];
  function learn(store: S, revisions: Record<string, SliceRevision>, seq: number) {
    store.dispatch(learnSliceRevisions('b1', revisions, seq));
  }
  const rename = (store: S, name: string) => store.dispatch(castActions.setCharacters([eliza(name)]));
  const castName = (disk: Disk) => (disk.books.get('b1')!.cast!.characters[0] as Character).name;
  const outcomes = (disk: Disk) => disk.log.map((p) => p.outcome);
  const staleToasts = (store: S) =>
    (store.getState() as { notifications: { toasts: { dedupeKey?: string; message: string }[] } })
      .notifications.toasts.filter((t) => t.dedupeKey === 'book-persist-stale:b1');
  const marks = (store: S) =>
    (store.getState() as { bookMeta: { needsFullRead?: Record<string, number> } }).bookMeta.needsFullRead?.b1;
  /* Layout's full read of b1, in its order: the mark is cleared, the kept
     saves are let go, the tokens learnt, then the slices hydrated. A
     book-meta save held for the read goes once it hydrates (#3784 P1). */
  function fullRead(store: S, disk: Disk) {
    const seq = store.dispatch(beginFullRead('b1')) as unknown as number;
    store.dispatch(bookMetaActions.clearNeedsFullRead({ bookId: 'b1', upTo: marks(store) ?? 0 }));
    store.dispatch(dropRetainedSaves('b1', true));
    learn(store, disk.revisions('b1'), seq);
    store.dispatch(
      bookMetaActions.hydrateFromBookState({ bookId: 'b1', state: disk.books.get('b1')!.state as never }),
    );
  }

  /* A cast save whose four attempts all fail: kept for the book's next flush. */
  async function keepCastSave(store: S, disk: Disk, name: string) {
    disk.failNext(4, isCast);
    rename(store, name);
    void store.dispatch(flushBookPersistence('b1'));
    await advance(8000);
  }

  it('attempt 0 carries no base; its retries and the replay of the kept save carry the captured base', async () => {
    const { disk, store, restore } = setup();
    const captured = disk.revision('b1', 'cast');
    await keepCastSave(store, disk, 'Eliza Vane');
    store.dispatch(flushBookPersistence('b1'));
    await advance(0);
    const sent = reqs();
    expect(sent).toHaveLength(5);
    expect(sent[0].baseRevision).toBeUndefined();
    for (const r of sent.slice(1)) expect(r.baseRevision).toEqual(captured);
    expect(outcomes(disk)).toEqual(['503', '503', '503', '503', 'ok']);
    restore();
  });

  /* Pass 7 (OD-C2) — only a kept field carries its base: an outside write to
     it refuses it, while a live field sent beside it is unconditional, as on
     `main`. */
  it('a live build merged with a kept save: an outside write refuses the kept field, and the live field overwrites', async () => {
    const { disk, store, restore } = setup();
    const captured = disk.revision('b1', 'state');
    /* Keep T1: its save is given up on after the user left the book. */
    disk.failNext(4, isState);
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'T1' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch(uiSlice.actions.goHome());
    await advance(8000);

    /* Another writer renames the book and writes notes; back on the book, a
       live notes commit merges with the kept book-meta fields. */
    disk.write('b1', 'state', { ...disk.books.get('b1')!.state, title: 'Elsewhere', notes: 'theirs' });
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'cast_pending' }));
    store.dispatch(bookMetaActions.setDraftField({ field: 'notes', value: 'n' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await advance(600);
    /* #3784 P1 — the follow-up waits for the re-read the refusal asked for. */
    expect(marks(store)).toBe(1);
    fullRead(store, disk);
    await advance(600);

    const refused = reqs().at(-2)!;
    expect(refused.patch).toMatchObject({ title: 'T1', notes: 'n' });
    expect(refused.baseRevision?.title).toBe(captured.title);
    expect(refused.baseRevision).not.toHaveProperty('notes');
    expect(outcomes(disk).slice(-2)).toEqual(['409', 'ok']);
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'Elsewhere', notes: 'n' });
    expect(staleToasts(store)).toHaveLength(1);
    expect(marks(store)).toBeUndefined();
    restore();
  });

  it('a second state build in the same window keeps the kept fields it was merged with, and the kept base', async () => {
    const { disk, store, restore } = setup();
    const captured = disk.revision('b1', 'state');
    disk.failNext(4, isState);
    store.dispatch({ type: 'ui/confirmCast' });
    void store.dispatch(flushBookPersistence('b1'));
    await advance(8000);

    /* Two book-meta commits inside one debounce window, after the kept
       castConfirmed: the second build merges over the first. */
    store.dispatch(bookMetaActions.setDraftField({ field: 'notes', value: 'a' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch(bookMetaActions.setDraftField({ field: 'notes', value: 'b' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await advance(600);

    const last = reqs().at(-1)!;
    expect(last.patch).toMatchObject({ castConfirmed: true, notes: 'b' });
    /* Pass 7 (C1) — the base covers the kept field only; the live ones have none. */
    expect(last.baseRevision).toEqual({ castConfirmed: captured.castConfirmed });
    expect(outcomes(disk).at(-1)).toBe('ok');
    expect(disk.books.get('b1')!.state).toMatchObject({ castConfirmed: true, notes: 'b' });
    restore();
  });

  /* #3784 (owner decision) — queued `state` edits combine, newest value per
     field, instead of the later build replacing the queued patch. */
  it('two queued state edits with no kept save combine into one send, and its success prunes the rollback baseline', async () => {
    const { disk, store, restore } = setup();
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'X' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch({ type: 'ui/confirmCast' });
    await advance(600);

    expect(reqs()).toHaveLength(1);
    expect(reqs()[0].patch).toMatchObject({ title: 'X', author: 'Marin Vale', castConfirmed: true });
    expect(reqs()[0].baseRevision).toBeUndefined();
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'X', castConfirmed: true });
    /* The book-meta edit's own success handler still ran. */
    expect(
      (store.getState() as { bookMeta: { lastCommitted?: Record<string, unknown> } }).bookMeta.lastCommitted?.b1,
    ).toBeUndefined();
    restore();
  });

  it('a confirmCast after a commit that carried a kept title sends the newer title live, with the base of the kept fields it left unchanged', async () => {
    const { disk, store, restore } = setup();
    const captured = disk.revision('b1', 'state');
    /* Keep T1: its save is given up on after the user left the book. */
    disk.failNext(4, isState);
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'T1' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch(uiSlice.actions.goHome());
    await advance(8000);
    expect(outcomes(disk)).toEqual(['503', '503', '503', '503']);

    /* Back on the book: the user commits T2, and confirmCast follows in the same window. */
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'cast_pending' }));
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'T2' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch({ type: 'ui/confirmCast' });
    await advance(600);

    expect(reqs()).toHaveLength(5);
    const last = reqs().at(-1)!;
    expect(last.patch).toMatchObject({ title: 'T2', author: 'Marin Vale', castConfirmed: true });
    /* Pass 7 (C1) — title and castConfirmed are live (no base); the seven kept
       book-meta fields T2's commit did not change keep theirs. */
    const kept = ['author', 'series', 'narratorCredit', 'genre', 'publicationDate', 'description', 'notes'];
    expect(last.baseRevision).toEqual(Object.fromEntries(kept.map((f) => [f, captured[f]])));
    expect(outcomes(disk).at(-1)).toBe('ok');
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'T2', castConfirmed: true });
    restore();
  });

  /* #3784 (owner decision) — a rolled-back save undoes only the book-meta
     edit; the castConfirmed combined into it is kept and re-sent. */
  it('a combined commit + confirmCast that gives up with the book open rolls back the commit and keeps castConfirmed', async () => {
    const { disk, store, restore } = setup();
    const captured = disk.revision('b1', 'state');
    disk.failNext(4, isState);
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'X' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    store.dispatch({ type: 'ui/confirmCast' });
    await advance(8000);
    const meta = (store.getState() as { bookMeta: { saved: Record<string, { title: string }>; draft: { title?: string } | null } }).bookMeta;
    expect(meta.saved.b1.title).toBe('The Northern Star');
    expect(meta.draft?.title).toBe('X');

    store.dispatch(flushBookPersistence('b1'));
    await advance(0);
    const last = reqs().at(-1)!;
    expect(last.patch).toEqual({ castConfirmed: true });
    expect(last.baseRevision).toEqual({ castConfirmed: captured.castConfirmed });
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'The Northern Star', castConfirmed: true });
    restore();
  });

  it('a full read stamped before a PUT landed does not overwrite what the PUT taught', async () => {
    const { disk, store, restore } = setup();
    const before = disk.revisions('b1');
    const seq = store.dispatch(beginFullRead('b1')) as unknown as number;
    rename(store, 'Eliza X');
    await advance(500);
    /* The read's response arrives late, carrying the pre-write tokens. */
    learn(store, before, seq);
    disk.failNext(1, isCast);
    rename(store, 'Eliza Y');
    await advance(1600);
    expect(outcomes(disk)).toEqual(['ok', '503', 'ok']);
    expect(castName(disk)).toBe('Eliza Y');
    restore();
  });

  it('voice override: a kept roster is refused after another book applied a linked override to this one', async () => {
    const { disk, store, restore } = setup();
    await keepCastSave(store, disk, 'Eliza Vane');
    const overridden = [{ ...eliza('Eliza'), overrideTtsVoices: { qwen: { name: 'designed-1' } } }];
    disk.write('b1', 'cast', { characters: overridden });
    store.dispatch(flushBookPersistence('b1'));
    await advance(0);
    expect(outcomes(disk).at(-1)).toBe('409');
    expect(disk.books.get('b1')!.cast!.characters).toEqual(overridden);
    restore();
  });

  it('wipe: a retrying confirmCast that spans a re-parse is refused, and the book stays unconfirmed', async () => {
    const { disk, store, restore } = setup();
    disk.failNext(1, isState);
    store.dispatch({ type: 'ui/confirmCast' });
    await advance(500);
    disk.reparse('b1');
    await advance(1000);
    expect(outcomes(disk)).toEqual(['503', '409']);
    expect(disk.books.get('b1')!.state.castConfirmed).toBe(false);
    restore();
  });

  it('D2 on a retry: toasts once, does not roll back, is not kept, and marks the book', async () => {
    const { disk, store, restore } = setup();
    disk.write('b1', 'state', { ...disk.books.get('b1')!.state, title: 'Elsewhere' });
    disk.failNext(1, isState);
    store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'T1' }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
    await advance(2000);

    /* Pass 7 (C6) — only the stale title is dropped; the other based fields of
       the commit go in a follow-up, once the re-read lands (#3784 P1). */
    expect(outcomes(disk)).toEqual(['503', '409']);
    expect(disk.books.get('b1')!.state.title).toBe('Elsewhere');
    expect(staleToasts(store)).toHaveLength(1);
    expect(staleToasts(store)[0].message).toContain('changed elsewhere');
    const meta = (store.getState() as { bookMeta: { saved: { b1: { title: string } }; draft: unknown } }).bookMeta;
    expect(meta.saved.b1.title).toBe('T1');
    expect(meta.draft).toBeNull();
    expect(marks(store)).toBe(1);
    expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
    fullRead(store, disk);
    await advance(0);
    expect(outcomes(disk)).toEqual(['503', '409', 'ok']);
    expect(reqs().at(-1)!.patch).not.toHaveProperty('title');
    expect(disk.books.get('b1')!.state.title).toBe('Elsewhere');
    restore();
  });

  it('D2 on a replay: toasts once naming the book, is not kept, and marks the book', async () => {
    const { disk, store, restore } = setup();
    await keepCastSave(store, disk, 'Eliza Vane');
    disk.write('b1', 'cast', { characters: [eliza('Elsewhere')] });
    store.dispatch(flushBookPersistence('b1'));
    await advance(0);
    expect(outcomes(disk).at(-1)).toBe('409');
    expect(staleToasts(store)).toHaveLength(1);
    expect(staleToasts(store)[0].message).toContain('"The Northern Star"');
    expect(marks(store)).toBe(1);
    expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
    restore();
  });

  /* P6-3 (#3784) — X's attempt 0 fails and its retry is held while `overtake`
     runs; X's retry then answers. */
  async function staleRetryAfter(store: S, disk: Disk, overtake: () => Promise<void>) {
    disk.failNext(1, isCast);
    rename(store, 'Eliza X');
    await advance(500);
    let release!: () => void;
    putBookState.mockImplementationOnce(
      (id: string, req: never) =>
        new Promise((resolve, reject) => {
          release = () => {
            try {
              resolve(disk.put(id, req));
            } catch (e) {
              reject(e);
            }
          };
        }),
    );
    await advance(1000);
    store.dispatch(bookMetaActions.setDraftField({ field: 'notes', value: 'typing' }));
    await overtake();
    release();
    await advance(0);
  }
  const draft = (store: S) => (store.getState() as { bookMeta: { draft: { notes?: string } | null } }).bookMeta.draft;

  /* Pass 7 (C9, OD-C3) — single flight: Y waits behind X's held retry, and an
     outside write makes that retry stale. Y already replaced X in the outbox,
     so Y owns the outcome and is sent unconditionally. */
  it('a stale refusal of a value a newer edit replaced neither toasts nor forces a re-read, and sends the newer value', async () => {
    const { disk, store, restore } = setup();
    await staleRetryAfter(store, disk, async () => {
      rename(store, 'Eliza Y');
      disk.write('b1', 'cast', { characters: [eliza('Elsewhere')] });
      await advance(500);
    });
    expect(outcomes(disk)).toEqual(['503', '409', 'ok']);
    expect(castName(disk)).toBe('Eliza Y');
    expect(staleToasts(store)).toHaveLength(0);
    expect(marks(store)).toBeUndefined();
    expect(draft(store)?.notes).toBe('typing');
    restore();
  });

  it('a stale refusal no newer edit replaced still toasts and forces a re-read', async () => {
    const { disk, store, restore } = setup();
    await staleRetryAfter(store, disk, async () => {
      disk.write('b1', 'cast', { characters: [eliza('Elsewhere')] });
    });
    expect(outcomes(disk)).toEqual(['503', '409']);
    expect(castName(disk)).toBe('Elsewhere');
    expect(staleToasts(store)).toHaveLength(1);
    expect(marks(store)).toBe(1);
    restore();
  });

  /* P6-4 (#3784), pass 7 (C5, OD-C1) — a kept castConfirmed rides a notes
     commit whose send fails; a title commit made during the backoff rides the
     scheduled retry, next to the failed fields with their bases. */
  const commit = (store: S, field: 'title' | 'notes', value: string) => {
    store.dispatch(bookMetaActions.setDraftField({ field, value }));
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'b1' }));
  };
  async function commitDuringKeptBackoff(store: S, disk: Disk) {
    disk.failNext(4, isState);
    store.dispatch({ type: 'ui/confirmCast' });
    void store.dispatch(flushBookPersistence('b1'));
    await advance(8000);
    disk.failNext(1, isState);
    commit(store, 'notes', 'a');
    await advance(600);
    commit(store, 'title', 'T');
    await advance(2000);
    expect(outcomes(disk).slice(-2)).toEqual(['503', 'ok']);
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'T', notes: 'a' });
  }

  it("a commit during a kept castConfirmed's backoff rides its retry, and castConfirmed keeps its base", async () => {
    const { disk, store, restore } = setup();
    const captured = disk.revision('b1', 'state');
    await commitDuringKeptBackoff(store, disk);
    const retry = reqs().at(-1)!;
    expect(retry.patch).toMatchObject({ castConfirmed: true, title: 'T', notes: 'a' });
    expect(retry.baseRevision?.castConfirmed).toBe(captured.castConfirmed);
    expect(retry.baseRevision?.notes).toBe(captured.notes);
    expect(retry.baseRevision).not.toHaveProperty('title');
    expect(disk.books.get('b1')!.state.castConfirmed).toBe(true);
    expect(staleToasts(store)).toHaveLength(0);
    expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
    restore();
  });

  it('a kept castConfirmed is refused once the book changed elsewhere: toast and re-read', async () => {
    const { disk, store, restore } = setup();
    disk.failNext(4, isState);
    store.dispatch({ type: 'ui/confirmCast' });
    void store.dispatch(flushBookPersistence('b1'));
    await advance(8000);
    disk.reparse('b1');
    store.dispatch(flushBookPersistence('b1'));
    await advance(0);
    expect(reqs().at(-1)!.patch).toEqual({ castConfirmed: true });
    expect(outcomes(disk).at(-1)).toBe('409');
    expect(disk.books.get('b1')!.state.castConfirmed).toBe(false);
    expect(staleToasts(store)).toHaveLength(1);
    expect(marks(store)).toBe(1);
    restore();
  });

  it('a save given up on after leaving the book keeps the kept field it carried and the edit that rode its retry', async () => {
    const { disk, store, restore } = setup();
    disk.failNext(4, isState);
    store.dispatch({ type: 'ui/confirmCast' });
    void store.dispatch(flushBookPersistence('b1'));
    await advance(8000);
    /* The notes commit carrying the kept castConfirmed fails all four
       attempts; the title commit, made during its backoff as the user leaves,
       rides its retries. */
    disk.failNext(4, isState);
    commit(store, 'notes', 'a');
    await advance(600);
    commit(store, 'title', 'T');
    store.dispatch(uiSlice.actions.goHome());
    await advance(8000);
    expect(outcomes(disk).slice(-4)).toEqual(['503', '503', '503', '503']);

    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'cast_pending' }));
    store.dispatch(flushBookPersistence('b1'));
    await advance(0);
    expect(reqs().at(-1)!.patch).toMatchObject({ castConfirmed: true, title: 'T', notes: 'a' });
    expect(outcomes(disk).at(-1)).toBe('ok');
    expect(disk.books.get('b1')!.state).toMatchObject({ castConfirmed: true, title: 'T', notes: 'a' });
    restore();
  });

  it('a stale refusal of a field the newer send did not carry still toasts and re-reads', async () => {
    const { disk, store, restore } = setup();
    disk.failNext(4, isState);
    store.dispatch({ type: 'ui/confirmCast' });
    void store.dispatch(flushBookPersistence('b1'));
    await advance(8000);
    let release!: () => void;
    putBookState.mockImplementationOnce(
      (id: string, req: never) =>
        new Promise((resolve, reject) => {
          release = () => {
            try {
              resolve(disk.put(id, req));
            } catch (e) {
              reject(e);
            }
          };
        }),
    );
    commit(store, 'notes', 'a');
    await advance(600);
    disk.reparse('b1');
    commit(store, 'title', 'T');
    release();
    await advance(600);
    expect(marks(store)).toBe(1);
    fullRead(store, disk);
    await advance(600);
    expect(outcomes(disk)).toEqual(['503', '503', '503', '503', '409', 'ok']);
    expect(disk.books.get('b1')!.state).toMatchObject({ castConfirmed: false, title: 'T' });
    expect(staleToasts(store)).toHaveLength(1);
    expect(marks(store)).toBeUndefined();
    restore();
  });

  /* Pass 7 (OD-C1, R2) — the confirmCast made while the commit's PUT is out
     waits for the retry; the path-taken 4xx rolls the commit back, and
     castConfirmed goes alone in the follow-up. */
  it('book-meta fields that ride a queued confirmCast keep their refusal toast and rollback', async () => {
    const { disk, store, restore } = setup();
    let fail!: () => void;
    putBookState.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = () => reject(new Error('Book state PUT failed (503): Service Unavailable'));
        }),
    );
    putBookState.mockImplementationOnce(() =>
      Promise.reject(new Error('Book state PUT failed (409): A book already exists at that Author/Series/Title path.')),
    );
    commit(store, 'title', 'Collides');
    await advance(600);
    store.dispatch({ type: 'ui/confirmCast' });
    fail();
    await advance(1600);
    expect(reqs().at(-2)!.patch).toMatchObject({ castConfirmed: true, title: 'Collides' });
    expect(reqs().at(-1)!.patch).toEqual({ castConfirmed: true });
    const state = store.getState() as {
      bookMeta: { saved: { b1: { title: string } }; draft: { title?: string } | null };
      notifications: { toasts: { dedupeKey?: string }[] };
    };
    expect(state.notifications.toasts.map((t) => t.dedupeKey)).toContain('book-meta-persist-failed');
    expect(state.bookMeta.saved.b1.title).toBe('The Northern Star');
    expect(state.bookMeta.draft?.title).toBe('Collides');
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'The Northern Star', castConfirmed: true });
    restore();
  });

  /* A combined commit + confirmCast send that the server refuses (a 4xx)
     after a newer build of the key was made. */
  function refuseLater() {
    let refuse!: () => void;
    putBookState.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          refuse = () =>
            reject(new Error('Book state PUT failed (409): A book already exists at that Author/Series/Title path.'));
        }),
    );
    return () => refuse();
  }
  type MetaState = {
    bookMeta: { saved: { b1: { title: string } }; draft: { title?: string } | null };
    notifications: { toasts: { dedupeKey?: string }[] };
  };
  const metaToasts = (store: S) =>
    (store.getState() as MetaState).notifications.toasts.filter((t) => t.dedupeKey === 'book-meta-persist-failed');

  it('a refused send rolls back and toasts the book-meta fields no newer build replaced', async () => {
    const { disk, store, restore } = setup();
    const refuse = refuseLater();
    commit(store, 'title', 'Collides');
    store.dispatch({ type: 'ui/confirmCast' });
    await advance(600);
    expect(reqs().at(-1)!.patch).toMatchObject({ castConfirmed: true, title: 'Collides' });
    /* The newer build carries castConfirmed only. */
    store.dispatch({ type: 'ui/confirmCast' });
    refuse();
    await advance(600);
    expect(reqs().at(-1)!.patch).toEqual({ castConfirmed: true });
    expect(outcomes(disk).at(-1)).toBe('ok');
    const state = store.getState() as MetaState;
    expect(metaToasts(store)).toHaveLength(1);
    expect(state.bookMeta.saved.b1.title).toBe('The Northern Star');
    expect(state.bookMeta.draft?.title).toBe('Collides');
    expect(disk.books.get('b1')!.state).toMatchObject({ castConfirmed: true, title: 'The Northern Star' });
    restore();
  });

  it('a refused send whose every book-meta field a newer commit replaced neither rolls back nor toasts', async () => {
    const { disk, store, restore } = setup();
    const refuse = refuseLater();
    commit(store, 'title', 'Collides');
    await advance(600);
    commit(store, 'title', 'Other');
    refuse();
    await advance(600);
    expect(outcomes(disk).at(-1)).toBe('ok');
    const state = store.getState() as MetaState;
    expect(metaToasts(store)).toHaveLength(0);
    expect(state.bookMeta.saved.b1.title).toBe('Other');
    expect(state.bookMeta.draft).toBeNull();
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'Other' });
    restore();
  });

  it('a refused send whose book-meta fields a newer commit replaced does not roll them back, and re-sends castConfirmed', async () => {
    const { disk, store, restore } = setup();
    const refuse = refuseLater();
    commit(store, 'title', 'Collides');
    store.dispatch({ type: 'ui/confirmCast' });
    await advance(600);
    /* Only castConfirmed is left uncovered: a plain 4xx with no handler. */
    commit(store, 'title', 'Other');
    refuse();
    await advance(600);
    expect(outcomes(disk).at(-1)).toBe('ok');
    const state = store.getState() as MetaState;
    expect(metaToasts(store)).toHaveLength(0);
    expect(state.bookMeta.saved.b1.title).toBe('Other');
    expect(disk.books.get('b1')!.state).toMatchObject({ title: 'Other' });
    /* R2 (c, pass 7) — the castConfirmed the refused send carried is not lost. */
    expect(disk.books.get('b1')!.state.castConfirmed).toBe(true);
    restore();
  });

  /* Plan 289 pass 7 (C) — one request in flight per (book, slice), and a
     per-field outbox. Each test seeds `known` with setup()'s full read. */
  describe('single-flight outbox (pass 7, C)', () => {
    type R = { slice: string; patch?: unknown };
    const carries = (req: R, f: string) => req.slice === 'state' && f in ((req.patch ?? {}) as object);
    const isTitle = (_id: string, req: R) => carries(req, 'title');
    const isConfirm = (_id: string, req: R) => carries(req, 'castConfirmed');
    const toastKeys = (store: S) =>
      (store.getState() as MetaState).notifications.toasts.map((t) => t.dedupeKey);
    const stateOnDisk = (disk: Disk) => disk.books.get('b1')!.state;
    /* A kept castConfirmed: its four attempts fail while the book stays open. */
    async function keepConfirm(store: S, disk: Disk) {
      disk.failNext(4, isState);
      store.dispatch({ type: 'ui/confirmCast' });
      void store.dispatch(flushBookPersistence('b1'));
      await advance(8000);
    }

    it('R1: a 200 for an in-flight confirmCast does not lend its title token to a queued rename', async () => {
      const { disk, store, restore } = setup();
      const release = disk.hold(isConfirm);
      store.dispatch({ type: 'ui/confirmCast' });
      await advance(500);
      disk.failNext(1, isTitle);
      commit(store, 'title', 'Mine');
      disk.write('b1', 'state', { ...stateOnDisk(disk), title: 'Theirs' });
      await advance(500);
      release();
      await advance(3000);
      expect(stateOnDisk(disk).title).toBe('Theirs');
      expect(staleToasts(store)).toHaveLength(1);
      expect(marks(store)).toBe(1);
      restore();
    });

    it('R1-learn: a landed confirmCast teaches only castConfirmed, so a retried rename is refused', async () => {
      const { disk, store, restore } = setup();
      disk.write('b1', 'state', { ...stateOnDisk(disk), title: 'Theirs' });
      store.dispatch({ type: 'ui/confirmCast' });
      await advance(500);
      disk.failNext(1, isTitle);
      commit(store, 'title', 'Mine');
      await advance(3000);
      expect(outcomes(disk)).toContain('409');
      expect(stateOnDisk(disk).title).toBe('Theirs');
      restore();
    });

    it.each([
      { name: '(a) book open', leave: false },
      { name: '(b) book left', leave: true },
    ])('R2 $name: a refused rename rolls back, and the kept castConfirmed it carried lands in a follow-up', async ({ leave }) => {
      const { disk, store, restore } = setup();
      await keepConfirm(store, disk);
      const before = toastKeys(store).length;
      disk.refuseNext('book_path_taken', isTitle);
      commit(store, 'title', 'Collides');
      if (leave) store.dispatch(uiSlice.actions.goHome());
      await advance(600);
      const meta = (store.getState() as MetaState).bookMeta;
      expect(meta.saved.b1.title).toBe('The Northern Star');
      expect(meta.draft?.title).toBe(leave ? undefined : 'Collides');
      expect(reqs().at(-1)!.patch).toEqual({ castConfirmed: true });
      expect(stateOnDisk(disk)).toMatchObject({ title: 'The Northern Star', castConfirmed: true });
      expect(toastKeys(store).slice(before)).toEqual(['book-meta-persist-failed']);
      restore();
    });

    it("R3: a rename riding confirmCast's retry is not refused for its own unacknowledged write", async () => {
      const { disk, store, restore } = setup();
      disk.failNext(1, isState);
      store.dispatch({ type: 'ui/confirmCast' });
      await advance(600);
      const release = disk.hold(isTitle, { afterWrite: true });
      commit(store, 'title', 'T1');
      await advance(900);
      commit(store, 'title', 'T2');
      await advance(600);
      release();
      await advance(2000);
      expect(stateOnDisk(disk)).toMatchObject({ title: 'T2', castConfirmed: true });
      expect(staleToasts(store)).toHaveLength(0);
      expect(marks(store)).toBeUndefined();
      restore();
    });

    it('single flight: overlapping state and cast saves keep one PUT in transit per key, newest value wins', async () => {
      const { disk, store, restore } = setup();
      const releaseState = disk.hold(isState);
      commit(store, 'title', 'A');
      await advance(600);
      store.dispatch({ type: 'ui/confirmCast' });
      await advance(600);
      const releaseCast = disk.hold(isCast);
      rename(store, 'Eliza X');
      await advance(600);
      rename(store, 'Eliza Y');
      await advance(600);
      commit(store, 'title', 'B');
      await advance(600);
      releaseState();
      releaseCast();
      await advance(3000);
      expect(disk.maxInTransit('b1', 'state')).toBe(1);
      expect(disk.maxInTransit('b1', 'cast')).toBe(1);
      expect(stateOnDisk(disk)).toMatchObject({ title: 'B', castConfirmed: true });
      expect(castName(disk)).toBe('Eliza Y');
      restore();
    });

    it('a sentence edit made while a merge is in flight keeps the tombstone in the follow-up (fs-58)', async () => {
      const { disk, store, restore } = setup({
        sentences: [
          { id: 1, chapterId: 1, text: 'One.', characterId: 'narrator' },
          { id: 2, chapterId: 1, text: 'Two.', characterId: 'narrator' },
        ],
        mergedAwayKeys: [],
      });
      const release = disk.hold((_id, req) => req.slice === 'manuscript');
      store.dispatch(manuscriptActions.mergeSentences({ chapterId: 1, sentenceIds: [1, 2] }));
      await advance(500);
      store.dispatch(manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'eliza' }));
      await advance(600);
      release();
      await advance(100);
      expect(reqs().at(-1)!.patch).toMatchObject({ mergedAwayKeys: ['1:2'] });
      const onDisk = disk.books.get('b1')!.manuscript!;
      expect(onDisk.mergedAwayKeys).toEqual(['1:2']);
      expect((onDisk.sentences[0] as { characterId: string }).characterId).toBe('eliza');
      restore();
    });

    const sentences = (text = 'One.') => [
      { id: 1, chapterId: 1, text, characterId: 'narrator' },
      { id: 2, chapterId: 1, text: 'Two.', characterId: 'narrator' },
    ];

    /* C1 / C6 — a manuscript build is ONE unit: the refused `sentences` takes
       `mergedAwayKeys` with it, so nothing is re-sent (a split send would write
       the file without its tombstones, fs-58). */
    it('a manuscript 409 naming only sentences drops the whole build: nothing is re-sent', async () => {
      const { disk, store, restore } = setup({ sentences: sentences(), mergedAwayKeys: [] });
      disk.write('b1', 'manuscript', { sentences: sentences(), mergedAwayKeys: [] });
      learn(store, disk.revisions('b1'), store.dispatch(beginFullRead('b1')) as unknown as number);
      disk.failNext(1, (_id, req) => req.slice === 'manuscript');
      store.dispatch(manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'eliza' }));
      await advance(600);
      disk.write('b1', 'manuscript', { sentences: sentences('Theirs.'), mergedAwayKeys: [] });
      await advance(5000);
      expect(outcomes(disk)).toEqual(['503', '409']);
      expect(reqs().filter((r) => r.slice === 'manuscript')).toHaveLength(2);
      expect((disk.books.get('b1')!.manuscript!.sentences[0] as { text: string }).text).toBe('Theirs.');
      expect(staleToasts(store)).toHaveLength(1);
      expect(marks(store)).toBe(1);
      expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
      restore();
    });

    /* C2 — a bulk reassignment still unsent owns the unit's failure toast even
       when a plain edit rode along in the same window. */
    it('a plain manuscript edit made after a bulk reassignment keeps the bulk toast on a refusal', async () => {
      const { disk, store, restore } = setup({ sentences: sentences(), mergedAwayKeys: [] });
      disk.refuseNext('book_busy', (_id, req) => req.slice === 'manuscript');
      store.dispatch(
        manuscriptActions.setSentencesCharacterBulk({
          keys: [{ chapterId: 1, sentenceId: 1 }],
          characterId: 'eliza',
          targetLabel: 'Eliza',
        }),
      );
      store.dispatch(manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 2, characterId: 'eliza' }));
      await advance(600);
      expect(outcomes(disk)).toEqual(['refused']);
      expect(toastKeys(store)).toContain('bulk-reassign-persist-failed');
      expect(toastKeys(store)).not.toContain('book-persist-failed:b1');
      expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
      restore();
    });

    /* C6 — a 409 with no usable `fields` reads as "every based unit": the kept
       castConfirmed (which has a base) is dropped, the live commit that rode
       beside it (no base) is not, and the flight ends after the follow-up. */
    it.each([
      { name: 'missing', fields: undefined },
      { name: 'empty', fields: [] },
    ])('a stale 409 with $name fields drops the based unit only, and the live fields go in a follow-up', async ({ fields }) => {
      const { disk, store, restore } = setup();
      await keepConfirm(store, disk);
      putBookState.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('Book state PUT failed (409): stale'), { code: 'stale_revision', fields }),
        ),
      );
      commit(store, 'title', 'T');
      await advance(5000);
      expect(marks(store)).toBe(1);
      fullRead(store, disk);
      await advance(600);
      expect(reqs().at(-2)!.patch).toMatchObject({ castConfirmed: true, title: 'T' });
      expect(reqs().at(-1)!.patch).toMatchObject({ title: 'T' });
      expect(reqs().at(-1)!.patch).not.toHaveProperty('castConfirmed');
      expect(stateOnDisk(disk)).toMatchObject({ title: 'T', castConfirmed: false });
      expect(staleToasts(store)).toHaveLength(1);
      expect(marks(store)).toBeUndefined();
      expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
      restore();
    });

    /* C6 / termination — a 4xx on a send with no rollback handler is final: its
       entries go, nothing is kept, and the flight ends. (Capped, as below: a
       loop would otherwise never yield.) */
    it('a 404 drops the key’s outbox and ends the flight: one send, nothing kept', async () => {
      const { disk, store, restore } = setup();
      let sends = 0;
      putBookState.mockImplementation(() => {
        sends += 1;
        return sends > 6 ? Promise.resolve(undefined) : Promise.reject(new Error('Book state PUT failed (404): Book not found'));
      });
      rename(store, 'Eliza X');
      await advance(10_000);
      expect(sends).toBe(1);
      expect(castName(disk)).toBe('Eliza');
      expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
      expect(sends).toBe(1);
      restore();
    });

    it('a stale refusal of a send that carried no base is final: one send, one toast, one mark, no loop', async () => {
      const { disk, store, restore } = setup();
      /* The server only names fields that had a base, so this is a mock or a
         future server. It is capped: a loop would otherwise never yield. */
      let sends = 0;
      putBookState.mockImplementation(() => {
        sends += 1;
        return Promise.reject(
          sends > 6
            ? new Error('Book state PUT failed (400): loop cap')
            : Object.assign(new Error('Book state PUT failed (409): stale'), { code: 'stale_revision', fields: ['title'] }),
        );
      });
      commit(store, 'title', 'Mine');
      await advance(10_000);
      expect(sends).toBe(1);
      expect(staleToasts(store)).toHaveLength(1);
      expect(marks(store)).toBe(1);
      expect(stateOnDisk(disk).title).toBe('The Northern Star');
      restore();
    });

    it('a full read is ignored only for the fields a PUT landed on since it was stamped', async () => {
      const { disk, store, restore } = setup();
      disk.write('b1', 'state', { ...stateOnDisk(disk), title: 'X' });
      const seq = store.dispatch(beginFullRead('b1')) as unknown as number;
      const read = disk.revisions('b1');
      store.dispatch({ type: 'ui/confirmCast' });
      await advance(500);
      learn(store, read, seq);
      store.dispatch(
        bookMetaActions.hydrateFromBookState({
          bookId: 'b1',
          state: { title: 'X', author: 'Marin Vale', series: '', prosodyEnabled: false } as never,
        }),
      );
      disk.failNext(1, isTitle);
      commit(store, 'title', 'Y');
      await advance(2000);
      const retry = reqs().find((r, i) => i > 0 && 'title' in r.patch && r.baseRevision);
      expect(retry?.baseRevision?.title).toBe(read.state.title);
      expect(stateOnDisk(disk).title).toBe('Y');
      restore();
    });


    /* #3784 P1 (review pass 8) — a marked book's book-meta sends wait for its
       full read; the read's drop of kept saves does not take them. */
    it('P1: a marked book holds its state sends until its full read lands, then sends them', async () => {
      const { disk, store, restore } = setup();
      store.dispatch(bookMetaActions.markNeedsFullRead({ bookId: 'b1' }));
      store.dispatch({ type: 'ui/confirmCast' });
      rename(store, 'Eliza X');
      await advance(10_000);
      expect(reqs().map((r) => r.slice)).toEqual(['cast']);
      expect(store.dispatch(flushBookPersistence('b1'))).toBeNull();
      fullRead(store, disk);
      await advance(0);
      expect(stateOnDisk(disk).castConfirmed).toBe(true);
      restore();
    });

    it('P1 control: a mark on another book holds nothing', async () => {
      const { disk, store, restore } = setup();
      store.dispatch(bookMetaActions.markNeedsFullRead({ bookId: 'b2' }));
      store.dispatch({ type: 'ui/confirmCast' });
      await advance(600);
      expect(stateOnDisk(disk).castConfirmed).toBe(true);
      restore();
    });

  });
});
