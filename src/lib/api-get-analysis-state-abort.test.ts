/* #3967 — the analysis-state read takes an AbortSignal so the analysis-stream
   middleware can abort a refusal re-read that never settles. The real path must
   hand the signal to fetch: the middleware test only sees the signal the mock
   received, so a dropped signal would leave the HTTP request open after the expiry.

   Mocks global fetch, mirroring api-get-book-state-abort.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.getAnalysisState — abort signal (#3967)', () => {
  it('passes the signal through to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();

    await api.getAnalysisState('book-1', ctrl.signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/books/book-1/analysis/state');
    expect(fetchMock.mock.calls[0][1]).toEqual({ signal: ctrl.signal });
  });
});
