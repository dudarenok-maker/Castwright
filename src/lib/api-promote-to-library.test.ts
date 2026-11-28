/* Wire-level test for api.promoteToLibrary's error path: the server's
   cloned-source 403 / unreadable-source 503 body `{ error }` surfaces as just that sentence, not the
   generic "promote failed (403): {raw json}" wrapper (mirrors the assign 409
   case in api-assign-library-voice.test.ts). */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.promoteToLibrary — error surfacing', () => {
  it('unwraps the curated 403 error sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'This voice was cloned from a recording.' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(
      api.promoteToLibrary({ bookId: 'b', characterId: 'c', name: 'N' }),
    ).rejects.toThrow(/^This voice was cloned from a recording\.$/);
  });

  it('unwraps the curated 503 retry sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Try again in a moment.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(
      api.promoteToLibrary({ bookId: 'b', characterId: 'c', name: 'N' }),
    ).rejects.toThrow(/^Try again in a moment\.$/);
  });

  it('keeps the generic wrapper for other failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(
      api.promoteToLibrary({ bookId: 'b', characterId: 'c', name: 'N' }),
    ).rejects.toThrow(/promote failed \(500\): boom/);
  });
});
