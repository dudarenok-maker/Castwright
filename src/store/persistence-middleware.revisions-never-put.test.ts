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
  /* One payload per action creator. `satisfies` makes a new revisions action
     without an entry here a compile error, so it cannot dodge this test. */
  const PAYLOADS = {
    hydrate: { bookId: 'A', state: STATE },
    applyServerState: STATE,
    applyPoll: { ...STATE, drift: [] },
    applyBackgroundPoll: { bookId: 'B', drift: [] },
    applyDismiss: { driftId: 'd', state: STATE },
    forgetBook: 'A',
  } satisfies { [K in keyof typeof revisionsActions]: Parameters<(typeof revisionsActions)[K]>[0] };

  it('no revisions action ever reaches putBookState', async () => {
    const store = hydratedStore();
    for (const [name, payload] of Object.entries(PAYLOADS)) {
      store.dispatch((revisionsActions as unknown as Record<string, (p: unknown) => { type: string }>)[name](payload));
    }
    await store.dispatch(flushBookPersistence('A') as never);
    expect(putBookState.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'revisions')).toEqual([]);
  });
});
