/* #3754 / #3624 — an unsaved book-meta draft typed on book B must never fold
   into another book's `saved` when the stage moves to A. Drives a REAL store
   (ui, bookMeta, manuscript, cast, changeLog, notifications) with the
   persistence middleware through every route to A: a direct `openBook`, a
   library round trip (`goHome`), and URL hydration (`hydrateFromUrl`).
   Controls (c) and (d) pin the boundaries: a library round trip back to the
   SAME book keeps the draft, and a view change within a book keeps it. (e)
   and (f) pin a save that fails after B was left: kept and re-sent (#3784). */
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

/* A commit on A with something typed, so a save to A is sent (#3784 review pass 9:
   a details save carries only the typed fields; an empty commit sends nothing). */
const commitOnA = (store: Store) => {
  store.dispatch(bookMetaActions.setDraftField({ field: 'notes', value: 'A note' }));
  store.dispatch(bookMetaActions.commitDraft({ bookId: 'A' }));
};

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
    commitOnA(store);
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
    commitOnA(store);
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
    commitOnA(store);
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

  /* #3784 (owner decision) — a save for B that finally fails after B was left
     is not rolled back, whether the user is in another book or on the library:
     it is kept and re-sent on B's next flush (guarded by the revision check).
     The draft is never restored, so B's text cannot reach another book. Every
     try rejects, and fake timers run out the retries (1s / 2s / 4s). */
  const failEveryTryThenRecover = async (store: Store, leave: () => void) => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      putBookState.mockRejectedValue(new Error('Book state PUT failed (500)'));
      openBook(store, 'B');
      typeDraftOnB(store);
      store.dispatch(bookMetaActions.commitDraft({ bookId: 'B' }));
      /* Leaving sends B's queued PUT at once (S3). */
      leave();
      expect(putsTo('B')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20000);
      /* The first try plus three retries, all refused. */
      expect(putsTo('B')).toHaveLength(4);
    } finally {
      putBookState.mockReset();
      putBookState.mockImplementation(async () => {});
      errSpy.mockRestore();
    }
  };

  const expectKeptAndResent = async (store: Store) => {
    const before = putsTo('B').length;
    const flushed = store.dispatch(flushBookPersistence('B') as never);
    await vi.advanceTimersByTimeAsync(20000);
    await flushed;
    const resent = putsTo('B').slice(before);
    expect(resent.some((c) => (c[1] as { patch: { title?: string } }).patch?.title === 'B DRAFT')).toBe(true);
    vi.useRealTimers();
  };

  it("(e) a save for B that FAILS after A is opened is kept and re-sent, and B's text never reaches A", async () => {
    const store = makeStore();
    await failEveryTryThenRecover(store, () => openBook(store, 'A'));
    /* Not rolled back: saved[B] keeps the value its kept save will write. */
    expect(store.getState().bookMeta.saved.B?.title).toBe('B DRAFT');
    expect(store.getState().bookMeta.draft).toBeNull();
    commitOnA(store);
    const flushedA = store.dispatch(flushBookPersistence('A') as never);
    await vi.advanceTimersByTimeAsync(1000);
    await flushedA;
    expect(putsTo('A').length).toBeGreaterThan(0);
    for (const c of putsTo('A')) expect(JSON.stringify(c[1])).not.toContain('B DRAFT');
    expect(store.getState().bookMeta.saved.A?.title).toBe('A title');
    await expectKeptAndResent(store);
  });

  it('(f) a save for B that FAILS while the user is on the library is kept and re-sent, not rolled back', async () => {
    const store = makeStore();
    await failEveryTryThenRecover(store, () => store.dispatch(uiActions.goHome()));
    expect(store.getState().bookMeta.saved.B?.title).toBe('B DRAFT');
    expect(store.getState().bookMeta.draft).toBeNull();
    await expectKeptAndResent(store);
  });

  /* P6-1 — a 4xx is final: nothing is kept, so after the book was left `saved`
     must stop claiming the refused title (reverted), without the draft being
     restored into a closed book or another one. */
  const refusedAfterLeaving = async (leave: (store: Store) => void) => {
    const store = makeStore();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      putBookState.mockRejectedValue(
        new Error('Book state PUT failed (409): A book already exists at that Author/Series/Title path.'),
      );
      openBook(store, 'B');
      typeDraftOnB(store);
      store.dispatch(bookMetaActions.commitDraft({ bookId: 'B' }));
      leave(store);
      await store.dispatch(flushBookPersistence('B') as never);
      /* A 4xx is not retried. */
      expect(putsTo('B')).toHaveLength(1);
    } finally {
      putBookState.mockReset();
      putBookState.mockImplementation(async () => {});
      errSpy.mockRestore();
    }
    return store;
  };

  it('(g) a 4xx refusal for B that arrives on the library reverts saved, restores no draft', async () => {
    const store = await refusedAfterLeaving((s) => s.dispatch(uiActions.goHome()));
    expect(store.getState().bookMeta.saved.B?.title).toBe('B title');
    expect(store.getState().bookMeta.lastCommitted?.B).toBeUndefined();
    expect(store.getState().bookMeta.draft).toBeNull();
  });

  it("(h) a 4xx refusal for B that arrives inside book A reverts B's saved and leaves A untouched", async () => {
    const store = await refusedAfterLeaving((s) => openBook(s, 'A'));
    expect(store.getState().bookMeta.saved.B?.title).toBe('B title');
    expect(store.getState().bookMeta.lastCommitted?.B).toBeUndefined();
    expect(store.getState().bookMeta.draft).toBeNull();
    expect(store.getState().bookMeta.saved.A?.title).toBe('A title');
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
