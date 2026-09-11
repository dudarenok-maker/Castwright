/* #3195 Q1 — POST /api/info/dismiss-whats-new's wire wrapper now reads the
   body (for the settings-corruption flag, DismissWhatsNewResponse) where on
   main it never did. Any 2xx is a successful dismiss: a 204 or a body-stripped
   response must resolve (with no flag) rather than convert a server-side
   success into a thrown error that leaves the what's-new banner up.

   Mocks global fetch, mirroring api-put-book-state-error.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.dismissWhatsNew — response handling', () => {
  it('passes the corruption flag through from a JSON 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, corruptSettingsFile: true }), { status: 200 }),
      ),
    );
    await expect(api.dismissWhatsNew()).resolves.toEqual({ ok: true, corruptSettingsFile: true });
  });

  it('resolves on a 2xx with no readable body (204) — the dismiss succeeded, there is just no flag', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.dismissWhatsNew()).resolves.toEqual({ ok: true, corruptSettingsFile: undefined });
  });

  it('still rejects on a non-2xx, naming the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(api.dismissWhatsNew()).rejects.toThrow(/500/);
  });
});
