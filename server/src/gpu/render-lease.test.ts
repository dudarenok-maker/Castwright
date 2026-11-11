import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: () => 'http://sidecar.test',
}));

import { renewRenderLeaseOnce, LEASE_TTL_S, LEASE_RENEW_MS } from './render-lease.js';
import { setActiveGenerationBooksProvider } from './active-generation-gate.js';

describe('render lease (#4079)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setActiveGenerationBooksProvider(() => []);
  });

  it('posts a lease to the sidecar while a render is registered', async () => {
    setActiveGenerationBooksProvider(() => ['book-1']);
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    await expect(renewRenderLeaseOnce()).resolves.toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://sidecar.test/render-lease');
    expect(JSON.parse(init.body as string)).toEqual({ holder: 'castwright-server', ttl_seconds: LEASE_TTL_S });
  });

  it('posts nothing when no render is in flight (the lease then lapses on its own)', async () => {
    setActiveGenerationBooksProvider(() => []);
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    await expect(renewRenderLeaseOnce()).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('an unreachable sidecar is not an error', async () => {
    setActiveGenerationBooksProvider(() => ['book-1']);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(renewRenderLeaseOnce()).resolves.toBe(false);
  });

  it('renews well inside the TTL so one missed tick does not drop the lease', () => {
    expect(LEASE_RENEW_MS * 2).toBeLessThan(LEASE_TTL_S * 1000);
  });
});
