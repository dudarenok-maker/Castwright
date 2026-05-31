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

const readyResp = { ok: true, json: async () => ({ status: 'ready' }) };

/* Small budgets keep the poll loop fast + deterministic in tests. */
const FAST = { timeoutMs: 40, pollIntervalMs: 5 };
const PATIENT = { timeoutMs: 5_000, pollIntervalMs: 2 };

describe('ensureSidecarEngineReady', () => {
  it('does not touch the sidecar for a cloud engine (gemini)', async () => {
    const f = vi.fn();
    global.fetch = f as unknown as typeof fetch;
    await ensureSidecarEngineReady('gemini');
    expect(f).not.toHaveBeenCalled();
  });

  it('POSTs /load with the engine and resolves once ready', async () => {
    const f = vi.fn().mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await ensureSidecarEngineReady('qwen');

    expect(f).toHaveBeenCalledTimes(1);
    const [target, init] = f.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('http://localhost:9000/load');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ engine: 'qwen' });
  });

  /* srv-17 core: a respawn window (sidecar unreachable) is RIDDEN OUT, not
     failed. The gate polls and proceeds once the fresh sidecar is ready. */
  it('polls through a transient unreachable sidecar then resolves once ready (respawn)', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, PATIENT)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(3); // waited out two failures, then ready
  });

  it('polls through a still-loading model then resolves once ready', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'loading' }) })
      .mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, PATIENT)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(2);
  });

  /* The 2026-05-31 cascade fix: during a recycle DRAIN the sidecar /load now
     answers the recycling 503 (drain fence) instead of an instant `ready`, so
     the gate must POLL THROUGH the drain and only proceed once the respawned
     sidecar is ready — otherwise a queued chapter marches into a 503 and fails. */
  it('polls through a recycle drain (recycling 503) then resolves once respawned', async () => {
    const recyclingResp = {
      ok: false,
      status: 503,
      json: async () => ({ detail: 'TTS sidecar is recycling to free memory; retry shortly.' }),
    };
    const f = vi
      .fn()
      .mockResolvedValueOnce(recyclingResp)
      .mockResolvedValueOnce(recyclingResp)
      .mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, PATIENT)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(3); // waited out the drain, then ready
  });

  it('gives up best-effort (no throw) after the budget when the sidecar stays down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, FAST)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(f.mock.calls.length).toBeGreaterThan(1); // polled, didn't bail on first failure
  });

  it('gives up best-effort after the budget when /load keeps returning non-ok', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    global.fetch = f as unknown as typeof fetch;
    await expect(ensureSidecarEngineReady('qwen', undefined, FAST)).resolves.toBeUndefined();
    expect(f.mock.calls.length).toBeGreaterThan(1);
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

  it('aborts the wait promptly when the run signal fires mid-poll', async () => {
    const ac = new AbortController();
    /* Sidecar stays down; abort fires during the first inter-poll sleep. */
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    setTimeout(() => ac.abort(), 10);
    await expect(
      ensureSidecarEngineReady('qwen', ac.signal, { timeoutMs: 5_000, pollIntervalMs: 50 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
