/* #2348 review BLOCKING finding — POST /api/sidecar/restart
   (server/src/routes/sidecar-health.ts) answers every failure branch with a
   409 or 503 carrying `{ ok: false, error: "<human sentence>" }`; there is no
   200-with-ok:false shape. Before this fix, realRestartSidecar (api.ts)
   threw the generic `Sidecar restart failed (${status}): ${rawBody}`
   wrapper on any non-ok response, burying that sentence behind a raw JSON
   blob — the exact shape #2165 already fixed once for
   PUT /api/books/{bookId}/state (api-put-book-state-error.test.ts). This
   file pins the same contract for the sidecar-restart wrapper.

   Mocks global fetch, mirroring api-put-book-state-error.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.restartSidecar — refusal messages', () => {
  it("surfaces the server's error sentence on a 409, not the JSON envelope", async () => {
    const message =
      'No active supervisor — sidecar auto-start is disabled or the server is still booting.';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: message }), { status: 409 }),
        ),
      ),
    );

    await expect(api.restartSidecar()).rejects.toThrow(message);

    const err = await api.restartSidecar().catch((e: Error) => e);
    expect((err as Error).message).toBe(message);
    expect((err as Error).message).not.toContain('Sidecar restart failed');
    expect((err as Error).message).not.toContain('{"ok"');
  });

  it("surfaces the server's error sentence on a 503, not the JSON envelope", async () => {
    const message = 'Sidecar did not become healthy within 30s after restart.';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: message }), { status: 503 }),
        ),
      ),
    );

    const err = await api.restartSidecar().catch((e: Error) => e);
    expect((err as Error).message).toBe(message);
    expect((err as Error).message).not.toContain('Sidecar restart failed');
    expect((err as Error).message).not.toContain('{"ok"');
  });

  it('falls back to the formatted wrapper when the body is not JSON (e.g. a proxy 502 page)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>502 Bad Gateway</html>', { status: 502 }))),
    );

    const err = await api.restartSidecar().catch((e: Error) => e);
    expect((err as Error).message).toBe(
      'Sidecar restart failed (502): <html>502 Bad Gateway</html>',
    );
  });

  it('falls back to the formatted wrapper when the JSON body has no usable error field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 409 })),
      ),
    );

    const err = await api.restartSidecar().catch((e: Error) => e);
    expect((err as Error).message).toBe('Sidecar restart failed (409): {"ok":false}');
  });

  it('resolves ok:true on a 200 without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))),
    );

    await expect(api.restartSidecar()).resolves.toEqual({ ok: true });
  });

  /* #2348 review Minor finding N7 — realRestartSidecar surfaced the
     server's own error text with no length cap (measured: a 40,056-char
     body rendered raw into the UI). describeConfigSaveError's sibling
     /api/config path already caps at 500 chars via
     MAX_SAVE_ERROR_MESSAGE_LENGTH/finalizeSaveErrorMessage
     (override-row.tsx) — this pins the same cap, applied the same way,
     for both the parsed `error` field and the raw wrapper-text fallback. */
  it("caps a pathological server error sentence at 500 chars, same as describeConfigSaveError", async () => {
    const pathological = 'x'.repeat(40_056);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, error: pathological }), { status: 409 }),
        ),
      ),
    );

    const err = await api.restartSidecar().catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message.length).toBe(501); // 500 chars + the "…" suffix
    expect(message.endsWith('…')).toBe(true);
    expect(message.startsWith('x'.repeat(500))).toBe(true);
  });

  it('caps a pathological non-JSON wrapper body at 500 chars too', async () => {
    const pathological = '<html>' + 'y'.repeat(40_056) + '</html>';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(pathological, { status: 502 }))));

    const err = await api.restartSidecar().catch((e: Error) => e);
    const message = (err as Error).message;
    expect(message.length).toBe(501);
    expect(message.endsWith('…')).toBe(true);
    expect(message.startsWith('Sidecar restart failed (502): <html>')).toBe(true);
  });
});
