import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetBookReadTokensForTest,
  bookFetch,
  commitBookReadToken,
  rememberManuscriptBook,
  setRepairedBookHandler,
} from './book-read-token';

const fetchMock = vi.fn();
const stateRead = (token?: string) =>
  new Response('{}', { status: 200, headers: token ? { 'x-book-read-token': token } : {} });
const repairedRefusal = () =>
  new Response(JSON.stringify({ error: 'repaired', code: 'book_repaired_reload' }), { status: 409 });
const echoed = (call: number) => new Headers((fetchMock.mock.calls[call][1] as RequestInit | undefined)?.headers).get('x-book-read-token');

beforeEach(() => {
  __resetBookReadTokensForTest();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('bookFetch (#3713)', () => {
  it('sends a request on a book with no token exactly as given', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    const init = { method: 'DELETE' };
    await bookFetch('/api/books/b1', init);
    expect(fetchMock).toHaveBeenCalledWith('/api/books/b1', init);
  });

  it('a state read ISSUES the token but writes do not echo it until a full hydrate commits it', async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET' ? stateRead('tok') : new Response('{}'),
    );
    await bookFetch('/api/books/b1/state');
    await bookFetch('/api/books/b1/state', { method: 'PUT' });
    expect(echoed(1)).toBeNull();
    commitBookReadToken('b1');
    await bookFetch('/api/books/b1/state', { method: 'PUT' });
    expect(echoed(2)).toBe('tok');
  });

  it('echoes only on the book it was issued for', async () => {
    fetchMock.mockResolvedValueOnce(stateRead('tok')).mockResolvedValue(new Response('{}'));
    await bookFetch('/api/books/b1/state');
    commitBookReadToken('b1');
    await bookFetch('/api/books/b2', { method: 'DELETE' });
    expect(echoed(1)).toBeNull();
  });

  it('commits nothing for a read that carried no token (nothing was repaired)', async () => {
    fetchMock.mockResolvedValue(stateRead());
    await bookFetch('/api/books/b1/state');
    commitBookReadToken('b1');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    expect(echoed(1)).toBeNull();
  });

  it('a failed state read issues nothing', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500, headers: { 'x-book-read-token': 'tok' } }));
    await bookFetch('/api/books/b1/state');
    commitBookReadToken('b1');
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    expect(echoed(1)).toBeNull();
  });

  it('a manuscript-keyed write echoes the token of the book that manuscript was read from', async () => {
    fetchMock.mockResolvedValueOnce(stateRead('tok')).mockResolvedValue(new Response('{}'));
    await bookFetch('/api/books/b1/state');
    commitBookReadToken('b1');
    rememberManuscriptBook('m_1', 'b1');
    await bookFetch('/api/manuscripts/m_1/analysis', { method: 'POST' });
    expect(echoed(1)).toBe('tok');
    await bookFetch('/api/manuscripts/m_other/analysis', { method: 'POST' });
    expect(echoed(2)).toBeNull();
  });

  it('a 409 book_repaired_reload on a write tells the handler which book, and the caller still sees the response', async () => {
    const handler = vi.fn();
    setRepairedBookHandler(handler);
    fetchMock.mockResolvedValue(repairedRefusal());
    const res = await bookFetch(`/api/books/${encodeURIComponent('a__s__t')}`, { method: 'DELETE' });
    expect(handler).toHaveBeenCalledWith('a__s__t');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('book_repaired_reload');
  });

  it('an ordinary 409, a 409 on a read, and a non-JSON 409 leave the handler alone', async () => {
    const handler = vi.fn();
    setRepairedBookHandler(handler);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy' }), { status: 409 }));
    await bookFetch('/api/books/b1/state', { method: 'PUT' });
    fetchMock.mockResolvedValueOnce(repairedRefusal());
    await bookFetch('/api/books/b1/state');
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 409 }));
    await bookFetch('/api/books/b1', { method: 'DELETE' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('requests outside /api/books and /api/manuscripts pass through untouched', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    const init = { method: 'POST' };
    await bookFetch('/api/library', init);
    expect(fetchMock).toHaveBeenCalledWith('/api/library', init);
  });

  it('a mocked fetch result without headers or clone does not throw', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(bookFetch('/api/books/b1/state')).resolves.toBeTruthy();
    fetchMock.mockResolvedValue({ ok: false, status: 409 });
    await expect(bookFetch('/api/books/b1', { method: 'DELETE' })).resolves.toBeTruthy();
  });
});
