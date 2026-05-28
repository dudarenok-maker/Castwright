import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: () => 'http://localhost:9000',
}));

import { ensureSidecarEngineReady } from './ensure-sidecar-loaded.js';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('ensureSidecarEngineReady', () => {
  it('does not touch the sidecar for a cloud engine (gemini)', async () => {
    const f = vi.fn();
    global.fetch = f as unknown as typeof fetch;
    await ensureSidecarEngineReady('gemini');
    expect(f).not.toHaveBeenCalled();
  });

  it('POSTs /load with the engine and resolves once ready', async () => {
    const f = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) });
    global.fetch = f as unknown as typeof fetch;

    await ensureSidecarEngineReady('qwen');

    expect(f).toHaveBeenCalledTimes(1);
    const [target, init] = f.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('http://localhost:9000/load');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ engine: 'qwen' });
  });

  it('resolves best-effort (no throw) on a non-ok /load response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }) as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('resolves best-effort when /load reports a non-ready status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: 'loading' }) }) as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('resolves best-effort when the fetch itself rejects (sidecar down)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(ensureSidecarEngineReady('qwen')).resolves.toBeUndefined();
  });

  it('throws AbortError without calling fetch when the run signal is already aborted', async () => {
    const f = vi.fn();
    global.fetch = f as unknown as typeof fetch;
    const ac = new AbortController();
    ac.abort();
    await expect(ensureSidecarEngineReady('qwen', ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f).not.toHaveBeenCalled();
  });
});
