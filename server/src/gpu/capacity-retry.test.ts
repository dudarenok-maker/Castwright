import { describe, it, expect, vi, afterEach } from 'vitest';
import { withCapacityRetry, getCapacityWaiterCount, parseNoCapacity } from './capacity-retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import { setProbeSidecarHealthProvider } from './sidecar-health-gate.js';

/* Free-function contract for the reusable no-capacity retry helper (Task 5,
   #1720). Unlike the old SidecarTtsProvider.postWithCapacityRetry, this
   RETURNS any non-`noCapacity` response (ok or failure) — the caller applies
   its own error handling. It only throws NoCapacityError after maxAttempts,
   or an abort rejection. */

function noCapacityResponse(neededMb: number, deviceKey: string): Response {
  return new Response(JSON.stringify({ noCapacity: true, neededMb, deviceKey }), {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'content-type': 'application/json' },
  });
}

function okResponse(): Response {
  return new Response(Buffer.from([0x01, 0x02]), {
    status: 200,
    headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000' },
  });
}

function fakeDevices(deviceKey: string, freeMb: number) {
  const [kind, indexStr] = deviceKey.split(':');
  return [
    {
      kind: kind as 'cuda' | 'rocm' | 'mps' | 'cpu',
      index: Number(indexStr),
      label: deviceKey,
      totalMb: 8_000,
      freeMb,
    },
  ];
}

describe('withCapacityRetry', () => {
  it('(a) first doPost returns ok → returned as-is, capacityProbe.read NOT called', async () => {
    const ok = okResponse();
    const doPost = vi.fn(async () => ok);
    const capacityProbeRead = vi.fn();

    const result = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
    });

    expect(result).toBe(ok);
    expect(doPost).toHaveBeenCalledTimes(1);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('(b) noCapacity 503 + eviction would help + analysis idle → evicts once, retries, succeeds', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    const evictOllama = vi.fn(async () => {});
    const analyzerEvictWouldHelp = vi.fn(async () => true);

    const result = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp,
      isAnalysisInFlight: () => false,
      pollMs: 1,
      maxAttempts: 5,
    });

    expect(calls).toBe(2);
    expect(evictOllama).toHaveBeenCalledTimes(1);
    expect(analyzerEvictWouldHelp).toHaveBeenCalledWith(2_000, 500);
    expect(result.ok).toBe(true);
  });

  it('(c) persistent noCapacity → throws NoCapacityError after maxAttempts', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:0'));

    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: async () => false,
      isAnalysisInFlight: () => false,
      pollMs: 0,
      maxAttempts: 3,
    }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(NoCapacityError);
    expect(err.engine).toBe('qwen');
    expect(err.neededMb).toBe(4_000);
    expect(err.deviceKey).toBe('cuda:0');
    expect(doPost).toHaveBeenCalledTimes(3);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(d) CONTRACT: a 503 that is NOT noCapacity is returned, not thrown', async () => {
    const body = new Response(JSON.stringify({ detail: 'base17-unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    const doPost = vi.fn(async () => body);
    const capacityProbeRead = vi.fn();

    const result = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: capacityProbeRead },
    });

    expect(result).toBe(body);
    expect(result.status).toBe(503);
    expect(doPost).toHaveBeenCalledTimes(1);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('(e) a 500 response is returned, not thrown', async () => {
    const body = new Response('internal error', { status: 500 });
    const doPost = vi.fn(async () => body);
    const capacityProbeRead = vi.fn();

    const result = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
    });

    expect(result).toBe(body);
    expect(result.status).toBe(500);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('frees an idle TTS base before falling back to the poll', async () => {
    const evictIdleTts = vi.fn().mockResolvedValue(true);
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? noCapacityResponse(4000, 'cuda:0') : new Response('ok', { status: 200 });
    });

    const res = await withCapacityRetry(doPost, {
      engine: 'qwen',
      evictIdleTts,
      /* Analyzer lever off, so the TTS lever is the only thing that can rescue it. */
      analyzerEvictWouldHelp: async () => false,
      pollMs: 0,
    });

    expect(res.status).toBe(200);
    expect(evictIdleTts).toHaveBeenCalledTimes(1);
    expect(doPost).toHaveBeenCalledTimes(2); // refused, freed, retried OK
  });

  it('#1839 finding 1: evictIdleTts reporting false does not burn an immediate no-op retry — it still takes the poll wait', async () => {
    /* Before the fix, evictIdleTts (evict-idle-tts.ts's evictIdleQwenBase)
       reported `true` whenever it was CALLED, even when it froze nothing —
       so `if (await evictIdleTts()) continue;` fired an immediate retry with
       no poll wait, wasting one of the limited maxAttempts on a guaranteed
       repeat 503. With the honest `false`, this attempt must instead fall
       through to the normal poll wait (measured via elapsed wall-clock time,
       since maxAttempts:2 leaves exactly one wait before giving up). */
    const evictIdleTts = vi.fn().mockResolvedValue(false); // ran, but froze nothing
    const doPost = vi.fn(async () => noCapacityResponse(4000, 'cuda:0'));
    const pollMs = 40;

    const start = Date.now();
    await expect(
      withCapacityRetry(doPost, {
        engine: 'qwen',
        evictIdleTts,
        analyzerEvictWouldHelp: async () => false,
        pollMs,
        maxAttempts: 2,
      }),
    ).rejects.toThrow(NoCapacityError);
    const elapsed = Date.now() - start;

    expect(evictIdleTts).toHaveBeenCalledTimes(1);
    expect(doPost).toHaveBeenCalledTimes(2);
    // A wasted immediate `continue` would finish in well under pollMs; a
    // real poll wait takes at least pollMs before the second doPost fires.
    expect(elapsed).toBeGreaterThanOrEqual(pollMs - 5);
  });

  it('does not retry the TTS eviction more than once', async () => {
    const evictIdleTts = vi.fn().mockResolvedValue(true);
    const doPost = vi.fn(async () => noCapacityResponse(4000, 'cuda:0'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'qwen',
        evictIdleTts,
        analyzerEvictWouldHelp: async () => false,
        pollMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(NoCapacityError);

    expect(evictIdleTts).toHaveBeenCalledTimes(1);
  });

  it('(f) getCapacityWaiterCount() reflects a parked waiter while polling, back to 0 after', async () => {
    expect(getCapacityWaiterCount()).toBe(0);
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        // The retry after the poll wait — the waiter count should already be up.
        expect(getCapacityWaiterCount()).toBe(1);
      }
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });

    await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: async () => false, // force the poll wait, no eviction
      isAnalysisInFlight: () => false,
      pollMs: 1,
      maxAttempts: 5,
    });

    expect(calls).toBe(2);
    expect(getCapacityWaiterCount()).toBe(0);
  });
});

describe('withCapacityRetry — design-resident extended wait (#2678 Task 3)', () => {
  // #2678 review N5: several tests below register a fake sidecar-health
  // provider via `setProbeSidecarHealthProvider`. Without a reset, the
  // "unregistered → fails closed" test a few lines down only passed because
  // it happens to run FIRST in file/declaration order — a reorder (or a new
  // test inserted above it) would silently leak a fake provider into it.
  // Reset to the unregistered state after every test so isolation doesn't
  // depend on order.
  afterEach(() => {
    setProbeSidecarHealthProvider(null);
  });

  it('(1) isDesignResident true throughout → keeps polling past generic maxAttempts, up to the design budget', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:0'));
    const isDesignResident = vi.fn().mockResolvedValue(true);

    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      analyzerEvictWouldHelp: async () => false,
      isDesignResident,
      pollMs: 0,
      maxAttempts: 3,
      designMaxAttempts: 5,
    }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(NoCapacityError);
    // 3 generic attempts, then 5 more under the design budget.
    expect(doPost).toHaveBeenCalledTimes(3 + 5);
    // Consulted exactly once, at the moment the generic bound was reached.
    expect(isDesignResident).toHaveBeenCalledTimes(1);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(2) doPost starts returning ok partway through the extended window → resolves with that response', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      // 3 generic attempts + 2 more under the design budget, then ok.
      return calls <= 5 ? noCapacityResponse(4_000, 'cuda:0') : okResponse();
    });
    const isDesignResident = vi.fn().mockResolvedValue(true);

    const result = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      analyzerEvictWouldHelp: async () => false,
      isDesignResident,
      pollMs: 0,
      maxAttempts: 3,
      designMaxAttempts: 10,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(6);
    expect(isDesignResident).toHaveBeenCalledTimes(1);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(3) isDesignResident false throughout → NoCapacityError still thrown at the ORIGINAL maxAttempts bound', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:0'));
    const isDesignResident = vi.fn().mockResolvedValue(false);

    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      analyzerEvictWouldHelp: async () => false,
      isDesignResident,
      pollMs: 0,
      maxAttempts: 3,
      designMaxAttempts: 100,
    }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(NoCapacityError);
    expect(doPost).toHaveBeenCalledTimes(3);
    expect(isDesignResident).toHaveBeenCalledTimes(1);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(4) isDesignResident rejects → treated as false (fail-closed), thrown at the original bound, no unhandled rejection', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:0'));
    const isDesignResident = vi.fn().mockRejectedValue(new Error('probe exploded'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'qwen',
        capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
        analyzerEvictWouldHelp: async () => false,
        isDesignResident,
        pollMs: 0,
        maxAttempts: 3,
        designMaxAttempts: 100,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(doPost).toHaveBeenCalledTimes(3);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(5) getCapacityWaiterCount() reflects the call as waiting for the entire extended window, then decrements to 0', async () => {
    expect(getCapacityWaiterCount()).toBe(0);
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls > 3) {
        // Inside the extended design-budget window — waiter must already be up.
        expect(getCapacityWaiterCount()).toBe(1);
      }
      return calls <= 5 ? noCapacityResponse(4_000, 'cuda:0') : okResponse();
    });

    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      analyzerEvictWouldHelp: async () => false,
      isDesignResident: async () => true,
      pollMs: 0,
      maxAttempts: 3,
      designMaxAttempts: 10,
    });

    expect(calls).toBe(6);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('PR-review finding: caller abort mid-design-budget throws NoCapacityError, not a raw AbortError', async () => {
    /* Simulates /api/sidecar/load's own 90s AbortController firing before the
       ~200s extended design-wait budget completes. Before the fix, once
       usingDesignBudget flips true, abortableDelay's rejection (the caller's
       AbortError) propagated straight out of withCapacityRetry — the route's
       `e instanceof NoCapacityError` check missed it, and the caller reported
       a generic "stuck process" timeout instead of the real, well-classified
       capacity-contention diagnosis.

       Deterministic (no wall-clock race): the caller's AbortController fires
       on the FIRST doPost call made after the extended design budget has
       just been committed to (call #3, with maxAttempts:2) — mirroring the
       real route's 90s ceiling landing partway through the extended window.
       pollMs:0 keeps every wait a same-tick no-op except the one the abort
       lands on. */
    const controller = new AbortController();
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls === 3) {
        // The caller's own hard timeout fires here — after usingDesignBudget
        // has been committed to (set on call #2), but long before this call's
        // own designMaxAttempts could ever be reached.
        controller.abort(new DOMException('caller timeout', 'AbortError'));
      }
      return noCapacityResponse(4_000, 'cuda:0');
    });
    const isDesignResident = vi.fn().mockResolvedValue(true);

    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      analyzerEvictWouldHelp: async () => false,
      isDesignResident,
      signal: controller.signal,
      pollMs: 0,
      maxAttempts: 2,
      designMaxAttempts: 1_000,
    }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(NoCapacityError);
    expect((err as InstanceType<typeof NoCapacityError>).engine).toBe('qwen');
    expect((err as InstanceType<typeof NoCapacityError>).neededMb).toBe(4_000);
    expect((err as InstanceType<typeof NoCapacityError>).deviceKey).toBe('cuda:0');
    expect(calls).toBe(3);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('defaultIsDesignResident (via probeSidecarHealthIfRegistered) does not extend the wait when unregistered — same original bound', async () => {
    // No isDesignResident override, no sidecar-health registration in this
    // test process → probeSidecarHealthIfRegistered() resolves null →
    // defaultIsDesignResident fails closed to false.
    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:0'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'qwen',
        capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
        analyzerEvictWouldHelp: async () => false,
        pollMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(doPost).toHaveBeenCalledTimes(3);
  });

  it('#2678 review finding: defaultIsDesignResident does NOT extend the wait when the resident design is on a DIFFERENT device than the one denied', async () => {
    // 2-GPU scenario: VoiceDesign resident on cuda:0, but THIS request was
    // denied capacity on cuda:1 — a different, unrelated card. Before the
    // fix, defaultIsDesignResident only read the global `qwenDesignResident`
    // flag and extended the wait anyway, wasting ~200s on a wait VoiceDesign
    // freeing cuda:0 could never resolve.
    setProbeSidecarHealthProvider(async () => ({
      qwenDesignResident: true,
      qwenDeviceKey: 'cuda:0',
    }));

    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:1'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'coqui',
        capacityProbe: { read: async () => fakeDevices('cuda:1', 100) },
        analyzerEvictWouldHelp: async () => false,
        pollMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    // No extension: gives up at the ORIGINAL maxAttempts bound, not the
    // (much larger) design budget.
    expect(doPost).toHaveBeenCalledTimes(3);
  });

  it('review finding: default isDesignResident + default describeBlockers share ONE sidecar-health probe on give-up, not two', async () => {
    // Both isDesignResident (false, so the call proceeds to give up) and
    // describeBlockers run at the SAME give-up decision, back-to-back, when
    // both are left at their defaults. Before the fix each called
    // probeSidecarHealthIfRegistered() independently — two full live
    // /health round-trips (each with its own timeout and disk-touching side
    // effects) for one give-up event. After the fix they share one probe.
    const probe = vi.fn(async () => ({
      qwenDesignResident: false,
      qwenDeviceKey: 'cuda:0',
      modelLoaded: false,
      kokoroLoaded: false,
      qwenLoaded: false,
      qwenBase17Loaded: false,
    }));
    setProbeSidecarHealthProvider(probe);

    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:1'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'coqui',
        capacityProbe: { read: async () => fakeDevices('cuda:1', 100) },
        analyzerEvictWouldHelp: async () => false,
        pollMs: 0,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('#2678 review finding: defaultIsDesignResident DOES extend the wait when the resident design is on the SAME device as the one denied', async () => {
    setProbeSidecarHealthProvider(async () => ({
      qwenDesignResident: true,
      qwenDeviceKey: 'cuda:1',
    }));

    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:1'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'coqui',
        capacityProbe: { read: async () => fakeDevices('cuda:1', 100) },
        analyzerEvictWouldHelp: async () => false,
        pollMs: 0,
        maxAttempts: 3,
        designMaxAttempts: 5,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    // Extended: 3 generic attempts + 5 more under the design budget.
    expect(doPost).toHaveBeenCalledTimes(3 + 5);
  });

  it('defaultIsDesignResident does NOT extend the wait for qwenDesignEverLoaded — the process-lifetime latch is not current residency', async () => {
    // qwenDesignEverLoaded is a process-lifetime latch (server/tts-sidecar/main.py):
    // set once on first design use and never reset. If defaultIsDesignResident
    // read that field instead of (or in addition to) qwenDesignResident, every
    // future capacity denial for the rest of the process's life would extend to
    // the ~200s design budget even with no VoiceDesign resident right now. This
    // pins the distinction: everLoaded=true, resident=false/absent, matching
    // deviceKey, must still give up at the ORIGINAL maxAttempts bound.
    setProbeSidecarHealthProvider(async () => ({
      qwenDesignEverLoaded: true,
      qwenDesignResident: false,
      qwenDeviceKey: 'cuda:1',
    }));

    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:1'));

    await expect(
      withCapacityRetry(doPost, {
        engine: 'coqui',
        capacityProbe: { read: async () => fakeDevices('cuda:1', 100) },
        analyzerEvictWouldHelp: async () => false,
        pollMs: 0,
        maxAttempts: 3,
        designMaxAttempts: 5,
      }),
    ).rejects.toBeInstanceOf(NoCapacityError);

    // No extension: gives up at the ORIGINAL maxAttempts bound, not 3 + 5.
    expect(doPost).toHaveBeenCalledTimes(3);
  });
});

describe('parseNoCapacity', () => {
  it('returns the parsed shape for a 503 noCapacity body', async () => {
    const parsed = await parseNoCapacity(noCapacityResponse(1_234, 'cuda:1'));
    expect(parsed).toEqual({ neededMb: 1_234, deviceKey: 'cuda:1' });
  });

  it('returns null for a non-503 status', async () => {
    expect(await parseNoCapacity(okResponse())).toBeNull();
  });

  it('returns null for a 503 that is not a noCapacity shape', async () => {
    const r = new Response(JSON.stringify({ detail: 'nope' }), { status: 503 });
    expect(await parseNoCapacity(r)).toBeNull();
  });
});
