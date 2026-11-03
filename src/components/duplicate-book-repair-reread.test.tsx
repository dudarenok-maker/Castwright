import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { AppInfo, Character } from '../lib/types';

const h = vi.hoisted(() => ({
  info: null as unknown,
  putBookState: vi.fn(),
  getLibrary: vi.fn(async () => ({ authors: [] })),
  getBookState: vi.fn(async () => ({})),
}));
vi.mock('../lib/api', () => ({
  api: { putBookState: h.putBookState, getLibrary: h.getLibrary, getBookState: h.getBookState },
}));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: vi.fn(async () => {}) }),
}));

import { DuplicateBookRepairReread } from './duplicate-book-repair-reread';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { castActions } from '../store/cast-slice';
import { installRepairedBookHandler, BOOK_REPAIRED_MESSAGE } from '../store/repaired-book-handler';
import { __resetBookReadTokensForTest, bookFetch } from '../lib/book-read-token';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { bookMetaSlice, bookMetaActions } from '../store/book-meta-slice';
import { notificationsSlice } from '../store/notifications-slice';

const repair = {
  previousBookId: 'a__s__t',
  newBookId: 'a__s__t-2',
  keptFolder: 'A/S/T2',
  reassignedFolder: 'A/S/T',
  reassignedManuscriptId: null as string | null,
};
const info = (repairs: (typeof repair)[]): AppInfo =>
  ({
    appVersion: '1.8.0',
    sidecarVersion: null,
    schemas: {},
    lastSeenAppVersion: null,
    showWhatsNew: false,
    releaseNotes: '',
    duplicateBookIdRepairs: repairs,
  }) as AppInfo;

/** `stage` is the view the tab is on; the slices hold `openBookId` either way (leaving a book keeps them). */
function makeStore(
  openBookId: string,
  manuscriptId: string | null,
  stage: 'ready' | 'books' = 'ready',
  withPersistence = false,
) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      chapters: chaptersSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      notifications: notificationsSlice.reducer,
    } as never,
    preloadedState: {
      ui: {
        stage:
          stage === 'ready'
            ? { kind: 'ready', bookId: openBookId, view: 'cast', currentChapterId: 3, openProfileId: null }
            : { kind: 'books' },
      },
    } as never,
    middleware: (gDM) => {
      const base = gDM({ serializableCheck: false, immutableCheck: false });
      return withPersistence ? base.concat(persistenceMiddleware) : base;
    },
  });
  /* The tab loaded this book: its slices carry its identity. */
  store.dispatch(manuscriptActions.resetForBook(openBookId));
  store.dispatch(
    manuscriptActions.hydrateFromBookState({ state: { bookId: openBookId, manuscriptId, title: 'T', chapters: [] } as never } as never),
  );
  return store;
}
type S = ReturnType<typeof makeStore>;
const root = (store: S) =>
  store.getState() as unknown as {
    ui: { stage: { bookId?: string } };
    bookMeta: { needsFullRead?: Record<string, number> };
    manuscript: { manuscriptId: string | null; bookId: string | null };
  };

const tree = (store: S) => (
  <Provider store={store as never}>
    <DuplicateBookRepairReread />
  </Provider>
);

beforeEach(() => {
  vi.useFakeTimers();
  h.info = null;
});
afterEach(() => vi.useRealTimers());

describe('DuplicateBookRepairReread (#3713)', () => {
  it('a repair already in the first /api/info answer changes nothing (the tab loaded after the sweep)', () => {
    h.info = info([repair]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]); // the next poll lists it again
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeUndefined();
  });

  it('a repair that appears later, for the open id: marks a full read of that id and stays on it', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
    expect(root(store).ui.stage.bookId).toBe('a__s__t');
  });

  it('a tab that LEFT the book but still holds its slices is marked too (reopening must not trust them)', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x', 'books');
    expect(root(store).ui.stage.bookId).toBeUndefined();
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
  });

  it('a tab proven to hold the re-minted twin moves to the new id and reads it', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_loser');
    const view = render(tree(store));
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t-2');
    expect(root(store).manuscript.bookId).toBe('a__s__t-2');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t-2']).toBeGreaterThan(0);
  });

  it("a tab whose manuscriptId is not the loser's (the kept twin) re-reads the same id", () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_winner');
    const view = render(tree(store));
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
  });

  it('a tab with no manuscript loaded is not taken for the loser when the record names none', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', null);
    const view = render(tree(store));
    expect(root(store).manuscript.manuscriptId).toBeNull();
    h.info = info([repair]); // reassignedManuscriptId: null
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
    expect(root(store).bookMeta.needsFullRead?.['a__s__t-2']).toBeUndefined();
  });

  it('a tab on another book is left alone', () => {
    h.info = info([]);
    const store = makeStore('other', 'm_o');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeUndefined();
  });

  it('acts once per repair: a later poll that lists it again does nothing more', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    const mark = root(store).bookMeta.needsFullRead?.['a__s__t'];
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBe(mark);
  });
});

describe('the rebind meets the server gate (#3713)', () => {
  const eliza = (name: string) => ({ id: 'c1', name, role: '', color: 'narrator' }) as Character;
  const accepted = { writes: 0 };
  const toasts = (store: S) =>
    (store.getState() as unknown as { notifications: { toasts: { message: string }[] } }).notifications.toasts.map(
      (t) => t.message,
    );

  beforeEach(() => {
    __resetBookReadTokensForTest();
    accepted.writes = 0;
    h.putBookState.mockReset();
    h.getLibrary.mockClear();
    /* The gate: every write on the repaired id is refused until a token is echoed, and no token is committed here. */
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response('{}', { headers: { 'x-book-read-token': 'tok' } });
      if (new Headers(init?.headers).get('x-book-read-token') !== 'tok') {
        return new Response(JSON.stringify({ error: 'repaired', code: 'book_repaired_reload' }), { status: 409 });
      }
      accepted.writes += 1;
      return new Response('{}');
    });
    h.putBookState.mockImplementation(async (id: string, req: unknown) => {
      const res = await bookFetch(`/api/books/${id}/state`, { method: 'PUT', body: JSON.stringify(req) });
      if (!res.ok) {
        const body = (await res.json()) as { code?: string };
        throw Object.assign(new Error(`Book state PUT failed (${res.status}): refused`), { code: body.code });
      }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('an edit queued on the copy tab when it is rebound is refused (the old id belongs to the kept twin), and the user is told', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_loser', 'ready', true);
    installRepairedBookHandler(store);
    const view = render(tree(store));
    act(() => void store.dispatch(castActions.setCharacters([eliza('Stale')])));
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(root(store).ui.stage.bookId).toBe('a__s__t-2');
    expect(accepted.writes).toBe(0);
    expect(toasts(store)).toContain(BOOK_REPAIRED_MESSAGE);
    err.mockRestore();
  });

  it('an uncommitted details draft typed on the copy tab survives the rebind', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_loser', 'ready', true);
    act(() => void store.dispatch(bookMetaActions.setDraftField({ field: 'title', value: 'Typed' })));
    const view = render(tree(store));
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t-2');
    expect((store.getState() as unknown as { bookMeta: { draft: unknown } }).bookMeta.draft).toEqual({ title: 'Typed' });
  });
});
