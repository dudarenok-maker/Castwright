import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });

vi.mock('../workspace/user-settings.js', () => ({
  getResolvedSidecarUrl: () => 'http://localhost:9000',
  readConfigOverrides: () => ({}),
}));

/* Passthrough mock for the existing readiness tests — they don't care about
   the GPU gate; the withGpuLoad suite overrides this per-test via vi.doMock +
   vi.resetModules. */
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class extends Error {},
}));

const forceSidecarRecycleMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock('./sidecar-supervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sidecar-supervisor.js')>();
  return {
    ...actual,
    forceSidecarRecycle: (...args: unknown[]) => forceSidecarRecycleMock(...args),
  };
});

import {
  ensureSidecarEngineReady,
  reconcileResidentQwenTiers,
  UNLOAD_DISPATCHER,
} from './ensure-sidecar-loaded.js';

/* reconcileResidentQwenTiers' /unload moved to undici's fetch — it needs
   UNLOAD_DISPATCHER plus its own ceiling, because that call waits on the
   sidecar's `_synth_lock` and neither production caller supplies a signal.
   Delegating undici's fetch to whatever this file stubs globally keeps every
   existing stub and assertion working across both transports. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
  forceSidecarRecycleMock.mockClear();
});

/* A settled /health response: reachable, not recycling, engine installed. */
const readyResp = { ok: true, json: async () => ({ qwen_package_installed: true }) };

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

  it('GETs /health (never /load — loads nothing) and resolves once reachable', async () => {
    const f = vi.fn().mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await ensureSidecarEngineReady('qwen');

    expect(f).toHaveBeenCalledTimes(1);
    const [target, init] = f.mock.calls[0] as [string, RequestInit];
    expect(target).toBe('http://localhost:9000/health');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined(); // pure readiness probe, no model load
  });

  it('waits while the engine package reports not installed, then resolves', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ qwen_package_installed: false }) })
      .mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;
    await expect(ensureSidecarEngineReady('qwen', undefined, PATIENT)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(2);
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

  it('polls through a pending recycle (drain fence) then resolves once settled', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ recycle_pending: true }) })
      .mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await expect(ensureSidecarEngineReady('qwen', undefined, PATIENT)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(2);
  });

  /* The 2026-05-31 cascade fix: during a recycle DRAIN the sidecar answers a
     recycling 503 (drain fence), so the gate must POLL THROUGH the drain and
     only proceed once the respawned sidecar is reachable — otherwise a queued
     chapter marches into a 503 and fails. */
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
    // srv-50: exhausting the readiness budget is strong evidence of a wedge —
    // force a recycle instead of silently giving up.
    expect(forceSidecarRecycleMock).toHaveBeenCalledTimes(1);
    expect(forceSidecarRecycleMock.mock.calls[0][0]).toContain('qwen');
  });

  it('does NOT force-recycle when readiness resolves before the deadline', async () => {
    const f = vi.fn().mockResolvedValue(readyResp);
    global.fetch = f as unknown as typeof fetch;

    await ensureSidecarEngineReady('qwen', undefined, PATIENT);

    expect(forceSidecarRecycleMock).not.toHaveBeenCalled();
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

describe('reconcileResidentQwenTiers (run-start VRAM hygiene)', () => {
  /* Build a fetch mock: first GET /health returns `health`, every POST /unload
     is recorded. Returns the recorded /unload bodies. */
  const unloadInits: Array<(RequestInit & { dispatcher?: unknown }) | undefined> = [];
  beforeEach(() => {
    unloadInits.length = 0;
  });

  function mockSidecar(health: Record<string, unknown>): {
    fetch: ReturnType<typeof vi.fn>;
    unloads: () => Array<Record<string, unknown>>;
  } {
    const unloads: Array<Record<string, unknown>> = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/health')) return { ok: true, json: async () => health };
      if (url.endsWith('/unload')) {
        unloadInits.push(init);
        unloads.push(JSON.parse((init?.body as string) ?? '{}'));
        return { ok: true, json: async () => ({ status: 'idle' }) };
      }
      throw new Error(`unexpected ${url}`);
    });
    return { fetch: f, unloads: () => unloads };
  }

  it('evicts the 0.6B base for a pure-1.7B run, keeps the 1.7B base, reports true', async () => {
    const m = mockSidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    global.fetch = m.fetch as unknown as typeof fetch;
    await expect(reconcileResidentQwenTiers({ keep06: false, keep17: true })).resolves.toBe(true);
    expect(m.unloads()).toEqual([{ engine: 'qwen' }]); // 0.6B only
  });

  /* #2287 seventh call site. /unload waits on the sidecar's `_synth_lock`, so
     it can legitimately exceed undici's hidden 300s headersTimeout — and this
     path is the WORST of the family, because the catch swallows the failure,
     Promise.allSettled discards it, and the function returns `true` anyway: the
     caller is told the tier was evicted when it was not, then loads the 1.7B on
     top of a resident 0.6B (8 GB OOM). Neither production caller supplies a
     signal, so a dispatcher alone would trade that for an unbounded hang —
     assert BOTH. The file's delegation mock makes the transport swap otherwise
     invisible, so without this the fix could be reverted with the whole suite
     still green. */
  it('sends /unload with the long-call dispatcher AND a bound (regression lock)', async () => {
    const m = mockSidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    global.fetch = m.fetch as unknown as typeof fetch;

    await reconcileResidentQwenTiers({ keep06: false, keep17: true });

    expect(unloadInits, 'the /unload should have been issued').toHaveLength(1);
    const init = unloadInits[0]!;
    /* Identity, not presence: `toBeDefined()` would also pass for an Agent with
       a finite headersTimeout, which reintroduces the exact bug. */
    expect(init.dispatcher, '/unload must carry UNLOAD_DISPATCHER').toBe(UNLOAD_DISPATCHER);
    expect(init.signal, '/unload must stay bounded — no caller supplies one').toBeDefined();
  });

  it('evicts the 1.7B base for a pure-0.6B run, keeps the 0.6B base, reports true', async () => {
    const m = mockSidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    global.fetch = m.fetch as unknown as typeof fetch;
    await expect(reconcileResidentQwenTiers({ keep06: true, keep17: false })).resolves.toBe(true);
    expect(m.unloads()).toEqual([{ engine: 'qwen', model: '1.7b' }]); // 1.7B only
  });

  it('evicts nothing for a mixed-tier run (both in use), reports false', async () => {
    const m = mockSidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    global.fetch = m.fetch as unknown as typeof fetch;
    await expect(reconcileResidentQwenTiers({ keep06: true, keep17: true })).resolves.toBe(false);
    expect(m.unloads()).toEqual([]);
  });

  it('no-ops when the unused tier is not resident, reports false (#1839 finding 1)', async () => {
    /* The tier we'd drop (0.6B) was never resident to begin with — a fresh
       sidecar, or a run that only ever touched 1.7B. Before the fix this
       call still reported "success" up through evictIdleQwenBase even
       though zero /unload calls were issued, which cost capacity-retry.ts a
       wasted immediate-retry attempt (see capacity-retry.test.ts). */
    const m = mockSidecar({ qwen_loaded: false, qwen_base17_loaded: true });
    global.fetch = m.fetch as unknown as typeof fetch;
    await expect(reconcileResidentQwenTiers({ keep06: false, keep17: true })).resolves.toBe(false); // 0.6B not loaded → nothing to evict
    expect(m.unloads()).toEqual([]);
  });

  it('skips (no evict) while a recycle is pending, reports false', async () => {
    const m = mockSidecar({ qwen_loaded: true, recycle_pending: true });
    global.fetch = m.fetch as unknown as typeof fetch;
    await expect(reconcileResidentQwenTiers({ keep06: false, keep17: true })).resolves.toBe(false);
    expect(m.unloads()).toEqual([]);
  });

  it('is best-effort: a down sidecar does not throw, reports false', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(reconcileResidentQwenTiers({ keep06: false, keep17: true })).resolves.toBe(false);
  });

  it('#2790 — checks /unload response status: non-ok (e.g. 500 from base17 contention) does not report success', async () => {
    /* #2752's regression: if the base17 load is in flight when Stop presses
       /unload {model:'1.7b'}, unload_base17() raises unhandled → 500 response.
       The old code caught ALL errors and treated them as success, then told
       the caller the tier was evicted when it was not. The second-stage
       reconcile on the Node side compounded this: it checked neither res.ok
       nor threw on error, so a 500 from the sidecar was silently swallowed,
       and the caller was told the 1.7B was free when it was not — then loaded
       Base+VoiceDesign together into an 8 GB card (OOM).
       This test confirms the node side now checks res.ok and does not report
       success when the sidecar returns non-ok. */
    mockSidecar({ qwen_loaded: true, qwen_base17_loaded: true });
    global.fetch = vi
      .fn()
      .mockImplementationOnce(async (url: string, _init?: RequestInit) => {
        if (url.endsWith('/health')) return { ok: true, json: async () => ({ qwen_loaded: true, qwen_base17_loaded: true }) };
        throw new Error(`unexpected ${url}`);
      })
      .mockImplementationOnce(async (_url: string, _init?: RequestInit) => {
        // First /unload returns 500 (base17 in flight, unload_base17() raised)
        return { ok: false, status: 500, json: async () => ({}) };
      })
      .mockImplementationOnce(async (url: string, _init?: RequestInit) => {
        // Subsequent /health calls succeed normally
        if (url.endsWith('/health')) return { ok: true, json: async () => ({ qwen_loaded: true, qwen_base17_loaded: true }) };
        throw new Error(`unexpected ${url}`);
      });

    await expect(reconcileResidentQwenTiers({ keep06: false, keep17: true })).resolves.toBe(false);
    // Caller does NOT get told the tier was evicted
  });
});

describe('ensureSidecarEngineReady — withGpuLoad gate', () => {
  /* Each test must: vi.resetModules() → vi.doMock() → dynamic import.
     This ensures the dynamic `await import('../gpu/gpu-load.js')` inside
     ensureSidecarEngineReady resolves to the test's mock, not the module cache. */
  afterEach(() => {
    vi.doUnmock('../gpu/gpu-load.js');
    vi.doUnmock('../workspace/user-settings.js');
    vi.resetModules();
  });

  it('wraps the readiness poll in withGpuLoad (surfaces GpuBusy on a constrained card)', async () => {
    const order: string[] = [];
    vi.resetModules();
    vi.doMock('../workspace/user-settings.js', () => ({
      getResolvedSidecarUrl: () => 'http://localhost:9000',
      readConfigOverrides: () => ({}),
    }));
    vi.doMock('../gpu/gpu-load.js', () => ({
      withGpuLoad: async (fn: () => Promise<unknown>) => { order.push('gpu-load-gate'); return fn(); },
      GpuBusyError: class extends Error {},
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('load'); return { ok: true, json: async () => ({ status: 'ready' }) }; }));
    const { ensureSidecarEngineReady: ensureReady } = await import('./ensure-sidecar-loaded.js');
    await ensureReady('qwen', undefined, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(order[0]).toBe('gpu-load-gate');
    expect(order).toContain('load');
  });

  it('does NOT engage the gate for a cloud / non-sidecar engine', async () => {
    const gate = vi.fn(async (fn: () => Promise<unknown>) => fn());
    vi.resetModules();
    vi.doMock('../gpu/gpu-load.js', () => ({ withGpuLoad: gate, GpuBusyError: class extends Error {} }));
    const { ensureSidecarEngineReady: ensureReady } = await import('./ensure-sidecar-loaded.js');
    await ensureReady('gemini' as never);
    expect(gate).not.toHaveBeenCalled();
  });
});
