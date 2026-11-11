import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  getResolvedSidecarUrl: () => 'http://sidecar.test',
}));

import { renewRenderLeaseOnce, startRenderLease, LEASE_TTL_S, LEASE_RENEW_MS } from './render-lease.js';
import { setQualityRenderCounter, setActiveGenerationBooksProvider } from './active-generation-gate.js';

describe('render lease (#4079)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setQualityRenderCounter(() => 0);
    setActiveGenerationBooksProvider(() => []);
  });

  it('posts a lease to the sidecar while a running render uses the Quality tier', async () => {
    setQualityRenderCounter(() => 1);
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    await expect(renewRenderLeaseOnce()).resolves.toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://sidecar.test/render-lease');
    expect(JSON.parse(init.body as string)).toEqual({ holder: 'castwright-server', ttl_seconds: LEASE_TTL_S });
  });

  it('a render that does not use the Quality tier (Kokoro-only / standard) takes no lease', async () => {
    setActiveGenerationBooksProvider(() => ['book-1']); // a render IS running
    setQualityRenderCounter(() => 0); // ...but not on the 1.7B tier
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    await expect(renewRenderLeaseOnce()).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('posts nothing when nothing is registered (the lease then lapses on its own)', async () => {
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    await expect(renewRenderLeaseOnce()).resolves.toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('an unreachable sidecar is not an error', async () => {
    setQualityRenderCounter(() => 1);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(renewRenderLeaseOnce()).resolves.toBe(false);
  });

  it('renews well inside the TTL so one missed tick does not drop the lease', () => {
    expect(LEASE_RENEW_MS * 2).toBeLessThan(LEASE_TTL_S * 1000);
  });

  it('startRenderLease renews on every LEASE_RENEW_MS tick while a Quality render is registered', async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    setQualityRenderCounter(() => 1);
    const t = startRenderLease();
    try {
      expect(f).not.toHaveBeenCalled(); // nothing posts before the first tick
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://sidecar.test/render-lease');
      expect(JSON.parse(init.body as string)).toEqual({ holder: 'castwright-server', ttl_seconds: LEASE_TTL_S });
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
      expect(f).toHaveBeenCalledTimes(2);
      /* Render over: the next tick posts nothing, and the lease lapses on its own. */
      setQualityRenderCounter(() => 0);
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS);
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(t);
      vi.useRealTimers();
    }
  });

  it('the real render registry feeds the gate: only a Quality job counts, and only while registered', async () => {
    const f = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', f);
    /* A fresh module graph, so the route's own gate registration (clobbered by
       the stubs above) is the one in effect. */
    vi.resetModules();
    const lease = await import('./render-lease.js');
    const gen = await import('../routes/generation.js');
    const quality = gen.__registerFakeJobForTest('book-q', [], true);
    await expect(lease.renewRenderLeaseOnce()).resolves.toBe(true);
    quality();
    await expect(lease.renewRenderLeaseOnce()).resolves.toBe(false);
    const standard = gen.__registerFakeJobForTest('book-s', [], false);
    await expect(lease.renewRenderLeaseOnce()).resolves.toBe(false);
    standard();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a real run records whether it uses the Quality tier, from the computed per-character tier set', () => {
    const src = readFileSync(fileURLToPath(new URL('../routes/generation.ts', import.meta.url)), 'utf8');
    expect(src).toContain('usesQuality17: usedQwenTiers.keep17');
  });

  it('index.ts starts the lease timer at boot', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/^\s*startRenderLease\(\);/m);
    expect(src).toContain("from './gpu/render-lease.js'");
  });
});
