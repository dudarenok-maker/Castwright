import { describe, it, expect, vi, afterEach } from 'vitest';
import { evictIdleQwenBase } from './evict-idle-tts.js';
import { reconcileResidentQwenTiers } from '../tts/ensure-sidecar-loaded.js';

/* #4102 — a variant mint (`purpose: 'mint'`) needs the 1.7B-Base resident, so
   its capacity-retry lever must never post /unload {model:'1.7b'}. Drives the
   REAL reconcile against a fetch-mocked sidecar so a keep-flag regression is
   seen as the unload it causes, not as a changed argument. */

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function sidecar(health: Record<string, unknown>) {
  const unloads: Array<Record<string, unknown>> = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/health')) return { ok: true, json: async () => health };
    if (url.endsWith('/unload')) {
      unloads.push(JSON.parse((init?.body as string) ?? '{}'));
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return unloads;
}

const lever = (purpose: 'design' | 'mint') =>
  evictIdleQwenBase({
    modelKey: 'qwen3-tts-0.6b',
    purpose,
    _isAnyGenerationActive: () => false,
    _probeHealth: async () => ({ qwenLoaded: true, kokoroLoaded: false }),
    _reconcile: (keep, signal, out) => reconcileResidentQwenTiers(keep, signal, out),
  });

describe('evictIdleQwenBase purpose "mint" (#4102)', () => {
  it('never unloads the 1.7B-Base, frees only the 0.6B', async () => {
    const unloads = sidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    await expect(lever('mint')).resolves.toBe(true);
    expect(unloads).toEqual([{ engine: 'qwen' }]);
    expect(unloads).not.toContainEqual({ engine: 'qwen', model: '1.7b' });
  });

  it('control: a design still frees both bases (VoiceDesign stays protected by the decline)', async () => {
    const unloads = sidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    await lever('design');
    expect(unloads).toContainEqual({ engine: 'qwen', model: '1.7b' });
  });

  it('a mint still declines while another VoiceDesign is resident', async () => {
    const unloads = sidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    const out = await evictIdleQwenBase({
      modelKey: 'qwen3-tts-0.6b',
      purpose: 'mint',
      _isAnyGenerationActive: () => false,
      _probeHealth: async () => ({ qwenLoaded: true, qwenDesignResident: true }),
      _reconcile: (keep, signal, o) => reconcileResidentQwenTiers(keep, signal, o),
    });
    expect(out).toBe('declined');
    expect(unloads).toEqual([]);
  });
});
