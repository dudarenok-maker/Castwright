/* #3395 pass 2, N1 — pins revisions-scope-middleware's own behaviour (react
   generically to any action that moves `ui.stage`'s bookId) plus the full
   end-to-end repro through a real store + the real persistence-middleware:
   a previous book's `pending` must never leak into, and must never be
   persisted for, a book that lands with no revisions.json on disk. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const { putBookStateSpy } = vi.hoisted(() => ({
  putBookStateSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({ api: { putBookState: putBookStateSpy } }));

import { uiSlice, uiActions } from './ui-slice';
import { revisionsSlice, revisionsActions } from './revisions-slice';
import { revisionsScopeMiddleware } from './revisions-scope-middleware';
import { persistenceMiddleware } from './persistence-middleware';

function makeStore() {
  return configureStore({
    reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer },
    middleware: (getDefault) =>
      getDefault().concat(revisionsScopeMiddleware, persistenceMiddleware),
  });
}

beforeEach(() => {
  putBookStateSpy.mockClear();
});

describe('revisionsScopeMiddleware', () => {
  it('dispatches bookScopeChanged when ui.stage.bookId diverges from revisions.bookId', () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'book-A', status: 'complete' }));
    expect(store.getState().revisions.bookId).toBe('book-A');
  });

  it('resets to null when navigation leaves the book context entirely (goHome)', () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'book-A', status: 'complete' }));
    store.dispatch(
      revisionsActions.hydrateFromBookState({ bookId: 'book-A', pending: [], drift: [] }),
    );
    store.dispatch(
      revisionsActions.enqueuePending({
        id: 'r1',
        chapterId: 1,
        characterId: 'nora',
        playable: false,
        segments: [],
      }),
    );
    expect(store.getState().revisions.pending).toHaveLength(1);

    store.dispatch(uiActions.goHome());
    expect(store.getState().revisions.bookId).toBeNull();
    expect(store.getState().revisions.pending).toEqual([]);
  });

  it('is a no-op (no extra dispatch/state churn) when the book has not changed', () => {
    const store = makeStore();
    store.dispatch(uiActions.openBook({ id: 'book-A', status: 'complete' }));
    const afterOpen = store.getState().revisions;
    store.dispatch(revisionsActions.dismissDrift('some-drift-id'));
    /* Same reference — bookScopeChanged's guard no-ops rather than
       re-assigning a fresh object when bookId is unchanged, so an unrelated
       action doesn't gratuitously touch the per-book fields. */
    expect(store.getState().revisions.bookId).toBe(afterOpen.bookId);
  });
});

describe('revisionsScopeMiddleware + persistenceMiddleware — N1 end-to-end repro', () => {
  it('a book with no revisions.json never inherits, and never persists, a previous book\'s pending', async () => {
    const store = makeStore();

    /* Open book A and seed it with a pending revision — mirrors the disk
       hydrate a book with real revisions.json would receive. */
    store.dispatch(uiActions.openBook({ id: 'book-A', status: 'complete' }));
    store.dispatch(
      revisionsActions.hydrateFromBookState({
        bookId: 'book-A',
        pending: [{ id: 'rA', chapterId: 1, characterId: 'nora', segments: [] }],
        drift: [],
      }),
    );
    expect(store.getState().revisions.pending.map((r) => r.id)).toEqual(['rA']);

    /* Navigate to book B — the scope reset must fire synchronously, before
       book B's own (possibly null) getBookState response ever lands. */
    store.dispatch(uiActions.openBook({ id: 'book-B', status: 'complete' }));
    expect(store.getState().revisions.pending).toEqual([]);

    /* Book B has no revisions.json — Layout dispatches hydrateFromBookState
       with a bookId but no revisions payload. */
    store.dispatch(revisionsActions.hydrateFromBookState({ bookId: 'book-B' }));
    expect(store.getState().revisions.pending).toEqual([]);

    /* Dismiss a drift on B — the reviewer's repro action that used to PUT
       book A's leaked `pending` into book B's revisions.json. */
    store.dispatch(revisionsActions.dismissDrift('some-drift-id'));
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(putBookStateSpy).toHaveBeenCalledWith(
      'book-B',
      expect.objectContaining({ slice: 'revisions', patch: expect.objectContaining({ pending: [] }) }),
    );
    const carriedRA = putBookStateSpy.mock.calls.some(
      ([bookId, body]) =>
        bookId === 'book-B' &&
        ((body as { patch: { pending: Array<{ id: string }> } }).patch.pending ?? []).some(
          (r) => r.id === 'rA',
        ),
    );
    expect(carriedRA).toBe(false);
  });
});
