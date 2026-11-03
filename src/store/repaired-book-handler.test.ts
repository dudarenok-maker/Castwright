import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const h = vi.hoisted(() => ({
  getLibrary: vi.fn(),
  getBookState: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api: { getLibrary: h.getLibrary, getBookState: h.getBookState } }));

import { installRepairedBookHandler, BOOK_REPAIRED_MESSAGE } from './repaired-book-handler';
import { __resetBookReadTokensForTest, bookFetch } from '../lib/book-read-token';
import { bookMetaSlice } from './book-meta-slice';
import { librarySlice } from './library-slice';
import { notificationsSlice } from './notifications-slice';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';

const fetchMock = vi.fn();
const refusal = () => new Response(JSON.stringify({ code: 'book_repaired_reload', error: 'x' }), { status: 409 });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeStore(heldBookId: string | null) {
  const store = configureStore({
    reducer: {
      bookMeta: bookMetaSlice.reducer,
      library: librarySlice.reducer,
      notifications: notificationsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
    } as never,
  });
  if (heldBookId) store.dispatch(manuscriptActions.resetForBook(heldBookId));
  installRepairedBookHandler(store);
  return store;
}
type S = ReturnType<typeof makeStore>;
const root = (s: S) =>
  s.getState() as unknown as {
    bookMeta: { needsFullRead?: Record<string, number> };
    notifications: { toasts: { message: string; dedupeKey?: string }[] };
    library: { loaded: boolean };
  };

beforeEach(() => {
  __resetBookReadTokensForTest();
  h.getLibrary.mockReset();
  h.getLibrary.mockResolvedValue({ authors: [], unfiled: [] });
  h.getBookState.mockReset();
  h.getBookState.mockImplementation(async (id: string) => {
    await bookFetch(`/api/books/${id}/state`);
    return {};
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return new Response('{}', { headers: { 'x-book-read-token': 'tok' } });
    return new Headers(init?.headers).get('x-book-read-token') === 'tok' ? new Response(null, { status: 204 }) : refusal();
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('the repaired-book handler (#3713)', () => {
  it('a refused write toasts once (path-free), marks the book for a full read and refreshes the Library', async () => {
    const store = makeStore('other');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    const toasts = root(store).notifications.toasts.filter((t) => t.dedupeKey === 'book-repaired:b1');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe(BOOK_REPAIRED_MESSAGE);
    expect(root(store).bookMeta.needsFullRead?.['b1']).toBeGreaterThan(0);
    expect(h.getLibrary).toHaveBeenCalled();
    expect(root(store).library.loaded).toBe(true);
  });

  it('a book these slices do not hold is read and committed, so the retry carries the token and passes', async () => {
    makeStore('other');
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
    await flush();
    await flush();
    expect(h.getBookState).toHaveBeenCalledWith('b1');
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(204);
  });

  it('a book these slices DO hold is left to the full read the mark triggers: no token is committed here', async () => {
    makeStore('b1');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(h.getBookState).not.toHaveBeenCalled();
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
  });

  it('a failing Library refresh is logged, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.getLibrary.mockRejectedValue(new Error('down'));
    makeStore('other');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
