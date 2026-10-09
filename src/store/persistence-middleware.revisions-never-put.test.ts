/* Plan 286 — the client never PUTs revisions.json (invariant 1). Drives the
   revisions actions through a store with the real persistence middleware,
   with the old gate OPEN (book hydrated), flushes, and checks every
   putBookState call. */
import { describe, it, expect, vi, expectTypeOf } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { StateSlice, PutStateRequest } from '../lib/types';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn(async (_bookId: string, _req: PutStateRequest) => {}),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { putBookState } }));

import { persistenceMiddleware, flushBookPersistence } from './persistence-middleware';
import { revisionsSlice, revisionsActions } from './revisions-slice';
import { uiSlice, uiActions } from './ui-slice';

const STATE = { bookId: 'A', fileId: '000000000000001-a', rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline: {} };

function hydratedStore() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer }, middleware: (g) => g().concat(persistenceMiddleware) });
  store.dispatch(uiActions.openBook({ id: 'A', status: 'complete' } as never));
  store.dispatch(revisionsActions.hydrate({ bookId: 'A', state: STATE }));
  return store;
}

describe('no revisions PUT (plan 286)', () => {
  it('StateSlice cannot name revisions', () => {
    expectTypeOf<'revisions'>().not.toMatchTypeOf<StateSlice>();
  });
  it("none of today's revisions actions schedules a PUT, even with the book hydrated", async () => {
    const store = hydratedStore();
    store.dispatch(revisionsActions.acceptAllPending());
    store.dispatch(revisionsActions.rejectAllPending());
    store.dispatch(revisionsActions.dismissDrift('d'));
    store.dispatch(revisionsActions.acceptRevision({ revisionId: 'r', selection: {} }));
    store.dispatch(revisionsActions.rejectRevision('r'));
    store.dispatch(revisionsActions.rolledBack({ chapterId: 1, timelineEntryId: 't', rolledBackId: 'x' }));
    store.dispatch(revisionsActions.enqueuePending({ id: 'p', chapterId: 1, characterId: 'c', segments: [] }));
    store.dispatch(revisionsActions.markRevisionPlayable({ chapterId: 1 }));
    store.dispatch(revisionsActions.persistPendingAfterHydrateMerge());
    await store.dispatch(flushBookPersistence('A') as never);
    expect(putBookState.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'revisions')).toEqual([]);
  });
});
