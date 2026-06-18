/* Wire-level tests for api.createPairSession — the companion pairing
   session endpoint introduced by the QR redesign (feat/pairing-qr-redesign).

   Tests run against the `real` implementation (VITE_USE_MOCKS is not set
   in the vitest environment, so USE_MOCKS=false and api===real). fetch is
   stubbed to exercise the POST body, the happy path, and the error branch,
   following the same pattern as api-analysis-state.test.ts. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api.createPairSession — wire contract', () => {
  it('POSTs to /api/pair/session and returns a well-formed PairSessionInfo', async () => {
    const payload = {
      qrPayload: 'https://www.castwright.ai/pair?h=192.168.1.42%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R',
      hostPort: '192.168.1.42:8443',
      port: 8443,
      code: 'K7QF3M2P',
      fpTag: 'J4XQ2A7BWZ9K3M5R',
      expiresAt: 1_750_000_000_000,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const info = await api.createPairSession();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pair/session',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(info.code).toBe('K7QF3M2P');
    expect(info.fpTag).toBe('J4XQ2A7BWZ9K3M5R');
    expect(info.qrPayload).toBe('https://www.castwright.ai/pair?h=192.168.1.42%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R');
    expect(info.hostPort).toBe('192.168.1.42:8443');
    expect(info.port).toBe(8443);
    expect(info.expiresAt).toBeGreaterThan(0);
  });

  it('throws on non-200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 })),
    );

    await expect(api.createPairSession()).rejects.toThrow(/500/);
  });
});
