/* #3754 / #3624 — an unsaved book-meta draft typed on book B must never fold
   into another book's `saved` when the stage moves to A. Drives a REAL store
   (ui, bookMeta, manuscript, cast, changeLog, notifications) with the
   persistence middleware through every route to A: a direct `openBook`, a
   library round trip (`goHome`), and URL hydration (`hydrateFromUrl`).
   Controls (c) and (d) pin the boundaries: a library round trip back to the
   SAME book keeps the draft, and a view change within a book keeps it. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { PutStateRequest, Stage } from '../lib/types';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn(async (_bookId: string, _req: PutStateRequest) => {}),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { putBookState } }));

import { persistenceMiddleware, flushBookPersistence } from './persistence-middleware';
import { bookMetaActions, bookMetaSlice } from './book-meta-slice';
import { uiSlice, uiActions } from './ui-slice';
import { manuscriptSlice } from './manuscript-slice';
import { castSlice } from './cast-slice';
import { changeLogSlice } from './change-log-slice';
import { notificationsSlice } from './notifications-slice';

type Store = ReturnType<typeof makeStore>;

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      cast: castSlice.reducer,
      changeLog: changeLogSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (g) => g().concat(persistenceMiddleware),
  });
  /* Seed saved[A] / saved[B] the way a book open does (before any typing —
     hydrateFromBookState clears the draft). */
  store.dispatch(
    bookMetaActions.hydrateFromBookState({ bookId: 'A', state: { title: 'A title', author: '', series: '' } }),
  );
  store.dispatch(
    bookMetaActions.hydrateFromBookState({ bookId: 'B', state: { title: 'B title', author: '', series: '' } }),
  );
  return store;
}

const openBook = (store: Store, id: string) => store.dispatch(uiActions.openBook({ id, status: 'complete' }));

const typeDraftOnB = (store: Store) =>
  store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'B DRAFT' }));

/* A ready Stage, built the way ui-slice's `openBook` does for a complete book
   ('complete' → view 'listen', READY_DEFAULTS for the rest). */
const readyStage = (bookId: string): Stage => ({
  kind: 'ready',
  bookId,
  view: 'listen',
  currentChapterId: 3,
  openProfileId: null,
});

const putsTo = (bookId: string) => putBookState.mock.calls.filter((c) => c[0] === bookId);

describe('persistenceMiddleware — meta draft clear on book switch (#3754, #3624)', () => {
  beforeEach(() => {
    putBookState.mockClear();
  });

  it('(a) direct switch: a draft typed on B never lands in A', async () => {
    const store = makeStore();
    openBook(store, 'B');
    typeDraftOnB(store);
    openBook(store, 'A');
    expect(store.getState().bookMeta.draft).toBeNull();
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'A' }));
    await store.dispatch(flushBookPersistence('A') as never);
    expect(putsTo('A').length).toBeGreaterThan(0);
    for (const c of putsTo('A')) expect(JSON.stringify(c[1])).not.toContain('B DRAFT');
    expect(store.getState().bookMeta.saved.A?.title).toBe('A title');
  });

  it('(b) via the library: B -> home -> A never carries the draft', async () => {
    const store = makeStore();
    openBook(store, 'B');
    typeDraftOnB(store);
    store.dispatch(uiActions.goHome());
    openBook(store, 'A');
    expect(store.getState().bookMeta.draft).toBeNull();
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'A' }));
    await store.dispatch(flushBookPersistence('A') as never);
    expect(putsTo('A').length).toBeGreaterThan(0);
    for (const c of putsTo('A')) expect(JSON.stringify(c[1])).not.toContain('B DRAFT');
    expect(store.getState().bookMeta.saved.A?.title).toBe('A title');
  });

  it('(b) via a URL: B -> hydrateFromUrl(ready A) never carries the draft', async () => {
    const store = makeStore();
    openBook(store, 'B');
    typeDraftOnB(store);
    store.dispatch(uiActions.hydrateFromUrl(readyStage('A')));
    expect(store.getState().bookMeta.draft).toBeNull();
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'A' }));
    await store.dispatch(flushBookPersistence('A') as never);
    expect(putsTo('A').length).toBeGreaterThan(0);
    for (const c of putsTo('A')) expect(JSON.stringify(c[1])).not.toContain('B DRAFT');
    expect(store.getState().bookMeta.saved.A?.title).toBe('A title');
  });

  it('(c) control: a library round trip back to the SAME book keeps the draft', async () => {
    const store = makeStore();
    openBook(store, 'B');
    typeDraftOnB(store);
    store.dispatch(uiActions.goHome());
    openBook(store, 'B');
    expect(store.getState().bookMeta.draft).toEqual({ title: 'B DRAFT' });
    store.dispatch(bookMetaActions.commitDraft({ bookId: 'B' }));
    await store.dispatch(flushBookPersistence('B') as never);
    const puts = putsTo('B');
    expect(puts.length).toBeGreaterThan(0);
    expect(puts.some((c) => (c[1] as { patch: { title?: string } }).patch?.title === 'B DRAFT')).toBe(true);
    expect(store.getState().bookMeta.saved.B?.title).toBe('B DRAFT');
  });

  it('(d) control: a view change within the same book keeps the draft', () => {
    const store = makeStore();
    openBook(store, 'B');
    typeDraftOnB(store);
    store.dispatch(uiActions.changeView('cast'));
    expect(store.getState().bookMeta.draft).toEqual({ title: 'B DRAFT' });
    store.dispatch(uiActions.changeView('listen'));
    expect(store.getState().bookMeta.draft).toEqual({ title: 'B DRAFT' });
  });
});
