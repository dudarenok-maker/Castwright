import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  withCapacityRetry,
  getCapacityWaiterCount,
  parseNoCapacity,
  createHardTimeoutAbortReason,
} from './capacity-retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';
import { setProbeSidecarHealthProvider } from './sidecar-health-gate.js';
import { registerEndpointCallInFlight } from '../analyzer/analyzer-concurrency.js';

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

  it('PR-review finding: caller HARD-TIMEOUT abort mid-design-budget throws NoCapacityError, not a raw AbortError', async () => {
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
       lands on. The abort is marked via createHardTimeoutAbortReason() —
       exactly what /api/sidecar/load's route now does (#2678 re-review N3) —
       so this stays the ONLY abort shape withCapacityRetry converts. */
    const controller = new AbortController();
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls === 3) {
        // The caller's own hard timeout fires here — after usingDesignBudget
        // has been committed to (set on call #2), but long before this call's
        // own designMaxAttempts could ever be reached.
        controller.abort(createHardTimeoutAbortReason('caller timeout'));
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

  it('#2678 re-review N3: a user-pause/regen-displacement abort mid-design-budget passes through as a plain AbortError, not NoCapacityError', async () => {
    /* Mirrors the previous test exactly, EXCEPT the caller's AbortController
       fires with the same unmarked shape generation.ts's `chapterCtrl` uses
       (a bare `.abort()` — see generation.ts's `onParentAbort`/explicit-pause
       call sites) rather than createHardTimeoutAbortReason(). This is the
       signal shape a real user Pause or regen displacement produces on the
       synthesis path (server/src/tts/sidecar.ts shares the SAME
       withCapacityRetry call with /api/sidecar/load). Before the fix, ANY
       abort while usingDesignBudget was true — marked or not — was converted
       to NoCapacityError, which generation.ts's `name === 'AbortError'`
       pause-detector does not recognise, so it fell through to
       describeSynthesisError and surfaced as a fatal `vram-spill` instead of
       a clean pause. The fix must let this unmarked abort through unchanged:
       a plain AbortError, `.name === 'AbortError'`, not NoCapacityError. */
    const controller = new AbortController();
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls === 3) {
        controller.abort(); // unmarked — exactly what a user Pause produces
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

    expect(err).not.toBeInstanceOf(NoCapacityError);
    expect((err as { name?: string })?.name).toBe('AbortError');
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

  it('#2678 review finding: defaultDescribeBlockers forwards qwenDesignResident into the give-up error', async () => {
    // Same extended-wait-then-exhausted scenario as above, but this pins that
    // the FINAL NoCapacityError actually names the resident VoiceDesign as a
    // blocker — previously describeVramBlockers had no way to hear about it,
    // so the operator got a generic "free VRAM" message even though a
    // VoiceDesign was the exact, known cause.
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
    ).rejects.toMatchObject({
      blockers: [
        {
          model: 'A voice design',
          remedy: 'Wait for the in-progress voice design to finish — it frees automatically once idle.',
        },
      ],
    });
  });

  it('#2678 review finding F1: defaultDescribeBlockers does NOT name a design resident on a DIFFERENT device as a blocker', async () => {
    // Same 2-GPU repro as the isDesignResident test above (design resident on
    // cuda:0, this request denied on cuda:1) — but this pins the OTHER half:
    // before the fix, defaultDescribeBlockers forwarded the raw, unqualified
    // `qwenDesignResident` flag straight into describeVramBlockers regardless
    // of which device it named, so the final NoCapacityError still told the
    // operator to "wait for the in-progress voice design to finish" even
    // though that design runs on an unrelated card and can never free cuda:1.
    setProbeSidecarHealthProvider(async () => ({
      qwenDesignResident: true,
      qwenDeviceKey: 'cuda:0',
    }));

    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:1'));

    const err = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:1', 100) },
      analyzerEvictWouldHelp: async () => false,
      pollMs: 0,
      maxAttempts: 3,
      designMaxAttempts: 5,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(NoCapacityError);
    // No extension (isDesignResident correctly says false for this device)...
    expect(doPost).toHaveBeenCalledTimes(3);
    // ...AND no misleading "wait for the voice design" blocker in the error.
    expect((err as NoCapacityError).blockers).toEqual([]);
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

describe('withCapacityRetry — analyzer endpoint eviction (#3084)', () => {
  it('an endpoint call on cuda:1 does not block Ollama eviction for a cuda:0 denial (Ollama gate unchanged)', async () => {
    const release = registerEndpointCallInFlight('other-card');
    try {
      let calls = 0;
      const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
      const evictOllama = vi.fn(async () => {});
      await withCapacityRetry(doPost, {
        engine: 'qwen',
        capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
        evictOllama,
        analyzerEvictWouldHelp: vi.fn(async () => true),
        // isAnalysisInFlight deliberately omitted: the default Ollama slot gate is under test
        evictEndpoints: vi.fn(async () => ({ attempted: 0, unloaded: 0 })),
        pollMs: 1,
        maxAttempts: 5,
      });
      expect(evictOllama).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
  });

  it('an Ollama call in flight blocks only Ollama eviction: endpoint unloads are still attempted', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    const evictOllama = vi.fn(async () => {});
    const evictEndpoints = vi.fn(async () => ({ attempted: 1, unloaded: 1 }));
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 3_000) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => true,
      evictEndpoints,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictEndpoints).toHaveBeenCalledWith('cuda:0');
    expect(evictOllama).not.toHaveBeenCalled();
  });

  it('unloads endpoints for the denied card even when evicting Ollama would not help', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:1') : okResponse()));
    const evictEndpoints = vi.fn(async () => ({ attempted: 1, unloaded: 1 }));
    const evictOllama = vi.fn(async () => {});
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:1', 500) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => false),
      isAnalysisInFlight: () => false,
      evictEndpoints,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictEndpoints).toHaveBeenCalledWith('cuda:1');
    expect(evictOllama).not.toHaveBeenCalled();
  });

  /* N1 — the two levers must never act on one measurement, and neither latch may spend the
     other's chance. The three cases below use a realistic isAnalysisInFlight: the analyzer is
     mid-call when the denial arrives and its call ends WHILE the unload POST is out (llama-swap
     blocks until the model is gone), which is the sequence a shared latch got wrong. */
  it("Ollama busy at the denial and idle at the next one is still evicted: the endpoint lever never spends Ollama's chance", async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls <= 2 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    let ollamaBusy = true;
    const isAnalysisInFlight = vi.fn(() => ollamaBusy);
    const evictOllama = vi.fn(async () => {});
    /* The analyzer's chunk call finishes while this POST is out. */
    const evictEndpoints = vi.fn(async () => {
      ollamaBusy = false;
      return { attempted: 1, unloaded: 1 };
    });
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight,
      evictEndpoints,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictEndpoints).toHaveBeenCalledTimes(1);
    expect(evictOllama).toHaveBeenCalledTimes(1);
    /* Read once per iteration, immediately before evictOllama() — never once for two levers. */
    expect(isAnalysisInFlight).toHaveBeenCalledTimes(2);
  });

  it('an endpoint unload alone frees the card: Ollama, busy when the denial arrived, is never evicted', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    let ollamaBusy = true;
    const evictOllama = vi.fn(async () => {});
    const evictEndpoints = vi.fn(async () => {
      ollamaBusy = false; // the analyzer goes idle during the unload
      return { attempted: 1, unloaded: 1 };
    });
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => ollamaBusy,
      evictEndpoints,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(evictOllama).not.toHaveBeenCalled();
    expect(doPost).toHaveBeenCalledTimes(2);
  });

  it("a failed unload POST spends no Ollama chance: Ollama, idle at the second denial, is still evicted", async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls <= 3 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    let ollamaBusy = true;
    const evictOllama = vi.fn(async () => {});
    let unloadAttempts = 0;
    const evictEndpoints = vi.fn(async () => {
      unloadAttempts += 1;
      ollamaBusy = false; // the analyzer's call ends while the refused POST is out
      return { attempted: 1, unloaded: 0 }; // the server refused
    });
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => ollamaBusy,
      evictEndpoints,
      evictIdleTts: vi.fn(async () => false),
      pollMs: 1,
      maxAttempts: 6,
    });
    /* Denial 1: Ollama busy → endpoints asked, refused. Denial 2: Ollama idle → evicted.
       Denial 3: Ollama's latch is spent → endpoints asked again (no endpoint latch). */
    expect(unloadAttempts).toBe(2);
    expect(evictOllama).toHaveBeenCalledTimes(1);
  });

  /* A1 — no latch: with the REAL evictEndpointsOnDevice behind the default closure, a realistic
     two-endpoint, multi-model, multi-poll admission. This is the sequence the deleted
     `endpointsUnloaded` latch got wrong, and no injected single-stub case can see it. */
  it('the default lever asks an endpoint that goes idle only at a later poll, after another endpoint already unloaded', async () => {
    const { _setUserSettingsCacheForTest, _resetUserSettingsCache } = await import('../workspace/user-settings.js');
    const { analyzerEndpointSchema } = await import('../workspace/analyzer-endpoints.js');
    const { noteEndpointModelUsed, _resetEndpointRuntimeForTest } = await import('../analyzer/transports/endpoint-runtime.js');
    const { markEndpointRunActive, _resetEndpointBusyForTest } = await import('../analyzer/analyzer-concurrency.js');
    _resetEndpointBusyForTest();
    _resetEndpointRuntimeForTest();
    /* A real unload server (Global Constraints: real sockets, not a stubbed fetch). */
    const { createServer } = await import('node:http');
    const sent: string[] = [];
    const server = createServer((req, res) => {
      sent.push(req.url ?? '');
      res.writeHead(200);
      res.end('OK');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const mk = (id: string, path: string) =>
      analyzerEndpointSchema.parse({ id, name: id.toUpperCase(), baseUrl: `${origin}/v1`, gpu: 'cuda:0', contextTokens: 8192, unloadUrl: `${origin}/${path}/{model}` });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [mk('a', 'ua'), mk('b', 'ub')], analyzerEndpointKeys: {} });
    noteEndpointModelUsed('a', 'm1');
    noteEndpointModelUsed('b', 'm2');
    noteEndpointModelUsed('b', 'm3');
    let releaseB = markEndpointRunActive(['b']); // B is mid-run when the first denial arrives
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls === 4) releaseB(); // B's run ends between polls 4 and 5
      return calls <= 5 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    try {
      await withCapacityRetry(doPost, {
        engine: 'qwen',
        capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
        evictOllama: vi.fn(async () => {}),
        analyzerEvictWouldHelp: vi.fn(async () => false),
        isAnalysisInFlight: () => false,
        evictIdleTts: vi.fn(async () => false),
        describeBlockers: async () => [],
        isDesignResident: async () => false,
        pollMs: 1,
        maxAttempts: 10,
      });
      /* A once at poll 1; B's two models once each after its run ended — nothing latched B out,
         and m3 was not abandoned behind m2. Never a second POST for any (endpoint, model). */
      expect(sent).toEqual(['/ua/m1', '/ub/m2', '/ub/m3']);
    } finally {
      releaseB();
      releaseB = () => {};
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      info.mockRestore();
      _resetUserSettingsCache();
      _resetEndpointRuntimeForTest();
      _resetEndpointBusyForTest();
    }
  });

  it('the default give-up message names each sharing endpoint and its cause (A6)', async () => {
    const { _setUserSettingsCacheForTest, _resetUserSettingsCache } = await import('../workspace/user-settings.js');
    const { analyzerEndpointSchema } = await import('../workspace/analyzer-endpoints.js');
    const { noteEndpointModelUsed, _resetEndpointRuntimeForTest } = await import('../analyzer/transports/endpoint-runtime.js');
    const { markEndpointRunActive, _resetEndpointBusyForTest } = await import('../analyzer/analyzer-concurrency.js');
    _resetEndpointBusyForTest();
    _resetEndpointRuntimeForTest();
    /* A real server that drops every unload connection, so each POST throws. */
    const { createServer } = await import('node:http');
    let downHits = 0;
    const server = createServer((req) => {
      if (req.url?.startsWith('/ud/')) downHits += 1;
      req.socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const mk = (id: string, name: string, unloadUrl?: string) =>
      analyzerEndpointSchema.parse({ id, name, baseUrl: `${origin}/v1`, gpu: 'cuda:0', contextTokens: 8192, ...(unloadUrl ? { unloadUrl } : {}) });
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [mk('busy', 'Busy lab', `${origin}/ub/{model}`), mk('down', 'Down lab', `${origin}/ud/{model}`), mk('nourl', 'No-URL lab')],
      analyzerEndpointKeys: {},
    });
    noteEndpointModelUsed('busy', 'm');
    noteEndpointModelUsed('down', 'm');
    const release = markEndpointRunActive(['busy']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const err = await withCapacityRetry(vi.fn(async () => noCapacityResponse(2_000, 'cuda:0')), {
        engine: 'qwen',
        capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
        evictOllama: vi.fn(async () => {}),
        analyzerEvictWouldHelp: vi.fn(async () => false),
        isAnalysisInFlight: () => false,
        evictIdleTts: vi.fn(async () => false),
        describeBlockers: async () => [],
        isDesignResident: async () => false,
        pollMs: 1,
        maxAttempts: 3,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NoCapacityError);
      const message = (err as Error).message;
      expect(message).toMatch(/"Busy lab".*busy for the whole wait/);
      expect(message).toMatch(/"Down lab".*every unload request/);
      expect(message).toMatch(/"No-URL lab".*Unload URL/);
      expect(downHits).toBe(1); // "Down lab"'s one model, once, over three polls
    } finally {
      release();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      warn.mockRestore();
      info.mockRestore();
      _resetUserSettingsCache();
      _resetEndpointRuntimeForTest();
      _resetEndpointBusyForTest();
    }
  });

  it("a 2xx unload retries admission at once, and the next denial re-measures free memory before Ollama's lever", async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls <= 2 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    let probes = 0;
    const read = vi.fn(async () => fakeDevices('cuda:0', ++probes === 1 ? 500 : 3_000));
    const analyzerEvictWouldHelp = vi.fn(async () => false);
    const started = Date.now();
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp,
      isAnalysisInFlight: () => false,
      evictEndpoints: vi.fn(async () => ({ attempted: 1, unloaded: 1 })),
      evictIdleTts: vi.fn(async () => false),
      pollMs: 5_000,
      maxAttempts: 5,
    });
    /* Immediate retry (no 5 s poll wait), and Ollama's VRAM check saw the post-unload figure. */
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(analyzerEvictWouldHelp.mock.calls).toEqual([
      [2_000, 500],
      [2_000, 3_000],
    ]);
  });

  it('Ollama idle and helpful → evicted first, exactly as before, and the endpoints are never asked', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => (++calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse()));
    const read = vi.fn(async () => fakeDevices('cuda:0', 500));
    const evictIdleTts = vi.fn(async () => false);
    const evictEndpoints = vi.fn(async () => ({ attempted: 0, unloaded: 0 }));
    await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => true),
      isAnalysisInFlight: () => false,
      evictEndpoints,
      evictIdleTts,
      pollMs: 1,
      maxAttempts: 5,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(evictEndpoints).not.toHaveBeenCalled();
    expect(evictIdleTts).not.toHaveBeenCalled();
  });

  it('the give-up message names the Unload URL setting for a sharing endpoint without one', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(2_000, 'cuda:0'));
    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: vi.fn(async () => false),
      isAnalysisInFlight: () => false,
      evictEndpoints: vi.fn(async () => ({ attempted: 0, unloaded: 0 })),
      endpointUnloadNotes: () => ['Analyzer endpoint "Lab" shares this card but has no Unload URL — set "Unload URL".'],
      describeBlockers: async () => [],
      isDesignResident: async () => false,
      pollMs: 1,
      maxAttempts: 2,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoCapacityError);
    expect((err as Error).message).toContain('Unload URL');
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
