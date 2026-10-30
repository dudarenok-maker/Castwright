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

  it('returns the 200 { revision } body without sending a base when none is given', async () => {
    const revision = { title: 'abc123' };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ revision }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api.putBookState('book-1', { slice: 'state', patch: { title: 'New' } }),
    ).resolves.toEqual({ revision });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect('baseRevision' in sent).toBe(false);
  });

  it('sends baseRevision when given', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ revision: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.putBookState('book-1', {
      slice: 'state',
      patch: { title: 'New' },
      baseRevision: { title: 'tok' },
    });
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.baseRevision).toEqual({ title: 'tok' });
  });

  it('carries the 409 code on the thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'changed elsewhere', code: 'stale_revision' }), {
          status: 409,
        }),
      ),
    );
    const err = (await api
      .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
      .catch((e: Error) => e)) as Error & { code?: string };
    expect(err.code).toBe('stale_revision');
    expect(err.message).toContain('changed elsewhere');
  });

  it('carries the stale field names from a 409 stale_revision body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'changed elsewhere', code: 'stale_revision', fields: ['notes', 'title'] }),
          { status: 409 },
        ),
      ),
    );
    const err = (await api
      .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
      .catch((e: Error) => e)) as Error & { fields?: string[] };
    expect(err.fields).toEqual(['notes', 'title']);
  });

  it('leaves fields undefined when the body has none or a malformed list', async () => {
    for (const fields of [undefined, 'title', ['title', 3]]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ error: 'changed elsewhere', code: 'stale_revision', fields }), {
            status: 409,
          }),
        ),
      );
      const err = (await api
        .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
        .catch((e: Error) => e)) as Error & { fields?: string[] };
      expect(err.fields).toBeUndefined();
    }
  });

  it('leaves code undefined for a non-JSON failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    const err = (await api
      .putBookState('book-1', { slice: 'state', patch: { title: 'New' } })
      .catch((e: Error) => e)) as Error & { code?: string };
    expect(err.code).toBeUndefined();
  });
});
