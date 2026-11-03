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
import { uiSlice, uiActions } from './ui-slice';
import { castSlice, castActions } from './cast-slice';

const fetchMock = vi.fn();
const refusal = () => new Response(JSON.stringify({ code: 'book_repaired_reload', error: 'x' }), { status: 409 });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeStore(heldBookId: string | null, stageBookId: string | null = null) {
  const store = configureStore({
    reducer: {
      bookMeta: bookMetaSlice.reducer,
      library: librarySlice.reducer,
      notifications: notificationsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      cast: castSlice.reducer,
      ui: uiSlice.reducer,
    } as never,
  });
  if (heldBookId) store.dispatch(manuscriptActions.resetForBook(heldBookId));
  if (stageBookId) store.dispatch(uiActions.openBook({ id: stageBookId, status: 'complete' }));
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

  it('a book the stage SHOWS is left to the full read the mark triggers: no token is committed here', async () => {
    makeStore('b1', 'b1');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(h.getBookState).not.toHaveBeenCalled();
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
  });

  /* PR #4004 pass 3, finding 1: Layout reads only while the stage shows the book, so a tab that
     left it for the Library with its slices still holding it has no read coming. */
  it('a book the slices hold but the stage does NOT show is read and committed: the retry passes', async () => {
    makeStore('b1');
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
    await flush();
    await flush();
    expect(h.getBookState).toHaveBeenCalledWith('b1');
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(204);
  });

  it('the four-click repro: Edit clicked 4 times on a Library row for a held book is refused once, then passes', async () => {
    makeStore('b1');
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await bookFetch('/api/books/b1/state', { method: 'PUT' })).status);
      await flush();
      await flush();
    }
    expect(statuses[0]).toBe(409);
    expect(statuses.slice(1)).toEqual([204, 204, 204]);
    expect(h.getBookState).toHaveBeenCalledTimes(1);
  });

  /* PR #4004 pass 3, finding 2: the commit arms every save the middleware kept from before it. */
  it('drops kept saves, based state saves included, before committing the token', async () => {
    const store = makeStore('b1');
    const seen: unknown[] = [];
    const dispatch = store.dispatch.bind(store);
    store.dispatch = ((a: { type?: string }) => {
      seen.push(a);
      return dispatch(a as never);
    }) as typeof store.dispatch;
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(seen).toContainEqual({
      type: 'persistence/dropRetained',
      payload: 'b1',
      onFullRead: true,
      dropBased: true,
      dropQueued: true,
    });
  });

  /* PR #4004 pass 4, finding 1: the token vouches for what the slices hold, so slices still holding
     the OTHER twin under this id are reset before it is committed. */
  const names = (s: S) =>
    (s.getState() as unknown as { cast: { characters: { name: string }[] } }).cast.characters.map((c) => c.name);
  const seedCast = (s: S) =>
    s.dispatch(castActions.hydrateCharacters([{ id: 'l', name: 'Loser Row', role: '', color: 'narrator' }] as never));

  it('slices holding the refused book (stage elsewhere) are reset before the token is committed', async () => {
    const store = makeStore('b1');
    seedCast(store);
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(names(store)).toEqual([]);
    expect((store.getState() as unknown as { manuscript: { bookId: string } }).manuscript.bookId).toBe('b1');
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(204);
  });

  it('slices holding ANOTHER book are left alone', async () => {
    const store = makeStore('other');
    seedCast(store);
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(names(store)).toEqual(['Loser Row']);
  });

  it('a book the stage shows by the time the read returns is not reset or committed here', async () => {
    const store = makeStore('b1');
    seedCast(store);
    h.getBookState.mockImplementation(async (id: string) => {
      await bookFetch(`/api/books/${id}/state`);
      store.dispatch(uiActions.openBook({ id: 'b1', status: 'complete' }));
      return {};
    });
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(names(store)).toEqual(['Loser Row']);
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
  });

  it('a failing book re-read leaves the slices alone and the refusal in place', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.getBookState.mockRejectedValue(new Error('down'));
    const store = makeStore('b1');
    seedCast(store);
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(names(store)).toEqual(['Loser Row']);
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
    warn.mockRestore();
  });

  it('a failing book re-read leaves the refusal in place and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.getBookState.mockRejectedValue(new Error('down'));
    makeStore('b1');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    await flush();
    await flush();
    expect(warn).toHaveBeenCalled();
    expect((await bookFetch('/api/books/b1', { method: 'DELETE' })).status).toBe(409);
    warn.mockRestore();
  });

  /* PR #4004 pass 5: a series fan-out skips a repaired mate it holds no token for and says so in a header. */
  describe('a series fan-out that skipped a repaired book', () => {
    const skippedResponse = (list: unknown) =>
      new Response('{}', { headers: { 'x-skipped-repaired-books': encodeURIComponent(JSON.stringify(list)) } });

    it('toasts once, as info, naming each skipped book and what to do', async () => {
      const store = makeStore('other');
      fetchMock.mockResolvedValueOnce(
        skippedResponse([
          { bookId: 'b9', bookTitle: 'Wëird "Title"', reason: 'x' },
          { bookId: 'b8', bookTitle: 'Second', reason: 'x' },
        ]),
      );
      await bookFetch('/api/voices/v1/override', { method: 'PUT' });
      const toasts = root(store).notifications.toasts.filter((t) => (t as { kind?: string }).kind === 'info');
      expect(toasts).toHaveLength(1);
      expect(toasts[0].message).toContain('Wëird "Title"');
      expect(toasts[0].message).toContain('Second');
      expect(toasts[0].message).toMatch(/reopen/i);
    });

    it('a response without the header toasts nothing', async () => {
      const store = makeStore('other');
      fetchMock.mockResolvedValueOnce(new Response('{}'));
      await bookFetch('/api/voices/v1/override', { method: 'PUT' });
      expect(root(store).notifications.toasts).toHaveLength(0);
    });

    it('a malformed header is ignored, not thrown', async () => {
      const store = makeStore('other');
      fetchMock.mockResolvedValueOnce(new Response('{}', { headers: { 'x-skipped-repaired-books': '%7Bnot-json' } }));
      await expect(bookFetch('/api/voices/v1/override', { method: 'PUT' })).resolves.toBeDefined();
      expect(root(store).notifications.toasts).toHaveLength(0);
    });
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
