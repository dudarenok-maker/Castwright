/* #2165 — PUT /api/books/{bookId}/state now has a fourth deliberate 409 (an
   analysis is running and the patch would move the book's folder). That
   message reaches the user verbatim via BooksRoute's showError, so the wire
   layer must unwrap `{ error }` rather than handing over the JSON envelope.

   Mocks global fetch, mirroring api-analysis-state.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.putBookState — refusal messages', () => {
  it("surfaces the server's error sentence on a 409, not the JSON envelope", async () => {
    const message =
      'Analysis is running for this book. Wait for it to finish before renaming it — a rename mid-analysis would split the book across two folders.';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: message }), { status: 409 }))),
    );

    await expect(
      api.putBookState('book-1', { slice: 'state', patch: { title: 'New' } }),
    ).rejects.toThrow(message);

    const err = await api
      .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain('{"error"');
    expect((err as Error).message).toContain('409');
  });

  it('falls back to the raw body when it is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const err = await api
      .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('boom');
    expect((err as Error).message).toContain('500');
  });

  it('resolves on 204 without reading a body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.putBookState('book-1', { slice: 'state', patch: { title: 'New' } }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
