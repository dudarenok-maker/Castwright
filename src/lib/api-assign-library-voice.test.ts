/* Wire-level tests for api.assignLibraryVoice (fs-38 Wave 3b2, fix wave 2 —
   the cloned-voice assign-guard-accuracy review). Tests run against the
   `real` implementation (VITE_USE_MOCKS is not set in the vitest environment,
   so USE_MOCKS=false and api===real), following the same fetch-stub pattern
   as api-pair-session.test.ts.

   Two things pinned here:
   1. An explicit `modelKey` is forwarded in the POST body — the guard-
      accuracy fix depends on the caller actually sending it.
   2. I-3 — a 409 response's `{ error: '...' }` body surfaces as JUST that
      message, not the generic "assign failed (409): {raw json}" wrapper the
      catch-all error path would otherwise produce. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.assignLibraryVoice — wire contract', () => {
  it('POSTs bookId/characterId/modelKey to /api/voice-library/:voiceUuid/assign', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ updated: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.assignLibraryVoice('lib-1', {
      bookId: 'book-1',
      characterId: 'char-1',
      modelKey: 'qwen3-tts-0.6b',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice-library/lib-1/assign',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bookId: 'book-1',
          characterId: 'char-1',
          modelKey: 'qwen3-tts-0.6b',
        }),
      }),
    );
    expect(result).toEqual({ updated: 1 });
  });

  it('omits modelKey from the body when the caller has no engine context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ updated: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.assignLibraryVoice('lib-1', { bookId: 'book-1', characterId: 'char-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/voice-library/lib-1/assign',
      expect.objectContaining({
        body: JSON.stringify({ bookId: 'book-1', characterId: 'char-1' }),
      }),
    );
  });

  it('I-3: a 409 wrong-engine response surfaces JUST the server message, not the raw JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error:
              'Cloned voices render on Qwen, but this book is set to kokoro. Switch the ' +
              'book\'s engine to Qwen before assigning "Marlow".',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    await expect(
      api.assignLibraryVoice('lib-1', { bookId: 'book-1', characterId: 'char-1' }),
    ).rejects.toThrow('Cloned voices render on Qwen, but this book is set to kokoro.');
    // Must NOT be the generic wrapper with the raw JSON body inlined.
    await expect(
      api.assignLibraryVoice('lib-1', { bookId: 'book-1', characterId: 'char-1' }),
    ).rejects.not.toThrow(/Voice library assign failed \(409\): \{/);
  });

  it('falls back to a generic message when a 409 body has no `error` field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 409 })),
    );

    await expect(
      api.assignLibraryVoice('lib-1', { bookId: 'book-1', characterId: 'char-1' }),
    ).rejects.toThrow('Voice library assign failed.');
  });
});
