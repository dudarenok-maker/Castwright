/* A120 run 2 (2026-11-10) — the Don't reuse failure toast read "...the voice
   link is unchanged. Don't-reuse failed (502)." A bare status code is not a
   user sentence; a server-curated message must still pass through verbatim. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

const args = { bookId: 'b1', characterId: 'c1', fromBookId: 'b0' };

describe('api.declineVoiceLink — failure message', () => {
  it('gives a plain next step, with no status code, when the server sent no message (proxy 502)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));
    const err = (await api.declineVoiceLink(args).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Check the server is running, then try again.');
  });

  it("keeps the server's own curated message", async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Book is busy.' }), { status: 409 }),
        ),
    );
    const err = (await api.declineVoiceLink(args).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Book is busy.');
  });

  it('gives the same sentence when the server cannot be reached at all (fetch rejects)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = (await api.declineVoiceLink(args).catch((e: Error) => e)) as Error;
    expect(err.message).toBe('Check the server is running, then try again.');
  });
});
