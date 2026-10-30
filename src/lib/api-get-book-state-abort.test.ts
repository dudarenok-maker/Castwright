/* #3426 — the book-state read takes an AbortSignal so Layout can cancel a
   stalled read. The real path must hand the signal to fetch; the mock must
   reject with an AbortError on an already-aborted or mid-wait abort.

   Mocks global fetch, mirroring api-put-book-state-error.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, mockGetBookState } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.getBookState — abort signal (#3426)', () => {
  it('passes the signal through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();

    await api.getBookState('book-1', ctrl.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/books/book-1/state');
    expect(fetchMock.mock.calls[0][1]).toEqual({ signal: ctrl.signal });
  });
});

describe('mockGetBookState — abort signal (#3426)', () => {
  it('rejects with an AbortError when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(mockGetBookState('book-1', ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with an AbortError when aborted during the simulated latency', async () => {
    const ctrl = new AbortController();
    const read = mockGetBookState('book-1', ctrl.signal);
    ctrl.abort();
    await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  });
});
